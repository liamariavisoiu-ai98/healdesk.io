import { getTableColumns } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { leadEvents, leads, rateLimits } from "./db/schema";

/**
 * The marketing schema must never grow a column that could describe a
 * patient. This is a denylist, not an allowlist, because the point is to
 * catch the obvious mistake at review time: someone adds `patientName` to
 * the claim form and it lands in the wrong database. Anything subtler is a
 * design review, not a regex.
 */
const PHI_SHAPED = [
  /patient/i,
  /\bdob\b|date_of_birth|birth/i,
  /diagnos/i,
  /treatment_history|procedure/i,
  /condition/i,
  /\bnotes?\b/i,
  /medical/i,
  /transcript/i,
  /insurance/i,
];

describe("marketing schema", () => {
  it("has no patient-shaped columns", () => {
    for (const table of [leads, leadEvents, rateLimits]) {
      for (const name of Object.keys(getTableColumns(table))) {
        for (const pattern of PHI_SHAPED) {
          expect(name, `${name} looks like PHI`).not.toMatch(pattern);
        }
      }
    }
  });
});

const url = process.env.TEST_MARKETING_URL;
const describeDb = url ? describe : describe.skip;

describeDb("recordDemoUnlock", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.MARKETING_DATABASE_URL = url;
    pool = new Pool({ connectionString: url, max: 4 });
    // See rate-limit.test.ts: serialise the migration across parallel workers.
    const lock = await pool.connect();
    try {
      await lock.query("select pg_advisory_lock(424242)");
      await migrate(drizzle(lock), { migrationsFolder: "./drizzle" });
    } finally {
      await lock.query("select pg_advisory_unlock(424242)");
      lock.release();
    }
    const db = await import("./db");
    db.__setMarketingPoolForTests(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("delete from lead_events; delete from leads");
  });

  afterAll(async () => {
    const db = await import("./db");
    db.__setMarketingPoolForTests(undefined);
    await pool.end();
  });

  it("stores one row per normalised email and counts repeat unlocks", async () => {
    const { recordDemoUnlock } = await import("./leads");
    const a = await recordDemoUnlock({ email: "Dr.Chen@Clinic.com", isBusinessEmail: true });
    const b = await recordDemoUnlock({ email: "  dr.chen@clinic.com ", isBusinessEmail: true });
    expect(a.ok && a.created).toBe(true);
    expect(b.ok && !b.created).toBe(true);
    const { rows } = await pool.query("select email, email_normalized, unlock_count, lead_score from leads");
    expect(rows).toHaveLength(1);
    expect(rows[0].email_normalized).toBe("dr.chen@clinic.com");
    expect(rows[0].email).toBe("Dr.Chen@Clinic.com");
    expect(rows[0].unlock_count).toBe(2);
    expect(rows[0].lead_score).toBe("business");
    const events = await pool.query("select name from lead_events");
    expect(events.rows.map((r) => r.name)).toEqual(["demo_unlocked", "demo_unlocked"]);
  });

  it("records consent only with the wording, and never withdraws it on a later unlock", async () => {
    const { recordDemoUnlock } = await import("./leads");
    await recordDemoUnlock({ email: "owner@spa.com", isBusinessEmail: true });
    let row = (await pool.query("select marketing_consent, consent_at, consent_text from leads")).rows[0];
    expect(row.marketing_consent).toBe(false);
    expect(row.consent_at).toBeNull();

    await recordDemoUnlock({
      email: "owner@spa.com",
      isBusinessEmail: true,
      marketingConsent: true,
      noticeVersion: "v-test",
      consentText: "Email me about AYA.",
    });
    row = (await pool.query("select marketing_consent, consent_at, consent_text, consent_notice_version from leads")).rows[0];
    expect(row.marketing_consent).toBe(true);
    expect(row.consent_at).not.toBeNull();
    expect(row.consent_text).toBe("Email me about AYA.");
    expect(row.consent_notice_version).toBe("v-test");

    // A third unlock with the box unticked leaves the consent exactly as it was.
    await recordDemoUnlock({ email: "owner@spa.com", isBusinessEmail: true });
    const again = (await pool.query("select marketing_consent, consent_text from leads")).rows[0];
    expect(again.marketing_consent).toBe(true);
    expect(again.consent_text).toBe("Email me about AYA.");
  });

  it("keeps only the referrer's host and a well-formed campaign", async () => {
    const { recordDemoUnlock } = await import("./leads");
    await recordDemoUnlock({
      email: "x@y.com",
      isBusinessEmail: true,
      referrer: "https://www.google.com/search?q=med+spa+ai&utm=secret",
      campaign: "dental-q4",
    });
    const row = (await pool.query("select referrer_host, source_campaign from leads")).rows[0];
    expect(row.referrer_host).toBe("www.google.com");
    expect(row.source_campaign).toBe("dental-q4");
  });
});

describe("recordDemoUnlock without a database", () => {
  it("fails open and reports why", async () => {
    delete process.env.MARKETING_DATABASE_URL;
    const { recordDemoUnlock } = await import("./leads");
    const r = await recordDemoUnlock({ email: "a@b.co", isBusinessEmail: false });
    expect(r).toEqual({ ok: false, reason: "unconfigured" });
  });
});

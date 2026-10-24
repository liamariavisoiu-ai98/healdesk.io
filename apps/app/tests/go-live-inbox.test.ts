import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { ActorContext } from "@/lib/audit";
import { goLiveSource, goLiveStanding } from "@/lib/ops/inbox/go-live";
import type { GoLiveCheck, GoLiveCode, GoLiveMissing } from "@/lib/onboarding/go-live";
import type { InboxContext } from "@/lib/ops/inbox/types";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic, seedDemoClinic } from "./setup/factories";
import { readyForGoLive, setAgreement } from "./setup/go-live";

/**
 * Lane P5d, item 7: Home's go-live rows (lib/ops/inbox/go-live.ts), which
 * are not registered in INBOX_SOURCES yet (the row kind needs its line in
 * INBOX_KINDS, a file outside the lane), so the source is read directly.
 */

const missing = (code: GoLiveCode, side: GoLiveMissing["side"]): GoLiveMissing => ({ code, side, text: `${code}.` });
const check = (...items: GoLiveMissing[]): GoLiveCheck => ({ ok: items.length === 0, missing: items, notBuilt: [] });

describe("where a clinic stands at go-live (pure)", () => {
  test("ready when nothing is left or all that is left is ours; held when the clinic's part is done or its agreement stands in the way", () => {
    expect(goLiveStanding({ production: false, check: check() })).toBe("ready");
    expect(goLiveStanding({ production: false, check: check(missing("platform", "ours"), missing("gate_b_not_built", "ours")) })).toBe("ready");
    expect(goLiveStanding({ production: false, check: check(missing("gate_b", "ours")) })).toBe("ready");
    // Its channel's part done, its covered status not answered: held.
    expect(goLiveStanding({ production: false, check: check(missing("covered_status", "clinic"), missing("platform", "ours")) })).toBe("held");
    // Setup not done, but a superseded agreement: held, as go_live_held says.
    expect(goLiveStanding({ production: false, check: check(missing("agreement_version", "clinic"), missing("gate_b", "clinic")) })).toBe("held");
    // Still setting up, nothing else wrong: neither.
    expect(goLiveStanding({ production: false, check: check(missing("gate_b", "clinic")) })).toBeNull();
    expect(goLiveStanding({ production: false, check: check(missing("gate_b", "clinic"), missing("covered_status", "clinic")) })).toBeNull();
    // Live, leaving or the demo clinic: never a row.
    expect(goLiveStanding({ production: true, check: check() })).toBeNull();
    expect(goLiveStanding({ production: false, check: check(missing("leaving", "clinic")) })).toBeNull();
    expect(goLiveStanding({ production: false, check: check(missing("demo", "ours")) })).toBeNull();
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR: ActorContext = { type: "service", serviceName: "ops@healdesk.test" };

describeDb("Home's go-live rows, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  const ctx = (): InboxContext => ({
    now: new Date(),
    operator: { email: "ops@healdesk.test", request: {} },
    actor: ACTOR,
    request: {},
    clinicNames: async () => new Map(),
  });

  test("one row for the clinics ready (none for those held: that waits on the clinic), opening the first clinic's Setup tab; the demo and a clinic still setting up are not counted", async () => {
    const ready = await seedClinic("golive-ready");
    await readyForGoLive(ready.clinicId, ready.organizationId);
    const held = await seedClinic("golive-held");
    // Website chat's part done, under a superseded BAA: only the practice can sign the current one.
    await readyForGoLive(held.clinicId, held.organizationId, { version: "1.0.0" });
    const setting = await seedClinic("golive-setting");
    await setAgreement(setting.clinicId, setting.organizationId);
    await seedDemoClinic("golive");
    const live = await seedClinic("golive-live");
    await readyForGoLive(live.clinicId, live.organizationId);
    await getMigratorPool().query(`update clinics set data_classification = 'production' where id = $1`, [live.clinicId]);

    const { rows, partial } = await goLiveSource.read(ctx());
    expect(partial).toBeUndefined();
    expect(rows).toEqual([
      {
        id: "go_live:ready",
        kind: "go_live",
        count: 1,
        sentence: "1 clinic is ready to go live: the clinic's part is done and what is left is ours.",
        clinic: { id: ready.clinicId, name: "golive-ready Clinic" },
        button: { label: "Open Setup", kind: "link", href: `/admin/clinics/${ready.clinicId}/setup` },
        tone: "warn",
        dueAt: null,
      },
    ]);
  }, 120_000);
});

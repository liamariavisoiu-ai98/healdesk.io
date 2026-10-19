import { randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
  parseClinicProfile,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The misclassification signal on every read of the website (wave 2, R11;
 * plan Part L, "A DPA 'No' practice whose site says it accepts insurance goes
 * to the review queue"). WP9 raised it only at provisioning, so a practice
 * whose checkout read failed and whose demo stood in, which keeps no
 * insurance answer, was never asked again, and a drift read, which keeps the
 * baseline, could not raise it at all. Now every read raises it from what it
 * found; a practice whose baseline says nothing is read once more for that
 * alone (`insurance`), which changes nothing else; and a review ops decided
 * `passed` is not reopened by the same site.
 *
 * The DPA is unreleased; provisioning is shown the owner's release through
 * `release`, as tests/agreement-misclassification.test.ts does.
 */

const release = vi.hoisted(() => ({ dpa: true }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    getDpaTemplate: (version: string) => {
      const template = actual.getDpaTemplate(version);
      return template && release.dpa ? { ...template, approvedByCounsel: true } : template;
    },
  };
});
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return {
    ...actual,
    sendEmail: (
      email: Parameters<typeof actual.sendEmail>[0],
      options: Parameters<typeof actual.sendEmail>[1] = {},
    ) =>
      actual.sendEmail(email, {
        ...options,
        transport: { name: "fake", send: async () => ({ status: "sent", messageId: "msg" }) },
      }),
  };
});
vi.mock("@/lib/email/agreement-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/agreement-copy")>();
  return {
    ...actual,
    sendAgreementCopy: async () => ({ sent: false, status: "skipped", reason: "No transport." }),
  };
});

const { signAgreement } = await import("@/lib/agreements");
const { runOperation } = await import("@/lib/ops/api");
const { provisionClinic } = await import("@/lib/provisioning");
const { withTenant } = await import("@/lib/tenant");
const { runOneSiteReread } = await import("@/lib/website/job");
const { requestSiteReread } = await import("@/lib/website/queue");
const { siteRereadOwed } = await import("@/lib/website/store");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "misclassification-rereads-test" } as const;
const OPERATOR = { email: "ops@healdesk.test", request: {} };
const WEBSITE = "glowmedspa.com";

process.env.BETTER_AUTH_URL = "https://app.healdesk.test";

function profile(acceptsInsurance: "yes" | "no" | "unknown", readAt = "2026-10-07T09:00:00.000Z") {
  const p = parseClinicProfile({
    version: 1,
    website: WEBSITE,
    readAt,
    pages: 2,
    locations: [
      { label: "Glow", address: "1200 Congress Ave, Austin, TX 78701", phone: null, hours: null },
    ],
    services: [],
    providers: [],
    policies: ["Cancel 24 hours ahead."],
    faqs: [],
    acceptsInsurance,
    practiceKind: "med-spa",
    dropped: 0,
  });
  if (!p) throw new Error("the fixture profile does not parse");
  return p;
}

describeDb("the misclassification signal on re-reads", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    release.dpa = false;
    await closePools();
  });

  /** A med spa under the DPA, "No", provisioned with `seed` as the purchase's read. */
  async function dpaNo(label: string, seed: ClinicProfile) {
    const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
    const signed = await signAgreement(
      {
        clinicLegalName: `${label} Med Spa LLC`,
        specialty: "med-spa",
        signatoryName: "Laura Owner",
        signatoryEmail: email,
        isCoveredEntity: false,
        attributionMode: "estimated",
        platform: agreementPlatformFor("none"),
        bookingSystem: "none",
        calendarAccount: "workspace_no_baa",
        assentLabel: DPA_ASSENT_LABEL,
        templateVersion: currentDpaTemplate().version,
      },
      {},
      { dpaReleased: true },
    );
    return provisionClinic(
      {
        clinicName: `${label} Med Spa LLC`,
        specialty: "med-spa",
        platform: agreementPlatformFor("none"),
        plan: "voice-webchat-1000-1000",
        contactName: "Laura Owner",
        contactEmail: email,
        agreementId: signed.agreementId,
        idempotencyKey: `idem-${randomUUID()}`,
      },
      {},
      { setup: { website: WEBSITE, profile: seed } },
    );
  }

  const owed = (clinicId: string, drift = false) =>
    withTenant({ clinicId, actor: ACTOR }, (tx) => siteRereadOwed(tx, { now: new Date(), drift }));

  async function ask(clinicId: string, reason: "insurance" | "drift" | "ops") {
    return withTenant({ clinicId, actor: ACTOR }, (tx) =>
      requestSiteReread(tx, { reason, website: WEBSITE }),
    );
  }

  /** Run the clinic's queued read, apps/web faked to answer `answer`. */
  async function readNow(clinicId: string, id: string, answer: ClinicProfile) {
    return runOneSiteReread(clinicId, id, {
      read: async () => ({ status: "read", profile: answer }),
    });
  }

  async function reviews(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ id: string; status: string }>(
        `select id, status from audit_review_queue where clinic_id = $1 and kind = 'agreement_kind'
          order by created_at`,
        [clinicId],
      ),
    );
    return rows;
  }

  async function facts(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{ insurance: string; changes: number; notices: number }>(
        `select (select site_profile->>'acceptsInsurance' from clinics where id = $1) as insurance,
                (select count(*)::int from website_changes where clinic_id = $1) as changes,
                (select count(*)::int from billing_notices
                  where clinic_id = $1 and kind = 'website_changes') as notices`,
        [clinicId],
      ),
    );
    return rows[0]!;
  }

  test("a baseline that says nothing about insurance (the demo's never does) is read once more, and that read raises the signal and changes nothing else", async () => {
    const practice = await dpaNo("misdemo", profile("unknown"));
    expect(await reviews(practice.clinicId)).toEqual([]);

    // Owed once, for that alone.
    expect(await owed(practice.clinicId)).toEqual({ reason: "insurance", website: WEBSITE });
    const id = await ask(practice.clinicId, "insurance");

    // The site does say it: one open review; the baseline, the drift list and
    // the clinic's email are as they were, though the site's policies differ.
    const answer = { ...profile("yes", "2026-10-19T09:00:00.000Z"), policies: [] };
    const read = await readNow(practice.clinicId, id, answer);
    expect(read).toMatchObject({ status: "read", changes: 0, emailed: false });
    expect(await reviews(practice.clinicId)).toEqual([{ id: expect.any(String), status: "open" }]);
    expect(await facts(practice.clinicId)).toEqual({
      insurance: "unknown",
      changes: 0,
      notices: 0,
    });

    // Asked already: not owed again.
    expect(await owed(practice.clinicId)).toBeNull();
  });

  test("a drift read that keeps the baseline raises it too, and a review ops decided passed is not reopened", async () => {
    const practice = await dpaNo("misdrift", profile("no"));
    // The baseline answers the question: no insurance read is owed.
    expect(await owed(practice.clinicId)).toBeNull();

    const first = await ask(practice.clinicId, "ops");
    await readNow(practice.clinicId, first, profile("yes", "2026-10-19T09:00:00.000Z"));
    const [review] = await reviews(practice.clinicId);
    expect(review).toMatchObject({ status: "open" });
    // The baseline stands: an operator's read of a clinic with one is a drift read.
    expect((await facts(practice.clinicId)).insurance).toBe("no");

    // Ops asks the practice, which still bills no insurance electronically.
    const decided = (await runOperation(
      "decideAgreementReview",
      { clinicId: practice.clinicId, reviewId: review!.id, answer: "no" },
      OPERATOR,
    )) as { body: { data?: Record<string, unknown> } };
    expect(decided.body.data).toMatchObject({ status: "recorded", covered: true });

    // The same site saying the same thing a month on asks nothing more.
    const again = await ask(practice.clinicId, "ops");
    await readNow(practice.clinicId, again, profile("yes", "2026-11-19T09:00:00.000Z"));
    expect((await reviews(practice.clinicId)).map((r) => r.status)).toEqual(["passed"]);
  });

  test("a practice under the BAA is never read for it, and its reads raise nothing", async () => {
    const practice = await dpaNo("misbaa", profile("unknown"));
    // As if it had signed the BAA: the signal is a DPA practice's alone.
    await getMigratorPool().query(`update clinics set agreement_kind = 'baa' where id = $1`, [
      practice.clinicId,
    ]);
    expect(await owed(practice.clinicId)).toBeNull();
    const id = await ask(practice.clinicId, "ops");
    await readNow(practice.clinicId, id, profile("yes", "2026-10-19T09:00:00.000Z"));
    expect(await reviews(practice.clinicId)).toEqual([]);
  });
});

import { randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  currentDpaTemplate,
  DPA_ASSENT_LABEL,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The misclassification signal (package WP9, plan Part L): a practice that
 * signed the Data Protection Agreement as billing no insurance
 * electronically, whose own website says it accepts insurance, waits in the
 * practice questions' review queue (kind `agreement_kind`) for ops to ask it.
 * The decision is the practice's answer, recorded through setCoveredEntity.
 *
 * The DPA is unreleased; provisioning is shown the owner's release through
 * `release`, which changes only what `getDpaTemplate` reports, as
 * tests/dpa-signing.test.ts does, and its own flag never moves.
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

const sent = vi.hoisted(() => ({ kinds: [] as string[] }));
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
        transport: {
          name: "fake",
          send: async () => {
            sent.kinds.push(email.kind);
            return { status: "sent", messageId: `msg_${sent.kinds.length}` };
          },
        },
      }),
  };
});
vi.mock("@/lib/email/agreement-copy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/agreement-copy")>();
  return {
    ...actual,
    sendAgreementCopy: async () => ({
      sent: false,
      status: "skipped",
      reason: "No transport here.",
    }),
  };
});

const { signAgreement } = await import("@/lib/agreements");
const { flagInsuranceMismatch, insuranceMismatch, listAgreementReviews } =
  await import("@/lib/agreements/misclassification");
const { listPracticeReviews } = await import("@/lib/engine/practice/review");
const { recordOperatorOverride } = await import("@/lib/engine/practice/store");
const { parseEnvelope, runOperation } = await import("@/lib/ops/api");
const { provisionClinic } = await import("@/lib/provisioning");
const { withTenant } = await import("@/lib/tenant");

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "misclassification-test" } as const;
const OPERATOR = { email: "ops@healdesk.test", request: {} };

process.env.BETTER_AUTH_URL = "https://app.healdesk.test";

function profile(acceptsInsurance: "yes" | "no" | "unknown"): ClinicProfile {
  return {
    version: 1,
    website: "glowmedspa.com",
    readAt: "2026-10-07T09:00:00.000Z",
    pages: 2,
    locations: [
      { label: "Glow", address: "1200 Congress Ave, Austin, TX 78701", phone: null, hours: null },
    ],
    services: [],
    providers: [],
    policies: [],
    faqs: [],
    acceptsInsurance,
    practiceKind: "med-spa",
    dropped: 0,
  } as unknown as ClinicProfile;
}

describe("the signal", () => {
  const dpaNo = {
    regulatoryRegime: "hipaa-if-covered",
    agreementKind: "dpa",
    isCoveredEntity: false,
    siteProfile: { acceptsInsurance: "yes" as const },
  };

  test("is a DPA No practice whose site says it accepts insurance, and nothing else", () => {
    expect(insuranceMismatch(dpaNo)).toBe(true);
    expect(insuranceMismatch({ ...dpaNo, siteProfile: { acceptsInsurance: "unknown" } })).toBe(
      false,
    );
    expect(insuranceMismatch({ ...dpaNo, siteProfile: { acceptsInsurance: "no" } })).toBe(false);
    expect(insuranceMismatch({ ...dpaNo, siteProfile: null })).toBe(false);
    // A vet is outside HIPAA whatever it bills; a BAA covers a practice either way.
    expect(insuranceMismatch({ ...dpaNo, regulatoryRegime: "non-hipaa" })).toBe(false);
    expect(insuranceMismatch({ ...dpaNo, agreementKind: "baa" })).toBe(false);
    expect(insuranceMismatch({ ...dpaNo, isCoveredEntity: null })).toBe(false);
  });
});

describeDb("the misclassification review", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    sent.kinds.length = 0;
  });

  afterAll(async () => {
    release.dpa = false;
    await closePools();
  });

  /** A med spa provisioned under the agreement it signs, with its website read as given. */
  async function provisioned(
    label: string,
    kind: "dpa" | "baa",
    acceptsInsurance: "yes" | "no" | "unknown",
  ) {
    const email = `${label}-${randomUUID().slice(0, 8)}@glowspa.test`;
    const signed = await signAgreement(
      {
        clinicLegalName: `${label} Med Spa LLC`,
        specialty: "med-spa",
        signatoryName: "Laura Owner",
        signatoryEmail: email,
        isCoveredEntity: kind === "dpa" ? false : true,
        attributionMode: "estimated",
        platform: agreementPlatformFor("none"),
        bookingSystem: "none",
        calendarAccount: "workspace_no_baa",
        assentLabel: kind === "dpa" ? DPA_ASSENT_LABEL : BAA_ASSENT_LABEL,
        templateVersion: kind === "dpa" ? currentDpaTemplate().version : CURRENT_BAA_VERSION,
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
      { setup: { website: "glowmedspa.com", profile: profile(acceptsInsurance) } },
    );
  }

  async function reviewsOf(clinicId: string) {
    const { rows } = await inTenant(clinicId, (client) =>
      client.query<{
        id: string;
        kind: string;
        status: string;
        run_id: string | null;
        decided_by_label: string | null;
      }>(
        `select id, kind, status, run_id, decided_by_label from audit_review_queue where clinic_id = $1`,
        [clinicId],
      ),
    );
    return rows;
  }

  async function op(name: string, args: Record<string, unknown>) {
    const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
    if (!parsed.ok) throw new Error(`${name} is not an operation`);
    return (await runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR)) as {
      status: number;
      body: { data?: Record<string, unknown> };
    };
  }

  test("provisioning a DPA No practice whose site takes insurance opens one review, and only that one", async () => {
    const flagged = await provisioned("misyes", "dpa", "yes");
    const quiet = await provisioned("misunknown", "dpa", "unknown");
    const baa = await provisioned("misbaa", "baa", "yes");

    const reviews = await reviewsOf(flagged.clinicId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "agreement_kind", status: "open", run_id: null });
    expect(await reviewsOf(quiet.clinicId)).toEqual([]);
    expect(await reviewsOf(baa.clinicId)).toEqual([]);

    // A second read of the same site adds nothing: one open review per practice.
    const again = await withTenant({ clinicId: flagged.clinicId, actor: ACTOR }, (tx) =>
      flagInsuranceMismatch(tx),
    );
    expect(again).toBe(false);
    expect(await reviewsOf(flagged.clinicId)).toHaveLength(1);

    // Ops sees it among the agreement checks, never among the practice questions'.
    const listed = await listAgreementReviews({ actor: ACTOR });
    expect(listed.map((r) => [r.clinicId, r.status, r.signal])).toEqual([
      [flagged.clinicId, "open", "site_accepts_insurance"],
    ]);
    expect(await listPracticeReviews({ actor: ACTOR })).toEqual([]);
    expect((await op("listAgreementReviews", {})).body.data).toMatchObject({
      reviews: [{ clinicId: flagged.clinicId, status: "open" }],
    });

    // A run of the practice questions, or the operator's approval, supersedes
    // the open practice-questions reviews and leaves this one alone.
    await withTenant({ clinicId: flagged.clinicId, actor: ACTOR }, (tx) =>
      recordOperatorOverride(tx, { label: "ops@healdesk.test" }),
    );
    expect((await reviewsOf(flagged.clinicId))[0]!.status).toBe("open");
  });

  test("decided by the practice's answer: No keeps the DPA; Yes sends the BAA to sign", async () => {
    const stays = await provisioned("misstays", "dpa", "yes");
    const moves = await provisioned("mismoves", "dpa", "yes");
    const [stayReview] = await reviewsOf(stays.clinicId);
    const [moveReview] = await reviewsOf(moves.clinicId);

    const no = await op("decideAgreementReview", {
      clinicId: stays.clinicId,
      reviewId: stayReview!.id,
      answer: "no",
    });
    expect(no.body.data).toMatchObject({
      status: "recorded",
      covered: true,
      supersedeStarted: false,
    });
    expect((await reviewsOf(stays.clinicId))[0]).toMatchObject({
      status: "passed",
      decided_by_label: "ops@healdesk.test",
    });

    const yes = await op("decideAgreementReview", {
      clinicId: moves.clinicId,
      reviewId: moveReview!.id,
      answer: "yes",
    });
    expect(yes.body.data).toMatchObject({
      status: "recorded",
      covered: false,
      supersedeStarted: true,
      linkSent: true,
    });
    expect((await reviewsOf(moves.clinicId))[0]!.status).toBe("failed");
    expect(sent.kinds).toContain("agreement_to_sign");
    const { rows } = await inTenant(moves.clinicId, (client) =>
      client.query<{ status: string }>(
        `select status from agreement_resigns where clinic_id = $1`,
        [moves.clinicId],
      ),
    );
    expect(rows).toEqual([{ status: "open" }]);

    // Decided is decided.
    const twice = await op("decideAgreementReview", {
      clinicId: moves.clinicId,
      reviewId: moveReview!.id,
      answer: "no",
    });
    expect(twice.body.data).toMatchObject({ status: "refused" });
  });

  test("the queue's columns hold: a practice-questions review names its run, and one agreement check is open per practice", async () => {
    const flagged = await provisioned("mischeck", "dpa", "yes");
    await expect(
      inTenant(flagged.clinicId, (client) =>
        client.query(
          `insert into audit_review_queue (clinic_id, kind, run_id, due_on, due_at)
           values ($1, 'practice_questions', null, current_date, now())`,
          [flagged.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      inTenant(flagged.clinicId, (client) =>
        client.query(
          `insert into audit_review_queue (clinic_id, kind, run_id, due_on, due_at)
           values ($1, 'agreement_kind', null, current_date, now())`,
          [flagged.clinicId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

import { randomBytes, randomUUID } from "node:crypto";

import {
  CURRENT_BAA_VERSION,
  getBaaTemplate,
  hashBaaText,
  type BookingSystemId,
  type CalendarAccount,
} from "@healdesk/catalog";
import { BAA_ASSENT_LABEL } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { signAgreement } from "@/lib/agreements";
import {
  ProvisioningError,
  provisionClinic,
  validateProvisionRequest,
  type ProvisionRequest,
} from "@/lib/provisioning";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";

/**
 * Provisioning: turning a completed checkout into an account.
 *
 * The case that matters most is the DEFAULT one — a clinic with no booking
 * software, connecting nothing. If that path ever requires an integration
 * step, integration has crept back onto the critical path to revenue.
 */

/**
 * Standing in for a version falling below the go-live floor after a clinic
 * signed it (a later release raising MIN_ACCEPTABLE_BAA_VERSION, or a
 * rollback): a version in `floor.withdrawn` is one isBaaVersionAcceptable no
 * longer accepts, and nothing else changes. And for the floor as it stood
 * before a release raised it: a version in `floor.restored` is one it accepts
 * again, so a test can provision a document from before that release. BAA
 * 1.4.0 is released (13 October 2026), accepted for real, and the floor: 1.3.0
 * and 1.2.2 are refused for real.
 *
 * And for a booking system the catalogue reclassifies after a practice has
 * signed, as a vendor's written confirmation would (plan Q4): a system in
 * `catalogue.readsGoogle` is "yes" to whatever in apps/app asks the
 * catalogue (bookingSyncFor, selectCalendarClause). Signing has already
 * chosen its clause by then, inside the catalogue, where this reaches
 * nothing.
 */
const floor = vi.hoisted(() => ({ withdrawn: [] as string[], restored: [] as string[] }));
const catalogue = vi.hoisted(() => ({ readsGoogle: [] as string[] }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  const reclassified = (id: unknown) =>
    typeof id === "string" && catalogue.readsGoogle.includes(id);
  return {
    ...actual,
    isBaaVersionAcceptable: (version: string) =>
      (actual.isBaaVersionAcceptable(version) || floor.restored.includes(version)) &&
      !floor.withdrawn.includes(version),
    bookingSyncFor: (id: unknown) => (reclassified(id) ? "live" : actual.bookingSyncFor(id)),
    selectCalendarClause: (input: Parameters<typeof actual.selectCalendarClause>[0]) => {
      if (!reclassified(input.bookingSystem)) return actual.selectCalendarClause(input);
      const kind = actual.calendarTermsKind("live", input.calendarAccount);
      return {
        kind,
        clauseId: actual.CALENDAR_CLAUSE_IDS[kind],
        // The 1.3.0 redraft's calendarClauseBody refuses a kind its booking
        // system's real sync contradicts, which a reclassification is, so the
        // body is rendered for a system that reads Google; the tests read the
        // clause id and kind, not the body's wording.
        body: actual.calendarClauseBody({
          kind,
          account: input.calendarAccount,
          bookingSystem: "google_calendar",
        }),
      };
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;

function validRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    clinicName: "Radiance Med Spa",
    specialty: "med-spa",
    platform: "none",
    attributionMode: "estimated",
    averageTreatmentValueUsd: 550,
    plan: "voice-webchat-1000-1000",
    contactName: "Alex Chen",
    contactEmail: "alex@radiance.test",
    // A real uuid: validation only checks the shape, and the database check
    // that it exists and is unbound is what the integration tests exercise.
    agreementId: "11111111-1111-4111-8111-111111111111",
    // Unique per call so tests don't accidentally replay each other. The
    // idempotency tests override it deliberately.
    idempotencyKey: `test_${randomUUID()}`,
    ...overrides,
  };
}

/**
 * Sign an agreement the way the purchase flow does — before provisioning.
 *
 * Every provisioning test goes through this, which is the point: there is no
 * longer a way to create an account without a signature that already exists.
 */
async function signFor(
  clinicName: string,
  email: string,
): Promise<string> {
  const signed = await signAgreement({
    clinicLegalName: clinicName,
    specialty: "med-spa",
    signatoryName: "Alex Chen",
    signatoryTitle: "Owner",
    signatoryEmail: email,
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform: "none",
    // The current version (1.4.0, as 1.3.0 before it) reads both calendar answers.
    bookingSystem: "none",
    calendarAccount: "workspace_no_baa",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  return signed.agreementId;
}

type SignedAnswers = {
  /**
   * A version other than the current one, signed as if it were current: how
   * 1.2.0 was signed before 1.2.1 replaced it, 1.2.1 before 1.2.2, 1.2.2
   * before 1.3.0, and 1.3.0 before 1.4.0 replaced it.
   */
  version?: string;
  platform?: string;
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
};

/** Sign through signAgreement with the answers that say where the practice's bookings live. */
async function signWith(
  clinicName: string,
  email: string,
  answers: SignedAnswers,
): Promise<string> {
  const template = answers.version ? getBaaTemplate(answers.version) : undefined;
  if (answers.version && !template) throw new Error(`No template ${answers.version}`);
  const signed = await signAgreement(
    {
      clinicLegalName: clinicName,
      specialty: "med-spa",
      signatoryName: "Alex Chen",
      signatoryTitle: "Owner",
      signatoryEmail: email,
      isCoveredEntity: false,
      attributionMode: "estimated",
      platform: answers.platform,
      bookingSystem: answers.bookingSystem,
      calendarAccount: answers.calendarAccount,
      assentLabel: BAA_ASSENT_LABEL,
      templateVersion: template?.version ?? CURRENT_BAA_VERSION,
    },
    {},
    template ? { current: template } : {},
  );
  return signed.agreementId;
}

describe("provision request validation", () => {
  test("accepts the default path: no platform, estimated attribution", () => {
    expect(() => validateProvisionRequest(validRequest())).not.toThrow();
  });

  test("no longer needs an average treatment value, and still refuses a nonsense one", () => {
    // The monthly revenue report it fed is phase two (design 4.2), so the
    // funnel stopped asking. A value that is sent is still checked.
    expect(() =>
      validateProvisionRequest(validRequest({ averageTreatmentValueUsd: undefined })),
    ).not.toThrow();
    expect(() =>
      validateProvisionRequest(
        validRequest({ attributionMode: undefined, averageTreatmentValueUsd: undefined }),
      ),
    ).not.toThrow();
    expect(() =>
      validateProvisionRequest(validRequest({ averageTreatmentValueUsd: -5 })),
    ).toThrow(ProvisioningError);
  });

  test("refuses verified attribution when there is nothing to read from", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({ platform: "none", attributionMode: "verified" }),
      ),
    ).toThrow(/nothing for us to read from|has none/i);
  });

  test("allows verified attribution on a connectable platform", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({
          platform: "boulevard",
          attributionMode: "verified",
          averageTreatmentValueUsd: undefined,
        }),
      ),
    ).not.toThrow();
  });

  test("refuses provisioning with no signed agreement", () => {
    // Not a boolean any more. A caller can claim `accepted: true`; it cannot
    // conjure a signature row that already exists.
    expect(() =>
      validateProvisionRequest(validRequest({ agreementId: undefined as never })),
    ).toThrow(/business associate agreement/i);
  });

  test("refuses an agreement reference that isn't one", () => {
    expect(() =>
      validateProvisionRequest(validRequest({ agreementId: "yes-i-agreed" })),
    ).toThrow(ProvisioningError);
  });

  test("rejects unknown platforms, plans and specialties", () => {
    expect(() =>
      validateProvisionRequest(validRequest({ platform: "epic" })),
    ).toThrow(/platform/i);
    expect(() =>
      validateProvisionRequest(validRequest({ plan: "enterprise" })),
    ).toThrow(/plan/i);
    // A plan is a package at steps on the grid (owner, 13 October 2026): a
    // step off it, and the seven packages of 5 October, are not plans.
    for (const plan of ["voice-550", "voice-1600", "webchat-300-300", "web-voice", "complete"]) {
      expect(() => validateProvisionRequest(validRequest({ plan })), plan).toThrow(/plan/i);
    }
    // "radiology" rather than a plausible ICP: this fixture previously used
    // "veterinary", which was later added as a real specialty and turned a
    // rejection test into one that asserted nothing. Pick something the
    // catalogue will never carry.
    expect(() =>
      validateProvisionRequest(validRequest({ specialty: "radiology" })),
    ).toThrow(/specialty/i);
  });

  test("rejects a billing interval the catalog does not sell", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({ billingInterval: "week" as never }),
      ),
    ).toThrow(/billing interval/i);
    expect(() =>
      validateProvisionRequest(validRequest({ stripeSubscriptionId: "" })),
    ).toThrow(/stripeSubscriptionId/);
    // Optional: every caller that predates it still validates.
    expect(() =>
      validateProvisionRequest(validRequest({ billingInterval: "year" })),
    ).not.toThrow();
  });
});

describeDb("provisioning", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  afterEach(() => {
    floor.withdrawn = [];
    floor.restored = [];
    catalogue.readsGoogle = [];
  });

  /**
   * The Stripe-retry defect, pinned.
   *
   * Stripe re-delivers a webhook for up to three days on any non-2xx. Before
   * the idempotency ledger, the second delivery hit the clinic-slug unique
   * index, the retry loop generated `radiance-med-spa-a3f9c1`, and the clinic
   * got a SECOND organization and clinic — with the buyer billed once. This
   * test is the regression guard for that.
   */
  test("a repeated delivery replays instead of creating a second account", async () => {
    const agreementId = await signFor("Repeat Clinic", "repeat@clinic.test");
    const key = `cs_test_${randomUUID()}`;

    const first = await provisionClinic(
      validRequest({
        agreementId,
        clinicName: "Repeat Clinic",
        contactEmail: "repeat@clinic.test",
        idempotencyKey: key,
      }),
    );
    expect(first.replayed).toBe(false);

    const second = await provisionClinic(
      validRequest({
        agreementId,
        clinicName: "Repeat Clinic",
        contactEmail: "repeat@clinic.test",
        idempotencyKey: key,
      }),
    );

    // Same account, not a new one.
    expect(second.replayed).toBe(true);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.clinicId).toBe(first.clinicId);
    expect(second.clinicSlug).toBe(first.clinicSlug);

    const { rows } = await getMigratorPool().query<{ count: string }>(
      `select count(*)::text as count from clinics where name = $1`,
      ["Repeat Clinic"],
    );
    expect(rows[0]!.count).toBe("1");

    // One organization too, not two. The clinic count alone would still pass if
    // a replay somehow created an orphan org, and the org is what the agreement
    // binds to.
    const { rows: orgs } = await getMigratorPool().query<{ count: string }>(
      `select count(*)::text as count from organization where name = $1`,
      ["Repeat Clinic"],
    );
    expect(orgs[0]!.count).toBe("1");
  });

  /**
   * The other half of the same fix.
   *
   * Deduping must not cost us the ability to serve two genuinely different
   * clinics that share a name — that is what the slug retry is for, and
   * narrowing the unique-violation check to the slug constraints is what keeps
   * both behaviours. A regression here would look like the second clinic being
   * rejected, or silently handed the first one's account.
   */
  test("two different clinics with the same name still both provision", async () => {
    const firstAgreement = await signFor("Glow Bar", "one@glow.test");
    const secondAgreement = await signFor("Glow Bar", "two@glow.test");

    const first = await provisionClinic(
      validRequest({
        agreementId: firstAgreement,
        clinicName: "Glow Bar",
        contactEmail: "one@glow.test",
      }),
    );
    const second = await provisionClinic(
      validRequest({
        agreementId: secondAgreement,
        clinicName: "Glow Bar",
        contactEmail: "two@glow.test",
      }),
    );

    expect(second.replayed).toBe(false);
    expect(second.clinicId).not.toBe(first.clinicId);
    expect(first.clinicSlug).toBe("glow-bar");
    // Distinct slug, generated by the retry loop.
    expect(second.clinicSlug).not.toBe(first.clinicSlug);
    expect(second.clinicSlug.startsWith("glow-bar-")).toBe(true);
  });

  test("an idempotency key is required", async () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({ idempotencyKey: undefined as unknown as string }),
      ),
    ).toThrow(/idempotency key/i);
  });

  test("the default path completes with zero integration steps", async () => {
    const agreementId = await signFor("Radiance Med Spa", "alex@radiance.test");
    const result = await provisionClinic(validRequest({ agreementId }));

    expect(result.clinicSlug).toBe("radiance-med-spa");
    expect(result.clinicId).toBeTruthy();

    const { rows } = await getMigratorPool().query<{
      attribution_mode: string;
      booking_provider: string | null;
      average_treatment_value_usd: string | null;
      data_classification: string;
      plan: string;
    }>(
      `select attribution_mode, booking_provider, average_treatment_value_usd,
              data_classification, plan
         from clinics where id = $1`,
      [result.clinicId],
    );

    const clinic = rows[0]!;
    expect(clinic.attribution_mode).toBe("estimated");
    // The booking system signed, as BAA 1.3.0 records it: "none", no booking
    // software (plan C15). A 1.2.x signature naming no platform left it null.
    expect(clinic.booking_provider).toBe("none");
    expect(clinic.average_treatment_value_usd).toBe("550.00");
    expect(clinic.plan).toBe("voice-webchat-1000-1000");

    // Always synthetic at creation, whatever the buyer ticked. Moving to
    // production requires a signed BAA and is a separate, deliberate act.
    expect(clinic.data_classification).toBe("synthetic");
  });

  test("binds the agreement signed before payment, rather than recording a new one", async () => {
    const email = "owner@hashcheck.test";
    const agreementId = await signFor("Hash Check Clinic", email);

    const result = await provisionClinic(
      validRequest({ contactEmail: email, agreementId }),
    );

    const { rows } = await getMigratorPool().query<{
      id: string;
      document_version: string;
      document_hash: string;
      rendered_text: string;
      accepted_by_email: string;
      user_id: string | null;
      bound_at: Date | null;
    }>(
      `select id, document_version, document_hash, rendered_text,
              accepted_by_email, user_id, bound_at
         from baa_acceptances where organization_id = $1`,
      [result.organizationId],
    );

    // Exactly one. Provisioning must not add a second acceptance alongside the
    // one they actually signed.
    expect(rows).toHaveLength(1);

    const acceptance = rows[0]!;
    expect(acceptance.id).toBe(agreementId);
    expect(acceptance.document_version).toBe(CURRENT_BAA_VERSION);
    // The hash covers the RENDERED text — the per-clinic document, not the
    // template — which is what makes "what did they actually agree to"
    // answerable after the template changes.
    expect(acceptance.document_hash).toBe(hashBaaText(acceptance.rendered_text));
    expect(acceptance.rendered_text).toContain("Hash Check Clinic");
    expect(acceptance.accepted_by_email).toBe(email);
    expect(acceptance.bound_at).not.toBeNull();
    // The user does not exist yet — the frozen columns carry the record.
    expect(acceptance.user_id).toBeNull();
  });

  test("refuses to reuse an agreement that already belongs to an account", async () => {
    const agreementId = await signFor("Reuse Clinic", "reuse@example.test");
    await provisionClinic(
      validRequest({ contactEmail: "reuse@example.test", agreementId }),
    );

    // One signature, one account. Otherwise a captured agreement id becomes a
    // free account, and two clinics share one contract.
    await expect(
      provisionClinic(
        validRequest({
          clinicName: "Second Clinic",
          contactEmail: "second@example.test",
          agreementId,
        }),
      ),
    ).rejects.toThrow(/could not be attached/i);
  });

  test("the acceptance record cannot be altered by the runtime role", async () => {
    // A BAA acceptance the application can edit afterwards is not evidence.
    const { Pool } = await import("pg");
    const app = new Pool({ connectionString: process.env.TEST_APP_URL });
    try {
      await expect(
        app.query(`update baa_acceptances set accepted_by_name = 'someone else'`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query(`delete from baa_acceptances`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });

  /**
   * The inverse of the test this replaces.
   *
   * That test asserted provisioning created a pending owner invitation. It was
   * correct while a clinic console existed; it is now the exact defect. A
   * clinic never signs in, so an invitation issued here is a live credential
   * with a 14-day fuse and nothing behind it, accruing one per sale. Asserting
   * the absence is worth more than deleting the test: this is the property that
   * would silently come back if someone restored the insert.
   */
  test("creates no invitation and no password: the buyer's one sign-in has no credential", async () => {
    const agreementId = await signFor("Invite Clinic", "invitee@example.test");
    const result = await provisionClinic(
      validRequest({ contactEmail: "invitee@example.test", agreementId }),
    );

    // Not "no invitation with this id" — no invitation for this organization at
    // all, so the check cannot be satisfied by writing one under another id.
    const { rows: invites } = await getMigratorPool().query(
      `select id from invitation where organization_id = $1`,
      [result.organizationId],
    );
    expect(invites).toHaveLength(0);

    // Since the funnel plan (design D3), the buyer's address is the clinic's
    // one sign-in: exactly one user, the owner, with no credential of any
    // kind. Better Auth keeps passwords and providers in `account`, and there
    // is no row there: the only way in is a single-use link to this address.
    const { rows: users } = await getMigratorPool().query<{ id: string }>(
      `select id from "user" where email = $1`,
      ["invitee@example.test"],
    );
    expect(users).toHaveLength(1);
    const { rows: credentials } = await getMigratorPool().query(
      `select id from account where user_id = $1`,
      [users[0]!.id],
    );
    expect(credentials).toHaveLength(0);
    const { rows: grants } = await getMigratorPool().query(
      `select role from app_user_clinic_grants($1)`,
      [users[0]!.id],
    );
    expect(grants).toEqual([{ role: "owner" }]);

    // And no standing system principal either. `usr_system_healdesk` existed
    // only to satisfy the invitation's inviterId; a permanent user row that
    // nothing ever authenticates as is one more principal to keep out of every
    // membership query.
    const { rows: system } = await getMigratorPool().query(
      `select id from "user" where id = $1`,
      ["usr_system_healdesk"],
    );
    expect(system).toHaveLength(0);

    // The organization is still created and still carries the clinic: the FK on
    // clinics.organization_id is NOT NULL, and dropping the invitation must not
    // have taken the tenant row with it.
    const { rows: clinic } = await getMigratorPool().query<{
      organization_id: string;
    }>(`select organization_id from clinics where id = $1`, [result.clinicId]);
    expect(clinic[0]!.organization_id).toBe(result.organizationId);
  });

  test("gives colliding clinic names distinct slugs", async () => {
    const first = await provisionClinic(
      validRequest({
        clinicName: "Glow Clinic",
        contactEmail: "a@glow.test",
        agreementId: await signFor("Glow Clinic", "a@glow.test"),
      }),
    );
    const second = await provisionClinic(
      validRequest({
        clinicName: "Glow Clinic",
        contactEmail: "b@glow.test",
        agreementId: await signFor("Glow Clinic", "b@glow.test"),
      }),
    );

    expect(first.clinicSlug).toBe("glow-clinic");
    expect(second.clinicSlug).not.toBe(first.clinicSlug);
    expect(second.clinicSlug).toMatch(/^glow-clinic-/);
  });

  test("a provisioned clinic accepts synthetic data immediately", async () => {
    const result = await provisionClinic(
      validRequest({
        contactEmail: "phi@example.test",
        agreementId: await signFor("PHI Clinic", "phi@example.test"),
      }),
    );

    // The BAA gate allows writes to a 'synthetic' clinic, so the product is
    // testable end to end without implying a real patient anywhere.
    const pool = getMigratorPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [
        result.clinicId,
      ]);
      await expect(
        client.query(
          `insert into contacts (clinic_id, phone) values ($1, '+15550100002')`,
          [result.clinicId],
        ),
      ).resolves.toBeTruthy();
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  /**
   * The entitlements row is written in the same transaction as the clinic,
   * with allowances copied from the catalog at the moment of sale. Two
   * different packages, so a test that only ever checks one cannot pass on a
   * row seeded with constants.
   */
  test("seeds entitlements for the package sold, waiting on Stripe when there is a subscription", async () => {
    const result = await provisionClinic(
      validRequest({
        clinicName: "Entitled Clinic",
        contactEmail: "ent@example.test",
        agreementId: await signFor("Entitled Clinic", "ent@example.test"),
        plan: "voice-metachat-1000-1500",
        billingInterval: "year",
        stripeCustomerId: "cus_provisioned",
        stripeSubscriptionId: "sub_provisioned",
      }),
    );

    const row = await readEntitlements(result.clinicId);
    // A subscription to wait on: the first invoice.paid activates it.
    expect(row.status).toBe("provisioning");
    expect(row.plan_code).toBe("voice-metachat-1000-1500");
    expect(row.billing_interval).toBe("year");
    expect(row.stripe_customer_id).toBe("cus_provisioned");
    expect(row.stripe_subscription_id).toBe("sub_provisioned");
    // The steps bought, not a package's fixed allowance.
    expect(row.included_voice_minutes).toBe(1_000);
    expect(row.included_chat_conversations).toBe(1_500);
    // Voice + Meta Chat: Meta Chat includes website chat.
    expect(row.channels_enabled).toEqual({ web: true, meta: true, voice: true });
    // Nothing paid yet; the first invoice sets this.
    expect(row.setup_fee_paid_usd).toBe("0.00");
  });

  test("the no-Stripe path starts active, with the package's own allowances", async () => {
    const result = await provisionClinic(
      validRequest({
        clinicName: "Dev Path Clinic",
        contactEmail: "dev@example.test",
        agreementId: await signFor("Dev Path Clinic", "dev@example.test"),
        plan: "webchat-300",
      }),
    );

    const row = await readEntitlements(result.clinicId);
    // Nothing will ever arrive to activate it, so it starts there.
    expect(row.status).toBe("active");
    expect(row.plan_code).toBe("webchat-300");
    expect(row.billing_interval).toBe("month");
    expect(row.stripe_customer_id).toBeNull();
    expect(row.stripe_subscription_id).toBeNull();
    expect(row.included_voice_minutes).toBe(0);
    expect(row.included_chat_conversations).toBe(300);
    expect(row.channels_enabled).toEqual({ web: true, meta: false, voice: false });
  });

  test("the demo option is provisioning's own: a request carrying it provisions a customer like any other", async () => {
    // /api/provision builds the options itself and never from the body, so a
    // body claiming the marker is just a body. validateProvisionRequest lets
    // it through untouched, and nothing reads it.
    const smuggled = {
      ...validRequest({
        clinicName: "Smuggled Demo",
        contactEmail: "smuggled@example.test",
        agreementId: await signFor("Smuggled Demo", "smuggled@example.test"),
      }),
      demo: true,
    } as ProvisionRequest;
    expect(() => validateProvisionRequest(smuggled)).not.toThrow();
    const result = await provisionClinic(smuggled);
    const row = await readEntitlements(result.clinicId);
    expect(row.status).toBe("active");
    expect(await isDemo(result.clinicId)).toBe(false);
  });

  test("with the internal option, a demo clinic: status demo, no Stripe ids, no setup window, synthetic", async () => {
    const result = await provisionClinic(
      validRequest({
        clinicName: "Demo Practice",
        contactEmail: "demo-ops@example.test",
        agreementId: await signFor("Demo Practice", "demo-ops@example.test"),
        plan: "voice-metachat-1000-1000",
      }),
      {},
      { demo: true },
    );
    const row = await readEntitlements(result.clinicId);
    expect(row.status).toBe("demo");
    expect(row.stripe_customer_id).toBeNull();
    expect(row.stripe_subscription_id).toBeNull();
    expect(await isDemo(result.clinicId)).toBe(true);
    const deadline = await inClinicTenant(result.clinicId, (client) =>
      client.query<{ setup_deadline_at: Date | null; reason: string }>(
        `select e.setup_deadline_at, t.reason
           from entitlements e join billing_transitions t on t.clinic_id = e.clinic_id
          where e.clinic_id = $1`,
        [result.clinicId],
      ),
    );
    expect(deadline.rows).toEqual([{ setup_deadline_at: null, reason: "provisioned_demo" }]);
    // Its one sign-in is the operator's, as owner.
    expect(result.ownerUserId).toBeTruthy();

    // Never a purchase: refused with a Stripe id or a checkout intent.
    await expect(
      provisionClinic(
        validRequest({
          clinicName: "Demo With Stripe",
          contactEmail: "demo-stripe@example.test",
          agreementId: await signFor("Demo With Stripe", "demo-stripe@example.test"),
          stripeCustomerId: "cus_demo_refused",
          stripeSubscriptionId: "sub_demo_refused",
        }),
        {},
        { demo: true },
      ),
    ).rejects.toThrow(/not a purchase/);
    await expect(
      provisionClinic(
        validRequest({
          clinicName: "Demo With Intent",
          contactEmail: "demo-intent@example.test",
          agreementId: await signFor("Demo With Intent", "demo-intent@example.test"),
        }),
        {},
        { demo: true, intentRef: "intent_demo_refused" },
      ),
    ).rejects.toThrow(/not a purchase/);
  });

  test("two clinics cannot be provisioned onto one Stripe subscription", async () => {
    await expect(
      provisionClinic(
        validRequest({
          clinicName: "Second On Same Sub",
          contactEmail: "dup@example.test",
          agreementId: await signFor("Second On Same Sub", "dup@example.test"),
          stripeCustomerId: "cus_other",
          stripeSubscriptionId: "sub_provisioned",
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  /* ------------------------------------ what the signed acceptance decides (plan C15) */

  test("the approval gate reads the signed agreement's own version: a draft or a superseded one provisions nothing", async () => {
    // Until plan C15 the gate asked whether the CURRENT template was
    // approved, so while 1.2.1 was current a row signed under any other
    // version went through. The row's own version decides now, as it does
    // at go-live (isBaaVersionAcceptable).
    const draftEmail = "draft@gate.test";
    const draft = validRequest({
      clinicName: "Draft Gate Clinic",
      contactEmail: draftEmail,
      // 1.1.0-draft, never released, signed as if it were current.
      agreementId: await signWith("Draft Gate Clinic", draftEmail, {
        version: "1.1.0-draft",
        platform: "none",
      }),
    });
    const supersededEmail = "superseded@gate.test";
    const superseded = validRequest({
      clinicName: "Superseded Gate Clinic",
      contactEmail: supersededEmail,
      // 1.2.0, released on 1 October and replaced by 1.2.1 that day: below the floor.
      agreementId: await signWith("Superseded Gate Clinic", supersededEmail, {
        version: "1.2.0",
        platform: "none",
      }),
    });
    const replacedEmail = "replaced@gate.test";
    const replaced = validRequest({
      clinicName: "Replaced Gate Clinic",
      contactEmail: replacedEmail,
      // 1.2.1, released on 1 October and replaced by 1.2.2 on 9 October before
      // any clinic signed it: below the floor 1.2.2 raised.
      agreementId: await signWith("Replaced Gate Clinic", replacedEmail, {
        version: "1.2.1",
        platform: "none",
      }),
    });
    const outrightEmail = "outright@gate.test";
    const outright = validRequest({
      clinicName: "Outright Gate Clinic",
      contactEmail: outrightEmail,
      // 1.2.2, released on 9 October and replaced outright by 1.3.0 on 12
      // October before any clinic signed it: below the floor 1.3.0 raised.
      agreementId: await signWith("Outright Gate Clinic", outrightEmail, {
        version: "1.2.2",
        platform: "none",
      }),
    });
    const transcriptEmail = "transcripts@gate.test";
    const transcripts = validRequest({
      clinicName: "Transcript Gate Clinic",
      contactEmail: transcriptEmail,
      platform: "calcom",
      // 1.3.0, released on 12 October and replaced outright by 1.4.0 on 13
      // October before any clinic signed it, since it describes a stored
      // transcript: below the floor 1.4.0 raised, calendar terms and all.
      agreementId: await signWith("Transcript Gate Clinic", transcriptEmail, {
        version: "1.3.0",
        bookingSystem: "calcom",
        calendarAccount: "workspace_baa",
      }),
    });

    for (const [request, version] of [
      [draft, "1.1.0-draft"],
      [superseded, "1.2.0"],
      [replaced, "1.2.1"],
      [outright, "1.2.2"],
      [transcripts, "1.3.0"],
    ] as const) {
      // A refusal, not a 500: the row never changes, so a retry would only
      // meet it again, and a paid purchase belongs with ops.
      await expect(provisionClinic(request), version).rejects.toMatchObject({
        name: "ProvisioningError",
        field: "agreementId",
        message: expect.stringContaining(
          `Version ${version} of the business associate agreement can't be used`,
        ),
      });
      // Nothing written: no clinic, no claim on the key, the signature unbound.
      expect(await written(request), version).toEqual({ clinics: 0, claims: 0, bound: false });
    }

    // The version's own standing is all the gate asks: 1.4.0, released,
    // current and the floor since 13 October 2026, provisions, with its
    // calendar terms.
    const releasedEmail = "released@gate.test";
    const released = validRequest({
      clinicName: "Released Gate Clinic",
      contactEmail: releasedEmail,
      agreementId: await signWith("Released Gate Clinic", releasedEmail, {
        bookingSystem: "google_calendar",
        calendarAccount: "workspace_baa",
      }),
    });
    const first = await provisionClinic(released);
    expect(first.replayed).toBe(false);
    expect(await written(released)).toEqual({ clinics: 1, claims: 1, bound: true });
    expect(await electionRowsOf(first.clinicId)).toHaveLength(1);

    // The gate judges an account about to be made, never one that exists.
    // Once the version falls below the floor (a later release raising
    // MIN_ACCEPTABLE_BAA_VERSION, or a rollback), Stripe's redelivery of the
    // same purchase still replays, rather than meeting a 422 and a
    // provisioning_rejected alert for a clinic that is already there.
    floor.withdrawn = [CURRENT_BAA_VERSION];
    expect(await provisionClinic(released)).toEqual({
      organizationId: first.organizationId,
      clinicId: first.clinicId,
      clinicSlug: first.clinicSlug,
      replayed: true,
    });
    expect(await written(released)).toEqual({ clinics: 1, claims: 1, bound: true });
    expect(await electionRowsOf(first.clinicId)).toHaveLength(1);
  });

  test("where bookings live is the signed agreement's: a purchase naming another platform is provisioned as signed, and recorded", async () => {
    // Signed naming Mindbody, bought naming no booking software. Not refused,
    // because a refusal here comes after payment: the clinic is what was
    // signed, and the difference is a security event, with nothing about
    // anyone in it.
    // Each signature here is 1.2.2's by name, not whatever is current, so the
    // cases keep testing a document before 1.3.0 after the release moves
    // 1.3.0 to BAA_TEMPLATES[0]. 1.2.2 is below the floor since that release
    // (the approval gate test refuses it), so the floor stands as it did
    // before it for these cases; a 1.3.0 signature's own case is the next
    // test's "One Way Clinic".
    floor.restored = ["1.2.2"];
    const email = "mismatch@platform.test";
    const agreementId = await signWith("Mismatch Clinic", email, {
      version: "1.2.2",
      platform: "mindbody",
    });
    const mismatched = await provisionClinic(
      validRequest({
        clinicName: "Mismatch Clinic",
        contactEmail: email,
        agreementId,
        platform: "none",
      }),
      { ipAddress: "203.0.113.9", userAgent: "synthetic-relay" },
    );
    expect(await bookingProviderOf(mismatched.clinicId)).toBe("mindbody");
    expect(await mismatchEventsOf(mismatched.organizationId)).toEqual([
      {
        actor_label: "provisioning",
        ip_address: "203.0.113.9",
        metadata: {
          clinicId: mismatched.clinicId,
          clinicSlug: mismatched.clinicSlug,
          agreementId,
          purchasePlatform: "none",
          signedPlatform: "mindbody",
          bookingProvider: "mindbody",
        },
      },
    ]);

    // The booking system the funnel signs with beside the platform is the
    // finer answer (Google Calendar alone names no platform), and a purchase
    // that matches records nothing. 1.2.2 reads neither calendar answer, so
    // it gives the location no calendar terms either: it waits for an
    // election (plan §2.8).
    const funnelEmail = "funnel@platform.test";
    const funnel = await provisionClinic(
      validRequest({
        clinicName: "Funnel Clinic",
        contactEmail: funnelEmail,
        agreementId: await signWith("Funnel Clinic", funnelEmail, {
          version: "1.2.2",
          platform: "none",
          bookingSystem: "google_calendar",
          calendarAccount: "workspace_baa",
        }),
      }),
    );
    expect(await bookingProviderOf(funnel.clinicId)).toBe("google_calendar");
    expect(await mismatchEventsOf(funnel.organizationId)).toEqual([]);
    expect(await electionRowsOf(funnel.clinicId)).toEqual([]);

    // Kept beside a platform that is not its own, the answer gives way to
    // the document, which names the platform.
    const splitEmail = "split@platform.test";
    const split = await provisionClinic(
      validRequest({
        clinicName: "Split Clinic",
        contactEmail: splitEmail,
        platform: "mindbody",
        agreementId: await signWith("Split Clinic", splitEmail, {
          version: "1.2.2",
          platform: "mindbody",
          bookingSystem: "calcom",
        }),
      }),
    );
    expect(await bookingProviderOf(split.clinicId)).toBe("mindbody");
    expect(await mismatchEventsOf(split.organizationId)).toEqual([]);
  });

  test("a signature from 1.3.0 on gives the location it sets up its first calendar terms: the agreement row, sequence 1, as signed", async () => {
    // Signed as whatever is current: 1.4.0 since 13 October 2026, which
    // carries 1.3.0's calendar clauses under the same ids.
    const email = "terms@calendar.test";
    const agreementId = await signWith("Covered Terms Clinic", email, {
      bookingSystem: "calcom",
      calendarAccount: "workspace_baa",
    });
    const request = validRequest({
      clinicName: "Covered Terms Clinic",
      contactEmail: email,
      agreementId,
      platform: "calcom",
    });
    const result = await provisionClinic(request);

    const { rows: acceptance } = await getMigratorPool().query<{ document_hash: string }>(
      `select document_hash from baa_acceptances where id = $1`,
      [agreementId],
    );
    expect(await electionRowsOf(result.clinicId)).toEqual([
      {
        sequence: 1,
        source: "agreement",
        agreement_id: agreementId,
        terms_kind: "covered",
        clause_id: "google-calendar-covered",
        calendar_account: "workspace_baa",
        booking_sync: "live",
        booking_system: "calcom",
        document_version: CURRENT_BAA_VERSION,
        document_hash: acceptance[0]!.document_hash,
        document_released: true,
        owner_confirmed: false,
        rendered_text: null,
        elected_by_label: "Alex Chen, Owner",
        link_id: null,
        elected_by_user_id: null,
      },
    ]);
    expect(await bookingProviderOf(result.clinicId)).toBe("calcom");
    expect(await mismatchEventsOf(result.organizationId)).toEqual([]);
    // Audited in provisioning's own transaction, as provisioning.
    const audited = await inClinicTenant(result.clinicId, (client) =>
      client.query<{ actor_service_name: string; metadata: Record<string, unknown> }>(
        `select actor_service_name, metadata from audit_log
          where clinic_id = $1 and resource_type = 'calendar_election'`,
        [result.clinicId],
      ),
    );
    expect(audited.rows).toEqual([
      {
        actor_service_name: "provisioning",
        metadata: { sequence: 1, source: "agreement", termsKind: "covered" },
      },
    ]);
    // A redelivery replays and records nothing more.
    expect((await provisionClinic(request)).replayed).toBe(true);
    expect(await electionRowsOf(result.clinicId)).toHaveLength(1);

    // Signed for a one-way system, bought naming no booking software: the
    // clinic is provisioned as signed, so its terms are the not-used clause
    // and its bookings requests, and the difference is recorded.
    const oneWayEmail = "oneway@calendar.test";
    const oneWay = await provisionClinic(
      validRequest({
        clinicName: "One Way Clinic",
        contactEmail: oneWayEmail,
        platform: "none",
        agreementId: await signWith("One Way Clinic", oneWayEmail, {
          bookingSystem: "mindbody",
          calendarAccount: "workspace_no_baa",
        }),
      }),
    );
    expect(await electionRowsOf(oneWay.clinicId)).toMatchObject([
      {
        sequence: 1,
        source: "agreement",
        terms_kind: "not_used",
        clause_id: "google-calendar-not-used",
        booking_sync: "manual",
        booking_system: "mindbody",
      },
    ]);
    expect(await bookingProviderOf(oneWay.clinicId)).toBe("mindbody");
    expect(await mismatchEventsOf(oneWay.organizationId)).toMatchObject([
      {
        metadata: {
          purchasePlatform: "none",
          signedPlatform: "mindbody",
          bookingProvider: "mindbody",
        },
      },
    ]);
  });

  test("a row from 1.3.0 on that does not hold the calendar terms it was signed with is refused before anything is written", async () => {
    // Not a row signing writes: its render guard needs both answers, and it
    // records the one clause they select, which is always a clause for the
    // account kind signed. Refused here rather than failing inside the
    // transaction, so a paid purchase reaches ops at once.
    const malformed: Record<string, unknown>[] = [
      // Covered is for a Workspace account with Google's BAA, never a personal one.
      {
        bookingSystem: "calcom",
        calendarAccount: "personal",
        appliedClauses: ["parties", "google-calendar-covered"],
      },
      // Uncovered is for any account but that one.
      {
        bookingSystem: "calcom",
        calendarAccount: "workspace_baa",
        appliedClauses: ["parties", "google-calendar-uncovered"],
      },
      // No account kind for the clause to be for.
      { bookingSystem: "calcom", appliedClauses: ["parties", "google-calendar-covered"] },
      // A booking system the v1 list does not hold.
      {
        bookingSystem: "zenoti",
        calendarAccount: "workspace_baa",
        appliedClauses: ["parties", "google-calendar-covered"],
      },
      // Two calendar clauses for one location.
      {
        bookingSystem: "calcom",
        calendarAccount: "workspace_baa",
        appliedClauses: ["google-calendar-covered", "google-calendar-not-used"],
      },
      // A sync stored beside the clause that the clause contradicts.
      {
        bookingSystem: "calcom",
        calendarAccount: "workspace_baa",
        bookingSync: "manual",
        appliedClauses: ["parties", "google-calendar-covered"],
      },
      // No calendar clause at all, which every document from 1.3.0 on applies.
      { bookingSystem: "calcom", calendarAccount: "workspace_baa", appliedClauses: ["parties"] },
    ];
    for (const variables of malformed) {
      const request = validRequest({
        clinicName: "Malformed Terms Clinic",
        contactEmail: "malformed@calendar.test",
        platform: "calcom",
        agreementId: await seedUnboundAcceptance(CURRENT_BAA_VERSION, {
          clinicLegalName: "Malformed Terms Clinic",
          isCoveredEntity: false,
          ...variables,
        }),
      });
      await expect(provisionClinic(request), JSON.stringify(variables)).rejects.toMatchObject({
        name: "ProvisioningError",
        field: "agreementId",
        message: expect.stringMatching(/does not record the calendar terms/),
      });
      expect(await written(request)).toEqual({ clinics: 0, claims: 0, bound: false });
    }
  });

  test("a booking system the catalogue reclassifies after signing leaves the location under the clause it signed", async () => {
    // Signed while Boulevard is unverified, so under the not-used clause, and
    // paid for after a vendor's confirmation moved it to "yes" (plan Q4).
    // The signed clause is what the location is under, and refusing it now
    // would leave a paid purchase with no account: it is recorded as signed,
    // manual and all, and the difference logged. Live booking takes an
    // election, which widens and so needs the owner.
    const email = "reclassified@calendar.test";
    const agreementId = await signWith("Reclassified Clinic", email, {
      bookingSystem: "boulevard",
      calendarAccount: "workspace_baa",
    });
    catalogue.readsGoogle = ["boulevard"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await provisionClinic(
        validRequest({
          clinicName: "Reclassified Clinic",
          contactEmail: email,
          agreementId,
          platform: "boulevard",
        }),
      );
      expect(await electionRowsOf(result.clinicId)).toMatchObject([
        {
          sequence: 1,
          source: "agreement",
          terms_kind: "not_used",
          clause_id: "google-calendar-not-used",
          calendar_account: "workspace_baa",
          booking_sync: "manual",
          booking_system: "boulevard",
          document_version: CURRENT_BAA_VERSION,
        },
      ]);
      expect(await bookingProviderOf(result.clinicId)).toBe("boulevard");
      expect(await mismatchEventsOf(result.organizationId)).toEqual([]);
      const logged = warn.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("calendar terms recorded as signed"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`"agreementId":"${agreementId}"`);
      expect(logged[0]).toContain(`"kind":"not_used"`);
      expect(logged[0]).toContain("the catalogue now selects covered");
    } finally {
      warn.mockRestore();
    }
  });
});

type Written = { clinics: number; claims: number; bound: boolean };

/** What a refused provision left: clinics of its name, claims on its key, and whether its agreement is bound. */
async function written(request: ProvisionRequest): Promise<Written> {
  const { rows } = await getMigratorPool().query<Written>(
    `select (select count(*) from clinics where name = $1)::int as clinics,
            (select count(*) from provisioning_attempts where idempotency_key = $2)::int as claims,
            (select organization_id is not null from baa_acceptances where id = $3) as bound`,
    [request.clinicName, request.idempotencyKey, request.agreementId],
  );
  return rows[0]!;
}

/** An unbound acceptance written as the migrator: for a row no signing path writes. */
async function seedUnboundAcceptance(
  version: string,
  variables: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, document_version, document_hash, rendered_text, variables, assent_label,
        accepted_by_name, accepted_by_email, accepted_at)
     values ($1, $2, $3, 'BAA (synthetic)', $4::jsonb, 'I agree', 'Alex Chen',
             'malformed@calendar.test', now())`,
    [id, version, randomBytes(32).toString("hex"), JSON.stringify(variables)],
  );
  return id;
}

/** clinics.booking_provider; clinics is not FORCEd, so the migrator reads it directly. */
async function bookingProviderOf(clinicId: string): Promise<string | null> {
  const { rows } = await getMigratorPool().query<{ booking_provider: string | null }>(
    `select booking_provider from clinics where id = $1`,
    [clinicId],
  );
  return rows[0]!.booking_provider;
}

type SecurityEvent = {
  actor_label: string;
  ip_address: string | null;
  metadata: Record<string, unknown>;
};

/** The provision_platform_mismatch events recorded against an organisation. */
async function mismatchEventsOf(organizationId: string): Promise<SecurityEvent[]> {
  const { rows } = await getMigratorPool().query<SecurityEvent>(
    `select actor_label, ip_address, metadata from security_events
      where organization_id = $1 and event = 'provision_platform_mismatch'
      order by occurred_at`,
    [organizationId],
  );
  return rows;
}

/** The location's calendar elections. calendar_elections is FORCEd, so read inside its tenant. */
async function electionRowsOf(clinicId: string): Promise<Record<string, unknown>[]> {
  const result = await inClinicTenant(clinicId, (client) =>
    client.query(
      `select sequence, source, agreement_id, terms_kind, clause_id, calendar_account, booking_sync,
              booking_system, document_version, document_hash, document_released, owner_confirmed,
              rendered_text, elected_by_label, link_id, elected_by_user_id
         from calendar_elections where clinic_id = $1 order by sequence`,
      [clinicId],
    ),
  );
  return result.rows;
}

/** entitlements is FORCEd, so even the migrator reads it inside a tenant. */
async function readEntitlements(clinicId: string): Promise<{
  status: string;
  plan_code: string;
  billing_interval: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  included_voice_minutes: number;
  included_chat_conversations: number;
  channels_enabled: { web: boolean; meta: boolean; voice: boolean };
  setup_fee_paid_usd: string;
}> {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const { rows } = await client.query(
      `select * from entitlements where clinic_id = $1`,
      [clinicId],
    );
    await client.query("rollback");
    expect(rows).toHaveLength(1);
    return rows[0];
  } finally {
    client.release();
  }
}

/** app_clinic_is_demo(), asked inside the clinic's tenant. */
async function isDemo(clinicId: string): Promise<boolean> {
  const result = await inClinicTenant(clinicId, (client) =>
    client.query<{ demo: boolean }>(`select app_clinic_is_demo($1) as demo`, [clinicId]),
  );
  return result.rows[0]!.demo;
}

/** One migrator transaction with the clinic's tenant declared. */
async function inClinicTenant<T>(
  clinicId: string,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getMigratorPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

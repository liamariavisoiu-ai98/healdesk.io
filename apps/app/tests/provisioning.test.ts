import { randomUUID } from "node:crypto";

import { CURRENT_BAA_VERSION, hashBaaText } from "@healdesk/catalog";
import { BAA_ASSENT_LABEL } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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

const describeDb = hasTestDatabase ? describe : describe.skip;

function validRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    clinicName: "Radiance Med Spa",
    specialty: "med-spa",
    platform: "none",
    attributionMode: "estimated",
    averageTreatmentValueUsd: 550,
    plan: "chat-voice",
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
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  return signed.agreementId;
}

describe("provision request validation", () => {
  test("accepts the default path: no platform, estimated attribution", () => {
    expect(() => validateProvisionRequest(validRequest())).not.toThrow();
  });

  test("requires an average treatment value for estimated attribution", () => {
    // It is the only input to the figures we report. Without it the first
    // monthly report would have nothing to say.
    expect(() =>
      validateProvisionRequest(
        validRequest({ averageTreatmentValueUsd: undefined }),
      ),
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
    // "radiology" rather than a plausible ICP: this fixture previously used
    // "veterinary", which was later added as a real specialty and turned a
    // rejection test into one that asserted nothing. Pick something the
    // catalogue will never carry.
    expect(() =>
      validateProvisionRequest(validRequest({ specialty: "radiology" })),
    ).toThrow(/specialty/i);
  });

  test("rejects a billing interval or chat choice the catalog does not sell", () => {
    expect(() =>
      validateProvisionRequest(
        validRequest({ billingInterval: "week" as never }),
      ),
    ).toThrow(/billing interval/i);
    expect(() =>
      validateProvisionRequest(
        validRequest({ chatChannelChoice: "sms" as never }),
      ),
    ).toThrow(/chat channel/i);
    expect(() =>
      validateProvisionRequest(validRequest({ stripeSubscriptionId: "" })),
    ).toThrow(/stripeSubscriptionId/);
    // Both optional: every caller that predates them still validates.
    expect(() =>
      validateProvisionRequest(
        validRequest({ billingInterval: "year", chatChannelChoice: "meta" }),
      ),
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
    expect(clinic.booking_provider).toBeNull();
    expect(clinic.average_treatment_value_usd).toBe("550.00");
    expect(clinic.plan).toBe("chat-voice");

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
  test("creates no invitation and no login for the buyer", async () => {
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

    // No user for the buyer, and none they could be invited to become.
    const { rows: users } = await getMigratorPool().query(
      `select id from "user" where email = $1`,
      ["invitee@example.test"],
    );
    expect(users).toHaveLength(0);

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
        plan: "chat-voice",
        billingInterval: "year",
        chatChannelChoice: "meta",
        stripeCustomerId: "cus_provisioned",
        stripeSubscriptionId: "sub_provisioned",
      }),
    );

    const row = await readEntitlements(result.clinicId);
    // A subscription to wait on: the first invoice.paid activates it.
    expect(row.status).toBe("provisioning");
    expect(row.plan_code).toBe("chat-voice");
    expect(row.billing_interval).toBe("year");
    expect(row.stripe_customer_id).toBe("cus_provisioned");
    expect(row.stripe_subscription_id).toBe("sub_provisioned");
    expect(row.included_voice_minutes).toBe(1_000);
    expect(row.included_chat_conversations).toBe(1_000);
    // "Web OR Meta + Voice", and the buyer chose Meta.
    expect(row.chat_channel_choice).toBe("meta");
    expect(row.channels_enabled).toEqual({ web: false, meta: true, voice: true });
    // Nothing paid yet; the first invoice sets this.
    expect(row.setup_fee_paid_usd).toBe("0.00");
  });

  test("the no-Stripe path starts active, with the package's own allowances", async () => {
    const result = await provisionClinic(
      validRequest({
        clinicName: "Dev Path Clinic",
        contactEmail: "dev@example.test",
        agreementId: await signFor("Dev Path Clinic", "dev@example.test"),
        plan: "chat-single",
      }),
    );

    const row = await readEntitlements(result.clinicId);
    // Nothing will ever arrive to activate it, so it starts there.
    expect(row.status).toBe("active");
    expect(row.plan_code).toBe("chat-single");
    expect(row.billing_interval).toBe("month");
    expect(row.stripe_customer_id).toBeNull();
    expect(row.stripe_subscription_id).toBeNull();
    expect(row.included_voice_minutes).toBe(0);
    expect(row.included_chat_conversations).toBe(1_000);
    // A choice package with no choice sent defaults to web.
    expect(row.chat_channel_choice).toBe("web");
    expect(row.channels_enabled).toEqual({ web: true, meta: false, voice: false });
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
});

/** entitlements is FORCEd, so even the migrator reads it inside a tenant. */
async function readEntitlements(clinicId: string): Promise<{
  status: string;
  plan_code: string;
  billing_interval: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  included_voice_minutes: number;
  included_chat_conversations: number;
  chat_channel_choice: string | null;
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

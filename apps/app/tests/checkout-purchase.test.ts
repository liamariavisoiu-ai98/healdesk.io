import { createHash, randomUUID } from "node:crypto";

import {
  agreementPlatformFor,
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  hashBaaText,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";
import { sealRecord, type AgreementRecord, type IntentRecord } from "@healdesk/catalog/checkout-record";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as postProvision } from "@/app/api/provision/route";
import { getAgreement, listCopyDeliveries, signAgreement } from "@/lib/agreements";
import { importCheckoutRecords } from "@/lib/checkout/import";
import { findIntent, markIntentFailed } from "@/lib/checkout/intents";
import { sendOrderConfirmedDelayed } from "@/lib/checkout/order-delayed";
import { welcomeState } from "@/lib/checkout/welcome";
import { setupDeadline } from "@/lib/clinic/setup-window";
import { runOperation, type Operator } from "@/lib/ops/api";
import { replyByDate } from "@/lib/reply-by";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { consumeSignInLink } from "@/lib/sign-in/links";

import { agreementRecord, intentRecord, nonce, records } from "./setup/checkout-records";
import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";

/**
 * The purchase, from Pay to signed in (plan Part A4, C1–C3), since
 * 14 October 2026 (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * apps/web records the signed agreement and the purchase as sealed records
 * in the marketing Sheet, so a buyer can sign and pay while this host is in
 * standby, and relays both with the first paid invoice. What must hold here:
 * the records are imported only if their seals open and the agreement
 * re-renders to its hash; the imported agreement keeps its own id and time;
 * the import is idempotent, so a retried event finds both rows and
 * continues; provisioning from the imported intent makes the clinic, its one
 * sign-in, its channels and its setup window, and spends the intent; and
 * /welcome hands the paying browser, and only that browser, one sign-in link.
 */

const SECRET = "checkout-purchase-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

const describeDb = hasTestDatabase ? describe : describe.skip;

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };

function signed(url: string, body: unknown): Request {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
    },
    body: raw,
  });
}

/** A signed agreement and one press of Pay for it, as apps/web records them. */
function purchase(
  options: {
    inviteRef?: string;
    attempt?: number;
    sessionId?: string;
    purchase?: Record<string, unknown>;
    /** The agreement's own answers, over the default med spa's. */
    signature?: Omit<Parameters<typeof agreementRecord>[0], "signatoryEmail">;
  } = {},
) {
  const email = `laura-${randomUUID().slice(0, 8)}@glowspa.test`;
  const agreement = agreementRecord(
    { signatoryEmail: email, ...options.signature },
    { acceptedAt: new Date(Date.now() - 3 * 60_000) },
  );
  const n = nonce();
  const intent = intentRecord(agreement, {
    attempt: options.attempt ?? 1,
    sessionId: options.sessionId ?? "cs_test_paid",
    nonceHash: n.hash,
    purchase: { ...(options.inviteRef ? { inviteRef: options.inviteRef } : {}), ...options.purchase },
  });
  return { email, agreement, intent, nonce: n };
}

/** The first invoice of `subscription`, paid, relayed as the webhook relays it: with the records and what was paid for. */
async function provision(
  p: { agreement: AgreementRecord; intent: IntentRecord },
  subscription: string,
  paid: { attempt?: unknown; plan?: unknown; billingInterval?: unknown } = {},
  relayed: Record<string, unknown> = { records: records(p.agreement, p.intent) },
) {
  const response = await postProvision(
    signed("http://app.test/api/provision", {
      ref: p.intent.ref,
      idempotencyKey: subscription,
      stripeCustomerId: "cus_test_1",
      stripeSubscriptionId: subscription,
      attempt: p.intent.attempt,
      plan: "voice-webchat-1000-1000",
      billingInterval: "month",
      ...paid,
      ...relayed,
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

const subscription = () => `sub_test_${randomUUID().slice(0, 8)}`;

describe("the setup window", () => {
  test("ends at the last instant of the 30th day after purchase, on the clinic's own calendar", () => {
    // 6 Oct in New York; 5 Nov falls after the clocks go back on 1 Nov.
    expect(setupDeadline(new Date("2026-10-06T15:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-11-06T04:59:59.999Z",
    );
    // 03:00 UTC is still 5 Oct in New York, so the window starts a day earlier.
    expect(setupDeadline(new Date("2026-10-06T03:00:00Z"), "America/New_York").toISOString()).toBe(
      "2026-11-05T04:59:59.999Z",
    );
    expect(setupDeadline(new Date("2026-10-06T10:00:00Z"), "Asia/Dubai").toISOString()).toBe(
      "2026-11-05T19:59:59.999Z",
    );
  });
});

describeDb("importing the checkout records", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the agreement keeps its own id, time, signer and document; the purchase its ref, press and nonce", async () => {
    const p = purchase({ inviteRef: randomUUID() });
    expect(await importCheckoutRecords(p.intent.ref, records(p.agreement, p.intent))).toEqual({
      ok: true,
      intent: "imported",
      agreement: "imported",
    });

    const pool = getMigratorPool();
    const { rows: rows } = await pool.query(
      `select id, accepted_at, document_version, document_hash, rendered_text, variables, assent_label,
              accepted_by_name, accepted_by_email, accepted_by_title, ip_address, user_agent,
              organization_id, copy_sent_at
         from baa_acceptances`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(p.agreement.id);
    expect((row.accepted_at as Date).toISOString()).toBe(p.agreement.acceptedAt);
    expect(row).toMatchObject({
      document_version: p.agreement.documentVersion,
      document_hash: p.agreement.documentHash,
      assent_label: p.agreement.assentLabel,
      accepted_by_name: "Laura Owner",
      accepted_by_email: p.email,
      accepted_by_title: "Owner",
      ip_address: "203.0.113.4",
      user_agent: "Mozilla/5.0 (vitest)",
      organization_id: null,
      copy_sent_at: null,
    });
    // The text was rendered here again, and is the document that was signed.
    expect(hashBaaText(row.rendered_text as string)).toBe(p.agreement.documentHash);
    expect(row.variables).toMatchObject({
      clinicLegalName: "Glow Med Spa LLC",
      appliedClauses: p.agreement.appliedClauses,
      displayedHashVerified: false,
      bookingSystem: "none",
      calendarAccount: "workspace_no_baa",
    });

    // The signature's own event, carrying the instant it was made.
    const { rows: events } = await pool.query(
      `select actor_label, ip_address, metadata from security_events where event = 'baa_accepted'`,
    );
    expect(events).toEqual([
      {
        actor_label: p.email,
        ip_address: "203.0.113.4",
        metadata: expect.objectContaining({
          agreementId: p.agreement.id,
          hash: p.agreement.documentHash,
          acceptedAtEpochMs: new Date(p.agreement.acceptedAt).getTime(),
          recordedBy: "apps/web",
        }),
      },
    ]);

    const intent = (await findIntent(p.intent.ref))!;
    expect(intent).toMatchObject({
      ref: p.intent.ref,
      attempt: 1,
      agreementId: p.agreement.id,
      contactEmail: p.email,
      plan: "voice-webchat-1000-1000",
      openSessionId: "cs_test_paid",
      inviteRef: p.intent.ref,
      consumedAt: null,
    });
    expect(intent.nonceHash!.toString("hex")).toBe(p.nonce.hash);
    expect(intent.createdAt.toISOString()).toBe(p.intent.createdAt);
    expect(intent.payload).toMatchObject({ terms: { version: "2026-10-14.1" }, timezone: "America/New_York" });

    // Again, as a retried event: both rows are found, nothing is written twice.
    expect(await importCheckoutRecords(p.intent.ref, records(p.agreement, p.intent))).toEqual({
      ok: true,
      intent: "present",
      agreement: "present",
    });
    expect((await pool.query(`select 1 from baa_acceptances`)).rows).toHaveLength(1);
    expect((await pool.query(`select 1 from security_events where event = 'baa_accepted'`)).rows).toHaveLength(1);
  });

  test("the copy's evidence is imported once, and the first delivery is findable", async () => {
    const p = purchase();
    const sentAt = new Date(new Date(p.agreement.acceptedAt).getTime() + 4_000).toISOString();
    const withCopy = { ...p.agreement, copy: { sentAt, pdfSha256: "b".repeat(64) } };
    expect(await importCheckoutRecords(p.intent.ref, records(withCopy, p.intent))).toMatchObject({ ok: true });
    const { rows } = await getMigratorPool().query(
      `select copy_sent_at, copy_document_sha256 from baa_acceptances where id = $1`,
      [p.agreement.id],
    );
    expect((rows[0]!.copy_sent_at as Date).toISOString()).toBe(sentAt);
    expect(rows[0]!.copy_document_sha256).toBe("b".repeat(64));
    const deliveries = await listCopyDeliveries(p.agreement.id);
    expect(deliveries).toEqual([
      { deliveredAt: expect.any(Date), sha256: "b".repeat(64), firstCopy: true, trigger: "signature" },
    ]);
  });

  test("a seal that does not match is refused: the purchase's reaches only ops, the agreement's marks the purchase failed", async () => {
    const p = purchase();
    const edited = { ...records(p.agreement, p.intent) };
    edited.intent = { ...edited.intent, json: edited.intent.json.replace("Laura Owner", "Laura Other") };
    expect(await importCheckoutRecords(p.intent.ref, edited)).toMatchObject({ ok: false, reach: "ops", field: "records" });
    expect(await findIntent(p.intent.ref)).toBeNull();

    // Sealed by someone who does not hold the secret.
    const forged = { intent: sealRecord(p.intent, "a-guess"), agreement: sealRecord(p.agreement, "a-guess") };
    expect(await importCheckoutRecords(p.intent.ref, forged)).toMatchObject({ ok: false, reach: "ops" });

    const agreementEdited = records(p.agreement, p.intent);
    agreementEdited.agreement = {
      ...agreementEdited.agreement,
      json: agreementEdited.agreement.json.replace("Glow Med Spa LLC", "Glow Med Spa Inc"),
    };
    expect(await importCheckoutRecords(p.intent.ref, agreementEdited)).toMatchObject({
      ok: false,
      reach: "intent",
      field: "agreementId",
    });
    // The purchase is ours, so it is here to be marked failed; the agreement is not.
    expect(await findIntent(p.intent.ref)).not.toBeNull();
    expect((await getMigratorPool().query(`select 1 from baa_acceptances`)).rows).toHaveLength(0);
  });

  test("a document that no longer renders to its hash is refused, even under a good seal", async () => {
    const p = purchase();
    // Sealed with the real secret, so only the re-render can catch it.
    const renamed = {
      ...p.agreement,
      variables: { ...p.agreement.variables, clinicLegalName: "Glow Med Spa Inc" },
    };
    expect(await importCheckoutRecords(p.intent.ref, records(renamed, p.intent))).toMatchObject({
      ok: false,
      reach: "intent",
      field: "agreementId",
      message: expect.stringMatching(/hash_mismatch/),
    });
    expect((await getMigratorPool().query(`select 1 from baa_acceptances`)).rows).toHaveLength(0);
  });

  test("a purchase the agreement does not describe is refused by the field, as before payment", async () => {
    const other = purchase({ purchase: { clinicName: "Other Spa LLC" } });
    expect(await importCheckoutRecords(other.intent.ref, records(other.agreement, other.intent))).toMatchObject({
      ok: false,
      reach: "intent",
      field: "agreementId",
      message: expect.stringMatching(/sign it again/),
    });
    const elsewhere = purchase({ purchase: { contactEmail: "someone@else.test" } });
    expect(
      await importCheckoutRecords(elsewhere.intent.ref, records(elsewhere.agreement, elsewhere.intent)),
    ).toMatchObject({ ok: false, field: "contactEmail" });
  });
});

describeDb("provisioning from the imported records, and /welcome", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("makes the clinic, its one sign-in, its channels and its setup window, and spends the intent", async () => {
    const p = purchase({ inviteRef: randomUUID() });
    const sub = subscription();
    const first = await provision(p, sub);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ replayed: false, plan: "voice-webchat-1000-1000", billingInterval: "month" });
    const clinicId = first.json.clinicId as string;

    const pool = getMigratorPool();
    const { rows: intents } = await pool.query(
      `select consumed_at, stripe_subscription_id, provisioned_clinic_id, provisioned_user_id from checkout_intents where ref = $1`,
      [p.intent.ref],
    );
    expect(intents[0]).toMatchObject({ stripe_subscription_id: sub, provisioned_clinic_id: clinicId });
    expect(intents[0]!.consumed_at).toBeInstanceOf(Date);

    // The imported agreement is the one bound, under its own id.
    const bound = (await getAgreement(p.agreement.id))!;
    expect(bound.organizationId).toBe(first.json.organizationId);
    expect(bound.acceptedAt.toISOString()).toBe(p.agreement.acceptedAt);

    const ownerId = intents[0]!.provisioned_user_id as string;
    const { rows: users } = await pool.query(`select email from "user" where id = $1`, [ownerId]);
    expect(users[0]!.email).toBe(p.email);
    const { rows: grants } = await pool.query(`select slug, role from app_user_clinic_grants($1)`, [ownerId]);
    expect(grants).toEqual([{ slug: first.json.clinicSlug, role: "owner" }]);

    const { channels, entitled } = await inTenant(clinicId, async (client) => ({
      channels: (await client.query<{ channel: string }>(`select channel from clinic_channels order by channel`)).rows,
      entitled: (
        await client.query<{ bought_plan_id: string; setup_deadline_at: Date }>(
          `select bought_plan_id, setup_deadline_at from entitlements`,
        )
      ).rows,
    }));
    expect(channels.map((r) => r.channel)).toEqual(["voice", "web"]);
    expect(entitled[0]!.bought_plan_id).toBe("voice-webchat-1000-1000");
    const daysOut = (new Date(entitled[0]!.setup_deadline_at).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(32);

    // Stripe redelivers: the same subscription is a replay, the records
    // found and continued past; another subscription is refused.
    expect((await provision(p, sub)).json.replayed).toBe(true);
    expect((await provision(p, subscription())).status).toBe(409);
    // A relay that carries no records still finds the purchase it imported.
    expect((await provision(p, sub, {}, {})).json.replayed).toBe(true);
  });

  // One purchase per test: the relay below names one Stripe customer, and a
  // second account for it would be a replay of the first.
  test.each([
    [
      "veterinary",
      { kind: "dpa", specialty: "veterinary", clinicLegalName: "Golden Paws Veterinary LLC", isCoveredEntity: false },
      { specialty: "veterinary" },
      "non-hipaa",
    ],
    ["no", { kind: "dpa", isCoveredEntity: false }, {}, "hipaa-if-covered"],
  ] as const)(
    "since the DPA's release, a %s practice's Data Protection Agreement provisions its account, bound to the current DPA (dpa/1.1.0 since 30 October 2026)",
    async (label, signature, purchaseFields, regime) => {
      const p = purchase({ signature, purchase: purchaseFields });
      expect(p.agreement.documentVersion, label).toBe("dpa/1.1.0");
      const response = await provision(p, subscription());
      expect(response.status, `${label}: ${JSON.stringify(response.json)}`).toBe(201);
      expect(response.json.replayed).toBe(false);
      const clinicId = response.json.clinicId as string;
      const bound = (await getAgreement(p.agreement.id))!;
      expect(bound.organizationId, label).toBe(response.json.organizationId);
      const { rows } = await getMigratorPool().query<{
        regulatory_regime: string;
        agreement_kind: string;
        is_covered_entity: boolean | null;
      }>(`select regulatory_regime, agreement_kind, is_covered_entity from clinics where id = $1`, [clinicId]);
      expect(rows[0], label).toEqual({
        regulatory_regime: regime,
        agreement_kind: "dpa",
        is_covered_entity: false,
      });
    },
  );

  test("a payment provisions only while the purchase names the press of Pay and the terms paid", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const p = purchase({ attempt: 2 });
      // A payment for another press of Pay than the one recorded.
      const stale = await provision(p, subscription(), { attempt: 1 });
      expect(stale.status).toBe(422);
      expect(stale.json.field).toBe("attempt");
      expect(errors.some((line) => line.includes("provisioning_rejected") && line.includes('"field":"attempt"'))).toBe(
        true,
      );
      const refused = (await findIntent(p.intent.ref))!;
      expect(refused.consumedAt).toBeNull();
      expect(refused.provisionFailedAt).toBeInstanceOf(Date);

      // Terms that are not the purchase's, and terms that are missing, are refused the same way.
      expect((await provision(p, subscription(), { plan: "voice-metachat-1000-1000" })).json.field).toBe("plan");
      expect((await provision(p, subscription(), { billingInterval: "year" })).json.field).toBe("billingInterval");
      expect((await provision(p, subscription(), { attempt: null, plan: null, billingInterval: null })).json.field).toBe(
        "attempt",
      );
      expect((await getMigratorPool().query(`select 1 from clinics`)).rows).toHaveLength(0);

      // The press that was paid, as paid, makes the account from its own terms.
      const current = await provision(p, subscription());
      expect(current.status).toBe(201);
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });

  test("a seal or a hash that does not match refuses the paid purchase: 422, ops told, nothing made", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const p = purchase();
      const relayed = records(p.agreement, p.intent);
      relayed.agreement = { ...relayed.agreement, seal: sealRecord(p.agreement, "a-guess").seal };
      const refused = await provision(p, subscription(), {}, { records: relayed });
      expect(refused.status).toBe(422);
      expect(refused.json.field).toBe("agreementId");
      expect(errors.some((line) => line.includes("provisioning_rejected"))).toBe(true);
      expect((await findIntent(p.intent.ref))!.provisionFailedAt).toBeInstanceOf(Date);
      expect((await getMigratorPool().query(`select 1 from clinics`)).rows).toHaveLength(0);

      const q = purchase();
      const edited = records(q.agreement, q.intent);
      edited.intent = { ...edited.intent, json: edited.intent.json.replace("glowspa.test", "evilspa.test") };
      const unopened = await provision(q, subscription(), {}, { records: edited });
      expect(unopened.status).toBe(422);
      expect(unopened.json.field).toBe("records");
      expect(await findIntent(q.intent.ref)).toBeNull();
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });

  test("a second subscription for a purchase already set up, and a purchase nobody holds, both reach ops", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const p = purchase();
      const first = await provision(p, subscription());
      expect(first.status).toBe(201);

      const second = await provision(p, subscription());
      expect(second.status).toBe(409);
      const duplicate = errors.find((line) => line.includes("ops alert") && line.includes("duplicate_subscription"));
      expect(duplicate).toBeDefined();
      expect(duplicate).toContain(first.json.clinicId as string);
      // The account the first subscription made still stands: never marked failed.
      expect((await findIntent(p.intent.ref))!.provisionFailedAt).toBeNull();

      // Another purchase paid by the same Stripe customer: the clinic it
      // already has is the answer (plan C1), a 200 replay that makes nothing
      // and sends no welcome, and ops hears of the second subscription.
      const again = purchase();
      const sameCustomer = await provision(again, subscription());
      expect(sameCustomer.status).toBe(200);
      expect(sameCustomer.json).toMatchObject({ replayed: true, clinicId: first.json.clinicId });
      expect((await getMigratorPool().query(`select 1 from clinics`)).rows).toHaveLength(1);
      expect(
        errors.some(
          (line) =>
            line.includes("ops alert") &&
            line.includes("duplicate_subscription") &&
            line.includes('"source":"customer"') &&
            line.includes(first.json.clinicId as string),
        ),
      ).toBe(true);

      // No records, and nothing imported before: unknown.
      const nobody = purchase();
      const unknown = await provision(nobody, subscription(), {}, {});
      expect(unknown.status).toBe(422);
      expect(
        errors.some((line) => line.includes("ops alert") && line.includes("provisioning_rejected") && line.includes('"field":"ref"')),
      ).toBe(true);
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });

  test("a body with no purchase reference is refused, however complete: 422, ops told, nothing made", async () => {
    // The whole purchase as the request, the shape the development path and
    // the callers from before intents sent: with a real signed agreement it
    // used to make an account no paid purchase stood behind (plan C1: no
    // legacy branch).
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const email = `legacy-${randomUUID().slice(0, 8)}@glowspa.test`;
      // A "No" that signed the BAA before the DPA's release (20 October 2026).
      const signedAgreement = await signAgreement(
        {
          clinicLegalName: "Legacy Med Spa LLC",
          specialty: "med-spa",
          signatoryName: "Laura Owner",
          signatoryEmail: email,
          isCoveredEntity: false,
          attributionMode: "estimated",
          platform: agreementPlatformFor("none"),
          bookingSystem: "none",
          calendarAccount: "workspace_no_baa",
          assentLabel: BAA_ASSENT_LABEL,
          templateVersion: CURRENT_BAA_VERSION,
        },
        {},
        { dpaReleased: false },
      );
      const key = subscription();
      const response = await postProvision(
        signed("http://app.test/api/provision", {
          clinicName: "Legacy Med Spa LLC",
          specialty: "med-spa",
          platform: agreementPlatformFor("none"),
          plan: "voice-webchat-1000-1000",
          contactName: "Laura Owner",
          contactEmail: email,
          agreementId: signedAgreement.agreementId,
          idempotencyKey: key,
          stripeCustomerId: `cus_legacy_${randomUUID().slice(0, 8)}`,
          stripeSubscriptionId: key,
        }),
      );
      expect(response.status).toBe(422);
      expect(((await response.json()) as { field?: string }).field).toBe("ref");
      expect(
        errors.some(
          (line) => line.includes("provisioning_rejected") && line.includes('"field":"ref"') && line.includes('"source":"request"'),
        ),
      ).toBe(true);
      const pool = getMigratorPool();
      expect((await pool.query(`select 1 from clinics`)).rows).toHaveLength(0);
      expect(
        (await pool.query(`select 1 from provisioning_attempts where idempotency_key = $1`, [key])).rows,
      ).toHaveLength(0);
      expect((await getAgreement(signedAgreement.agreementId))!.organizationId).toBeNull();
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });

  test("a funnel purchase confirms no call routing and no phone line: the wizard asks both", async () => {
    const p = purchase();
    const provisioned = await provision(p, subscription());
    expect(provisioned.status).toBe(201);
    const { rows: stored } = await getMigratorPool().query(`select payload from checkout_intents where ref = $1`, [
      p.intent.ref,
    ]);
    expect(stored[0]!.payload).not.toHaveProperty("callRouting");
    expect(stored[0]!.payload).not.toHaveProperty("phoneSystemType");
    const [clinic] = await inTenant(provisioned.json.clinicId as string, async (client) => {
      const { rows } = await client.query<{
        call_routing: string;
        call_routing_confirmed_at: Date | null;
        phone_system_type: string;
        onboarding: Record<string, string | null>;
      }>(`select call_routing, call_routing_confirmed_at, phone_system_type, onboarding from clinics`);
      return rows;
    });
    expect(clinic).toMatchObject({
      call_routing: "conditional",
      call_routing_confirmed_at: null,
      phone_system_type: "unknown",
    });
    expect(clinic!.onboarding.call_routing_chosen).toBeNull();
    expect(clinic!.onboarding.phone_type_confirmed).toBeNull();
  });

  test("/welcome gives the paying browser one sign-in link, and nobody else anything", async () => {
    const p = purchase({ sessionId: "cs_test_paid" });
    const asPayer = { ref: p.intent.ref, sessionId: "cs_test_paid", nonce: p.nonce.value };
    // Before the first invoice brings the purchase here, there is nothing to say.
    expect(await welcomeState(asPayer)).toEqual({ status: "unknown" });
    expect(await runOperation("welcomeHandoff", { ref: p.intent.ref, sessionId: "cs_test_paid" }, OPERATOR)).toEqual({
      status: 200,
      body: { data: { ready: false } },
    });

    await importCheckoutRecords(p.intent.ref, records(p.agreement, p.intent));
    expect(await welcomeState({ ...asPayer, nonce: null })).toEqual({ status: "unknown" });
    expect(await welcomeState({ ...asPayer, nonce: "someone-elses" })).toEqual({ status: "unknown" });
    expect(await welcomeState({ ...asPayer, sessionId: "cs_test_other" })).toEqual({ status: "unknown" });
    expect(await welcomeState(asPayer)).toMatchObject({ status: "pending" });
    // Imported but not provisioned: apps/web's page keeps waiting.
    expect((await runOperation("welcomeHandoff", { ref: p.intent.ref, sessionId: "cs_test_paid" }, OPERATOR)).body).toEqual({
      data: { ready: false },
    });

    await provision(p, subscription());
    // apps/web's /welcome is told where to send the browser: this app's own
    // /welcome, on its public origin, for this purchase and Session only.
    expect((await runOperation("welcomeHandoff", { ref: p.intent.ref, sessionId: "cs_test_paid" }, OPERATOR)).body).toEqual({
      data: { ready: true, url: `http://localhost:3001/welcome?h=${p.intent.ref}&cs=cs_test_paid` },
    });
    expect((await runOperation("welcomeHandoff", { ref: p.intent.ref, sessionId: "cs_test_other" }, OPERATOR)).body).toEqual({
      data: { ready: false },
    });
    expect((await runOperation("welcomeHandoff", { ref: "nope", sessionId: "cs_test_paid" }, OPERATOR)).status).toBe(400);

    const ready = await welcomeState(asPayer);
    expect(ready.status).toBe("ready");
    const token = (ready as { url: string }).url.split("/link/")[1]!;
    const consumed = await consumeSignInLink(token, null);
    expect(consumed).toMatchObject({ ok: true, purpose: "checkout" });
    expect((consumed as { redirectTo: string }).redirectTo).toMatch(
      /^\/c\/([a-z0-9-]+)\/protect\?next=%2Fc%2F\1%2Fsetup$/,
    );

    // Polled again (a reload, a second tab): the link was already handed out.
    expect(await welcomeState(asPayer)).toMatchObject({ status: "use_email" });
  });

  test("a paid purchase provisioning refuses says so on /welcome and tells ops", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const p = purchase({ sessionId: "cs_test_x" });
    // Imported by an earlier delivery; then another purchase binds the agreement first.
    await importCheckoutRecords(p.intent.ref, records(p.agreement, p.intent));
    await getMigratorPool().query(
      `insert into organization (id, name, slug, created_at) values ('org_other', 'Other', 'other-org', now())`,
    );
    await getMigratorPool().query(`select app_bind_agreement($1::uuid, 'org_other')`, [p.agreement.id]);

    const refused = await provision(p, subscription());
    expect(refused.status).toBe(422);
    expect(await welcomeState({ ref: p.intent.ref, sessionId: "cs_test_x", nonce: p.nonce.value })).toMatchObject({
      status: "failed",
    });
    expect((await runOperation("welcomeHandoff", { ref: p.intent.ref, sessionId: "cs_test_x" }, OPERATOR)).body).toEqual({
      data: { ready: true, url: `http://localhost:3001/welcome?h=${p.intent.ref}&cs=cs_test_x` },
    });
    expect(errors.some((line) => line.includes("provisioning_rejected"))).toBe(true);
    spy.mockRestore();
  });

  test("the buyer of a refused purchase is written to once, with the order's terms (B3)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = purchase();
    await importCheckoutRecords(p.intent.ref, records(p.agreement, p.intent));
    await getMigratorPool().query(
      `insert into organization (id, name, slug, created_at) values ('org_other_b3', 'Other', 'other-b3-org', now())`,
    );
    await getMigratorPool().query(`select app_bind_agreement($1::uuid, 'org_other_b3')`, [p.agreement.id]);

    // Refused twice (a replay of the purchase): the mark, and so the email,
    // belong to the first refusal only.
    expect((await provision(p, subscription())).status).toBe(422);
    const firstMark = (await findIntent(p.intent.ref))!.provisionFailedAt;
    expect(firstMark).toBeInstanceOf(Date);
    expect((await provision(p, subscription())).status).toBe(422);
    expect((await findIntent(p.intent.ref))!.provisionFailedAt).toEqual(firstMark);
    expect(await markIntentFailed(p.intent.ref)).toBeNull();

    const sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
    const transport: EmailTransport = {
      name: "fake",
      send: async (target, message) => {
        sent.push({ target, message });
        return { status: "sent", messageId: "msg_b3" };
      },
    };
    expect(await sendOrderConfirmedDelayed((await findIntent(p.intent.ref))!, { transport })).toBe("sent");

    const [{ target, message }] = sent as [{ target: DeliveryTarget; message: OutgoingEmail }];
    expect(target.to).toBe(p.email);
    expect(message.subject).toBe("Your healdesk order is confirmed: one step on our side");
    expect(message.text).toContain(`We'll email your sign-in link to this address by ${replyByDate(firstMark!)}.`);
    expect(message.text).toContain("Monthly billing ($1,200) starts the day AYA first answers a patient.");
    expect(message.text).toContain("The setup fee is non-refundable.");
    // Keyed by a digest of the ref, which opens /welcome: never the ref itself.
    const digest = createHash("sha256").update(p.intent.ref).digest("hex");
    expect(message.idempotencyKey).toBe(`hd-order_confirmed_delayed-${digest}-1`);
    expect(JSON.stringify(message)).not.toContain(p.intent.ref);
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "order_confirmed_delayed" },
      { name: "delivery", value: digest },
    ]);
  });
});

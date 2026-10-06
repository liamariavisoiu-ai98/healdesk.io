import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BAA_ASSENT_LABEL,
  CURRENT_BAA_VERSION,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { POST as postIntent } from "@/app/api/checkout/intents/route";
import { POST as postIntentSession } from "@/app/api/checkout/intents/session/route";
import { POST as postProvision } from "@/app/api/provision/route";
import { signAgreement } from "@/lib/agreements";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { findIntent, markIntentFailed } from "@/lib/checkout/intents";
import { sendOrderConfirmedDelayed } from "@/lib/checkout/order-delayed";
import { welcomeState } from "@/lib/checkout/welcome";
import { setupDeadline } from "@/lib/clinic/setup-window";
import { replyByDate } from "@/lib/reply-by";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { consumeSignInLink } from "@/lib/sign-in/links";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

/**
 * The purchase, from Pay to signed in (plan Part A4, C1–C3).
 *
 * apps/web hands the purchase to apps/app before Stripe sees it (an intent),
 * and provisions from that intent once the first invoice is paid. What must
 * hold: everything provisioning checks is checked before payment; one setup
 * link makes one intent, which a retried payment reuses; provisioning from
 * an intent makes the clinic, its one sign-in, its channels and its setup
 * window, and spends the intent; and /welcome hands the paying browser, and
 * only that browser, one sign-in link.
 */

const SECRET = "checkout-purchase-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

const describeDb = hasTestDatabase ? describe : describe.skip;

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

async function agreementFor(email: string): Promise<string> {
  const result = await signAgreement({
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    signatoryName: "Laura Owner",
    signatoryTitle: "Owner",
    signatoryEmail: email,
    isCoveredEntity: false,
    attributionMode: "estimated",
    platform: "none",
    assentLabel: BAA_ASSENT_LABEL,
    templateVersion: CURRENT_BAA_VERSION,
  });
  return result.agreementId;
}

function nonce(): { value: string; hash: string } {
  const value = randomBytes(24).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}

async function purchase(overrides: Record<string, unknown> = {}) {
  const email = `laura-${randomUUID().slice(0, 8)}@glowspa.test`;
  const agreementId = await agreementFor(email);
  const n = nonce();
  return {
    email,
    agreementId,
    nonce: n,
    body: {
      // The agreement's own answers: the legal name it names and its
      // covered-entity answer, which the intent is matched against.
      clinicName: "Glow Med Spa LLC",
      specialty: "med-spa",
      platform: "none",
      plan: "web-voice",
      billingInterval: "month",
      contactName: "Laura Owner",
      contactEmail: email.toUpperCase(),
      agreementId,
      isCoveredEntity: false,
      inviteRef: null,
      nonceHash: n.hash,
      profileStatus: "none",
      timezone: "America/New_York",
      terms: { version: "2026-10-06.1", acceptedAt: new Date().toISOString(), ip: "203.0.113.4" },
      ...overrides,
    },
  };
}

async function intent(body: unknown) {
  const response = await postIntent(signed("http://app.test/api/checkout/intents", body));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

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

describeDb("checkout intents", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  test("a valid purchase is stored before payment, and the answer carries the success URL", async () => {
    const p = await purchase();
    const { status, json } = await intent(p.body);
    expect(status).toBe(201);
    expect(json.attempt).toBe(1);
    expect(json.successUrl).toBe(`http://localhost:3001/welcome?h=${json.ref as string}&cs={CHECKOUT_SESSION_ID}`);

    const { rows } = await getMigratorPool().query(`select contact_email, payload from checkout_intents`);
    expect(rows[0]!.contact_email).toBe(p.email);
    expect(rows[0]!.payload.terms.version).toBe("2026-10-06.1");
  });

  test("an unsigned request, and anything provisioning would refuse, never get as far as a row", async () => {
    const p = await purchase();
    const unsigned = await postIntent(
      new Request("http://app.test/api/checkout/intents", { method: "POST", body: JSON.stringify(p.body) }),
    );
    expect(unsigned.status).toBe(401);

    expect((await intent({ ...p.body, plan: "nope" })).json.field).toBe("plan");
    expect((await intent({ ...p.body, nonceHash: "short" })).json.field).toBe("nonceHash");
    expect((await intent({ ...p.body, timezone: "Mars/Olympus" })).json.field).toBe("timezone");
    expect((await intent({ ...p.body, profileStatus: "read" })).json.field).toBe("profile");

    const { rows } = await getMigratorPool().query(`select 1 from checkout_intents`);
    expect(rows).toHaveLength(0);
  });

  test("the agreement must exist, be unbound and be signed by the buying address", async () => {
    const p = await purchase();
    expect((await intent({ ...p.body, agreementId: randomUUID() })).json.field).toBe("agreementId");
    expect((await intent({ ...p.body, contactEmail: "someone@else.test" })).json.field).toBe("contactEmail");
  });

  test("the agreement must be the document the purchase describes, or the buyer signs again", async () => {
    // Signed for "Glow Med Spa LLC", a med spa, "No" to billing insurance,
    // and no booking platform. A request changed after signing is refused
    // under `agreementId`, which sends the funnel back to the signature.
    const p = await purchase();
    const changed: [string, Record<string, unknown>][] = [
      ["another legal name", { clinicName: "Other Spa LLC" }],
      ["another specialty", { specialty: "dental" }],
      ["another covered answer", { isCoveredEntity: true }],
      ["not sure, after signing no", { isCoveredEntity: null }],
      ["another booking platform", { bookingSystem: "mindbody", calendarAccount: "workspace_baa", platform: "mindbody" }],
    ];
    for (const [label, overrides] of changed) {
      const refused = await intent({ ...p.body, ...overrides });
      expect(refused.status, label).toBe(422);
      expect(refused.json.field, label).toBe("agreementId");
      expect(refused.json.error, label).toMatch(/sign it again/);
    }
    const { rows } = await getMigratorPool().query(`select 1 from checkout_intents`);
    expect(rows).toHaveLength(0);

    // The name is compared as signed: trimmed.
    expect((await intent({ ...p.body, clinicName: "  Glow Med Spa LLC " })).status).toBe(201);
  });

  test("the covered-entity answer is required on an intent", async () => {
    const p = await purchase();
    const { isCoveredEntity: _missing, ...without } = p.body;
    expect((await intent(without)).json.field).toBe("covered");
    expect((await intent({ ...p.body, isCoveredEntity: "no" })).json.field).toBe("covered");
  });

  test("a press of Pay after the previous one was paid moves nothing: the paid Session keeps its terms", async () => {
    const stripe = createStripeFake({
      "checkout.sessions.retrieve": (id: unknown) => ({ id, status: "complete" }),
    });
    __setStripeForTests(stripe.stripe);
    try {
      const invite = randomUUID();
      const p = await purchase({ inviteRef: invite });
      const first = await intent(p.body);
      await postIntentSession(
        signed("http://app.test/api/checkout/intents/session", {
          ref: first.json.ref,
          attempt: 1,
          sessionId: "cs_test_paid",
        }),
      );

      const again = await intent({ ...p.body, plan: "complete", nonceHash: nonce().hash });
      expect(again.status).toBe(409);
      expect(again.json.error).toBe("This purchase is already paid. Check your email.");
      expect(stripe.callsTo("checkout.sessions.retrieve")[0]!.args[0]).toBe("cs_test_paid");

      // Still attempt 1, for web-voice, with the paying browser's nonce: the
      // payment provisions, and /welcome still knows that browser.
      const stored = (await findIntent(first.json.ref as string))!;
      expect(stored).toMatchObject({ attempt: 1, plan: "web-voice", openSessionId: "cs_test_paid" });
      expect(stored.nonceHash!.toString("hex")).toBe(p.nonce.hash);
    } finally {
      __setStripeForTests(null);
    }
  });

  test("a press of Pay after a Session that was not paid moves the intent on, for apps/web to expire that Session", async () => {
    __setStripeForTests(
      createStripeFake({ "checkout.sessions.retrieve": (id: unknown) => ({ id, status: "open" }) }).stripe,
    );
    try {
      const invite = randomUUID();
      const p = await purchase({ inviteRef: invite });
      const first = await intent(p.body);
      await postIntentSession(
        signed("http://app.test/api/checkout/intents/session", {
          ref: first.json.ref,
          attempt: 1,
          sessionId: "cs_test_open",
        }),
      );
      const again = await intent(p.body);
      expect(again.status).toBe(201);
      expect(again.json).toMatchObject({ attempt: 2, previousOpenSessionId: "cs_test_open" });
    } finally {
      __setStripeForTests(null);
    }
  });

  test("a press of Pay that cannot learn whether the previous Session was paid moves nothing", async () => {
    // It may have been: moving the intent past it would turn that payment
    // away at provisioning. The buyer is asked to try again instead.
    __setStripeForTests(
      createStripeFake({
        "checkout.sessions.retrieve": () => {
          throw new Error("Stripe did not answer");
        },
      }).stripe,
    );
    try {
      const invite = randomUUID();
      const p = await purchase({ inviteRef: invite });
      const first = await intent(p.body);
      await postIntentSession(
        signed("http://app.test/api/checkout/intents/session", {
          ref: first.json.ref,
          attempt: 1,
          sessionId: "cs_test_unknown",
        }),
      );

      const again = await intent({ ...p.body, plan: "complete", nonceHash: nonce().hash });
      expect(again.status).toBe(503);
      expect(again.json.error).toMatch(/Nothing has been charged/);
      const stored = (await findIntent(first.json.ref as string))!;
      expect(stored).toMatchObject({ attempt: 1, plan: "web-voice", openSessionId: "cs_test_unknown" });
      expect(stored.nonceHash!.toString("hex")).toBe(p.nonce.hash);
    } finally {
      __setStripeForTests(null);
    }
  });

  test("one setup link makes one intent; a retry reuses it and hands back the session to expire", async () => {
    const invite = randomUUID();
    const p = await purchase({ inviteRef: invite });
    const first = await intent(p.body);
    expect(first.json.attempt).toBe(1);

    const session = await postIntentSession(
      signed("http://app.test/api/checkout/intents/session", {
        ref: first.json.ref,
        attempt: 1,
        sessionId: "cs_test_first",
      }),
    );
    expect(session.status).toBe(200);

    const second = await intent(p.body);
    expect(second.json.ref).toBe(first.json.ref);
    expect(second.json.attempt).toBe(2);
    expect(second.json.previousOpenSessionId).toBe("cs_test_first");

    // Attempt 1 may no longer record a session: only the latest attempt can.
    const stale = await postIntentSession(
      signed("http://app.test/api/checkout/intents/session", {
        ref: first.json.ref,
        attempt: 1,
        sessionId: "cs_test_late",
      }),
    );
    expect(stale.status).toBe(409);
  });
});

describeDb("provisioning from a paid intent, and /welcome", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePools();
  });

  /** The first invoice of `subscription`, paid, relayed as the webhook relays it: with what was paid for. */
  async function provision(
    ref: string,
    subscription: string,
    paid: { attempt?: unknown; plan?: unknown; billingInterval?: unknown } = {},
  ) {
    const response = await postProvision(
      signed("http://app.test/api/provision", {
        ref,
        idempotencyKey: subscription,
        stripeCustomerId: "cus_test_1",
        stripeSubscriptionId: subscription,
        attempt: 1,
        plan: "web-voice",
        billingInterval: "month",
        ...paid,
      }),
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  test("makes the clinic, its one sign-in, its channels and its setup window, and spends the intent", async () => {
    const invite = randomUUID();
    const p = await purchase({ inviteRef: invite });
    const { json: saved } = await intent(p.body);
    const ref = saved.ref as string;

    const sub = `sub_test_${randomUUID().slice(0, 8)}`;
    const first = await provision(ref, sub);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ replayed: false, plan: "web-voice", billingInterval: "month" });
    const clinicId = first.json.clinicId as string;

    const pool = getMigratorPool();
    const { rows: intents } = await pool.query(
      `select consumed_at, stripe_subscription_id, provisioned_clinic_id, provisioned_user_id from checkout_intents where ref = $1`,
      [ref],
    );
    expect(intents[0]).toMatchObject({ stripe_subscription_id: sub, provisioned_clinic_id: clinicId });
    expect(intents[0]!.consumed_at).toBeInstanceOf(Date);

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
    expect(entitled[0]!.bought_plan_id).toBe("web-voice");
    const daysOut = (new Date(entitled[0]!.setup_deadline_at).getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(32);

    // Stripe redelivers: the same subscription is a replay, another is refused.
    expect((await provision(ref, sub)).json.replayed).toBe(true);
    expect((await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`)).status).toBe(409);
    // The setup link that bought it can't open a second purchase.
    expect((await intent(p.body)).status).toBe(409);
  });

  test("a payment provisions only while the intent names the press of Pay and the terms paid", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    try {
      const invite = randomUUID();
      const p = await purchase({ inviteRef: invite });
      const first = await intent(p.body);
      const ref = first.json.ref as string;
      // A second press moves the intent on, to another package.
      expect((await intent({ ...p.body, plan: "complete" })).json.attempt).toBe(2);

      // Attempt 1's Session paid for web-voice: never provisioned as Complete.
      const stale = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`, { attempt: 1 });
      expect(stale.status).toBe(422);
      expect(stale.json.field).toBe("attempt");
      expect(errors.some((line) => line.includes("provisioning_rejected") && line.includes('"field":"attempt"'))).toBe(
        true,
      );
      const refused = (await findIntent(ref))!;
      expect(refused.consumedAt).toBeNull();
      expect(refused.provisionFailedAt).toBeInstanceOf(Date);

      // Terms that are not the intent's, and terms that are missing, are refused the same way.
      const otherPlan = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`, { attempt: 2 });
      expect(otherPlan.json.field).toBe("plan");
      const otherInterval = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`, {
        attempt: 2,
        plan: "complete",
        billingInterval: "year",
      });
      expect(otherInterval.json.field).toBe("billingInterval");
      const missing = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`, {
        attempt: null,
        plan: null,
        billingInterval: null,
      });
      expect(missing.json.field).toBe("attempt");
      const { rows } = await getMigratorPool().query(`select 1 from clinics`);
      expect(rows).toHaveLength(0);

      // The latest press, as paid, makes the account from its own terms.
      const current = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`, {
        attempt: 2,
        plan: "complete",
        billingInterval: "month",
      });
      expect(current.status).toBe(201);
      expect(current.json.plan).toBe("complete");
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
      const p = await purchase();
      const { json: saved } = await intent(p.body);
      const ref = saved.ref as string;
      const first = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`);
      expect(first.status).toBe(201);

      const second = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`);
      expect(second.status).toBe(409);
      const duplicate = errors.find((line) => line.includes("ops alert") && line.includes("duplicate_subscription"));
      expect(duplicate).toBeDefined();
      expect(duplicate).toContain(first.json.clinicId as string);
      // The account the first subscription made still stands: never marked failed.
      expect((await findIntent(ref))!.provisionFailedAt).toBeNull();

      const unknown = await provision(randomUUID(), `sub_test_${randomUUID().slice(0, 8)}`);
      expect(unknown.status).toBe(422);
      expect(
        errors.some((line) => line.includes("ops alert") && line.includes("provisioning_rejected") && line.includes('"field":"ref"')),
      ).toBe(true);
    } finally {
      vi.mocked(console.error).mockRestore();
    }
  });

  test("a funnel purchase confirms no call routing and no phone line: the wizard asks both", async () => {
    // The four-step funnel asks neither question (the wizard's step 2.2 does),
    // so its intent carries neither, and nothing may stamp them confirmed.
    const p = await purchase();
    const { json: saved } = await intent(p.body);
    const ref = saved.ref as string;
    const { rows: stored } = await getMigratorPool().query(
      `select payload from checkout_intents where ref = $1`,
      [ref],
    );
    expect(stored[0]!.payload).not.toHaveProperty("callRouting");
    expect(stored[0]!.payload).not.toHaveProperty("phoneSystemType");

    const provisioned = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`);
    expect(provisioned.status).toBe(201);
    const [clinic] = await inTenant(provisioned.json.clinicId as string, async (client) => {
      const { rows } = await client.query<{
        call_routing: string;
        call_routing_confirmed_at: Date | null;
        phone_system_type: string;
        onboarding: Record<string, string | null>;
      }>(`select call_routing, call_routing_confirmed_at, phone_system_type, onboarding from clinics`);
      return rows;
    });
    // The defaults the runtime reads, explicitly unconfirmed: go-live and the
    // console's "Confirm call routing" still wait on the clinic's answer.
    expect(clinic).toMatchObject({
      call_routing: "conditional",
      call_routing_confirmed_at: null,
      phone_system_type: "unknown",
    });
    expect(clinic!.onboarding.call_routing_chosen).toBeNull();
    expect(clinic!.onboarding.phone_type_confirmed).toBeNull();
  });

  test("/welcome gives the paying browser one sign-in link, and nobody else anything", async () => {
    const p = await purchase();
    const { json: saved } = await intent(p.body);
    const ref = saved.ref as string;
    await postIntentSession(
      signed("http://app.test/api/checkout/intents/session", { ref, attempt: 1, sessionId: "cs_test_paid" }),
    );

    const asPayer = { ref, sessionId: "cs_test_paid", nonce: p.nonce.value };
    expect(await welcomeState({ ...asPayer, nonce: null })).toEqual({ status: "unknown" });
    expect(await welcomeState({ ...asPayer, nonce: "someone-elses" })).toEqual({ status: "unknown" });
    expect(await welcomeState({ ...asPayer, sessionId: "cs_test_other" })).toEqual({ status: "unknown" });
    expect(await welcomeState(asPayer)).toMatchObject({ status: "pending" });

    await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`);
    const ready = await welcomeState(asPayer);
    expect(ready.status).toBe("ready");
    const token = (ready as { url: string }).url.split("/link/")[1]!;
    const consumed = await consumeSignInLink(token, null);
    expect(consumed).toMatchObject({ ok: true, purpose: "checkout" });
    // The plan's first screen after /welcome: "Protect patient details", then the clinic.
    expect((consumed as { redirectTo: string }).redirectTo).toMatch(
      /^\/c\/([a-z0-9-]+)\/protect\?next=%2Fc%2F\1$/,
    );

    // Polled again (a reload, a second tab): the link was already handed out.
    expect(await welcomeState(asPayer)).toMatchObject({ status: "use_email" });
  });

  test("a paid purchase provisioning refuses says so on /welcome and tells ops", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    const p = await purchase();
    const { json: saved } = await intent(p.body);
    const ref = saved.ref as string;
    // Another purchase binds the agreement first, so this one can't.
    await getMigratorPool().query(
      `insert into organization (id, name, slug, created_at) values ('org_other', 'Other', 'other-org', now())`,
    );
    await getMigratorPool().query(`select app_bind_agreement($1::uuid, 'org_other')`, [p.agreementId]);

    const refused = await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`);
    expect(refused.status).toBe(422);
    expect(await welcomeState({ ref, sessionId: "cs_test_x", nonce: p.nonce.value })).toEqual({ status: "unknown" });
    await postIntentSession(
      signed("http://app.test/api/checkout/intents/session", { ref, attempt: 1, sessionId: "cs_test_x" }),
    );
    expect(await welcomeState({ ref, sessionId: "cs_test_x", nonce: p.nonce.value })).toMatchObject({
      status: "failed",
    });
    expect(errors.some((line) => line.includes("provisioning_rejected"))).toBe(true);
    spy.mockRestore();
  });

  test("the buyer of a refused purchase is written to once, with the order's terms (B3)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = await purchase();
    const { json: saved } = await intent(p.body);
    const ref = saved.ref as string;
    await getMigratorPool().query(
      `insert into organization (id, name, slug, created_at) values ('org_other_b3', 'Other', 'other-b3-org', now())`,
    );
    await getMigratorPool().query(`select app_bind_agreement($1::uuid, 'org_other_b3')`, [p.agreementId]);

    // Refused twice (a replay of the purchase): the mark, and so the email,
    // belong to the first refusal only.
    expect((await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`)).status).toBe(422);
    const firstMark = (await findIntent(ref))!.provisionFailedAt;
    expect(firstMark).toBeInstanceOf(Date);
    expect((await provision(ref, `sub_test_${randomUUID().slice(0, 8)}`)).status).toBe(422);
    expect((await findIntent(ref))!.provisionFailedAt).toEqual(firstMark);
    expect(await markIntentFailed(ref)).toBeNull();

    const sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
    const transport: EmailTransport = {
      name: "fake",
      send: async (target, message) => {
        sent.push({ target, message });
        return { status: "sent", messageId: "msg_b3" };
      },
    };
    expect(await sendOrderConfirmedDelayed((await findIntent(ref))!, { transport })).toBe("sent");

    const [{ target, message }] = sent as [{ target: DeliveryTarget; message: OutgoingEmail }];
    expect(target.to).toBe(p.email);
    expect(message.subject).toBe("Your healdesk order is confirmed: one step on our side");
    expect(message.text).toContain(`We'll email your sign-in link to this address by ${replyByDate(firstMark!)}.`);
    expect(message.text).toContain("Monthly billing ($897) starts the day AYA first answers a patient.");
    expect(message.text).toContain("The setup fee is non-refundable.");
    // Keyed by a digest of the ref, which opens /welcome: never the ref itself.
    const digest = createHash("sha256").update(ref).digest("hex");
    expect(message.idempotencyKey).toBe(`hd-order_confirmed_delayed-${digest}-1`);
    expect(JSON.stringify(message)).not.toContain(ref);
    expect(message.tags).toEqual([
      { name: "app", value: "app" },
      { name: "kind", value: "order_confirmed_delayed" },
      { name: "delivery", value: digest },
    ]);
  });
});

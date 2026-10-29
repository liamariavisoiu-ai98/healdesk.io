import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import {
  DIRECT_BOOKING_ADDENDUM_VERSION,
  GOOGLE_CALENDAR_DISCLOSURE,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  sign,
} from "@healdesk/catalog";
import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * E2E (launch readiness, 27 October 2026): one synthetic clinic, end to end,
 * against verify-local's real Postgres, through the product's own code.
 *
 *   checkout records -> first paid invoice -> provisioning -> /welcome's
 *   magic link -> a passkey -> the wizard's four steps -> website chat live ->
 *   an urgent message -> a booking request -> the transcript through the
 *   outbox to SES and back -> the alert queue -> DB-1's direct booking with
 *   its 60-second hold, idempotent on a retry.
 *
 * The steps share one clinic and run in order (vitest runs a file's tests
 * sequentially); each step's assertions are what the owner checks in /admin
 * after the same step of docs/design/launch-readiness-2026-10-27/
 * e2e-production-run-sheet.md.
 *
 * Synthetic only: "Juniper Synthetic Aesthetics", Robin Test at
 * robin@juniper-e2e.test, patients "Sam" and "Kit" on 555-01xx numbers. Ids
 * are pinned and letters-only (the audit guard refuses digit runs), the
 * database is emptied once before the journey (truncateAll), and booking times
 * are whole hours three days out on the clinic's clock, computed with the
 * zone's own offset for that day (tests/setup/desk-calendar.ts deskTime), so a
 * daylight-saving change cannot move them. The holds and the outbox run on the
 * database's clock, as in production.
 *
 * EVERY PLACE A VENDOR IS STUBBED, and what that leaves unproven:
 *
 * - Stripe. No Checkout Session is created and no test card is charged:
 *   sandboxed tests have no network, and Checkout runs in apps/web. The
 *   purchase is apps/web's two sealed records (tests/setup/checkout-records.ts,
 *   built with the catalog's own signing code), and the first paid invoice is
 *   a hand-built `invoice.paid` (billing_reason subscription_create, the $0
 *   plan-start placeholder line and the setup-fee line) in the shape the
 *   pinned API version sends, relayed to /api/provision and then to
 *   /api/billing/events exactly as apps/web's webhook relays them. Stripe's
 *   SDK is the recording fake (tests/setup/stripe-fake.ts), which fails any
 *   call nobody expected. Unproven: Stripe's signature (apps/web verifies it,
 *   apps/web route.test.ts), that apps/web's webhook ignores
 *   checkout.session.completed for provisioning (also route.test.ts), the
 *   hosted Checkout page, the test card, the real payload Stripe emits.
 * - SES. Transcript mail goes through the REAL SesTransport and the real AWS
 *   SDK to an SESv2 REST stand-in served from this process (as
 *   tests/ses-wire.test.ts does), answering TlsPolicy=REQUIRE. SES's delivery
 *   event is applied with recordSesTranscriptEvent, the function the SNS
 *   webhook calls after verifying SNS's signature (tests/ses-events.test.ts
 *   pins that verification). Unproven: SES itself, the SNS subscription,
 *   real TLS to the clinic's mail server.
 * - Resend. Mail that carries no patient information (the welcome email, the
 *   urgent alert L12, the booking-request alert L7) goes to a recording
 *   transport standing where Resend stands; where a path takes no transport
 *   (provisioning's welcome email) it goes to the ConsoleTransport, which
 *   sends nothing. Unproven: Resend, its API key, its webhook.
 * - The model (Anthropic). Every assistant turn is a scripted responder; the
 *   practice questions that pass a channel's audit are recorded by the
 *   fixture tests/setup/practice.ts (a passed run, as the job records one),
 *   not run. Unproven: Claude's real answers, the practice questions against
 *   a real model, the prompt cache.
 * - Google Calendar. The OAuth consent, token exchange, freeBusy and event
 *   insert are the in-memory fake from @healdesk/connectors; the global fetch
 *   throws so nothing leaves the process. Unproven: Google's consent screen,
 *   OAuth verification, real free/busy.
 * - WebAuthn. The browser and the device are a software authenticator
 *   (tests/setup/soft-authenticator.ts); the server's real
 *   @simplewebauthn/server verifiers check it. Unproven: a real browser's
 *   ceremony, the portal's cookie and Next's server actions around it.
 * - Retell (voice) and Meta (Instagram, Messenger, WhatsApp) are NOT
 *   exercised: no call is placed and no Meta webhook is sent. The voice
 *   channel is bought and stays not live. Unproven: everything on those two
 *   channels in this journey (their own suites are retell-voice.test.ts,
 *   voice*.test.ts and meta-*.test.ts).
 * - Slack and the ops email digest are not exercised; the alert queue is read
 *   from the outbox and the ops envelope's own projections.
 * - The script approval a passing run gives (approveAgentConfigVersion) is
 *   the test fixture approveAgentConfig, since no run happens; it is what
 *   direct booking's "script approved" gate reads.
 * - The operator's actions (toggleJob, confirmWebWidget, the projections
 *   /admin reads) go through the ops envelope's runOperation, without the
 *   console's sign-in or the HMAC hop from apps/web.
 * - Gate B in code (lib/compliance/gate-b.ts) is read as it is, never
 *   mocked: every item is built since 29 October 2026 (the practice
 *   questions ask every case, lib/engine/practice/booking.ts; the
 *   routed/answered counter and its notices, migration 0139), and the
 *   fixture's pass (tests/setup/practice.ts) records no case the runtime
 *   could not ask, so step 6 goes live on the real gate.
 *   tests/go-live.test.ts holds the refusal while an item is not built.
 *
 * DB-1's switch (HEALDESK_DIRECT_BOOKING_ENABLED and
 * HEALDESK_DIRECT_BOOKING_ADDENDUM) is set in THIS PROCESS ONLY, for the last
 * step, and removed after it. Nothing here changes a committed flag.
 */

import { POST as postBillingEvent } from "@/app/api/billing/events/route";
import { POST as postProvision } from "@/app/api/provision/route";
import { bookingTools, EMPTY_TOOL_STATE } from "@/lib/assistant/booking-tools";
import { EMPTY_CAPTURE, type AssistantPrompt, type AssistantResponder } from "@/lib/assistant/turn";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { slotLabel } from "@/lib/booking/calendar";
import { HOLD_SECONDS } from "@/lib/booking/holds";
import { bookedLine, detailsBeforeHoldLine } from "@/lib/booking/lines";
import { readToken, sendWebChatMessage, startWebChat, webChatClinic, type WebChatClinic } from "@/lib/chat/web-chat";
import { welcomeState } from "@/lib/checkout/welcome";
import { beginGoogleSignIn, completeGoogleSignIn } from "@/lib/connections/google-oauth";
import { gateBInCode } from "@/lib/compliance/gate-b";
import { recordSesTranscriptEvent } from "@/lib/conversations/transcript-outbox";
import { practiceQuestionsGate } from "@/lib/engine/practice/store";
import { runBillingNoticesJob } from "@/lib/email/outbox";
import {
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  startPasskeyAuthentication,
  startPasskeyRegistration,
  type SessionBinding,
} from "@/lib/factors/passkeys";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { evaluateChannels } from "@/lib/channels/events";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import { runOperation, type Operator } from "@/lib/ops/api";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { resumeScreen } from "@/lib/setup/screens";
import type { SetupScreenId } from "@/lib/setup/screen-ids";
import { loadSetupState } from "@/lib/setup/state";
import { consumeSignInLink } from "@/lib/sign-in/links";
import { withTenant } from "@/lib/tenant";

import { agreementRecord, intentRecord, nonce, records } from "./setup/checkout-records";
import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { DESK_TZ, deskTime, freshGoogle, installGoogleEnv, restoreGoogleEnv } from "./setup/desk-calendar";
import { inTenant, queuedNotices } from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { passPracticeQuestions } from "./setup/practice";
import { SoftAuthenticator } from "./setup/soft-authenticator";
import { createStripeFake } from "./setup/stripe-fake";

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;

const SECRET = "e2e-journey-test-secret";
process.env.HEALDESK_PROVISION_SECRET = SECRET;

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const SERVICE = { type: "service", serviceName: "e2e-journey" } as const;

/** Pinned, synthetic, letters-only ids. */
const IDS = {
  customer: "cus_ejourneybuyer",
  subscription: "sub_ejourneyfirst",
  session: "cs_test_ejourney",
  invoice: "in_ejourneyfirstpaid",
  event: "evt_ejourneyfirstpaid",
} as const;
const BUYER = { name: "Robin Test", email: "robin@juniper-e2e.test" };
const LEGAL_NAME = "Juniper Synthetic Aesthetics LLC";
const WEBSITE = "juniper-e2e.test";
const GOOGLE_ACCOUNT = { sub: "1100000000000000777", email: "bookings@juniper-e2e.test", hd: "juniper-e2e.test" };
const ENV_KEYS = [
  "BETTER_AUTH_URL",
  "HEALDESK_SES_CONFIGURATION_SET",
  "HEALDESK_EMAIL_FROM",
  "HEALDESK_EMAIL_TRANSPORT",
  "AWS_REGION",
  "AWS_ENDPOINT_URL_SESV2",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "HEALDESK_DIRECT_BOOKING_ENABLED",
  "HEALDESK_DIRECT_BOOKING_ADDENDUM",
] as const;

// -----------------------------------------------------------------------------
// The stand-ins
// -----------------------------------------------------------------------------

type SesRequest = { method: string; path: string; body: Record<string, unknown> };

/** SESv2's REST API, served from this process: the configuration set (TLS REQUIRE) and outbound-emails. */
async function localSes(): Promise<{ url: string; requests: SesRequest[]; server: Server }> {
  const requests: SesRequest[] = [];
  let sent = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const path = decodeURIComponent(new URL(req.url ?? "/", "http://ses.local").pathname);
      requests.push({ method: req.method ?? "", path, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} });
      const answer = (status: number, payload: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const set = /^\/v2\/email\/configuration-sets\/([^/]+)$/.exec(path);
      if (req.method === "GET" && set) answer(200, { ConfigurationSetName: set[1], DeliveryOptions: { TlsPolicy: "REQUIRE" } });
      else if (req.method === "POST" && path === "/v2/email/outbound-emails") answer(200, { MessageId: `ejourney-ses-message-${(sent += 1)}` });
      else answer(400, { message: "not served here" });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server };
}

/**
 * The mail router as production has it (getTransport): may-carry-phi goes to
 * SES (here the real SesTransport against the stand-in), everything else to
 * Resend (here a recording transport).
 */
class JourneyMail implements EmailTransport {
  readonly name = "journey";
  readonly resend: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  readonly ses: { target: DeliveryTarget; message: OutgoingEmail; messageId: string }[] = [];
  constructor(private readonly sesTransport: EmailTransport) {}
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    if (message.phiClass !== "none") {
      const result = await this.sesTransport.send(target, message);
      if (result.status === "sent") this.ses.push({ target, message, messageId: result.messageId });
      return result;
    }
    this.resend.push({ target, message });
    return { status: "sent", messageId: `ejourney-resend-${this.resend.length}` };
  }
}

/** A model that answers from a script, one entry per turn; it records what it was shown. */
function scripted(script: Array<(seen: { system: AssistantPrompt; last: string }) => Record<string, unknown>>) {
  const seen: { system: AssistantPrompt; last: string }[] = [];
  const responder: AssistantResponder = async ({ system, messages }) => {
    const entry = { system, last: messages[messages.length - 1]!.content };
    seen.push(entry);
    const next = script.shift();
    return JSON.stringify(next ? next(entry) : { reply: "Happy to help." });
  };
  return { responder, seen };
}

function signedRequest(path: string, body: unknown): Request {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return new Request(`http://app.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(raw, timestamp, SECRET),
    },
    body: raw,
  });
}

/** The first paid invoice as Stripe's pinned API version sends it: the $0 plan-start placeholder and the setup fee. */
function firstPaidInvoice(ref: string, setupCents: number) {
  const now = Math.floor(Date.now() / 1000);
  const lines = [
    {
      id: "il_ejourneyplaceholder",
      object: "line_item",
      amount: 0,
      period: { start: now, end: now + 30 * 86_400 },
      parent: {
        type: "subscription_item_details",
        subscription_item_details: { proration: false, subscription_item: "si_ejourneyplaceholder" },
      },
      pricing: { type: "price_details", price_details: { price: "price_ejourneyplaceholder" } },
    },
    {
      id: "il_ejourneysetup",
      object: "line_item",
      amount: setupCents,
      period: { start: now, end: now },
      parent: { type: "invoice_item_details", invoice_item_details: { proration: false } },
      pricing: { type: "price_details", price_details: { price: "price_ejourneysetup" } },
    },
  ];
  return {
    id: IDS.invoice,
    object: "invoice",
    customer: IDS.customer,
    billing_reason: "subscription_create",
    status: "paid",
    amount_paid: setupCents,
    amount_due: setupCents,
    hosted_invoice_url: `https://invoice.stripe.com/i/acct_ejourney/${IDS.invoice}`,
    status_transitions: { paid_at: now },
    metadata: {},
    period_start: now,
    period_end: now,
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: IDS.subscription,
        // apps/web's marker and the purchase it completes, as Checkout set them.
        metadata: { app: "healdesk", ref, attempt: "1", plan: "voice-webchat-1000-1000", billingInterval: "month" },
      },
    },
    lines: { object: "list", data: lines },
  };
}

// -----------------------------------------------------------------------------
// The journey
// -----------------------------------------------------------------------------

type Journey = {
  ses: Awaited<ReturnType<typeof localSes>>;
  mail: JourneyMail;
  google: FakeGoogleCalendar;
  stripeCalls: () => number;
  ref: string;
  nonceValue: string;
  clinicId: string;
  slug: string;
  userId: string;
  session: SessionBinding;
  deviceLabel: string;
  web: WebChatClinic;
  urgentConversationId: string;
};

const J = {} as Journey;
const savedEnv: Record<string, string | undefined> = {};

async function entitlement(clinicId: string) {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      status: string;
      setup_fee_paid_usd: string | null;
      first_paid_at: Date | null;
      plan_started_at: Date | null;
      bought_plan_id: string;
      stripe_subscription_id: string | null;
    }>(
      `select status, setup_fee_paid_usd, first_paid_at, plan_started_at, bought_plan_id, stripe_subscription_id
         from entitlements where clinic_id = $1`,
      [clinicId],
    );
    return rows[0]!;
  });
}

async function transcriptRows(clinicId: string) {
  return inTenant(clinicId, async (client) =>
    (
      await client.query<{ id: string; conversation_id: string; status: string; sealed: unknown; ses_message_id: string | null; delivered_at: Date | null; attempts: number }>(
        `select id, conversation_id, status, sealed, ses_message_id, delivered_at, attempts from transcript_emails order by created_at`,
      )
    ).rows,
  );
}

describeDb("E2E: a synthetic clinic from checkout to a booked appointment", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // truncateAll leaves the provisioning ledger (it has no foreign key to a
    // clinic), and this journey's subscription id is pinned: a ledger row from
    // an earlier run would make step 2 a replay of a clinic that is gone.
    await getMigratorPool().query(`delete from provisioning_attempts where idempotency_key = $1`, [IDS.subscription]);
    // Every platform attestation on record (the vendors' agreements, the
    // policies, the launch register), as the owner records them on
    // /admin/compliance before launch: the answer gate and go-live read them.
    await attestPlatform();
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    // The relying party and every link: BETTER_AUTH_URL's fallback, made explicit.
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    J.ses = await localSes();
    process.env.HEALDESK_SES_CONFIGURATION_SET = "healdesk-phi";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ENDPOINT_URL_SESV2 = J.ses.url;
    process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "test-only-not-a-secret";
    const { SesTransport } = await import("@/lib/reporting/deliver");
    J.mail = new JourneyMail(new SesTransport());
    installGoogleEnv();
    J.google = freshGoogle();
    J.google.addAccount(GOOGLE_ACCOUNT);
    const fake = createStripeFake();
    __setStripeForTests(fake.stripe);
    J.stripeCalls = () => fake.calls.length;
  }, 180_000);

  afterAll(async () => {
    __setStripeForTests(null);
    restoreGoogleEnv();
    J.ses?.server.closeAllConnections();
    J.ses?.server.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await closePools();
  });

  test("1. checkout: the signed agreement and the press of Pay exist only as apps/web's sealed records; apps/app has made nothing", async () => {
    const n = nonce();
    const agreement = agreementRecord({
      clinicLegalName: LEGAL_NAME,
      signatoryName: BUYER.name,
      signatoryEmail: BUYER.email,
      isCoveredEntity: true,
      bookingSystem: "google_calendar",
      calendarAccount: "workspace_baa",
    });
    const intent = intentRecord(agreement, {
      sessionId: IDS.session,
      nonceHash: n.hash,
      purchase: { website: WEBSITE, timezone: DESK_TZ },
    });
    J.ref = intent.ref;
    J.nonceValue = n.value;
    (J as Record<string, unknown>).records = records(agreement, intent);

    // A completed Checkout Session reaches apps/web only; here nothing knows the purchase.
    expect(await welcomeState({ ref: J.ref, sessionId: IDS.session, nonce: J.nonceValue })).toEqual({ status: "unknown" });
    expect(await runOperation("welcomeHandoff", { ref: J.ref, sessionId: IDS.session }, OPERATOR)).toEqual({
      status: 200,
      body: { data: { ready: false } },
    });
    expect((await getMigratorPool().query(`select 1 from clinics`)).rows).toHaveLength(0);
  });

  test("2. the first paid invoice: provisioning makes the account waiting on Stripe, and the invoice itself activates it", async () => {
    const relay = {
      ref: J.ref,
      idempotencyKey: IDS.subscription,
      stripeCustomerId: IDS.customer,
      stripeSubscriptionId: IDS.subscription,
      attempt: 1,
      plan: "voice-webchat-1000-1000",
      billingInterval: "month",
      hostedInvoiceUrl: `https://invoice.stripe.com/i/acct_ejourney/${IDS.invoice}`,
      records: (J as Record<string, unknown>).records,
    };
    const provisioned = await postProvision(signedRequest("/api/provision", relay));
    const body = (await provisioned.json()) as Record<string, unknown>;
    expect(provisioned.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ replayed: false, plan: "voice-webchat-1000-1000", billingInterval: "month" });
    J.clinicId = body.clinicId as string;
    J.slug = body.clinicSlug as string;

    // Provisioned but not yet paid on our side: the row waits for invoice.paid.
    expect(await entitlement(J.clinicId)).toMatchObject({
      status: "provisioning",
      bought_plan_id: "voice-webchat-1000-1000",
      stripe_subscription_id: IDS.subscription,
      first_paid_at: null,
    });
    // Stripe redelivers the invoice: a replay, one clinic.
    const again = await postProvision(signedRequest("/api/provision", relay));
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    expect((await getMigratorPool().query(`select 1 from clinics`)).rows).toHaveLength(1);

    // The same invoice.paid, forwarded once the account exists.
    const setupCents = 69_700 + 25_900;
    const event = {
      id: IDS.event,
      object: "event",
      api_version: "2026-08-26.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "invoice.paid",
      data: { object: firstPaidInvoice(J.ref, setupCents) },
    };
    const forwarded = await postBillingEvent(signedRequest("/api/billing/events", event));
    expect(forwarded.status, await forwarded.clone().text()).toBe(200);
    const paid = await entitlement(J.clinicId);
    expect(paid.status).toBe("active");
    expect(paid.first_paid_at).toBeInstanceOf(Date);
    // Billing starts the day AYA first answers a patient: no plan start yet.
    expect(paid.plan_started_at).toBeNull();
    expect(J.stripeCalls()).toBe(0);

    const { rows: users } = await getMigratorPool().query<{ id: string }>(`select id from "user" where email = $1`, [BUYER.email]);
    J.userId = users[0]!.id;
    // /admin: the clinic in the list, synthetic, its agreement signed.
    const listed = await runOperation("listClinics", {}, OPERATOR);
    expect(JSON.stringify(listed.body)).toContain(J.slug);
  });

  test("3. sign-in: /welcome hands the paying browser one magic link, spent once, into the passkey step", async () => {
    const asPayer = { ref: J.ref, sessionId: IDS.session, nonce: J.nonceValue };
    expect(await welcomeState({ ...asPayer, nonce: "someone-elses" })).toEqual({ status: "unknown" });
    const ready = await welcomeState(asPayer);
    expect(ready.status).toBe("ready");
    const token = (ready as { url: string }).url.split("/link/")[1]!;
    const consumed = await consumeSignInLink(token, null);
    expect(consumed).toMatchObject({ ok: true, purpose: "checkout" });
    expect((consumed as { redirectTo: string }).redirectTo).toBe(`/c/${J.slug}/protect?next=%2Fc%2F${J.slug}%2Fsetup`);
    // Spent: a second use is refused, and a reload of /welcome says "use your email".
    expect(await consumeSignInLink(token, null)).toMatchObject({ ok: false });
    expect(await welcomeState(asPayer)).toMatchObject({ status: "use_email" });
  });

  test("4. passkey: the device registers through the real verifiers and steps the session up", async () => {
    const device = new SoftAuthenticator();
    J.deviceLabel = "Front desk Mac";
    J.session = { userId: J.userId, sessionTokenHash: hashSessionToken(randomBytes(24).toString("base64url")) };
    const started = await startPasskeyRegistration({ session: J.session });
    if (!started.ok) throw new Error(started.reason);
    expect(
      await finishPasskeyRegistration({ session: J.session, response: device.create(started.options.challenge), deviceLabel: J.deviceLabel }),
    ).toMatchObject({ ok: true, deviceLabel: J.deviceLabel });
    const challenge = await startPasskeyAuthentication({ session: J.session });
    if (!challenge.ok) throw new Error(challenge.reason);
    expect(
      await finishPasskeyAuthentication({ session: J.session, response: device.get(challenge.options.challenge) }),
    ).toMatchObject({ ok: true, stepUp: { deviceLabel: J.deviceLabel } });
    const { rows } = await getMigratorPool().query(`select 1 from user_factors where user_id = $1`, [J.userId]);
    expect(rows).toHaveLength(1);
  });

  test(
    "5. the wizard's four steps, each saved as it completes, Google Calendar connected by its login button",
    async () => {
      const ctx: SaveContext = { clinicId: J.clinicId, slug: J.slug, userId: J.userId, actorLabel: J.deviceLabel };
      const inputs: Partial<Record<SetupScreenId, unknown>> = {
        basics: {
          name: "Juniper Synthetic Aesthetics",
          address: "100 Test Way, Springfield, NY 10001",
          phone: "(212) 555-0140",
          website: `https://${WEBSITE}/`,
          timezone: DESK_TZ,
        },
        hours: {
          hours: Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]])),
          closures: [],
        },
        services: {
          services: [
            { name: "Consultation", priceKind: "exact", price: 0, durationMinutes: 30 },
            { name: "Facial", priceKind: "exact", price: 100, durationMinutes: 60 },
          ],
        },
        question: { question: "Where do I park?", answer: "Free parking behind the building." },
        insurance: { billsInsurance: false },
        tone: { tone: "warm" },
        coverage: { coverageMode: "overflow_after_hours" },
        direct_line: { directLine: "(212) 555-0177" },
        deposits: { needsDeposits: false },
        urgent: { urgentHelp: "(212) 555-0188" },
        calendar: {},
        providers: { bookingDetail: "generic" },
        channels: {},
      };

      const visited: SetupScreenId[] = [];
      for (let guard = 0; guard < 20; guard += 1) {
        const state = (await loadSetupState({ clinicId: J.clinicId, userId: J.userId, actor: SERVICE }))!;
        const screen = resumeScreen(state.screens, state.progress);
        if (!screen || screen === "backup") break;
        if (screen === "calendar") {
          // Step 3's login button: Google's consent, then the callback, in the portal session.
          const { authUrl, cookieValue } = await beginGoogleSignIn({
            clinicId: J.clinicId,
            via: { kind: "portal", userId: J.userId, returnTo: "wizard" },
            disclosureVersion: GOOGLE_CALENDAR_DISCLOSURE.version,
            actor: { type: "user", userId: J.userId, label: J.deviceLabel },
          });
          const answer = J.google.authorize(authUrl, { sub: GOOGLE_ACCOUNT.sub }) as { code: string; state: string };
          const result = await completeGoogleSignIn(
            { ...answer, error: null, cookie: cookieValue },
            { portalSession: async () => ({ userId: J.userId, label: J.deviceLabel, steppedUp: true }) },
          );
          expect(result.outcome, JSON.stringify(result)).toBe("connected");
        }
        const saved = await saveSetupScreen(ctx, screen, inputs[screen] ?? {});
        expect(saved, `${screen}: ${JSON.stringify(saved)}`).toMatchObject({ ok: true });
        visited.push(screen);
      }
      // All four steps were walked, in the wizard's order.
      expect(visited).toEqual(expect.arrayContaining(["basics", "hours", "services", "tone", "coverage", "direct_line", "urgent", "calendar", "channels"]));
      expect(visited.indexOf("basics")).toBeLessThan(visited.indexOf("tone"));
      expect(visited.indexOf("tone")).toBeLessThan(visited.indexOf("calendar"));
      expect(visited.indexOf("calendar")).toBeLessThan(visited.indexOf("channels"));

      const connection = await inTenant(J.clinicId, async (c) =>
        (await c.query<{ status: string }>(`select status from provider_connections where provider = 'google_calendar'`)).rows,
      );
      expect(connection).toEqual([{ status: "active" }]);
      // /admin › the clinic's Setup: every step answered.
      const onboarding = await runOperation("getOnboarding", { clinicId: J.clinicId }, OPERATOR);
      expect(onboarding.status).toBe(200);
    },
    SLOW,
  );

  test("6. website chat goes live once the questions pass and the snippet is confirmed, Gate B's code built", async () => {
    // A pass of the practice questions, as the job records one, and the script
    // approval that pass gives (approveAgentConfigVersion in production; the
    // fixture approveAgentConfig here). Both stand in for the model's run.
    await passPracticeQuestions(J.clinicId, ["web"]);
    await withTenant({ clinicId: J.clinicId, actor: SERVICE }, (tx) => approveAgentConfig(tx, "practice questions (fixture)"));
    const liveAt = async (channel: string) =>
      inTenant(J.clinicId, async (c) =>
        (await c.query<{ live_at: Date | null }>(`select live_at from clinic_channels where channel = $1`, [channel])).rows[0]!.live_at,
      );

    // Gate B's code is built since 0139 (the counter and its notices), not
    // mocked: with the clinic's and ops' parts done, confirming the snippet
    // takes the channel live, and no go_live_held names Gate B.
    expect(gateBInCode().every((i) => i.built)).toBe(true);
    expect(await withTenant({ clinicId: J.clinicId, actor: SERVICE }, (tx) => practiceQuestionsGate(tx, "web"))).toEqual({
      open: true,
      why: "passed",
    });
    const confirmed = await runOperation("confirmWebWidget", { clinicId: J.clinicId }, OPERATOR);
    expect(confirmed.body).toEqual({ data: { status: "updated" } });
    await withTenant({ clinicId: J.clinicId, actor: SERVICE }, (tx) => evaluateChannels(tx, { only: "web", actor: "ops" }));
    expect(await liveAt("web")).toBeInstanceOf(Date);
    const { rows: alerts } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'go_live_held' and fields->>'clinicId' = $1`,
      [J.clinicId],
    );
    expect(alerts.map((a) => a.fields.code)).not.toContain("gate_b_not_built");
    // Voice is bought and not live: no Retell agent, no forwarding (not exercised).
    expect(await liveAt("voice")).toBeNull();
    const web = await webChatClinic(J.slug);
    expect(web).not.toBeNull();
    J.web = web!;
  });

  test(
    "7. an urgent message: matched before the model, the fixed line, L12 to the clinic at once; the transcript goes through SES when a number is left",
    async () => {
      // The owner's pending action, done in /admin > Jobs: the outbox's sender
      // on. Shipped off, an urgent alert (L12) is only queued, and the urgent
      // reply leaves out "I've told the team" (lib/notices/booking-alerts.ts).
      expect(await runOperation("toggleJob", { name: "billing-notices", enabled: true }, OPERATOR)).toMatchObject({ status: 200 });
      // The transcript sender ships ON (its migration seeds it on, since it
      // carries the deletion of undelivered copies); truncateAll re-seeds every
      // job off, so it is put back as a fresh deployment has it.
      expect(await runOperation("toggleJob", { name: "transcript-emails", enabled: true }, OPERATOR)).toMatchObject({ status: 200 });

      const start = await startWebChat(J.web);
      if (start.mode !== "chat") throw new Error(`no chat: ${start.mode}`);
      expect(start.opening).toMatch(/^You're chatting with an AI assistant for /);
      const { responder, seen } = scripted([() => ({ reply: "Thank you, Sam. The clinic will call you on that number.", booking: { first_name: "Sam", phone: "212 555 0192" } })]);
      const urgent = await sendWebChatMessage(J.web, start.token, "My lips are swelling after the filler and it's hard to breathe", { responder, transport: J.mail });
      if (urgent.mode !== "chat") throw new Error("no chat");
      expect(urgent.reply).toMatch(/911/);
      expect(urgent.reply).toContain("Leave a number for the clinic to call you.");
      // The model never saw it.
      expect(seen).toHaveLength(0);
      J.urgentConversationId = readToken(urgent.token, J.web.clinicId)!.conversationId!;

      // L12, critical, sent in-process to the clinic's one address, naming nobody.
      const l12 = await queuedNotices(J.clinicId, ["urgent"]);
      expect(l12, JSON.stringify(await queuedNotices(J.clinicId))).toHaveLength(1);
      expect(l12[0]!.sent_at).toBeInstanceOf(Date);
      const alertMail = J.mail.resend.filter((m) => m.message.subject && m.target.to === BUYER.email);
      expect(alertMail.length).toBeGreaterThan(0);
      expect(JSON.stringify(alertMail.map((m) => m.message))).not.toMatch(/swelling|Sam|0192/);

      // The number: the chat ends and its transcript goes now, through SES, sealed until SES answers.
      const number = await sendWebChatMessage(J.web, urgent.token, "Sam, 212 555 0192", { responder, transport: J.mail });
      if (number.mode !== "chat") throw new Error("no chat");
      expect(number.ended).toBe(true);
      expect(J.mail.ses).toHaveLength(1);
      expect(J.mail.ses[0]!.target.to).toBe(BUYER.email);
      expect(J.mail.ses[0]!.message.text).toContain("Visitor: Sam, 212 555 0192");
      const sesSends = J.ses.requests.filter((r) => r.path === "/v2/email/outbound-emails");
      expect(sesSends).toHaveLength(1);
      expect(sesSends[0]!.body).toMatchObject({ ConfigurationSetName: "healdesk-phi", Destination: { ToAddresses: [BUYER.email] } });

      const [row] = await transcriptRows(J.clinicId);
      expect(row).toMatchObject({ status: "sent", ses_message_id: J.mail.ses[0]!.messageId, delivered_at: null });
      expect(row!.sealed).not.toBeNull();
      expect(JSON.stringify(row!.sealed)).not.toMatch(/swelling|0192/);

      // SES reports it delivered: the copy is deleted, the row stays as a receipt without the words.
      expect(await recordSesTranscriptEvent({ messageId: J.mail.ses[0]!.messageId, type: "delivery" })).toBe(true);
      const [receipt] = await transcriptRows(J.clinicId);
      expect(receipt).toMatchObject({ status: "delivered", sealed: null, attempts: 1 });
      expect(receipt!.delivered_at).toBeInstanceOf(Date);
      // /admin › the clinic's Deliveries: the receipt, ids and times only.
      const deliveries = await runOperation("transcriptDeliveries", { clinicId: J.clinicId }, OPERATOR);
      expect(deliveries.status).toBe(200);
      expect(JSON.stringify(deliveries.body)).not.toMatch(/swelling|Sam|0192/);

      const convo = await inTenant(J.clinicId, async (c) =>
        (await c.query<{ urgent: boolean; outcome: string }>(`select urgent, outcome from conversations where id = $1`, [J.urgentConversationId])).rows,
      );
      expect(convo).toEqual([{ urgent: true, outcome: "escalated_to_human" }]);
    },
    SLOW,
  );

  test("8. a booking request (direct booking off, the shipped state): one request for the desk, and L7 queued without the details", async () => {
    expect(process.env.HEALDESK_DIRECT_BOOKING_ENABLED).toBeUndefined();
    const sw = await runOperation("bookingSwitch", {}, OPERATOR);
    expect((sw.body as { data: { directBooking: boolean } }).data.directBooking).toBe(false);
    const start = await startWebChat(J.web);
    if (start.mode !== "chat") throw new Error("no chat");
    const booking = { wants: true, first_name: "Kit", phone: "212 555 0193", window: "Thursday afternoon", service: "Consultation" };
    const { responder } = scripted([
      () => ({ reply: "Thanks Kit, the team will confirm Thursday afternoon.", booking }),
      () => ({ reply: "You're welcome." }),
    ]);
    const first = await sendWebChatMessage(J.web, start.token, "Kit, 212 555 0193, Thursday afternoon for a consultation", { responder, transport: J.mail });
    if (first.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(J.web, first.token, "Thanks!", { responder, transport: J.mail });
    const requests = await inTenant(J.clinicId, async (c) =>
      (await c.query<{ channel: string; status: string; preferred_window: string }>(`select channel, status, preferred_window from booking_requests`)).rows,
    );
    expect(requests).toEqual([{ channel: "web_chat", status: "requested", preferred_window: "Thursday afternoon" }]);
    const l7 = await queuedNotices(J.clinicId, ["booking_request"]);
    expect(l7).toHaveLength(1);
    expect(JSON.stringify(l7[0]!.payload)).not.toMatch(/Kit|0193|Thursday|Consultation/);
  });

  test("9. the alert queue: the clinic's outbox and ops' inbox hold pointers and counts, never a patient", async () => {
    const outbox = await queuedNotices(J.clinicId);
    const kinds = outbox.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["channel_live", "urgent", "booking_request"]));
    expect(JSON.stringify(outbox.map((n) => n.payload))).not.toMatch(/Sam|Kit|0192|0193|swelling/);
    // The minute job (billing-notices, switched on in step 7) sends what is due: L7 among it, a pointer naming nobody.
    const beforeRun = J.mail.resend.length;
    await runBillingNoticesJob({ transport: J.mail });
    const l7 = await queuedNotices(J.clinicId, ["booking_request"]);
    expect(l7[0]!.sent_at).toBeInstanceOf(Date);
    const sentNow = J.mail.resend.slice(beforeRun);
    expect(sentNow.length).toBeGreaterThan(0);
    expect(sentNow.every((m) => m.target.to === BUYER.email)).toBe(true);
    expect(JSON.stringify(sentNow.map((m) => m.message))).not.toMatch(/Sam|Kit|0192|0193|swelling|Thursday|Consultation/);
    const inbox = await runOperation("opsInbox", {}, OPERATOR);
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).not.toMatch(/Sam|Kit|0192|0193|swelling/);
    const queues = await runOperation("listMachineQueues", {}, OPERATOR);
    expect(queues.status).toBe(200);
  });

  test(
    "10. DB-1 on (this process only): a web chat booking is held for 60 seconds, written to Google once, and a retried tool call returns the same booking",
    async () => {
      process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
      process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
      try {
        const sw = await runOperation("bookingSwitch", {}, OPERATOR);
        expect((sw.body as { data: Record<string, boolean> }).data).toMatchObject({ directBooking: true, env: true, released: true, versionMatches: true });

        const at = deskTime(3, 10);
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: DESK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
        const offered = (system: AssistantPrompt) => [...system.turn.matchAll(/^- (\S+) = /gm)].map((m) => m[1]!);
        const { responder } = scripted([
          () => ({ reply: "Let me look.", booking: { wants: true, service: "Facial" }, action: { type: "find_times", service: "Facial", day } }),
          ({ system }) => ({ reply: "Great.", action: { type: "choose_time", at: offered(system).find((v) => new Date(v).getTime() === at.getTime()) } }),
          () => ({ reply: "You're booked!", booking: { first_name: "Kit", phone: "212 555 0193" } }),
        ]);
        const start = await startWebChat(J.web);
        if (start.mode !== "chat") throw new Error("no chat");
        let token = start.token;
        const say = async (text: string) => {
          const reply = await sendWebChatMessage(J.web, token, text, { responder, transport: J.mail });
          if (reply.mode !== "chat") throw new Error(`not a chat reply: ${reply.mode}`);
          token = reply.token;
          return reply.reply;
        };
        const times = await say("Can I book a facial?");
        expect(times, times).toContain(slotLabel(at, DESK_TZ));
        expect(await say("The ten o'clock please")).toBe(detailsBeforeHoldLine(slotLabel(at, DESK_TZ)));
        expect(await say("Kit, 212 555 0193")).toBe(bookedLine(slotLabel(at, DESK_TZ), "Facial"));

        const rows = await inTenant(J.clinicId, async (c) => ({
          appointments: (await c.query<{ id: string; scheduled_for: Date }>(`select id, scheduled_for from appointments`)).rows,
          holds: (await c.query<{ status: string; created_at: Date; expires_at: Date }>(`select status, created_at, expires_at from slot_holds`)).rows,
          requests: (await c.query<{ status: string; conversation_id: string; appointment_id: string | null }>(
            `select status, conversation_id, appointment_id from booking_requests where status <> 'requested'`,
          )).rows,
        }));
        expect(rows.appointments).toEqual([expect.objectContaining({ scheduled_for: at })]);
        expect(rows.holds).toEqual([expect.objectContaining({ status: "converted" })]);
        // Held for the minute, by the database clock, before the booked line was said.
        expect(rows.holds[0]!.expires_at.getTime() - rows.holds[0]!.created_at.getTime()).toBe(HOLD_SECONDS * 1000);
        expect(HOLD_SECONDS).toBe(60);
        expect(rows.requests).toEqual([expect.objectContaining({ status: "confirmed", appointment_id: rows.appointments[0]!.id })]);
        const inserts = () => J.google.requests.filter((r) => r.endpoint === "insert").length;
        expect(inserts()).toBe(1);

        // The same tool call again (a retried request): the one booking, nothing more written.
        const conversationId = rows.requests[0]!.conversation_id;
        const first = rows.appointments[0]!.scheduled_for.toISOString();
        const retried = await bookingTools({
          clinicId: J.clinicId,
          channel: "web_chat",
          holderKey: `web:${conversationId}`,
          bookingKey: `web:${conversationId}:1`,
          conversationId,
          timeZone: DESK_TZ,
          actor: SERVICE,
          budgetMs: 15_000,
        }).run({
          action: null,
          capture: { ...EMPTY_CAPTURE, firstName: "Kit", phone: "+12125550193" },
          state: { ...EMPTY_TOOL_STATE, service: "Facial", offered: [{ at: first, providerId: null }], chosen: { at: first, providerId: null } },
          now: new Date(),
        });
        expect(retried).toMatchObject({ bookingWritten: true, appointmentId: rows.appointments[0]!.id });
        expect(inserts()).toBe(1);
        const after = await inTenant(J.clinicId, async (c) => (await c.query(`select 1 from appointments`)).rows);
        expect(after).toHaveLength(1);
      } finally {
        delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
        delete process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM;
      }
      const off = await runOperation("bookingSwitch", {}, OPERATOR);
      expect((off.body as { data: { directBooking: boolean } }).data.directBooking).toBe(false);
    },
    SLOW,
  );
});

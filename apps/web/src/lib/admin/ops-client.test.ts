import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's readers and its failure wording, against a stubbed
 * upstream: what the console says when apps/app answers with a server error
 * (F12), that the agent's greeting survives the round trip to the textarea
 * (F2), and that every billing-panel answer is checked field by field before
 * a screen that offers a refund button renders it.
 *
 * The session check and the browser headers are stubbed; the signing, the
 * transport and the readers are the real ones.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import * as opsClient from "@/lib/admin/ops-client";
import {
  closeUnfinishedSetup,
  commitRefund,
  disconnectCalendar,
  extendSetupDeadline,
  fetchClinicBilling,
  fetchClinicHealth,
  fetchOnboarding,
  issueCalendarLink,
  issueStripeConnectLink,
  previewRefund,
  retryLocationSetup,
  retryOverageInvoice,
  setAutoConfirm,
  setAutoRenew,
  setClinicSettings,
  setDepositSettings,
  setMetaPlatform,
  setOverageMode,
  toggleJob,
} from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const BILLING = "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a";

type Reply = { status?: number; body: unknown; contentType?: string };
let replies: Reply[] = [];
let sent: Array<{ op: string; args: Record<string, unknown> }> = [];

function reply(body: unknown, status = 200): void {
  replies.push({ status, body });
}

beforeEach(() => {
  replies = [];
  sent = [];
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const next = replies.shift();
      if (!next) throw new Error("no stubbed reply");
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": next.contentType ?? "application/json" },
      });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// F12: a server error is not a refusal
// -----------------------------------------------------------------------------

describe("what the console says when apps/app fails (F12)", () => {
  test("a write answered 500 may have happened, and says so rather than 'nothing was changed'", async () => {
    reply({ error: "That operation failed partway through.", code: "failed" }, 500);
    const result = await setOverageMode(CLINIC, "hard_cap");
    expect(result).toEqual({
      ok: false,
      code: "failed",
      message:
        "The ops API failed partway through. It may have carried this out, in whole or in part: reload and check before trying again.",
    });
  });

  test("so does a 503, which can come from whatever stands in front of apps/app", async () => {
    reply({ error: "The operations API is unavailable.", code: "unavailable" }, 503);
    const result = await toggleJob("billing-requests", true);
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(!result.ok && result.message).toMatch(/may have carried this out/);
    expect(!result.ok && result.message).not.toMatch(/nothing was changed/);
  });

  test("a read answered 500 says nothing could be read", async () => {
    reply({ error: "That operation failed.", code: "failed" }, 500);
    expect(await fetchClinicBilling(CLINIC)).toEqual({
      ok: false,
      code: "failed",
      message: "The ops API failed while answering, so nothing below could be read.",
    });
  });

  test("a 4xx is still a refusal before anything ran, and keeps 'nothing was changed'", async () => {
    reply({ error: "Invalid request body.", code: "invalid_body" }, 400);
    expect(await setOverageMode(CLINIC, "allow")).toEqual({
      ok: false,
      code: "refused",
      message: "The ops API refused this. The reason is in our logs; nothing was changed.",
    });
    reply({ error: "Unauthorized.", code: "unauthorized" }, 401);
    expect(await setOverageMode(CLINIC, "allow")).toMatchObject({ code: "refused" });
  });
});

// -----------------------------------------------------------------------------
// F2: the greeting round trip
// -----------------------------------------------------------------------------

/** getOnboarding's `booking`, as apps/app's readBookingProjection writes it. */
const BOOKING = {
  mode: "manual",
  canOfferTimes: true,
  reasons: [
    {
      code: "auto_confirm_off",
      sentence:
        "Auto-confirm is off, so your assistant takes each booking as a request for your staff to confirm.",
    },
    { code: "kill_switch_off", sentence: "healdesk hasn't switched on live booking yet." },
  ],
  autoConfirm: false,
  autoConfirmChangedAt: "2026-10-11T09:30:00.000Z",
  killSwitchOn: false,
  demo: false,
  terms: {
    kind: "covered",
    source: "agreement",
    clauseId: "google-calendar-covered",
    documentVersion: "1.3.0",
    documentReleased: true,
    electedAt: "2026-10-08T09:00:00.000Z",
    reason: null,
  },
  calendar: {
    connectionId: BILLING,
    status: "active",
    accountKind: "workspace",
    hostedDomain: "glow.test",
    timeZoneMatches: true,
    disclosureCurrent: true,
    connectedAt: "2026-10-08T09:05:00.000Z",
    lastVerifiedAt: "2026-10-12T08:00:00.000Z",
    lastError: null,
    brokenAt: null,
  },
  calendarLinkOutstanding: false,
  pendingAssistantWrites: 1,
};

function onboardingWith(greeting: string, booking: unknown = BOOKING): unknown {
  return {
    data: {
      clinic: {
        id: CLINIC,
        slug: "glow-a1b2c3",
        name: "Glow Aesthetics",
        specialty: "med-spa",
        timezone: "America/New_York",
        dataClassification: "synthetic",
        attributionMode: "estimated",
        isCoveredEntity: true,
        phoneSystemType: "landline",
        callRouting: "conditional",
        callRoutingConfirmedAt: null,
        carrier: null,
        assistantNumberE164: null,
        publishedPhoneE164: null,
        openingHoursPresent: false,
        wentLiveAt: null,
      },
      steps: [],
      forwardingTest: { windowUntil: null, observed: null },
      stripeConnect: { accountId: null, connectedAt: null, authorizeUrl: null },
      meta: {
        enabled: false,
        platforms: { instagram: true, messenger: false, whatsapp: true },
        channels: [],
        bookingRequests: { waiting: 0, accepted: 0, confirmed: 0, declined: 0 },
      },
      forwarding: null,
      agent: {
        version: 3,
        greeting,
        services: [],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: null,
        approvedAt: null,
        approvedByLabel: null,
      },
      goLive: { ok: true },
      requirements: {
        fields: [],
        confirmedAt: null,
        source: null,
        setupLinkOutstanding: false,
        catalogue: [],
        neverAsked: [],
      },
      timezoneConfirmedAt: null,
      timezone: "America/New_York",
      calendarWrites: [],
      booking,
    },
  };
}

async function greetingRead(greeting: string): Promise<string> {
  replies.push({ body: onboardingWith(greeting) });
  const view = await fetchOnboarding(CLINIC);
  if (!view.ok) throw new Error(view.message);
  return view.data.agent!.greeting;
}

describe("the agent's greeting reaches the textarea as stored (F2)", () => {
  test("a 590-character greeting in paragraphs comes back whole, line breaks and all", async () => {
    const paragraph = "Thanks for calling Glow Aesthetics. ".repeat(8);
    const greeting = `${paragraph.trim()}\n\n${paragraph.trim()}\n${"x".repeat(
      590 - 2 * paragraph.trim().length - 3,
    )}`;
    expect(greeting).toHaveLength(590);
    // Under the old reader this came back flattened to one line and cut at
    // 400, and "Save script" wrote that back as a new version.
    expect(await greetingRead(greeting)).toBe(greeting);
  });

  test("Windows line ends are normalised, other control characters and bidi overrides go, and 600 is the cap", async () => {
    expect(await greetingRead("Hello\r\nthere\u0007 friend\u202E\tand welcome")).toBe(
      "Hello\nthere  friend\tand welcome",
    );
    expect(await greetingRead("y".repeat(700))).toHaveLength(600);
  });
});

// -----------------------------------------------------------------------------
// The billing panel's readers
// -----------------------------------------------------------------------------

function billingView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clinic: {
      id: CLINIC,
      slug: "glow-a1b2c3",
      name: "Glow Aesthetics",
      dataClassification: "synthetic",
      billingClinicId: BILLING,
      isLocation: true,
    },
    group: [
      {
        clinicId: BILLING,
        slug: "glow-main",
        name: "Glow Main",
        isBillingClinic: true,
        channels: [
          {
            channel: "web",
            enabled: true,
            status: "live",
            readyAt: "2026-10-07T00:00:00.000Z",
            waitingOn: null,
            liveAt: "2026-10-07T00:00:00.000Z",
            firstAnswerAt: "2026-10-07T09:30:00.000Z",
          },
          {
            channel: "voice",
            enabled: true,
            status: "waiting",
            readyAt: "2026-10-07T00:00:00.000Z",
            waitingOn: "forwarding",
            liveAt: null,
            firstAnswerAt: null,
          },
        ],
      },
      { clinicId: CLINIC, slug: null, name: null, isBillingClinic: false, channels: [] },
    ],
    channelsInService: ["web"],
    entitlements: {
      status: "active",
      boughtPlanId: "voice-metachat-500-300",
      billedPlanId: "webchat-300",
      isLegacy: false,
      interval: "month",
      locations: 2,
      planStartedAt: "2026-10-07T00:00:00.000Z",
      planStartAppliedAt: "2026-10-07T00:00:00.000Z",
      isPlanStarted: true,
      paidThrough: "2026-11-07T00:00:00.000Z",
      graceEndsAt: null,
      cancelAt: null,
      closesAt: null,
      overageMode: "allow",
      usageAlertsEnabled: true,
      firstPeriodRefundedAt: null,
      setupDeadlineAt: "2026-11-05T23:59:59.999Z",
      openInvoice: { url: "https://invoice.stripe.com/i/acct_x/test_y", amountCents: 89700 },
      hasSubscription: true,
      isMutationInFlight: false,
    },
    usage: [
      {
        meter: "chat_conversations",
        used: 12,
        included: 2000,
        remaining: 1988,
        overUnits: 0,
        overageCents: 0,
        percent: 0,
        windowStart: "2026-10-07T00:00:00.000Z",
        windowEnd: "2026-11-07T00:00:00.000Z",
        isWindowOpen: true,
      },
    ],
    transitions: [
      {
        fromStatus: "provisioning",
        toStatus: "active",
        actor: "system",
        reason: "invoice.paid",
        createdAt: "2026-10-01T10:00:00.000Z",
      },
    ],
    notices: [
      {
        kind: "payment_failed",
        createdAt: "2026-10-08T10:00:00.000Z",
        sendAfter: "2026-10-08T10:00:00.000Z",
        sentAt: null,
        attempts: 2,
        recipientsCount: null,
        lastError: "retrying: 503 from the transport",
      },
    ],
    requests: [
      {
        id: "0f0e0d0c-0b0a-4908-8706-050403020100",
        kind: "step_up",
        channel: "voice",
        reason: "first_answer",
        requestedAt: "2026-10-08T10:00:00.000Z",
        nextAttemptAt: "2026-10-08T10:05:00.000Z",
        attempts: 3,
        isInFlight: false,
        doneAt: null,
        outcome: null,
        outcomeReason: null,
        lastError: "stripe:api_error",
        isStuck: true,
        isHeldBySwitch: false,
      },
    ],
    overageInvoices: [
      {
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z",
        voiceUnits: 12,
        chatUnits: 0,
        amountCents: 960,
        status: "failed",
        invoicedAt: null,
        code: "card_error:card_declined",
      },
    ],
    attentionEvents: [
      {
        source: "billing",
        stripeEventId: "evt_1PxAbC",
        type: "invoice.paid",
        outcome: "dead_letter",
        failures: 3,
        receivedAt: "2026-10-08T10:00:00.000Z",
        code: "UnresolvedClinicError",
      },
    ],
    settings: {
      isPaused: false,
      pausedAt: null,
      pausedUntil: null,
      pausedByLabel: null,
      directLineE164: "+14155550199",
      directLineSetAt: "2026-10-07T00:00:00.000Z",
    },
    deposits: {
      depositsEnabled: false,
      bookVoiceWithoutDeposit: true,
      bookChatWithoutDeposit: false,
      depositUncollectable: "book_and_flag",
      depositHoldMinutes: 60,
      defaultAmountUsd: 50.5,
      hasDepositAmount: true,
      canEnable: false,
    },
    connect: { isConnected: false, accountLabel: null, connectedAt: null, disconnectedAt: null },
    flags: {
      refundWindowOpen: true,
      refundEligibleUntil: "2026-10-21",
      refundDue: false,
      stuckRequests: 1,
      pendingLocation: { locationNumber: 2, chargedAt: "2026-10-08T10:00:00.000Z" },
      pendingPlanChange: { planId: "voice-webchat-700-300", interval: "year" },
    },
    ...overrides,
  };
}

describe("the billing panel's readers are strict", () => {
  test("a well-formed view is read, with dates for the screen and the instants the panel sends back", async () => {
    reply({ data: billingView() });
    const result = await fetchClinicBilling(CLINIC);
    expect(sent).toEqual([{ op: "getClinicBilling", args: { clinicId: CLINIC } }]);
    if (!result.ok) throw new Error(result.message);
    const view = result.data;
    expect(view.clinic).toMatchObject({ isLocation: true, billingClinicId: BILLING });
    expect(view.group[0]!.channels[1]).toEqual({
      channel: "voice",
      enabled: true,
      status: "waiting",
      readyOn: "2026-10-07",
      waitingOn: "forwarding",
      liveOn: null,
      firstAnswerOn: null,
    });
    expect(view.entitlements).toMatchObject({
      boughtPlan: { id: "voice-metachat-500-300", name: "AYA Voice + Meta Chat, 500 minutes and 300 conversations" },
      billedPlan: { id: "webchat-300", name: "AYA Web Chat, 300 conversations" },
      planStartedAt: "2026-10-07 00:00 UTC",
      paidThroughOn: "2026-11-07",
      setupDeadlineAt: "2026-11-05 23:59 UTC",
      setupDeadlineIso: "2026-11-05T23:59:59.999Z",
      openInvoice: { url: "https://invoice.stripe.com/i/acct_x/test_y", amountCents: 89700 },
    });
    expect(view.entitlements!.boughtPlan!.name).not.toBe("voice-metachat-500-300");
    expect(view.overageInvoices[0]).toMatchObject({
      windowStartIso: "2026-09-01T00:00:00.000Z",
      windowStartOn: "2026-09-01",
      code: "card_error:card_declined",
    });
    expect(view.attentionEvents[0]).toMatchObject({
      stripeEventId: "evt_1PxAbC",
      code: "UnresolvedClinicError",
      receivedAt: "2026-10-08 10:00 UTC",
    });
    expect(view.deposits.defaultAmountUsd).toBe(50.5);
    expect(view.flags.pendingLocation).toEqual({ locationNumber: 2, chargedOn: "2026-10-08" });
    expect(view.flags.pendingPlanChange).toEqual({
      plan: { id: "voice-webchat-700-300", name: "AYA Voice + Web Chat, 700 minutes and 300 conversations" },
      interval: "year",
    });
  });

  test("a 5 October package the catalog no longer knows is shown by its id, never a blank", async () => {
    reply({
      data: billingView({
        entitlements: { ...(billingView().entitlements as object), boughtPlanId: "complete", billedPlanId: "complete" },
      }),
    });
    const result = await fetchClinicBilling(CLINIC);
    if (!result.ok) throw new Error(result.message);
    expect(result.data.entitlements!.boughtPlan).toEqual({ id: "complete", name: "complete" });
  });

  test("a pending plan change missing from an older apps/app reads as none", async () => {
    const flags = { ...(billingView().flags as Record<string, unknown>) };
    delete flags.pendingPlanChange;
    reply({ data: billingView({ flags }) });
    const result = await fetchClinicBilling(CLINIC);
    expect(result.ok && result.data.flags.pendingPlanChange).toBeNull();
  });

  test.each([
    [
      "an open invoice link off Stripe's invoice hosts",
      {
        entitlements: {
          ...(billingView().entitlements as object),
          openInvoice: { url: "https://evil.example/pay", amountCents: 1 },
        },
      },
    ],
    [
      "a plain-http invoice link",
      {
        entitlements: {
          ...(billingView().entitlements as object),
          openInvoice: { url: "http://invoice.stripe.com/i/x", amountCents: 1 },
        },
      },
    ],
    [
      "an event id that is not Stripe's",
      {
        attentionEvents: [
          { ...(billingView().attentionEvents as object[])[0], stripeEventId: "1PxAbC" },
        ],
      },
    ],
    [
      "an event code that is prose",
      {
        attentionEvents: [
          {
            ...(billingView().attentionEvents as object[])[0],
            code: "Error: card 4242 for jane@example.com",
          },
        ],
      },
    ],
    [
      "a status outside the vocabulary",
      { entitlements: { ...(billingView().entitlements as object), status: "frozen" } },
    ],
    [
      "a notice kind with spaces",
      { notices: [{ ...(billingView().notices as object[])[0], kind: "payment failed" }] },
    ],
    [
      "a date that is not toISOString's",
      { transitions: [{ ...(billingView().transitions as object[])[0], createdAt: "8 October" }] },
    ],
    [
      "a direct line that is not E.164",
      { settings: { ...(billingView().settings as object), directLineE164: "415 555 0199" } },
    ],
    ["a fractional count", { usage: [{ ...(billingView().usage as object[])[0], used: 1.5 }] }],
    [
      "a pending plan change on an interval outside the vocabulary",
      {
        flags: {
          ...(billingView().flags as object),
          pendingPlanChange: { planId: "voice-webchat-700-300", interval: "weekly" },
        },
      },
    ],
    ["a missing flags block", { flags: undefined }],
  ])("refuses %s: the whole panel shows the malformed state", async (_label, overrides) => {
    reply({ data: billingView(overrides) });
    expect(await fetchClinicBilling(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });

  test("a clinic with no billing row reads with null entitlements and no usage", async () => {
    reply({ data: billingView({ entitlements: null, usage: [] }) });
    const result = await fetchClinicBilling(CLINIC);
    expect(result.ok && result.data.entitlements).toBeNull();
  });
});

describe("the billing panel's writes", () => {
  test("a switch reads changed and auditRecorded, and carries upstream's refusal sentence", async () => {
    reply({ data: { status: "updated", changed: false, auditRecorded: true } });
    expect(await setClinicSettings(CLINIC, { aiPaused: true, aiPausedUntil: null })).toEqual({
      ok: true,
      data: { status: "updated", changed: false, auditRecorded: true },
    });
    expect(sent[0]).toEqual({
      op: "setClinicSettings",
      args: { clinicId: CLINIC, aiPaused: true, aiPausedUntil: null },
    });
    reply({
      data: { status: "error", message: "A pause's end is chosen when pausing the assistant." },
    });
    expect(await setClinicSettings(CLINIC, { aiPausedUntil: null })).toEqual({
      ok: true,
      data: { status: "refused", message: "A pause's end is chosen when pausing the assistant." },
    });
    reply({ data: { status: "updated", changed: "yes", auditRecorded: true } });
    expect(await setOverageMode(CLINIC, "allow")).toMatchObject({ ok: false, code: "malformed" });
  });

  test("an input object from the browser cannot point a write at another clinic", async () => {
    // A server action's argument is whatever the browser sent, types or not.
    const crafted = { clinicId: BILLING } as Record<string, unknown>;
    for (let i = 0; i < 4; i += 1) reply({ data: { status: "error", message: "No." } });
    await setClinicSettings(CLINIC, { aiPaused: false, ...crafted });
    await setDepositSettings(CLINIC, { depositHoldMinutes: 60, ...crafted });
    await commitRefund(CLINIC, {
      kind: "guarantee",
      confirmAmountCents: 1,
      reason: "x",
      ...crafted,
    });
    await extendSetupDeadline(CLINIC, {
      days: 1,
      fromDeadline: "2026-11-05T23:59:59.999Z",
      ...crafted,
    });
    expect(sent.map((call) => [call.op, call.args.clinicId])).toEqual([
      ["setClinicSettings", CLINIC],
      ["setDepositSettings", CLINIC],
      ["commitRefund", CLINIC],
      ["extendSetupDeadline", CLINIC],
    ]);
  });

  test("a refund preview carries the invoices paid out of band, to settle by hand, and only invoice ids", async () => {
    // An invoice paid out of band comes through for the operator to settle by hand.
    reply({
      data: {
        status: "ok",
        kind: "agreement_terminated",
        amountCents: 53820,
        cancelsPlan: true,
        planStartedOn: "2026-10-01",
        windowEndsOn: "2026-10-12",
        settleByHand: { amountCents: 89700, invoiceIds: ["in_wired1"] },
      },
    });
    expect(await previewRefund(CLINIC, "agreement_terminated")).toMatchObject({
      ok: true,
      data: { settleByHand: { amountCents: 89700, invoiceIds: ["in_wired1"] } },
    });
    // Anything but an invoice id there is a shape error, not text on the screen.
    reply({
      data: {
        status: "ok",
        kind: "agreement_terminated",
        amountCents: 53820,
        cancelsPlan: true,
        planStartedOn: null,
        windowEndsOn: null,
        settleByHand: { amountCents: 89700, invoiceIds: ["<script>"] },
      },
    });
    expect(await previewRefund(CLINIC, "agreement_terminated")).toMatchObject({ ok: false });
  });

  test("the refund preview and commit are read exactly; a busy or failed commit is carried as a refusal", async () => {
    reply({
      data: {
        status: "ok",
        kind: "first_period_cancel",
        amountCents: 89700,
        cancelsPlan: true,
        planStartedOn: "2026-10-07",
        windowEndsOn: "2026-10-21",
      },
    });
    expect(await previewRefund(CLINIC, "first_period_cancel")).toEqual({
      ok: true,
      data: {
        status: "ok",
        kind: "first_period_cancel",
        amountCents: 89700,
        cancelsPlan: true,
        planStartedOn: "2026-10-07",
        windowEndsOn: "2026-10-21",
        settleByHand: null,
      },
    });
    reply({
      data: {
        status: "refunded",
        amountCents: 89700,
        refundedAt: "2026-10-10T12:00:00.000Z",
        isCancelRequested: true,
        auditRecorded: true,
      },
    });
    expect(
      await commitRefund(CLINIC, {
        kind: "first_period_cancel",
        confirmAmountCents: 89700,
        reason: "Asked to cancel",
      }),
    ).toEqual({
      ok: true,
      data: {
        status: "refunded",
        amountCents: 89700,
        refundedAt: "2026-10-10 12:00 UTC",
        isCancelRequested: true,
        auditRecorded: true,
      },
    });
    expect(sent[1]!.args).toEqual({
      clinicId: CLINIC,
      kind: "first_period_cancel",
      confirmAmountCents: 89700,
      reason: "Asked to cancel",
    });
    reply({ data: { status: "failed", message: "Stripe didn't complete the refund." } });
    expect(
      await commitRefund(CLINIC, { kind: "guarantee", confirmAmountCents: 1, reason: "x" }),
    ).toEqual({
      ok: true,
      data: { status: "refused", message: "Stripe didn't complete the refund." },
    });
  });

  test("a Connect link is accepted only on connect.stripe.com", async () => {
    const link =
      "https://connect.stripe.com/oauth/authorize?response_type=code&client_id=ca_x&state=abc";
    reply({
      data: { status: "issued", url: link, expiresAt: "2026-10-10 12:15 UTC", auditRecorded: true },
    });
    expect(await issueStripeConnectLink(CLINIC)).toEqual({
      ok: true,
      data: { status: "issued", url: link, expiresAt: "2026-10-10 12:15 UTC", auditRecorded: true },
    });
    reply({
      data: {
        status: "issued",
        url: "https://connect.stripe.example/oauth/authorize?state=abc",
        expiresAt: "2026-10-10 12:15 UTC",
        auditRecorded: true,
      },
    });
    expect(await issueStripeConnectLink(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });

  test("the closure always sends its confirmation, and the extension names the deadline it extends", async () => {
    reply({ data: { status: "recorded", isNew: true, isSwitchOn: false, auditRecorded: true } });
    expect(await closeUnfinishedSetup(CLINIC)).toMatchObject({
      ok: true,
      data: { status: "recorded", isNew: true, isSwitchOn: false },
    });
    expect(sent[0]).toEqual({
      op: "closeUnfinishedSetup",
      args: { clinicId: CLINIC, confirm: true },
    });

    reply({
      data: {
        status: "extended",
        setupDeadlineAt: "2026-11-12T23:59:59.999Z",
        auditRecorded: true,
      },
    });
    expect(
      await extendSetupDeadline(CLINIC, { days: 7, fromDeadline: "2026-11-05T23:59:59.999Z" }),
    ).toEqual({
      ok: true,
      data: { status: "extended", setupDeadlineAt: "2026-11-12 23:59 UTC", auditRecorded: true },
    });
    expect(sent[1]!.args).toEqual({
      clinicId: CLINIC,
      days: 7,
      fromDeadline: "2026-11-05T23:59:59.999Z",
    });
  });

  test("the location, overage and auto-renew readers check what they carry", async () => {
    reply({ data: { status: "added", clinicId: CLINIC, slug: "glow-2", auditRecorded: true } });
    expect(await retryLocationSetup(BILLING)).toMatchObject({
      ok: true,
      data: { status: "added", slug: "glow-2" },
    });
    reply({ data: { status: "pending_setup", message: "It stays pending." } });
    expect(await retryLocationSetup(BILLING)).toEqual({
      ok: true,
      data: { status: "refused", message: "It stays pending." },
    });
    reply({
      data: {
        status: "invoiced",
        amountCents: 960,
        hostedInvoiceUrl: "https://pay.stripe.com/invoice/x",
        auditRecorded: true,
      },
    });
    expect(await retryOverageInvoice(CLINIC, "2026-09-01T00:00:00.000Z")).toMatchObject({
      ok: true,
      data: { status: "invoiced", hostedInvoiceUrl: "https://pay.stripe.com/invoice/x" },
    });
    reply({ data: { status: "ok", closesOn: "2026-11-07", changed: true, auditRecorded: false } });
    expect(await setAutoRenew(CLINIC, false)).toEqual({
      ok: true,
      data: { status: "ok", closesOn: "2026-11-07", changed: true, auditRecorded: false },
    });
    reply({ data: { status: "ok", closesOn: "7 November", changed: true, auditRecorded: true } });
    expect(await setAutoRenew(CLINIC, false)).toMatchObject({ ok: false, code: "malformed" });
    // Whether anything changed is part of the answer, not optional.
    reply({ data: { status: "ok", closesOn: null, auditRecorded: true } });
    expect(await setAutoRenew(CLINIC, true)).toMatchObject({ ok: false, code: "malformed" });
  });
});

// -----------------------------------------------------------------------------
// The booking card (plan §10, C17)
// -----------------------------------------------------------------------------

describe("the booking card reads the derived mode, and switches only Auto-confirm", () => {
  test("getOnboarding's booking is read field by field, instants in the console's UTC form", async () => {
    reply(onboardingWith("Hi"));
    const view = await fetchOnboarding(CLINIC);
    if (!view.ok) throw new Error(view.message);
    expect(view.data.booking).toEqual({
      ...BOOKING,
      autoConfirmChangedAt: "2026-10-11 09:30 UTC",
      terms: { ...BOOKING.terms, electedAt: "2026-10-08 09:00 UTC" },
      calendar: {
        ...BOOKING.calendar,
        connectedAt: "2026-10-08 09:05 UTC",
        lastVerifiedAt: "2026-10-12 08:00 UTC",
      },
    });
    // The direct-booking addendum's switch and gates are gone from the view.
    for (const key of ["bookingMode", "directBooking", "calendarConnection"]) {
      expect(view.data, key).not.toHaveProperty(key);
    }
  });

  test("no terms and no calendar read as such; an older apps/app's missing booking reads as null", async () => {
    reply(
      onboardingWith("Hi", {
        ...BOOKING,
        canOfferTimes: false,
        terms: {
          kind: "none",
          source: null,
          clauseId: null,
          documentVersion: null,
          documentReleased: null,
          electedAt: null,
          reason: "no_agreement",
        },
        calendar: null,
      }),
    );
    const bare = await fetchOnboarding(CLINIC);
    if (!bare.ok) throw new Error(bare.message);
    expect(bare.data.booking).toMatchObject({
      terms: { kind: "none", source: null, reason: "no_agreement" },
      calendar: null,
    });

    const fromOlder = onboardingWith("Hi") as { data: Record<string, unknown> };
    delete fromOlder.data.booking;
    reply(fromOlder);
    const older = await fetchOnboarding(CLINIC);
    if (!older.ok) throw new Error(older.message);
    expect(older.data.booking).toBeNull();
  });

  test("a mode, a terms kind or a reason it cannot read leaves the booking unreadable, never a guessed mode, and the rest of the page read", async () => {
    for (const booking of [
      { ...BOOKING, mode: "direct" },
      { ...BOOKING, terms: { ...BOOKING.terms, kind: "legacy" } },
      { ...BOOKING, reasons: [{ code: "Kill Switch", sentence: "x" }] },
      { ...BOOKING, calendar: { ...BOOKING.calendar, status: "connected" } },
      { ...BOOKING, pendingAssistantWrites: -1 },
      { ...BOOKING, killSwitchOn: "false" },
      null,
    ]) {
      reply(onboardingWith("Hi", booking));
      const view = await fetchOnboarding(CLINIC);
      if (!view.ok) throw new Error(`${JSON.stringify(booking)}: ${view.message}`);
      expect(view.data.booking, JSON.stringify(booking)).toBe("unreadable");
      expect(view.data.agent?.greeting).toBe("Hi");
    }
    // The rest of the page is as strict as it was.
    const broken = onboardingWith("Hi") as { data: Record<string, unknown> };
    broken.data.calendarWrites = "none";
    reply(broken);
    expect(await fetchOnboarding(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });

  test("setAutoConfirm sends the page's clinic and a boolean, and reads the mode it leaves", async () => {
    reply({
      data: {
        status: "updated",
        changed: true,
        autoConfirm: false,
        mode: "manual",
        reasons: BOOKING.reasons,
        auditRecorded: true,
      },
    });
    expect(await setAutoConfirm(CLINIC, false)).toEqual({
      ok: true,
      data: {
        status: "updated",
        changed: true,
        autoConfirm: false,
        mode: "manual",
        reasons: BOOKING.reasons,
        auditRecorded: true,
      },
    });
    expect(sent.at(-1)).toEqual({ op: "setAutoConfirm", args: { clinicId: CLINIC, on: false } });
    reply({ data: { status: "error", message: "Auto-confirm is on or off." } });
    expect(await setAutoConfirm(CLINIC, true)).toEqual({
      ok: true,
      data: { status: "refused", message: "Auto-confirm is on or off." },
    });
  });

  test("the calendar link takes no recipient, and shows a URL only when apps/app sends one", async () => {
    const issued = {
      status: "issued",
      expiresAt: "2026-10-19 09:00 UTC",
      delivery: { sent: 1, failed: 0, recipients: 1 },
      auditRecorded: true,
    };
    reply({ data: issued });
    expect(await issueCalendarLink(CLINIC)).toEqual({
      ok: true,
      data: { ...issued, url: null },
    });
    expect(sent.at(-1)).toEqual({ op: "issueCalendarLink", args: { clinicId: CLINIC } });

    // The demo clinic's, for Google's verification video.
    const demo = "https://app.healdesk.test/calendar/abc";
    reply({ data: { ...issued, url: demo } });
    expect(await issueCalendarLink(CLINIC)).toMatchObject({ ok: true, data: { url: demo } });
    reply({ data: { ...issued, url: "javascript:alert(1)" } });
    expect(await issueCalendarLink(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
    reply({ data: { status: "error", message: "No agreement is in effect." } });
    expect(await issueCalendarLink(CLINIC)).toEqual({
      ok: true,
      data: { status: "refused", message: "No agreement is in effect." },
    });
  });

  test("a disconnect reads disconnected, not connected, or the refusal", async () => {
    reply({ data: { status: "disconnected", revokedAtGoogle: false, auditRecorded: true } });
    expect(await disconnectCalendar(CLINIC)).toEqual({
      ok: true,
      data: { status: "disconnected", revokedAtGoogle: false, auditRecorded: true },
    });
    reply({ data: { status: "not_connected" } });
    expect(await disconnectCalendar(CLINIC)).toEqual({
      ok: true,
      data: { status: "not_connected" },
    });
    reply({ data: { status: "error", message: "No such clinic." } });
    expect(await disconnectCalendar(CLINIC)).toEqual({
      ok: true,
      data: { status: "refused", message: "No such clinic." },
    });
    expect(sent.map((call) => call.op)).toEqual([
      "disconnectCalendar",
      "disconnectCalendar",
      "disconnectCalendar",
    ]);
  });

  test("the direct-booking switch is gone from the client", () => {
    expect(opsClient).not.toHaveProperty("setBookingMode");
    expect(opsClient).not.toHaveProperty("DIRECT_BOOKING_GATES");
  });
});

// -----------------------------------------------------------------------------
// Patient rights: nothing of a patient goes up, and nothing typed comes back
// -----------------------------------------------------------------------------

describe("the care page's patient-rights operations carry no patient data (review of 12 October 2026)", () => {
  const ERASURE = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";

  function careReply(deletionRequest: Record<string, unknown>) {
    return {
      data: {
        clinic: {
          id: CLINIC,
          slug: "care-clinic",
          name: "Care Clinic",
          dataClassification: "synthetic",
          isCoveredEntity: true,
          wentLiveAt: null,
          offboardingStartedAt: null,
          exportDeliveredAt: null,
          destroyAfter: null,
          destroyedAt: null,
          destruction: null,
          voiceVendorDeletion: null,
        },
        patientRights: { amendments: 2, corrections: 1 },
        deletionRequests: [
          {
            id: ERASURE,
            requestedBy: "The person, through the practice",
            receivedAt: "2026-10-05T09:00:00.000Z",
            dueBy: "2026-10-19T09:00:00.000Z",
            erasedAt: "2026-10-05T10:00:00.000Z",
            deleted: { contacts: 1, conversations: 2 },
            restoreRecordUntil: "2026-11-09T10:00:00.000Z",
            steps: [
              {
                id: "retell",
                label: "Retell (the voice vendor): delete the person's calls and transcripts in Retell's console",
                stampedAt: "2026-10-06T10:00:00.000Z",
                stampedBy: "ops@healdesk.test",
                how: "Deleted in the vendor's console",
              },
            ],
            ...deletionRequest,
          },
        ],
        recipients: [],
        deliveries: [],
        incidents: [],
      },
    };
  }

  test("the deletion, amendments and corrections are gone from the client: they run in apps/app's shell", () => {
    for (const name of ["erasePerson", "amendRecord", "amendContact", "ERASURE_REQUESTERS"]) {
      expect(opsClient, name).not.toHaveProperty(name);
    }
    // And no operation by those names can be sent at all.
    const source = readFileSync(fileURLToPath(new URL("./ops-client.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/"(erasePerson|amendRecord|amendContact)"/);
  });

  test("a step's stamp sends exactly the clinic, the request, the step and a closed outcome", async () => {
    reply({ data: { status: "updated" } });
    expect(await opsClient.markErasureVendorDeleted(CLINIC, ERASURE, "retell", "nothing_held")).toEqual({
      ok: true,
      data: { status: "updated" },
    });
    // A field added here, or a typed outcome, fails this: the function takes
    // ids and the closed set, nothing a number or words could ride in.
    expect(opsClient.markErasureVendorDeleted.length).toBe(4);
    expect(sent).toEqual([
      {
        op: "markErasureVendorDeleted",
        args: { clinicId: CLINIC, erasureId: ERASURE, step: "retell", how: "nothing_held" },
      },
    ]);
  });

  test("the care view is read with who asked and each outcome from the closed sets, and refused with anything typed", async () => {
    reply(careReply({}));
    const read = await opsClient.fetchClinicCare(CLINIC);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.data.patientRights).toEqual({ amendments: 2, corrections: 1 });
      expect(read.data.deletionRequests[0]).toMatchObject({
        requestedBy: "The person, through the practice",
        rows: 3,
      });
    }
    for (const typed of [
      { requestedBy: "Jane Doe's mother, by telephone" },
      {
        steps: [
          {
            id: "retell",
            label: "Retell",
            stampedAt: "2026-10-06T10:00:00.000Z",
            stampedBy: "ops@healdesk.test",
            how: "deleted Jane's two calls",
          },
        ],
      },
    ]) {
      reply(careReply(typed));
      const refused = await opsClient.fetchClinicCare(CLINIC);
      expect(refused.ok, JSON.stringify(typed)).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// The clinic's Instagram, Messenger and WhatsApp switches
// -----------------------------------------------------------------------------

describe("the Meta platform switches cross as three flags, and one op switches one", () => {
  test("getOnboarding reads the three flags as booleans, and an older apps/app's missing ones as null", async () => {
    reply(onboardingWith("Hi"));
    const view = await fetchOnboarding(CLINIC);
    if (!view.ok) throw new Error(view.message);
    expect(view.data.meta.platforms).toEqual({ instagram: true, messenger: false, whatsapp: true });

    const older = onboardingWith("Hi") as { data: { meta: Record<string, unknown> } };
    delete older.data.meta.platforms;
    reply(older);
    const bare = await fetchOnboarding(CLINIC);
    if (!bare.ok) throw new Error(bare.message);
    expect(bare.data.meta.platforms).toBeNull();
  });

  test("a flag that is not a boolean is refused rather than shown as a switch", async () => {
    const odd = onboardingWith("Hi") as { data: { meta: Record<string, unknown> } };
    odd.data.meta.platforms = { instagram: "yes", messenger: false, whatsapp: true };
    reply(odd);
    expect(await fetchOnboarding(CLINIC)).toMatchObject({ ok: false });
  });

  test("setMetaPlatform sends the clinic, the platform and on or off, and nothing else", async () => {
    reply({ data: { status: "updated" } });
    expect(await setMetaPlatform(CLINIC, "whatsapp", false)).toMatchObject({ ok: true });
    expect(sent).toEqual([
      { op: "setMetaPlatform", args: { clinicId: CLINIC, platform: "whatsapp", enabled: false } },
    ]);
  });
});

describe("the first-weeks list", () => {
  function healthRow(plan: string | null) {
    return {
      clinicId: CLINIC,
      slug: "radiance",
      name: "Radiance",
      plan,
      wentLiveAt: "2026-10-07T00:00:00.000Z",
      daysLive: 6,
      conversations: { total: 3, last7: 3 },
      recovered: { total: 0, last7: 0 },
      bookings: 1,
      firstRecoveredBookingAt: null,
      lastConversationAt: null,
      recipients: 1,
      forwardingTested: true,
      connected: true,
      usage: null,
      touches: [],
      flags: [],
    };
  }

  test("names a clinic's plan as the catalog does, and an id it no longer knows as itself", async () => {
    reply({ data: { clinics: [healthRow("voice-500"), healthRow("complete"), healthRow(null)] } });
    const result = await fetchClinicHealth();
    if (!result.ok) throw new Error(result.message);
    expect(result.data.map((row) => row.plan)).toEqual(["AYA Voice, 500 minutes", "complete", null]);
  });
});

/**
 * The owner's direct-booking switch, for the purchase funnel's step 2. It is
 * apps/app's one reader's answer, carried across without a session; anything
 * but a clear "on" is off, and the answer is remembered for five minutes so a
 * public page cannot make every visitor a request to apps/app.
 */
describe("directBookingOpen", () => {
  const MINUTE = 60_000;

  beforeEach(() => {
    opsClient.__resetBookingSwitchForTests();
  });

  test("asks apps/app as a relay, with no browser context, and carries its answer", async () => {
    reply({ data: { directBooking: true } });
    expect(await opsClient.directBookingOpen(0)).toBe(true);
    expect(sent).toEqual([{ op: "bookingSwitch", args: {} }]);
    const init = vi.mocked(fetch).mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body)).not.toHaveProperty("context");
  });

  test("off when apps/app says off", async () => {
    reply({ data: { directBooking: false } });
    expect(await opsClient.directBookingOpen(0)).toBe(false);
  });

  test("off, and nothing asked, on a deployment that cannot ask", async () => {
    vi.stubEnv("HEALDESK_APP_URL", "");
    expect(await opsClient.directBookingOpen(0)).toBe(false);
    expect(sent).toEqual([]);
  });

  test("off when apps/app fails, is unreachable or answers something else", async () => {
    reply({ error: "The operations API is unavailable.", code: "unavailable" }, 503);
    expect(await opsClient.directBookingOpen(0)).toBe(false);
    opsClient.__resetBookingSwitchForTests();
    reply({ data: { directBooking: "true" } });
    expect(await opsClient.directBookingOpen(0)).toBe(false);
    opsClient.__resetBookingSwitchForTests();
    // No reply stubbed: the fetch throws, as an unreachable host does.
    expect(await opsClient.directBookingOpen(0)).toBe(false);
  });

  test("remembers the answer, success or failure, for five minutes", async () => {
    reply({ data: { directBooking: true } });
    expect(await opsClient.directBookingOpen(0)).toBe(true);
    expect(await opsClient.directBookingOpen(4 * MINUTE)).toBe(true);
    expect(sent).toHaveLength(1);
    reply({ data: { directBooking: false } });
    expect(await opsClient.directBookingOpen(5 * MINUTE)).toBe(false);
    expect(sent).toHaveLength(2);
  });

  test("one question in flight, however many ask at once", async () => {
    reply({ data: { directBooking: true } });
    expect(await Promise.all([opsClient.directBookingOpen(0), opsClient.directBookingOpen(0)])).toEqual([true, true]);
    expect(sent).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BILLING_NOTICE_KINDS,
  type BillingNoticeKind,
  type NoticePayloads,
} from "@/lib/billing/notices";
import { assertPayloadAllowed } from "@/lib/email/lint";

/**
 * The notice payloads' final shapes (build spec §11, with R31 on top), held to
 * the email platform's payload allowlist.
 *
 * A notice's payload is a jsonb column, and the sender refuses to render one
 * holding any key the allowlist (lib/email/lint.ts) does not class: a key that
 * fails here would leave every such notice unsendable in production, found
 * only when the first clinic's payment fails. The fixtures are typed against
 * NoticePayloads, so a shape that changes without its fixture fails the
 * typecheck, and a fixture whose key the allowlist refuses fails this test.
 */

const INVOICE_URL = "https://invoice.stripe.com/i/acct_testplatform/test_invoice";
const RECEIPT_URL = "https://pay.stripe.com/receipts/invoices/test_receipt";

const FIXTURES: { [K in BillingNoticeKind]: NoticePayloads[K] } = {
  payment_failed: {
    amountDueCents: 89_700,
    hostedInvoiceUrl: INVOICE_URL,
    graceEndsAt: "2026-10-13T09:00:00.000Z",
    isFirstPlanCharge: true,
  },
  payment_action_required: { amountDueCents: 89_700, hostedInvoiceUrl: INVOICE_URL },
  grace_ending: {
    graceEndsAt: "2026-10-13T09:00:00.000Z",
    hostedInvoiceUrl: null,
    amountDueCents: 89_700,
  },
  suspended: {
    kind: "grace_expired",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
    carrier: "verizon",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  },
  restored: { receiptUrl: RECEIPT_URL },
  cancel_scheduled: {
    endsAt: "2026-11-10T00:00:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: "2026-10-24",
    graceEndsAt: "2026-10-17T09:00:00.000Z",
  },
  cancel_reversed: { isBeforeStart: true },
  canceled: {
    passThroughDays: 30,
    endedAt: "2026-11-10T00:00:00.000Z",
    isBeforeStart: false,
    channels: ["web", "voice"],
    exportByOn: "2026-12-10",
    destroyByOn: "2026-12-10",
    carrier: null,
    phoneSystem: "unknown",
    routing: "all_calls",
  },
  renewal_upcoming: {
    renewsOn: "2027-10-10",
    amountCents: 1_148_400,
    planName: "Complete FrontDesk AI",
    locations: 1,
    noticeDays: 30,
  },
  // Overage is billed per started block of 100 (6 October 2026): the alerts
  // quote a block's price, and the invoice notice counts blocks.
  usage_80: {
    meter: "voice_minutes",
    used: 800,
    included: 1_000,
    windowEndsOn: "2026-11-10",
    overageMode: "allow",
    blockRateCents: 8_000,
  },
  usage_100: {
    meter: "chat_conversations",
    used: 2_000,
    included: 2_000,
    windowEndsOn: "2026-11-10",
    overageMode: "hard_cap",
    blockRateCents: 3_000,
  },
  overage_invoiced: {
    amountCents: 8_000,
    windowStart: "2026-10-10T00:00:00.000Z",
    windowEnd: "2026-11-10T00:00:00.000Z",
    voiceMinutes: 30,
    chatConversationsCount: 0,
    voiceBlocksCount: 1,
    chatBlocksCount: 0,
    voiceBlockRateCents: 8_000,
    chatBlockRateCents: 3_000,
    hostedInvoiceUrl: INVOICE_URL,
    isPaid: false,
  },
  // Voice kept, so no forwarding facts ride along: the shape every plan
  // change has unless it drops voice.
  plan_changed: {
    planName: "Web + Voice",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 50_000,
    hostedInvoiceUrl: INVOICE_URL,
    hasDroppedChannels: false,
    isBeforeStart: false,
    billedPlanId: "web-voice",
    isProrated: true,
  },
  location_added: {
    locations: 2,
    recurringCents: 89_700,
    setupFeeCents: 99_700,
    hostedInvoiceUrl: INVOICE_URL,
    isBeforeStart: true,
    billedPlanId: null,
  },
  connect_disconnected: {
    disconnectedAt: "2026-10-20T15:04:05.000Z",
    wasByWebhook: true,
    source: "stripe",
    hasUncheckedLinks: true,
  },
  plan_started: {
    planName: "Web Chatbot",
    boughtPlanId: "complete",
    channel: "web",
    amountCents: 39_700,
    interval: "month",
    startedOn: "2026-10-10",
    periodEndsOn: "2026-11-10",
    receiptUrl: RECEIPT_URL,
    isBilledByChannelsInService: true,
  },
  price_stepped_up: {
    channel: "voice",
    planName: "Web + Voice",
    amountCents: 89_700,
    interval: "month",
    isInvoicedNow: false,
    hostedInvoiceUrl: null,
    isPaid: false,
  },
  step_up_reminder: {
    channel: "voice",
    joinsOn: "2026-11-09",
    planName: "Web + Voice",
    amountCents: 89_700,
    interval: "month",
    waitingOn: "forwarding",
  },
  allowance_fallback: { meter: "chat_conversations", included: 2_000, windowEndsOn: "2026-11-10" },
  receipt: {
    amountCents: 89_700,
    hostedInvoiceUrl: INVOICE_URL,
    periodStartsOn: "2026-10-10",
    periodEndsOn: "2026-11-10",
  },
  refund_issued: {
    amountCents: 39_700,
    kind: "first_period_cancel",
    refundedAt: "2026-10-15T10:00:00.000Z",
  },
  card_expiring: {
    cardMasked: "Visa •••• 4242",
    cardExpiresOn: "2026-10-31",
    renewsOn: "2026-11-10",
  },
  connect_connected: { connectedAt: "2026-10-08T12:00:00.000Z", source: "portal" },
};

/**
 * The keys R31 adds for the undo-forwarding steps and L4's outstanding action.
 * They are category keys in lint.ts now, and lint.ts checks category keys
 * before its "…At/…On" date rule, so `waitingOn` is no longer read as a date.
 * Holding these kinds out of the check is what had hidden that bug, so every
 * kind is checked.
 */
const R31_KEYS = ["carrier", "phoneSystem", "routing", "waitingOn"];

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
  vi.stubEnv("HEALDESK_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the notice payloads", () => {
  test("every kind in the registry has a fixture of its final shape", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...BILLING_NOTICE_KINDS].sort());
  });

  test("every payload passes the email platform's allowlist", () => {
    for (const kind of BILLING_NOTICE_KINDS) {
      expect(() => assertPayloadAllowed(FIXTURES[kind], kind), kind).not.toThrow();
    }
  });

  test("the R31 keys are read as categories, never as dates", () => {
    // waitingOn ends in "On"; before lint.ts checked category keys first it was
    // classed as a date and every step-up reminder was refused when sent.
    for (const key of R31_KEYS) {
      expect(() => assertPayloadAllowed({ [key]: "voice" }), key).not.toThrow();
    }
    expect(() => assertPayloadAllowed({ waitingOn: "2026-10-08" })).not.toThrow();
    expect(() => assertPayloadAllowed({ waitingOn: "a sentence" })).toThrow();
  });

  test("no payload carries a field the allowlist would read as free text", () => {
    // `reason` is not a category key (use `kind`), and a date must end in At or
    // On: the two traps a payload written from the spec's prose falls into.
    for (const kind of BILLING_NOTICE_KINDS) {
      const keys = Object.keys(FIXTURES[kind]);
      expect(keys, kind).not.toContain("reason");
      expect(
        keys.filter((key) => /Until$|Label$/.test(key)),
        kind,
      ).toEqual([]);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { forwardingInstructions, type Carrier, type PhoneSystemType } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CoverageMode } from "@/lib/billing/answering";
import type { BillingNoticeKind, NoticePayloads } from "@/lib/billing/notices";
import { carriesUnsubscribe } from "@/lib/email/kind-rules";
import { NOTICE_KIND_REGISTRY, NOTICE_KINDS } from "@/lib/email/kinds";
import {
  assertPayloadAllowed,
  copyProblems,
  findLinks,
  linkProblems,
  PayloadNotAllowedError,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import {
  dayLong,
  dayShort,
  money,
  momentLong,
  monthAndYear,
  plusDays,
} from "@/lib/email/templates/billing-copy";
import { REPLY_LINES } from "@/lib/email/templates/compose";
import { clinicReason } from "@/lib/email/templates/context";
import { PENDING_TEMPLATES, TEMPLATES } from "@/lib/email/templates/registry";
import type { EmailAudience, RenderedEmail, TemplateContext } from "@/lib/email/templates/types";

/**
 * The billing emails (Annex X5: L2–L4, L19, L27, E1, E2, O14): every Package C
 * and D notice kind except the two usage alerts, which wait for the funnel's
 * stop-link page (M3).
 *
 * tests/email-templates.test.ts snapshots each kind's registered fixture and
 * holds it to the platform's lints. This file renders every branch each
 * template has (a first plan charge, a suspension with no invoice to point
 * at, a plan start billed by the channels in service, each carrier's undo
 * steps, each waiting state), holds every one of them to the same lints for
 * both audiences, snapshots the words, and checks the rules the lints cannot
 * see: undo codes only from the catalog, links only to Stripe's hosted pages
 * and the portal, dates in the clinic's own time zone, and nothing read from
 * the clock.
 */

const ORIGIN = "https://app.healdesk.test";
const PORTAL = `${ORIGIN}/`;
const INVOICE_URL = "https://invoice.stripe.com/i/acct_testplatform/test_invoice";
const RECEIPT_URL = "https://pay.stripe.com/receipts/invoices/test_receipt";
const RAISED_AT = new Date("2026-10-06T14:32:00Z");

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("HEALDESK_APP_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function contextFor(
  audience: EmailAudience = "patients",
  overrides: Partial<TemplateContext> = {},
): TemplateContext {
  return {
    clinicName: "Radiance Med Spa",
    audience,
    reason: clinicReason("Radiance Med Spa"),
    raisedAt: RAISED_AT,
    timeZone: "America/New_York",
    ...overrides,
  };
}

/**
 * The kinds this package templates: Package C's and D's, the usage alerts
 * included since 13 October 2026 (their stop-link page shipped on 8 October).
 */
const BILLING_KINDS = NOTICE_KINDS.filter(
  (kind) =>
    NOTICE_KIND_REGISTRY[kind].owner === "package_c" ||
    NOTICE_KIND_REGISTRY[kind].owner === "package_d",
);
// The billing payload map's kinds: the outbox registry holds the plan's own
// kinds too (the setup emails), which lib/notices/plan-notices.ts types.
type BillingKind = BillingNoticeKind;

type Variant = { name: string; kind: BillingKind; payload: Record<string, unknown> };

function variant<K extends BillingKind>(
  name: string,
  kind: K,
  payload: NoticePayloads[K],
): Variant {
  return { name, kind, payload: payload as Record<string, unknown> };
}

function render(v: Variant, ctx: TemplateContext = contextFor()): RenderedEmail {
  const entry = TEMPLATES[v.kind];
  if (!entry) throw new Error(`${v.kind} has no template`);
  return entry.render(v.payload, ctx);
}

const VARIANTS: Variant[] = [
  variant("a renewal that failed, with grace", "payment_failed", {
    amountDueCents: 89_700,
    hostedInvoiceUrl: INVOICE_URL,
    graceEndsAt: "2026-10-13T14:32:00.000Z",
    isFirstPlanCharge: false,
  }),
  variant("the first plan charge failed", "payment_failed", {
    amountDueCents: 39_700,
    hostedInvoiceUrl: INVOICE_URL,
    graceEndsAt: "2026-10-13T14:32:00.000Z",
    isFirstPlanCharge: true,
  }),
  variant("a failure with no invoice link and no grace", "payment_failed", {
    amountDueCents: 89_750,
    hostedInvoiceUrl: null,
    graceEndsAt: null,
    isFirstPlanCharge: false,
  }),
  variant("the bank asks for a check", "payment_action_required", {
    amountDueCents: 89_700,
    hostedInvoiceUrl: INVOICE_URL,
  }),
  variant("a check with no invoice link", "payment_action_required", {
    amountDueCents: 89_700,
    hostedInvoiceUrl: null,
  }),
  variant("grace ends tomorrow", "grace_ending", {
    graceEndsAt: "2026-10-13T14:32:00.000Z",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
  }),
  variant("grace ends, amount and link unknown", "grace_ending", {
    graceEndsAt: "2026-10-13T02:00:00.000Z",
    hostedInvoiceUrl: null,
    amountDueCents: null,
  }),
  variant("suspended for an unpaid invoice, Verizon landline", "suspended", {
    kind: "grace_expired",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
    carrier: "verizon",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  }),
  variant("suspended with no invoice to point at, carrier unknown", "suspended", {
    kind: "grace_expired",
    hostedInvoiceUrl: null,
    amountDueCents: null,
    carrier: null,
    phoneSystem: "unknown",
    routing: "overflow_after_hours",
  }),
  variant("suspended, a cloud phone system", "suspended", {
    kind: "grace_expired",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
    carrier: "comcast",
    phoneSystem: "voip",
    routing: "all_calls",
  }),
  variant("suspended, T-Mobile forwarding every call", "suspended", {
    kind: "unpaid",
    hostedInvoiceUrl: null,
    amountDueCents: 89_700,
    carrier: "tmobile",
    phoneSystem: "landline",
    routing: "all_calls",
  }),
  variant("suspended, after hours only on a known carrier", "suspended", {
    kind: "grace_expired",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
    carrier: "verizon",
    phoneSystem: "landline",
    routing: "after_hours_only",
  }),
  variant("suspended for a dispute, with an invoice still open", "suspended", {
    kind: "dispute",
    hostedInvoiceUrl: INVOICE_URL,
    amountDueCents: 89_700,
    carrier: "att",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  }),
  variant("suspended by the team, nothing owed", "suspended", {
    kind: "ops",
    hostedInvoiceUrl: null,
    amountDueCents: null,
    carrier: null,
    phoneSystem: "voip",
    routing: "all_calls",
  }),
  variant("restored, with its receipt", "restored", { receiptUrl: RECEIPT_URL }),
  variant("restored, no receipt link", "restored", { receiptUrl: null }),
  variant("auto-renew off inside the refund window", "cancel_scheduled", {
    endsAt: "2026-11-06T14:32:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: "2026-10-20",
    graceEndsAt: null,
  }),
  variant("auto-renew off after the refund window", "cancel_scheduled", {
    endsAt: "2027-01-06T14:32:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: null,
    graceEndsAt: null,
  }),
  variant("auto-renew off before the plan starts", "cancel_scheduled", {
    endsAt: "2026-11-05T14:32:00.000Z",
    isBeforeStart: true,
    refundWindowEndsOn: null,
    graceEndsAt: null,
  }),
  variant("auto-renew off while the first invoice is unpaid", "cancel_scheduled", {
    endsAt: "2026-11-06T14:32:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: null,
    graceEndsAt: "2026-10-13T14:32:00.000Z",
  }),
  variant("auto-renew off with grace that outlasts the plan", "cancel_scheduled", {
    endsAt: "2026-10-09T14:32:00.000Z",
    isBeforeStart: false,
    refundWindowEndsOn: null,
    graceEndsAt: "2026-10-13T14:32:00.000Z",
  }),
  variant("auto-renew back on before the start", "cancel_reversed", { isBeforeStart: true }),
  variant("auto-renew back on after the start", "cancel_reversed", { isBeforeStart: false }),
  variant("service ended: website chat and phone, AT&T all calls", "canceled", {
    passThroughDays: 30,
    endedAt: "2026-11-06T14:32:00.000Z",
    isBeforeStart: false,
    channels: ["web", "voice"],
    exportByOn: "2026-12-06",
    destroyByOn: "2027-02-04",
    carrier: "att",
    phoneSystem: "landline",
    routing: "all_calls",
  }),
  variant("service ended before the plan started: Meta only", "canceled", {
    passThroughDays: 30,
    endedAt: "2026-11-05T14:32:00.000Z",
    isBeforeStart: true,
    channels: ["meta"],
    exportByOn: "2026-12-05",
    destroyByOn: "2027-02-03",
    carrier: null,
    phoneSystem: "unknown",
    routing: "overflow_after_hours",
  }),
  variant("service ended: every channel, carrier 'other'", "canceled", {
    passThroughDays: 30,
    endedAt: "2026-12-20T14:32:00.000Z",
    isBeforeStart: false,
    channels: ["web", "meta", "voice"],
    exportByOn: "2027-01-19",
    destroyByOn: "2027-03-20",
    carrier: "other",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  }),
  variant("renewal in 30 days", "renewal_upcoming", {
    renewsOn: "2027-11-05",
    amountCents: 556_800,
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    locations: 1,
    noticeDays: 30,
  }),
  variant("renewal reminder at 21 days, three locations", "renewal_upcoming", {
    renewsOn: "2026-10-27",
    amountCents: 1_497_600,
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    locations: 3,
    noticeDays: 21,
  }),
  variant("overage on voice", "overage_invoiced", {
    amountCents: 10_400,
    windowStart: "2026-09-06T14:32:00.000Z",
    windowEnd: "2026-10-06T14:32:00.000Z",
    voiceMinutes: 30,
    chatConversationsCount: 0,
    voiceBlocksCount: 1,
    chatBlocksCount: 0,
    voiceBlockRateCents: 10_400,
    chatBlockRateCents: 5_200,
    hostedInvoiceUrl: INVOICE_URL,
    isPaid: true,
  }),
  variant("overage the card declined, left open to pay", "overage_invoiced", {
    amountCents: 10_400,
    windowStart: "2026-09-06T14:32:00.000Z",
    windowEnd: "2026-10-06T14:32:00.000Z",
    voiceMinutes: 30,
    chatConversationsCount: 0,
    voiceBlocksCount: 1,
    chatBlocksCount: 0,
    voiceBlockRateCents: 10_400,
    chatBlockRateCents: 5_200,
    hostedInvoiceUrl: INVOICE_URL,
    isPaid: false,
  }),
  variant("overage on both meters, no invoice link", "overage_invoiced", {
    amountCents: 26_000,
    windowStart: "2026-09-06T14:32:00.000Z",
    windowEnd: "2026-10-06T14:32:00.000Z",
    voiceMinutes: 1,
    chatConversationsCount: 201,
    voiceBlocksCount: 1,
    chatBlocksCount: 3,
    voiceBlockRateCents: 10_400,
    chatBlockRateCents: 5_200,
    hostedInvoiceUrl: null,
    isPaid: true,
  }),
  variant("plan changed after the start, billed by channels in service", "plan_changed", {
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 69_700,
    hostedInvoiceUrl: INVOICE_URL,
    hasDroppedChannels: false,
    isBeforeStart: false,
    billedPlanId: "webchat-300",
    isProrated: false,
  }),
  variant("plan changed after the start to annual billing, prorated", "plan_changed", {
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    interval: "year",
    locations: 1,
    setupFeeDeltaCents: 69_700,
    hostedInvoiceUrl: INVOICE_URL,
    hasDroppedChannels: false,
    isBeforeStart: false,
    billedPlanId: "webchat-300",
    isProrated: true,
  }),
  variant("plan changed before the start", "plan_changed", {
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 0,
    hostedInvoiceUrl: null,
    hasDroppedChannels: false,
    isBeforeStart: true,
    billedPlanId: null,
    isProrated: false,
  }),
  variant("plan changed before the start, annual, two locations", "plan_changed", {
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    interval: "year",
    locations: 2,
    setupFeeDeltaCents: 139_400,
    hostedInvoiceUrl: INVOICE_URL,
    hasDroppedChannels: false,
    isBeforeStart: true,
    billedPlanId: null,
    isProrated: false,
  }),
  variant("plan changed, the phone dropped", "plan_changed", {
    planName: "AYA Web Chat, 300 conversations",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 0,
    hostedInvoiceUrl: INVOICE_URL,
    hasDroppedChannels: true,
    isBeforeStart: false,
    billedPlanId: "webchat-300",
    isProrated: true,
    carrier: "spectrum",
    phoneSystem: "landline",
    routing: "overflow_after_hours",
  }),
  variant("plan changed, a channel dropped, named by its package alone", "plan_changed", {
    planName: "AYA Meta Chat",
    interval: "month",
    locations: 1,
    setupFeeDeltaCents: 0,
    hostedInvoiceUrl: null,
    hasDroppedChannels: true,
    isBeforeStart: false,
    billedPlanId: null,
    isProrated: false,
  }),
  variant("a location added after the start", "location_added", {
    locations: 2,
    recurringCents: 52_000,
    setupFeeCents: 95_600,
    hostedInvoiceUrl: INVOICE_URL,
    isBeforeStart: false,
    billedPlanId: "voice-webchat-500-300",
  }),
  variant("a location added before the start, no invoice link", "location_added", {
    locations: 3,
    recurringCents: 12_000,
    setupFeeCents: 25_900,
    hostedInvoiceUrl: null,
    isBeforeStart: true,
    billedPlanId: null,
  }),
  variant("Stripe connected from the portal", "connect_connected", {
    connectedAt: "2026-10-06T14:20:00.000Z",
    source: "portal",
  }),
  variant("Stripe connected from an ops link", "connect_connected", {
    connectedAt: "2026-10-06T18:05:00.000Z",
    source: "ops",
  }),
  variant("Stripe disconnected from Stripe's side, with links still open", "connect_disconnected", {
    disconnectedAt: "2026-10-06T14:20:00.000Z",
    wasByWebhook: true,
    source: "stripe",
    hasUncheckedLinks: true,
  }),
  variant("Stripe disconnected from Stripe's side, no links open", "connect_disconnected", {
    disconnectedAt: "2026-10-06T14:20:00.000Z",
    wasByWebhook: true,
    source: "stripe",
    hasUncheckedLinks: false,
  }),
  variant("Stripe disconnected from the portal", "connect_disconnected", {
    disconnectedAt: "2026-10-06T14:20:00.000Z",
    wasByWebhook: false,
    source: "portal",
    hasUncheckedLinks: false,
  }),
  variant("Stripe disconnected by the team, a link Stripe couldn't check", "connect_disconnected", {
    disconnectedAt: "2026-12-07T09:00:00.000Z",
    wasByWebhook: false,
    source: "ops",
    hasUncheckedLinks: true,
  }),
  variant("Stripe disconnected from the portal, with full payment and the text set back", "connect_disconnected", {
    disconnectedAt: "2026-10-06T14:20:00.000Z",
    wasByWebhook: false,
    source: "portal",
    hasUncheckedLinks: false,
    resetSwitchIds: ["full_payment", "text_payment_link"],
  }),
  variant("plan started on website chat, billed by channels in service", "plan_started", {
    planName: "AYA Web Chat, 300 conversations",
    boughtPlanId: "voice-webchat-500-300",
    channel: "web",
    amountCents: 12_000,
    interval: "month",
    startedOn: "2026-10-06",
    periodEndsOn: "2026-11-06",
    receiptUrl: RECEIPT_URL,
    isBilledByChannelsInService: true,
  }),
  variant("plan started days before a retried first charge was paid", "plan_started", {
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    boughtPlanId: "voice-webchat-500-300",
    channel: "voice",
    amountCents: 52_000,
    interval: "month",
    startedOn: "2026-10-01",
    periodEndsOn: "2026-11-01",
    receiptUrl: RECEIPT_URL,
    isBilledByChannelsInService: false,
  }),
  variant("plan started on Meta, annual, the whole package", "plan_started", {
    planName: "AYA Meta Chat, 300 conversations",
    boughtPlanId: "metachat-300",
    channel: "meta",
    amountCents: 172_800,
    interval: "year",
    startedOn: "2026-10-06",
    periodEndsOn: "2027-10-06",
    receiptUrl: null,
    isBilledByChannelsInService: false,
  }),
  variant("plan started with no first-answer channel", "plan_started", {
    planName: "AYA Voice, 500 minutes",
    boughtPlanId: "voice-500",
    channel: null,
    amountCents: 40_000,
    interval: "month",
    startedOn: "2026-10-06",
    periodEndsOn: "2026-11-06",
    receiptUrl: RECEIPT_URL,
    isBilledByChannelsInService: false,
  }),
  variant("the phone joined a monthly plan", "price_stepped_up", {
    channel: "voice",
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    amountCents: 52_000,
    interval: "month",
    isInvoicedNow: false,
    hostedInvoiceUrl: null,
    isPaid: false,
  }),
  variant("Meta joined an annual plan, invoiced now", "price_stepped_up", {
    channel: "meta",
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    amountCents: 556_800,
    interval: "year",
    isInvoicedNow: true,
    hostedInvoiceUrl: INVOICE_URL,
    isPaid: true,
  }),
  variant("the phone joined an annual plan, the card declined", "price_stepped_up", {
    channel: "voice",
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    amountCents: 499_200,
    interval: "year",
    isInvoicedNow: true,
    hostedInvoiceUrl: INVOICE_URL,
    isPaid: false,
  }),
  variant("phone waiting on forwarding", "step_up_reminder", {
    channel: "voice",
    joinsOn: "2026-10-13",
    planName: "AYA Voice + Web Chat, 500 minutes and 300 conversations",
    amountCents: 52_000,
    interval: "month",
    waitingOn: "forwarding",
  }),
  variant("phone waiting on setup", "step_up_reminder", {
    channel: "voice",
    joinsOn: "2026-10-13",
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    amountCents: 58_000,
    interval: "month",
    waitingOn: "setup",
  }),
  variant("website chat waiting on the snippet", "step_up_reminder", {
    channel: "web",
    joinsOn: "2026-10-13",
    planName: "AYA Meta Chat, 300 conversations",
    amountCents: 172_800,
    interval: "year",
    waitingOn: "snippet",
  }),
  variant("Meta waiting on the Facebook login, across the new year", "step_up_reminder", {
    channel: "meta",
    joinsOn: "2027-01-04",
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    amountCents: 58_000,
    interval: "month",
    waitingOn: "meta_connect",
  }),
  variant("Meta waiting on WhatsApp's payment method", "step_up_reminder", {
    channel: "meta",
    joinsOn: "2026-10-13",
    planName: "AYA Voice + Meta Chat, 500 minutes and 300 conversations",
    amountCents: 58_000,
    interval: "month",
    waitingOn: "whatsapp_payment_method",
  }),
  variant("90% of the voice minutes, extra blocks bill", "usage_80", {
    meter: "voice_minutes",
    used: 452,
    included: 500,
    windowEndsOn: "2026-11-06",
    overageMode: "allow",
    blockRateCents: 10_400,
  }),
  variant("90% of the chat conversations, under stop and fall back", "usage_80", {
    meter: "chat_conversations",
    used: 270,
    included: 300,
    windowEndsOn: "2026-11-06",
    overageMode: "hard_cap",
    blockRateCents: 7_800,
  }),
  variant("all the chat conversations, extra blocks bill", "usage_100", {
    meter: "chat_conversations",
    used: 300,
    included: 300,
    windowEndsOn: "2026-11-06",
    overageMode: "allow",
    blockRateCents: 5_200,
  }),
  variant("all the voice minutes, under stop and fall back", "usage_100", {
    meter: "voice_minutes",
    used: 1_000,
    included: 1_000,
    windowEndsOn: "2027-01-10",
    overageMode: "hard_cap",
    blockRateCents: 10_400,
  }),
  variant("the voice allowance ran out", "allowance_fallback", {
    meter: "voice_minutes",
    included: 1_000,
    windowEndsOn: "2026-11-06",
  }),
  variant("the chat allowance ran out, across the new year", "allowance_fallback", {
    meter: "chat_conversations",
    included: 4_000,
    windowEndsOn: "2027-01-10",
  }),
  variant("a renewal's receipt", "receipt", {
    amountCents: 89_700,
    hostedInvoiceUrl: INVOICE_URL,
    periodStartsOn: "2026-10-06",
    periodEndsOn: "2026-11-06",
  }),
  variant("a manual invoice's receipt, no period, no link", "receipt", {
    amountCents: 12_345,
    hostedInvoiceUrl: null,
    periodStartsOn: null,
    periodEndsOn: null,
  }),
  variant("the first-period refund", "refund_issued", {
    amountCents: 89_700,
    kind: "first_period_cancel",
    refundedAt: "2026-10-06T14:20:00.000Z",
  }),
  variant("the guarantee refund", "refund_issued", {
    amountCents: 89_700,
    kind: "guarantee",
    refundedAt: "2026-10-06T14:20:00.000Z",
  }),
  variant("any other refund", "refund_issued", {
    amountCents: 5_000,
    kind: "other",
    refundedAt: "2026-10-06T14:20:00.000Z",
  }),
  variant("a card that expires before the renewal", "card_expiring", {
    cardMasked: "Visa •••• 4242",
    cardExpiresOn: "2026-10-31",
    renewsOn: "2026-11-06",
  }),
];

/** The payload's own links: Stripe's hosted pages, whatever the key. */
function payloadLinks(payload: Record<string, unknown>): string[] {
  return Object.entries(payload)
    .filter(([key, value]) => /Url$/.test(key) && typeof value === "string")
    .map(([, value]) => value as string);
}

describe("the billing templates in the registry", () => {
  test("every Package C and D kind has a template, the usage alerts included", () => {
    expect(BILLING_KINDS).toHaveLength(23);
    for (const kind of BILLING_KINDS) {
      expect(TEMPLATES[kind], kind).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(PENDING_TEMPLATES, kind), kind).toBe(false);
    }
  });

  test("the usage alerts carry the one-click stop link: they are the usage-alerts switch's", () => {
    for (const kind of ["usage_80", "usage_100"] as const) {
      expect(carriesUnsubscribe(kind), kind).toBe(true);
    }
  });

  test("every branch below is a payload the allowlist accepts", () => {
    for (const v of VARIANTS) {
      expect(() => assertPayloadAllowed(v.payload, v.kind), v.name).not.toThrow();
    }
  });

  test("a waiting state passes the allowlist as a category, not as a date (L4)", () => {
    // waitingOn ends like a date key; read as one, every step_up_reminder
    // would be refused at send time and dead-lettered.
    expect(() =>
      assertPayloadAllowed({ waitingOn: "whatsapp_payment_method" }, "step_up_reminder"),
    ).not.toThrow();
    expect(() =>
      assertPayloadAllowed({ waitingOn: "set up the phone" }, "step_up_reminder"),
    ).toThrow(PayloadNotAllowedError);
  });

  test("every billing kind has at least one branch below", () => {
    expect(new Set(VARIANTS.map((v) => v.kind))).toEqual(new Set(BILLING_KINDS));
  });
});

describe("every branch of every billing template", () => {
  for (const v of VARIANTS) {
    describe(`${v.kind}: ${v.name}`, () => {
      for (const audience of ["patients", "clients"] as const) {
        test(`passes the platform's lints, for ${audience}`, () => {
          const email = render(v, contextFor(audience));
          expect(subjectProblems(email.subject)).toEqual([]);
          expect(
            copyProblems(
              [email.subject, email.preheader, email.text, visibleText(email.html)].join("\n"),
            ),
          ).toEqual([]);
          expect(linkProblems(email, v.kind)).toEqual([]);
          // A vet's footer asks a reply to leave out its clients' details.
          expect(email.text).toContain(REPLY_LINES[audience]);
        });
      }

      test("the words, as a snapshot", () => {
        const email = render(v);
        expect({
          subject: email.subject,
          preheader: email.preheader,
          text: email.text,
        }).toMatchSnapshot();
      });

      test("links only to the payload's Stripe pages and the portal's front door", () => {
        const email = render(v);
        const allowed = new Set([...payloadLinks(v.payload), PORTAL]);
        for (const link of findLinks(`${email.text}\n${email.html}`)) {
          expect(allowed.has(link), `${link} in ${v.name}`).toBe(true);
          // A Customer Portal session expires in minutes (§1); the portal opens it from Billing.
          expect(link).not.toMatch(/billing\.stripe\.com/);
        }
      });

      test("one clear action at most", () => {
        expect(render(v).html.match(/class="hd-action"/g)?.length ?? 0).toBeLessThanOrEqual(1);
      });

      test("prints dates in words, never a raw ISO date", () => {
        const { text } = render(v);
        expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      });
    });
  }
});

describe("undoing call forwarding", () => {
  type Facts = { carrier: Carrier | null; phoneSystem: PhoneSystemType; routing: CoverageMode };
  const cases: Facts[] = [];
  for (const carrier of [
    "verizon",
    "att",
    "tmobile",
    "spectrum",
    "comcast",
    "other",
    null,
  ] as const) {
    for (const phoneSystem of ["landline", "voip", "unknown"] as const) {
      for (const routing of ["all_calls", "overflow_after_hours", "after_hours_only"] as const) {
        cases.push({ carrier, phoneSystem, routing });
      }
    }
  }

  /** What the catalog says for the clinic's own carrier, system and coverage mode, passed as they are. */
  function catalogUndo(facts: Facts): string[] {
    return forwardingInstructions({
      carrier: facts.carrier,
      phoneSystemType: facts.phoneSystem,
      routing: facts.routing,
      destinationE164: "",
    }).undo.map((step) => [step.label, step.dial].filter(Boolean).join(" "));
  }

  test("After hours only on a known landline carrier gets that carrier's all-call cancel code, not 'ask your carrier'", () => {
    for (const carrier of ["verizon", "att", "tmobile", "spectrum", "comcast"] as const) {
      const facts: Facts = { carrier, phoneSystem: "landline", routing: "after_hours_only" };
      const { text } = render(
        variant("suspended", "suspended", { kind: "grace_expired", hostedInvoiceUrl: null, amountDueCents: null, ...facts }),
      );
      // After hours only switches all-call forwarding on at closing, so its
      // undo is All calls' undo: an all-call cancel code for each kind of
      // line the carrier sells (one for most, three for AT&T), never the
      // codes that cancel busy and no-answer forwarding.
      const undo = catalogUndo(facts);
      expect(undo, carrier).toEqual(catalogUndo({ ...facts, routing: "all_calls" }));
      for (const step of undo) {
        expect(step, carrier).toMatch(/^(?:Cancel all-call forwarding|Turn off forwarding)[^:]*: [*#]{1,2}\d{2}#?$/);
        expect(text, carrier).toContain(`- ${step}`);
      }
      expect(text, carrier).toContain(
        undo.length === 1 ? "dial this " : "dialling each code from the clinic's own line:",
      );
      expect(text, carrier).not.toContain("We don't have your carrier's codes on file");
      expect(text, carrier).not.toContain("on your carrier's schedule");
    }
  });

  test("the suspension prints exactly the catalog's undo steps for every carrier, system and mode", () => {
    for (const facts of cases) {
      const { text } = render(
        variant("suspended", "suspended", {
          kind: "grace_expired",
          hostedInvoiceUrl: null,
          amountDueCents: 100,
          ...facts,
        }),
      );
      const steps = catalogUndo(facts);
      for (const step of steps) expect(text, JSON.stringify(facts)).toContain(`- ${step}`);
      // Nothing else that looks like a forwarding code: every code printed is one of the catalog's.
      const printed = text.match(/[*#]{1,2}\d{2}#?/g) ?? [];
      for (const code of printed) {
        expect(steps.join(" "), `${code} for ${JSON.stringify(facts)}`).toContain(code);
      }
    }
  });

  test("an unknown carrier gets the catalog's ask-your-carrier step, not a guess", () => {
    const { text } = render(
      variant("suspended", "suspended", {
        kind: "grace_expired",
        hostedInvoiceUrl: null,
        amountDueCents: null,
        carrier: null,
        phoneSystem: "landline",
        routing: "overflow_after_hours",
      }),
    );
    expect(text).toContain("We don't have your carrier's codes on file");
    expect(text).toContain("Ask the carrier to remove the forwarding");
  });

  test("a known carrier's codes are dialled from the clinic's own line, named for the carrier", () => {
    const { text } = render(
      variant("suspended", "suspended", {
        kind: "grace_expired",
        hostedInvoiceUrl: null,
        amountDueCents: null,
        carrier: "tmobile",
        phoneSystem: "landline",
        routing: "overflow_after_hours",
      }),
    );
    // More than one step, and some of them alternatives, so they are steps
    // to follow rather than codes to dial one after another.
    expect(text).toContain(
      "Follow these T-Mobile steps, dialling each code from the clinic's own line:\n\n- Return T-Mobile's busy, no-answer and not-reachable forwarding to its default in one code: ##004#",
    );
    expect(text).toContain("- Or cancel busy forwarding on its own: ##67#");
    expect(text).toContain("- Or cancel no-answer forwarding on its own: ##61#");
    expect(text).not.toContain("##21#");

    // One code alone is one to dial.
    const single = render(
      variant("suspended", "suspended", {
        kind: "grace_expired",
        hostedInvoiceUrl: null,
        amountDueCents: null,
        carrier: "verizon",
        phoneSystem: "landline",
        routing: "all_calls",
      }),
    ).text;
    expect(single).toContain("From the clinic's own line, dial this Verizon code:\n\n- Cancel all-call forwarding: *73");
  });

  test("a step with nothing to dial prints as its words alone, after a lead that does not call it a code", () => {
    const { text } = render(
      variant("suspended", "suspended", {
        kind: "grace_expired",
        hostedInvoiceUrl: null,
        amountDueCents: null,
        carrier: "att",
        phoneSystem: "landline",
        routing: "overflow_after_hours",
      }),
    );
    expect(text).toContain("Follow these AT&T steps, dialling each code from the clinic's own line:");
    expect(text).not.toMatch(/dial th(?:is|ese) AT&T codes?/);
    expect(text).toContain("- Cancel busy forwarding on AT&T Phone: *91#");
    expect(text).toMatch(/^- On a traditional AT&T landline, call AT&T on 800\.288\.2020 to remove busy and no-answer forwarding[^\n]*\.$/m);
  });

  test("the end-of-service email prints undo steps only for a clinic that bought the phone", () => {
    const base = VARIANTS.find((v) => v.kind === "canceled")!;
    const withVoice = render(base).text;
    const chatOnly = render({
      ...base,
      payload: { ...base.payload, channels: ["web"] },
    }).text;
    expect(withVoice).toContain("- Cancel all-call forwarding on AT&T Phone: *73#");
    expect(withVoice).toContain("- Cancel all-call forwarding on a traditional AT&T landline: *73");
    expect(withVoice).toContain("pass straight through to your direct line");
    expect(chatOnly).not.toMatch(/forward/i);
    expect(chatOnly).toContain("Until you remove the healdesk snippet from your website, it asks visitors to call your practice instead.");
  });

  test("a plan change prints undo steps only when it dropped the phone", () => {
    const dropped = VARIANTS.find((v) => v.name === "plan changed, the phone dropped")!;
    expect(render(dropped).text).toContain("Phone isn't part of your new plan");
    expect(render(dropped).text).toContain("- On Spectrum Voice, cancel forwarding (*73 turns off both kinds): *73");
    expect(render(dropped).text).toContain("- On Spectrum Business Voice, ask Spectrum Business to remove the forwarding.");
    const kept = VARIANTS.find((v) => v.kind === "plan_changed")!;
    expect(render(kept).text).not.toMatch(/forward/i);
  });

  test("no template hard-codes a forwarding code: they come from the catalog", () => {
    const dir = join(process.cwd(), "src", "lib", "email", "templates");
    // The two usage alerts share one file.
    const file = (kind: string) => (kind === "usage_80" || kind === "usage_100" ? "usage_alert" : kind);
    for (const kind of BILLING_KINDS) {
      const source = readFileSync(join(dir, `${file(kind)}.ts`), "utf8");
      expect(source, kind).not.toMatch(/[*#]{1,2}\d{2}/);
    }
    expect(readFileSync(join(dir, "billing-copy.ts"), "utf8")).not.toMatch(/[*#]{1,2}\d{2}/);
  });
});

describe("what each email says", () => {
  const named = (name: string) => {
    const found = VARIANTS.find((v) => v.name === name);
    if (!found) throw new Error(name);
    return found;
  };

  test("a payment failure names the moment AYA stops, in the clinic's own time", () => {
    const { text } = render(named("a renewal that failed, with grace"));
    expect(text).toContain("AYA keeps answering until 10:32 am EDT on Tuesday 13 October.");
    expect(text).toContain("Pay the invoice: " + INVOICE_URL);
    const first = render(named("the first plan charge failed"));
    expect(first.subject).toBe("Your first healdesk charge didn't go through");
    expect(first.text).toContain("AYA answered her first patient, which starts your healdesk plan");
  });

  test("without an invoice link, the card is updated from the portal", () => {
    const { text } = render(named("a failure with no invoice link and no grace"));
    expect(text).toContain(`Update your card: ${PORTAL}`);
    expect(text).toContain("$897.50");
  });

  test("a suspension blames an unpaid invoice only when it has one to point at", () => {
    expect(render(named("suspended for an unpaid invoice, Verizon landline")).text).toContain(
      "Your healdesk invoice for $897 is unpaid, so we've suspended your service.",
    );
    const other = render(named("suspended with no invoice to point at, carrier unknown")).text;
    expect(other).not.toMatch(/unpaid|invoice/i);
    expect(other).toContain("Reply to this email and we'll tell you what's needed to restore it.");
  });

  test("a suspension a payment can't lift never blames an invoice or promises that paying restores it", () => {
    const dispute = render(named("suspended for a dispute, with an invoice still open"));
    expect(dispute.text).toContain(
      "A payment to healdesk has been disputed with your bank, so we've suspended your service.",
    );
    expect(dispute.text).not.toContain("is unpaid, so we've suspended");
    expect(`${dispute.preheader}\n${dispute.text}`).not.toMatch(/restores everything/);
    // The invoice is still owed, and said so, but not as the way back.
    expect(dispute.text).toContain(
      "Your healdesk invoice for $897 is also still unpaid. Paying it settles what's owed, but doesn't restore the service on its own.",
    );
    expect(dispute.text).toContain(`Pay the invoice: ${INVOICE_URL}`);
    expect(dispute.text).toContain(
      "Reply to this email and we'll tell you what's needed to restore it.",
    );
    const ops = render(named("suspended by the team, nothing owed"));
    expect(ops.text).toContain("We've suspended your healdesk service.");
    expect(`${ops.preheader}\n${ops.text}`).not.toMatch(/unpaid|invoice|restores everything/i);
  });

  test("auto-renew off before the start: the plan won't start and nothing more is charged", () => {
    const email = render(named("auto-renew off before the plan starts"), contextFor("clients"));
    expect(email.subject).toBe("Your healdesk plan won't start");
    expect(email.text).toContain("your plan won't start, and nothing more is charged");
    expect(email.text).toContain("While it's off, AYA doesn't answer clients.");
  });

  test("auto-renew off inside the refund window says a refund is due, and by when we'll write", () => {
    const { text } = render(named("auto-renew off inside the refund window"));
    expect(text).toContain("within 14 days of your plan starting");
    // Raised on Tuesday 6 October: the next business day in New York.
    expect(text).toContain("We'll email you by Wednesday 7 October to arrange the refund.");
    expect(render(named("auto-renew off after the refund window")).text).not.toMatch(/refund/i);
  });

  test("auto-renew off with an invoice unpaid names the moment AYA stops, and promises no refund", () => {
    const { text } = render(named("auto-renew off while the first invoice is unpaid"));
    expect(text).toContain(
      "An invoice is still unpaid, though, and unless it's paid AYA stops answering sooner, at 10:32 am EDT on Tuesday 13 October:",
    );
    expect(text).not.toContain("AYA keeps answering until then");
    expect(text).not.toMatch(/refund/i);
    // Grace that runs out after the plan has ended changes nothing.
    expect(render(named("auto-renew off with grace that outlasts the plan")).text).toContain(
      "AYA keeps answering until then.",
    );
  });

  test("a plan start says which channel, what was charged, and that billing follows the channels in service", () => {
    const patients = render(named("plan started on website chat, billed by channels in service"));
    expect(patients.subject).toBe("AYA answered her first patient: your plan has started");
    expect(patients.text).toContain(
      "AYA answered her first patient in your website chat, so your healdesk plan started on Tuesday 6 October.",
    );
    expect(patients.text).toContain("We've charged $120 for your first month of AYA Web Chat, 300 conversations");
    expect(patients.text).toContain("You bought AYA Voice + Web Chat, 500 minutes and 300 conversations.");
    expect(patients.text).toContain("To cancel online");
    const clients = render(
      named("plan started on website chat, billed by channels in service"),
      contextFor("clients"),
    );
    expect(clients.subject).toBe("AYA answered her first client: your plan has started");
    expect(render(named("plan started on Meta, annual, the whole package")).text).not.toContain(
      "You bought",
    );
  });

  test("a plan start gives the day the plan started, not the day a retried charge was paid", () => {
    // Raised on Tuesday 6 October, when the retried charge was paid; the
    // plan, and its 14-day refund window, started on the 1st.
    const { text } = render(named("plan started days before a retried first charge was paid"));
    expect(text).toContain(
      "AYA answered her first patient on the phone, so your healdesk plan started on Thursday 1 October.",
    );
    expect(text).not.toContain("6 October");
  });

  test("wherever a price joins from a first answer, the 30-day rule for a waiting channel is beside it", () => {
    for (const name of [
      "plan started on website chat, billed by channels in service",
      "plan changed after the start, billed by channels in service",
    ]) {
      expect(render(named(name)).text, name).toContain(
        "A channel that's ready but waiting on a step of yours joins 30 days after it became ready or after your plan started, whichever is later, and we email you a week before.",
      );
    }
  });

  test("an annual step-up says 'charged' only when its invoice was paid", () => {
    const paid = render(named("Meta joined an annual plan, invoiced now")).text;
    expect(paid).toContain("is invoiced now and charged to the card on file.");
    expect(paid).toContain(`View the invoice: ${INVOICE_URL}`);
    const declined = render(named("the phone joined an annual plan, the card declined")).text;
    expect(declined).not.toContain("charged to the card on file");
    expect(declined).toContain(
      "The difference for the rest of this year is invoiced now, and that invoice is due.",
    );
    expect(declined).toContain(`Pay the invoice: ${INVOICE_URL}`);
  });

  test("a step-up says the channel joined, never that it is in service: a waiting channel is not", () => {
    for (const v of VARIANTS.filter((x) => x.kind === "price_stepped_up")) {
      const email = render(v);
      expect(email.subject).toMatch(/joined your plan: your new price$/);
      expect(`${email.subject}\n${email.text}`).not.toMatch(/in service/i);
    }
    expect(render(named("Meta joined an annual plan, invoiced now")).text).toContain(
      "Instagram, Messenger and WhatsApp are now part of your healdesk plan",
    );
  });

  test("a waiting channel's notice names its one action and says the price joins either way", () => {
    const { subject, text } = render(named("Meta waiting on WhatsApp's payment method"));
    expect(subject).toBe("Instagram, Messenger and WhatsApp join your plan on 13 October");
    expect(text).toContain("add a payment method to your WhatsApp Business account in Meta");
    expect(text).toContain("join your plan whether or not they're live");
    expect(text).toContain("they join from that first answer instead");
    // Across the new year the year is printed, and the subject still fits.
    expect(render(named("Meta waiting on the Facebook login, across the new year")).subject).toBe(
      "Instagram, Messenger and WhatsApp join your plan on 4 January 2027",
    );
  });

  test("overage copy says the rates are provisional (CLAUDE.md)", () => {
    for (const v of VARIANTS.filter((x) =>
      ["overage_invoiced", "allowance_fallback"].includes(x.kind),
    )) {
      expect(render(v).text, v.name).toMatch(/provisional/);
    }
  });

  test("overage is worded in started blocks of 100 at the block price, never a per-unit rate", () => {
    const voice = render(named("overage on voice"));
    expect(voice.text).toContain("30 voice minutes, billed as 1 block of 100 voice minutes at $104");
    expect(voice.text).toContain(
      "Overage is billed for each started block of 100, so that comes to $104, charged to the card on file.",
    );
    const both = render(named("overage on both meters, no invoice link"));
    expect(both.text).toContain("1 voice minute, billed as 1 block of 100 voice minutes at $104");
    expect(both.text).toContain(
      "201 chat conversations, billed as 3 blocks of 100 chat conversations at $52 each",
    );
    expect(both.text).toContain("so that comes to $260");
    for (const email of [voice, both]) {
      expect(`${email.subject}\n${email.text}`).not.toMatch(
        /\$0\.\d|\b(a|per) (voice )?minute\b|\b(a|per) (chat )?conversation\b/,
      );
    }
  });

  test("overage is 'charged to the card on file' only when it was: a declined card's invoice is due", () => {
    const declined = render(named("overage the card declined, left open to pay"));
    expect(declined.text).not.toContain("charged to the card on file");
    expect(declined.text).toContain("so that comes to $104. The invoice for it is due now.");
    expect(declined.text).toContain(`Pay the invoice: ${INVOICE_URL}`);
  });

  test("the allowance fallback says what stops, until when, and that work under way carries on", () => {
    const voice = render(named("the voice allowance ran out"));
    expect(voice.subject).toBe("Allowance used: calls go to your direct line until 6 November");
    expect(voice.text).toContain("All 1,000 voice minutes in your plan are used");
    expect(voice.text).toContain("A call she's already on carries on.");
    // "Keep going" bills in started blocks of 100 since 6 October 2026.
    expect(voice.text).toContain("billed for each started block of 100 voice minutes");
    const chat = render(named("the chat allowance ran out, across the new year"));
    expect(chat.subject).toBe("Allowance used: AYA starts no new chats until 10 January 2027");
    expect(chat.text).toContain("Conversations already under way carry on.");
    expect(chat.text).toContain("billed for each started block of 100 chat conversations");
  });

  test("the 90% alert offers the sheet's two choices: move up a step, or let extra blocks bill", () => {
    const voice = render(named("90% of the voice minutes, extra blocks bill"));
    expect(voice.subject).toBe("You've used 90% of this month's voice minutes");
    expect(voice.text).toContain(
      "AYA has used 452 of the 500 voice minutes in this month's allowance, which resets on Friday 6 November.",
    );
    expect(voice.text).toContain("Move up a step in Billing, for a bigger monthly allowance");
    expect(voice.text).toContain(
      "Do nothing. AYA keeps answering, and each started block of 100 extra voice minutes is billed at $104.",
    );
    expect(voice.text).toMatch(/provisional/);
    expect(voice.text).toContain(`Open Billing: ${PORTAL}`);

    const capped = render(named("90% of the chat conversations, under stop and fall back")).text;
    expect(capped).toContain("You chose “Stop and fall back”");
    expect(capped).toContain("Nothing extra is billed.");
    expect(capped).not.toMatch(/\$\d/);
  });

  test("the 100% alert says what happens now, and that a step up costs less than extra blocks", () => {
    const allow = render(named("all the chat conversations, extra blocks bill"));
    expect(allow.subject).toBe("You've used all of this month's chat conversations");
    expect(allow.text).toContain("She keeps answering");
    expect(allow.text).toContain(
      "each started block of 100 extra chat conversations is billed at $52.",
    );
    expect(allow.text).toContain("it costs less than paying for extra blocks");

    const capped = render(named("all the voice minutes, under stop and fall back")).text;
    expect(capped).toContain("AYA doesn't answer new calls: they go to your direct line");
    expect(capped).toContain("switch to “Keep going and bill the extra”");
  });

  test("a usage alert that prints a block price says it is provisional, and never a per-unit rate", () => {
    for (const v of VARIANTS.filter((x) => x.kind === "usage_80" || x.kind === "usage_100")) {
      const email = render(v);
      if (/\$\d/.test(email.text)) expect(email.text, v.name).toMatch(/provisional/);
      expect(`${email.subject}\n${email.text}`, v.name).not.toMatch(
        /\$0\.\d|\b(a|per) (voice )?minute\b|\b(a|per) (chat )?conversation\b/,
      );
    }
  });

  test("a plan change's subject names the package, so the steps never push it past 70 characters", () => {
    const longest = "AYA Voice + Meta Chat, 1,500 minutes and 1,500 conversations";
    const { subject, text } = render(
      variant("the largest plan", "plan_changed", {
        planName: longest,
        interval: "month",
        locations: 1,
        setupFeeDeltaCents: 0,
        hostedInvoiceUrl: null,
        hasDroppedChannels: false,
        isBeforeStart: true,
        billedPlanId: null,
        isProrated: false,
      }),
    );
    expect(subject).toBe("Your healdesk plan is now AYA Voice + Meta Chat");
    expect(subjectProblems(subject)).toEqual([]);
    expect(text).toContain(`Your healdesk plan is now ${longest}, billed monthly.`);
  });

  test("every email that links a receipt says how to cancel online", () => {
    for (const v of VARIANTS) {
      const email = render(v);
      const receipt =
        Boolean(v.payload.hostedInvoiceUrl ?? v.payload.receiptUrl) &&
        !["payment_failed", "payment_action_required", "grace_ending", "suspended"].includes(
          v.kind,
        );
      if (receipt) expect(email.text, v.name).toContain(`To cancel online, sign in at ${PORTAL}`);
    }
  });

  test("a billed plan id the catalog doesn't know leaves its sentence out, not the email", () => {
    // The allowlist reads billedPlanId as an opaque id, so it can hold a retired plan.
    const v = named("plan changed after the start, billed by channels in service");
    const { text } = render({ ...v, payload: { ...v.payload, billedPlanId: "retired-plan" } });
    expect(text).toContain("Your healdesk plan is now AYA Voice + Web Chat, 500 minutes and 300 conversations, billed monthly.");
    expect(text).not.toContain("you're billed for");
  });

  test("a plan change says it was prorated only when it was", () => {
    // The billed package stayed: the invoice is the setup-fee difference alone.
    const setupOnly = render(
      named("plan changed after the start, billed by channels in service"),
    ).text;
    expect(setupOnly).not.toMatch(/prorat/i);
    expect(setupOnly).toContain(
      "The difference in setup fee, $697, was charged with the change, and that's all the invoice covers: the price you're billed hasn't changed.",
    );
    const prorated = render(named("plan changed after the start to annual billing, prorated")).text;
    expect(prorated).toContain(
      "The change is prorated: the invoice covers the difference for the rest of this billing period.",
    );
    expect(prorated).toContain("The difference in setup fee, $697, was charged with the change.");
    expect(prorated).not.toContain("that's all the invoice covers");
  });

  test("before the plan starts, cancelling online means the plan never starts", () => {
    const before = render(named("plan changed before the start, annual, two locations")).text;
    expect(before).toContain("turn auto-renew off in Billing. Your plan then won't start");
    expect(before).not.toContain("the period you've paid for");
    const after = render(named("plan changed after the start, billed by channels in service")).text;
    expect(after).toContain("Your plan then ends when the period you've paid for runs out.");
  });

  test("a refund never offers a setup fee back", () => {
    for (const v of VARIANTS.filter((x) => x.kind === "refund_issued")) {
      expect(render(v).text, v.name).not.toMatch(/setup fee/i);
    }
    expect(render(named("the first-period refund")).text).toContain(
      "your plan is cancelled with it",
    );
    expect(render(named("the guarantee refund")).text).toContain("Your plan carries on as before.");
  });

  test("a card is named by its brand and last four, with its expiry month", () => {
    const { text } = render(named("a card that expires before the renewal"));
    expect(text).toContain("Visa •••• 4242, expires at the end of October 2026");
    expect(text).toContain(`Update your card: ${PORTAL}`);
  });

  test("a disconnection from Stripe's side offers to connect again; one from the portal does not", () => {
    expect(
      render(named("Stripe disconnected from Stripe's side, with links still open")).text,
    ).toContain(`Connect Stripe again: ${PORTAL}`);
    const portal = render(named("Stripe disconnected from the portal")).text;
    expect(portal).not.toContain("Connect Stripe again");
    expect(portal).toContain("If nobody at your clinic disconnected it, reply to this email now.");
  });

  test("a disconnection never calls a link dead that may still be paid", () => {
    for (const name of [
      "Stripe disconnected from Stripe's side, with links still open",
      "Stripe disconnected by the team, a link Stripe couldn't check",
    ]) {
      const { text } = render(named(name));
      expect(text, name).toContain(
        "Links she had already sent may still be paid until they expire, within 24 hours, so check your Stripe account before collecting a deposit for one of those bookings.",
      );
      expect(text, name).not.toContain("stopped working");
    }
    // Every link expired or found paid: then, and only then, they're dead.
    expect(render(named("Stripe disconnected from the portal")).text).toContain(
      "Links she had already sent that weren't paid have stopped working",
    );
  });

  test("the end of service gives the pass-through end, the export and the destruction dates", () => {
    const { text, preheader } = render(
      named("service ended: website chat and phone, AT&T all calls"),
    );
    expect(text).toContain("For 30 days, until Sunday 6 December, calls that still forward to us");
    expect(text).toContain("Download it by Sunday 6 December.");
    expect(text).toContain(
      "We destroy our copies of your data within 30 days of your export being delivered, and by Thursday 4 February 2027 at the latest.",
    );
    expect(text).not.toContain("as your agreement says");
    expect(preheader).toBe("Calls still pass through to your direct line until 6 December.");
    const meta = render(named("service ended before the plan started: Meta only")).text;
    expect(meta).toContain("Your plan never started, so nothing more was charged.");
    expect(meta).toContain("AYA no longer replies on Instagram, Messenger or WhatsApp.");
    expect(meta).toContain("and by Wednesday 3 February 2027 at the latest.");
  });

  test("the end of service says the website chat takes no messages and asks visitors to call, never that it shows a contact form", () => {
    // A clinic that has left keeps nothing new about a patient (BAA clause
    // 17; lib/chat/contact-form.ts keepsMessages), so its widget shows the
    // practice's number in the form's place. Until 19 October E2 promised a
    // contact form there.
    const { text } = render(named("service ended: website chat and phone, AT&T all calls"));
    expect(text).toContain(
      "Your website chat no longer takes messages. Until you remove the healdesk snippet from your website, it asks visitors to call your practice instead.",
    );
    expect(text).not.toMatch(/contact form/i);
    expect(render(named("service ended before the plan started: Meta only")).text).not.toMatch(/contact form/i);
  });
});

describe("the shared words", () => {
  const ctx = contextFor();

  test("money: whole dollars without cents, otherwise two places", () => {
    expect(money(89_700)).toBe("$897");
    expect(money(2_450)).toBe("$24.50");
    expect(money(1_148_400)).toBe("$11,484");
    expect(money(5)).toBe("$0.05");
  });

  test("a moment is printed in the clinic's own time zone, with the hour", () => {
    // 02:00 UTC is the evening before in New York.
    expect(momentLong("2026-10-13T02:00:00.000Z", ctx)).toBe("10 pm EDT on Monday 12 October");
    expect(momentLong("2026-10-13T14:32:00.000Z", ctx)).toBe("10:32 am EDT on Tuesday 13 October");
    expect(dayLong("2026-11-10T00:00:00.000Z", ctx)).toBe("Monday 9 November");
    expect(
      dayLong("2026-11-10T00:00:00.000Z", contextFor("patients", { timeZone: "Asia/Dubai" })),
    ).toBe("Tuesday 10 November");
  });

  test("a bare date is that day wherever the clinic is", () => {
    expect(dayLong("2026-11-10", ctx)).toBe("Tuesday 10 November");
    expect(dayLong("2026-11-10", contextFor("patients", { timeZone: "Pacific/Honolulu" }))).toBe(
      "Tuesday 10 November",
    );
  });

  test("the year is printed only when it is not the year the notice was raised in", () => {
    expect(dayShort("2026-12-31", ctx)).toBe("31 December");
    expect(dayShort("2027-01-01", ctx)).toBe("1 January 2027");
    expect(dayLong("2027-11-05", ctx)).toBe("Friday 5 November 2027");
    expect(monthAndYear("2026-10-31", ctx)).toBe("October 2026");
  });

  test("days are added to a bare date as a bare date, and to a moment as a moment", () => {
    expect(plusDays("2026-11-06", 30)).toBe("2026-12-06");
    expect(plusDays("2026-11-06T14:32:00.000Z", 30)).toBe("2026-12-06T14:32:00.000Z");
  });

  test("nothing is read from the clock: the same notice renders the same bytes on any day", () => {
    const first = VARIANTS.map((v) => render(v));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-03-04T05:06:07.000Z"));
    const later = VARIANTS.map((v) => render(v));
    expect(later).toEqual(first);
  });
});

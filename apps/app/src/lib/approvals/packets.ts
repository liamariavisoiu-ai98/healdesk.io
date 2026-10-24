import { getPlan, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  billingEvents,
  billingRequests,
  overageInvoices,
  type BillingRequestKind,
  type BillingStatus,
  type OpsApproval,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { getEntitlements } from "@/lib/billing/entitlements";
import { MAX_FAILURES } from "@/lib/billing/events";
import { MAX_BILLING_REQUEST_ATTEMPTS } from "@/lib/billing/requests";
import { withTenant } from "@/lib/tenant";

import { KIND_SPECS, parsePayload, subjectId, type ApprovalKind } from "./kinds";

/**
 * Each waiting item's packet: the facts the owner needs to say yes or no,
 * read live from the same rows the Billing tab reads, as ids, closed codes,
 * counts, cents and days, and one sentence (`effect`) saying what approving
 * does, in money where it moves money, priced from @healdesk/catalog. Never
 * free text: an error is carried only when it is one of the billing engine's
 * codes, and nothing a clinic or a patient typed is read. Our billing status
 * is the entitlements row's (what the Stripe webhooks last told us), not a
 * live call to Stripe: a read here calls no vendor.
 */

export type BillingRequestFacts = {
  kind: "billing_request_retry";
  requestKind: BillingRequestKind;
  channel: Channel | null;
  /** Why it stopped: every attempt used, or a failure that retrying cannot fix. */
  reasonCode: "attempts_exhausted" | "permanent_error" | null;
  /** The last error, when it is one of the engine's codes ("stripe:card_declined"). */
  lastErrorCode: string | null;
  attempts: number;
  maxAttempts: number;
  billingStatus: BillingStatus | null;
  /** A later cancellation or closure that makes this change moot. */
  supersededBy: "cancel_now" | "close_setup" | null;
  /** The package bought's price per period, in cents, when it is one the catalog knows. */
  priceCents: number | null;
  interval: "month" | "year" | null;
};

export type OverageFacts = {
  kind: "overage_invoice_retry";
  windowStart: string;
  amountCents: number;
  /** The engine's code for why the last try failed ("api_error"). */
  lastErrorCode: string | null;
};

export type EventFacts = {
  kind: "billing_event_replay";
  eventType: string;
  failures: number;
  maxFailures: number;
};

export type Packet = {
  /** The existing console operation approving runs ("Executed by"). */
  operation: string;
  irreversible: boolean;
  /** False when the subject has moved on since it was proposed: approving would run nothing. */
  stillNeeded: boolean;
  /** What approving does, in plain words. */
  effect: string;
  facts: BillingRequestFacts | OverageFacts | EventFacts;
};

/** Every key a packet carries, for the test that holds it to no free text. */
export const PACKET_KEYS = ["effect", "facts", "irreversible", "operation", "stillNeeded"] as const;

const ENGINE_CODE = /^[a-z][a-z0-9_]{0,40}(:[a-z0-9_]{1,40})?$/;

function engineCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return ENGINE_CODE.test(trimmed) ? trimmed : null;
}

/** Cents as a reader reads money: "$80", "$1,200", "$0.90". */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

const CHANNEL_WORDS: Readonly<Record<Channel, string>> = { voice: "phone", web: "website chat", meta: "Meta chat" };

/** The money sentence for a billing request, from the catalog's price for the package bought. */
export function requestEffect(facts: Pick<BillingRequestFacts, "requestKind" | "channel" | "priceCents" | "interval">, locations = 1): string {
  const per = facts.interval === "year" ? "a year" : "a month";
  const price = facts.priceCents === null ? null : dollars(facts.priceCents * Math.max(1, locations));
  const where = locations > 1 ? ` for its ${locations} locations` : "";
  switch (facts.requestKind) {
    case "plan_start":
      return price
        ? `Starts the package price on the subscription, up to ${price} ${per}${where}, replacing the $0 line.`
        : "Starts the package price on the subscription, replacing the $0 line. The package is not one the catalog prices, so check the Billing tab first.";
    case "step_up":
      return price
        ? `Adds ${facts.channel ? CHANNEL_WORDS[facts.channel] : "a channel"} to what the subscription bills, up to the full package price of ${price} ${per}${where}.`
        : `Adds ${facts.channel ? CHANNEL_WORDS[facts.channel] : "a channel"} to what the subscription bills.`;
    case "close_setup":
      return "Cancels the subscription now and closes the account. The setup fee is not refunded. This cannot be undone.";
    case "cancel_now":
      return "Cancels the subscription now. This cannot be undone.";
  }
}

export function overageEffect(facts: Pick<OverageFacts, "windowStart" | "amountCents">): string {
  return `Invoices the extra usage for the month from ${day(new Date(facts.windowStart))}: ${dollars(facts.amountCents)}, charged to the card on file. If the failed try left an invoice in Stripe, that one is finished instead of a second.`;
}

export function eventEffect(): string {
  return `Applies the parked Stripe event again from the start, as if it had just arrived. It brings our record of the clinic's billing in line with what Stripe sent, and may send the clinic the billing email that event calls for.`;
}

type Ctx = { actor: ActorContext; request?: RequestContext };

async function billingRequestPacket(approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const payload = parsePayload("billing_request_retry", approval.payload);
  if (!payload) return null;
  return withTenant({ clinicId: payload.billingClinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const requests = await tx.db
      .select()
      .from(billingRequests)
      .where(eq(billingRequests.clinicId, payload.billingClinicId));
    const request = requests.find((r) => r.id === payload.requestId);
    const billing = await getEntitlements(tx.db, payload.billingClinicId);
    const bought = billing ? getPlan(billing.boughtPlanId ?? billing.planCode) : undefined;
    const interval = billing?.billingInterval ?? null;
    const priceCents = bought
      ? Math.round((interval === "year" ? bought.annualMonthlyUsd * 12 : bought.monthlyUsd) * 100)
      : null;
    const later = (kind: "cancel_now" | "close_setup") =>
      request !== undefined &&
      (request.kind === "plan_start" || request.kind === "step_up") &&
      requests.some((r) => r.kind === kind && r.outcome !== "skipped" && r.requestedAt > request.requestedAt);
    const channel = request && request.channelKey !== "-" ? (request.channelKey as Channel) : null;
    const facts: BillingRequestFacts = {
      kind: "billing_request_retry",
      requestKind: request?.kind ?? payload.requestKind,
      channel,
      reasonCode:
        request?.outcomeReason === "attempts_exhausted" || request?.outcomeReason === "permanent_error"
          ? request.outcomeReason
          : null,
      lastErrorCode: engineCode(request?.lastError),
      attempts: request?.attempts ?? 0,
      maxAttempts: MAX_BILLING_REQUEST_ATTEMPTS,
      billingStatus: billing?.status ?? null,
      supersededBy: later("cancel_now") ? "cancel_now" : later("close_setup") ? "close_setup" : null,
      priceCents,
      interval,
    };
    return {
      operation: KIND_SPECS.billing_request_retry.operation,
      irreversible: KIND_SPECS.billing_request_retry.irreversible,
      stillNeeded: request?.outcome === "dead_letter" && request.epoch === payload.epoch,
      effect: requestEffect(facts, billing?.locations ?? 1),
      facts,
    };
  });
}

async function overagePacket(approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const payload = parsePayload("overage_invoice_retry", approval.payload);
  if (!payload) return null;
  return withTenant({ clinicId: payload.billingClinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const [row] = await tx.db
      .select({
        status: overageInvoices.status,
        amountCents: overageInvoices.amountCents,
        windowStart: overageInvoices.windowStart,
        error: overageInvoices.error,
      })
      .from(overageInvoices)
      .where(and(eq(overageInvoices.id, payload.overageId), eq(overageInvoices.clinicId, payload.billingClinicId)))
      .limit(1);
    const facts: OverageFacts = {
      kind: "overage_invoice_retry",
      windowStart: (row?.windowStart ?? new Date(payload.windowStart)).toISOString(),
      amountCents: row?.amountCents ?? 0,
      lastErrorCode: engineCode(row?.error?.replace(/:\d+$/, "")),
    };
    return {
      operation: KIND_SPECS.overage_invoice_retry.operation,
      irreversible: KIND_SPECS.overage_invoice_retry.irreversible,
      stillNeeded: row?.status === "failed",
      effect: overageEffect(facts),
      facts,
    };
  });
}

async function eventPacket(approval: OpsApproval): Promise<Packet | null> {
  const payload = parsePayload("billing_event_replay", approval.payload);
  if (!payload) return null;
  const [row] = await unsafeDb
    .select({ type: billingEvents.type, outcome: billingEvents.outcome, failures: billingEvents.failures })
    .from(billingEvents)
    .where(eq(billingEvents.stripeEventId, subjectId(approval.subjectRef)))
    .limit(1);
  const facts: EventFacts = {
    kind: "billing_event_replay",
    eventType: payload.eventType,
    failures: row?.failures ?? 0,
    maxFailures: MAX_FAILURES,
  };
  return {
    operation: KIND_SPECS.billing_event_replay.operation,
    irreversible: KIND_SPECS.billing_event_replay.irreversible,
    stillNeeded: row?.outcome === "dead_letter",
    effect: eventEffect(),
    facts,
  };
}

/** One item's packet, read now; null when its subject could not be read. */
export async function packetFor(approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const kind = approval.kind as ApprovalKind;
  switch (kind) {
    case "billing_request_retry":
      return billingRequestPacket(approval, ctx);
    case "overage_invoice_retry":
      return overagePacket(approval, ctx);
    case "billing_event_replay":
      return eventPacket(approval);
  }
  return null;
}

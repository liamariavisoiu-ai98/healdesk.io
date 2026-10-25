import type { Channel } from "@healdesk/catalog";
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
import { getJob, JOB_ANNUAL_OVERAGE_INVOICE, JOB_BILLING_RECONCILE, JOB_BILLING_REQUESTS, JOB_SETUP_CLOSURE } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import {
  contactEffect,
  contactExtra,
  contactFacts,
  contactStillNeeded,
  type ContactFacts,
  type ContactPacketExtra,
} from "./contact-packets";
import { incidentPacketFor, type IncidentBatchFacts, type IncidentReportFacts } from "./incident-kinds";
import { KIND_SPECS, parsePayload, subjectId, type ApprovalKind, type ContactKind } from "./kinds";

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
  /** Whether the billing-requests job, which carries a re-armed request out, is switched on. */
  workerOn: boolean;
  /** For a closure: whether the setup-closure switch, without which the worker leaves it waiting, is on. Null for any other kind. */
  closureOn: boolean | null;
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
  facts: BillingRequestFacts | OverageFacts | EventFacts | ContactFacts | IncidentBatchFacts | IncidentReportFacts;
} & Partial<ContactPacketExtra>;

/** Every key a packet carries, for the test that holds it to no free text. */
export const PACKET_KEYS = ["effect", "facts", "irreversible", "operation", "stillNeeded"] as const;

/** A clinic-contact item's packet carries these as well (lane P6f): its draft, what may change, and the values now. */
export const CONTACT_PACKET_KEYS = [...PACKET_KEYS, "draft", "editable", "fields"].sort();

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

/**
 * What approving a billing request does: it re-arms it (lib/billing/requests.ts
 * rearmBillingRequest: due now, fresh tries, a new epoch), nothing more.
 * The change itself is the billing-requests worker's, at its next run, behind
 * its own switch, and the worker re-checks Stripe first and may skip it; a
 * closure also waits for the setup-closure switch.
 */
export function requestEffect(
  facts: Pick<BillingRequestFacts, "requestKind" | "workerOn" | "closureOn" | "channel">,
  reconcileOn = false,
): string {
  const off = facts.workerOn
    ? ""
    : " The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";
  // Proposed only while the hourly billing check, which would re-arm it, is off (lib/approvals/proposers.ts).
  const unretried = reconcileOn ? "" : " The hourly billing check is switched off, so nothing retries this by itself.";
  switch (facts.requestKind) {
    case "cancel_now":
      return `Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with fresh tries. Once carried out, the subscription is cancelled at once, and that cannot be undone.${off}`;
    case "close_setup":
      return (
        "Makes this closure due again. The billing worker carries it out at its next run, with fresh tries, if nothing has gone live and setup closure is switched on. Once carried out, the subscription is cancelled and the account closed, the setup fee is not refunded, and that cannot be undone." +
        off +
        (facts.closureOn === false ? " Setup closure is switched off, so the closure waits until it is switched on at System > Jobs." : "")
      );
    case "plan_start":
      return `Makes this plan start due again. The billing worker carries it out at its next run if it still applies, with fresh tries: it starts the package price on the subscription, replacing the $0 line.${unretried}${off}`;
    case "step_up":
      return `Makes this price step-up due again. The billing worker carries it out at its next run if it still applies, with fresh tries: it adds ${facts.channel ? CHANNEL_WORDS[facts.channel] : "the channel"} to what the subscription bills.${unretried}${off}`;
  }
}

export function overageEffect(facts: Pick<OverageFacts, "windowStart" | "amountCents">, dailyRunOn = false): string {
  return (
    `Invoices the extra usage for the month from ${day(new Date(facts.windowStart))} now: ${dollars(facts.amountCents)}, charged to the card on file. If the failed try left an invoice in Stripe, that one is finished instead of a second.` +
    (dailyRunOn ? "" : " The daily extra-usage run is switched off, so nothing retries this by itself.")
  );
}

/**
 * What replaying a parked event does, by its type, read from
 * lib/billing/events.ts dispatch and its handlers.
 */
const EVENT_EFFECTS: Readonly<Record<string, string>> = {
  "charge.dispute.created":
    "Applies a payment dispute: where the account can be suspended, AYA is suspended until support lifts it and the clinic is emailed its call-forwarding steps; otherwise the dispute is noted in its billing history.",
  "customer.subscription.deleted":
    "Applies the end of the subscription: the account is cancelled, the clock for returning and then destroying its data starts, and its Google Calendar and Meta access is removed.",
  "customer.subscription.updated":
    "Applies a change Stripe made to the subscription, such as its status, its price or a cancellation date.",
  "invoice.paid":
    "Applies a paid invoice: it can activate a clinic still being set up, start its plan, move its billing period on, or lift a suspension for non-payment.",
  "invoice.payment_failed":
    "Applies a failed payment: the invoice is recorded as owed, the clinic is emailed Stripe's page to pay, an active account moves to past due, and its grace period starts if none is running.",
  "invoice.payment_action_required":
    "Applies a payment the clinic's bank wants confirmed: the invoice is recorded as owed and the clinic is emailed Stripe's page to confirm it. The account's status does not change and no grace period starts.",
  "charge.refunded": "Applies a refund Stripe made: it is recorded in the clinic's billing history.",
};

export function eventEffect(eventType: string): string {
  const what = EVENT_EFFECTS[eventType] ?? "Applies the parked Stripe event again from the start.";
  return `${what} It is applied as if it had just arrived, and may send the clinic the billing email that event calls for.`;
}

/**
 * The switches the packets speak of (lib/scheduler/jobs.ts): the two a
 * re-armed request waits on, and the two whose being off is why a plan
 * start, a step-up or an overage invoice is in the list at all.
 */
export async function billingSwitches(): Promise<{ worker: boolean; closure: boolean; reconcile: boolean; overage: boolean }> {
  const [worker, closure, reconcile, overage] = await Promise.all([
    getJob(JOB_BILLING_REQUESTS),
    getJob(JOB_SETUP_CLOSURE),
    getJob(JOB_BILLING_RECONCILE),
    getJob(JOB_ANNUAL_OVERAGE_INVOICE),
  ]);
  return {
    worker: worker?.enabled === true,
    closure: closure?.enabled === true,
    reconcile: reconcile?.enabled === true,
    overage: overage?.enabled === true,
  };
}

const CHANNEL_WORDS: Readonly<Record<Channel, string>> = { voice: "phone", web: "website chat", meta: "Meta chat" };

type Ctx = { actor: ActorContext; request?: RequestContext };

async function billingRequestPacket(approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const payload = parsePayload("billing_request_retry", approval.payload);
  if (!payload) return null;
  const switches = await billingSwitches();
  return withTenant({ clinicId: payload.billingClinicId, actor: ctx.actor, request: ctx.request }, async (tx) => {
    const requests = await tx.db
      .select()
      .from(billingRequests)
      .where(eq(billingRequests.clinicId, payload.billingClinicId));
    const request = requests.find((r) => r.id === payload.requestId);
    const billing = await getEntitlements(tx.db, payload.billingClinicId);
    // A plan start or step-up is moot after a later cancellation or closure; a closure after a later cancellation.
    const moots: Readonly<Record<string, readonly ("cancel_now" | "close_setup")[]>> = {
      plan_start: ["cancel_now", "close_setup"],
      step_up: ["cancel_now", "close_setup"],
      close_setup: ["cancel_now"],
      cancel_now: [],
    };
    const later = (kind: "cancel_now" | "close_setup") =>
      request !== undefined &&
      (moots[request.kind] ?? []).includes(kind) &&
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
      workerOn: switches.worker,
      closureOn: (request?.kind ?? payload.requestKind) === "close_setup" ? switches.closure : null,
    };
    return {
      operation: KIND_SPECS.billing_request_retry.operation,
      irreversible: KIND_SPECS.billing_request_retry.irreversible,
      stillNeeded: request?.outcome === "dead_letter" && request.epoch === payload.epoch,
      effect: requestEffect(facts, switches.reconcile),
      facts,
    };
  });
}

async function overagePacket(approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const payload = parsePayload("overage_invoice_retry", approval.payload);
  if (!payload) return null;
  const switches = await billingSwitches();
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
      effect: overageEffect(facts, switches.overage),
      facts,
    };
  });
}

async function eventPacket(approval: OpsApproval): Promise<Packet | null> {
  const payload = parsePayload("billing_event_replay", approval.payload);
  if (!payload) return null;
  const [row] = await unsafeDb
    .select({
      type: billingEvents.type,
      outcome: billingEvents.outcome,
      failures: billingEvents.failures,
      processedAt: billingEvents.processedAt,
      receivedAt: billingEvents.receivedAt,
    })
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
    stillNeeded: row !== undefined && stillParkedAsProposed(row, payload.parkedAt),
    effect: eventEffect(payload.eventType),
    facts,
  };
}

/** Whether an event is still parked in the episode an item was proposed for (the proposer's parkedAt, to the second). */
export function stillParkedAsProposed(
  row: { outcome: string | null; processedAt: Date | null; receivedAt: Date },
  parkedAt: string,
): boolean {
  const at = row.processedAt ?? row.receivedAt;
  return row.outcome === "dead_letter" && Math.floor(at.getTime() / 1000) * 1000 === new Date(parkedAt).getTime();
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
    case "baa_resign_chase":
    case "agreement_question":
    case "setup_extended":
    case "setup_waiting_on_us":
    case "setup_help_offer":
    case "setup_reminder_now":
      return contactPacket(kind, approval, ctx);
    // The incident assistant (lane P6i).
    case "incident_open_batch":
    case "incident_report_send":
      return incidentPacketFor(approval, ctx);
  }
  return null;
}

/** A clinic-contact item's packet (lane P6f, ./contact-packets.ts). */
async function contactPacket(kind: ContactKind, approval: OpsApproval, ctx: Ctx): Promise<Packet | null> {
  const facts = await contactFacts(kind, approval.payload, ctx, new Date());
  if (!facts) return null;
  return {
    operation: KIND_SPECS[kind].operation,
    irreversible: KIND_SPECS[kind].irreversible,
    stillNeeded: contactStillNeeded(facts),
    effect: contactEffect(facts),
    facts,
    ...contactExtra(kind, approval.payload, approval.draft),
  };
}

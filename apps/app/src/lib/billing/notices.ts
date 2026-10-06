import type { BillingInterval, Carrier, Channel, PhoneSystemType } from "@healdesk/catalog";

import {
  billingNotices,
  BILLING_NOTICE_KINDS,
  type BillingNoticeKind,
  type ChannelWaitingOn,
  type UsageMeter,
} from "@/db/schema";
import type { CoverageMode } from "@/lib/billing/answering";
import type { TenantTx } from "@/lib/tenant";

/**
 * The billing-email outbox (design D12).
 *
 * Why an outbox and not "send the email in the webhook handler". A Stripe
 * event is applied inside one tenant transaction, and an email sent from in
 * there is sent even when the transaction then rolls back — the clinic is told
 * its payment failed about an event we did not record, and told again on the
 * retry. So handlers, the sweep and the jobs only INSERT a notice, in the same
 * transaction as the state change it describes, with a dedupe key that makes a
 * redelivery a no-op; the sender delivers it after commit, outside any
 * transaction, to the owners and billing contacts of the billing clinic
 * (lib/billing/recipients.ts) and never to report_recipients.
 *
 * F0 writes the types and the enqueue. The kinds come from the registry in
 * lib/email/kinds.ts; the email platform's sender (lib/email/outbox.ts,
 * re-exported at the bottom of this file) delivers them, and Package C writes
 * payloads and templates, not a sender (funnel and portal contracts §4).
 */

export { BILLING_NOTICE_KINDS, type BillingNoticeKind };

/**
 * The allowance-email payload, for both thresholds. Templates stay pending
 * until the funnel's M3.
 */
export type UsageNoticePayload = {
  meter: UsageMeter;
  used: number;
  /** The POOLED allowance: effectiveIncluded (included × locations). */
  included: number;
  /** ISO date (YYYY-MM-DD) the allowance window ends. */
  windowEndsOn: string;
  overageMode: "allow" | "hard_cap";
  /** The provisional overage rate in cents for this meter on the BOUGHT package. */
  rateCents: number;
};

/**
 * How the clinic's calls reach us, so an email that ends or suspends the
 * service can print the steps for undoing call forwarding for the clinic's
 * own carrier (catalog `forwardingInstructions(...).undo`, whose "ask your
 * carrier" branch covers a carrier we do not know). Catalog ids, never words
 * (R31).
 */
export type ForwardingFacts = {
  /** `clinics.carrier`; null when it was never collected or is not a catalog id. */
  carrier: Carrier | null;
  /** `clinics.phone_system_type`. */
  phoneSystem: PhoneSystemType;
  /** `coverageModeOf(clinic)`. */
  routing: CoverageMode;
};

/** Who started a Connect change: the portal, an operator's link, or Stripe itself. */
export type ConnectSource = "portal" | "ops" | "stripe";

/**
 * What each kind carries, and the dedupe key it is enqueued under (R22).
 *
 * The final shapes (build spec §11, with R31 on top). No PHI, ever: cents,
 * ISO dates, Stripe-hosted URLs, plan and channel names and ids, counts, enum
 * flags, a masked card. Never a treatment, a caller, a conversation or a
 * transcript. Every key passes `assertPayloadAllowed` (lib/email/lint.ts),
 * which classes a key by its name: flags start with is, has, was, can or
 * will; `…Cents` is cents, `…Url` a link on the allowlist, `…At` and `…On` an
 * ISO date, `…Days`, `…Minutes` and `…Count` counts. Dates are ISO strings,
 * rendered in words by the template.
 *
 * Dedupe keys are "once per what". A notice is enqueued on the BILLING
 * clinic's tenant, so the key is unique within one billing group.
 */
export type NoticePayloads = {
  /** Dedupe `<invoiceId>`. Critical. */
  payment_failed: {
    amountDueCents: number;
    hostedInvoiceUrl: string | null;
    graceEndsAt: string | null;
    /** The first plan invoice failed: nothing had started, so the copy says so. */
    isFirstPlanCharge: boolean;
  };
  /** Dedupe `<invoiceId>`. Critical. */
  payment_action_required: { amountDueCents: number; hostedInvoiceUrl: string | null };
  /** Dedupe `grace:<graceEndsAtIso>`, 24 hours before grace ends. */
  grace_ending: {
    graceEndsAt: string;
    hostedInvoiceUrl: string | null;
    amountDueCents: number | null;
  };
  /**
   * Dedupe `<cause>:<eventId | graceEndsAtIso>`: grace_expired, unpaid,
   * dispute or ops, with the Stripe event or the grace end that caused it.
   * Critical.
   */
  suspended: { hostedInvoiceUrl: string | null; amountDueCents: number | null } & ForwardingFacts;
  /** Dedupe `restored:<invoiceId>`. */
  restored: { receiptUrl: string | null };
  /** Dedupe `<stripeEventId>`, from the webhook only. */
  cancel_scheduled: {
    endsAt: string;
    isBeforeStart: boolean;
    /**
     * When auto-renew went off inside the first-period refund window: the
     * last day of that window (ISO date), so the email can say a refund is
     * due and the team will be in touch. Null otherwise. R31 calls this
     * `refundEligibleUntil`; the lint classes a date by a name ending in At
     * or On, so it is `refundWindowEndsOn` here.
     */
    refundWindowEndsOn: string | null;
  };
  /** Dedupe `<stripeEventId>`, from the webhook only. */
  cancel_reversed: { isBeforeStart: boolean };
  /** Dedupe `<subscriptionId>`. Never for a setup closure, whose email is the funnel's. */
  canceled: {
    /** FORWARDING_PASS_THROUGH_DAYS. */
    passThroughDays: number;
    endedAt: string;
    isBeforeStart: boolean;
    /** The bought channels. */
    channels: Channel[];
    /** The last day to ask for the export, and the day the data is destroyed (dueForDestruction's rule). */
    exportByOn: string;
    destroyByOn: string;
  } & ForwardingFacts;
  /** Dedupe `renewal:<renewsOn>:<noticeDays>`. Annual plans, 30 and 21 days ahead. */
  renewal_upcoming: {
    renewsOn: string;
    /** The annual price times the locations. */
    amountCents: number;
    planName: string;
    locations: number;
    noticeDays: 30 | 21;
  };
  /** Dedupe `<meter>:<windowStartIso>`. */
  usage_80: UsageNoticePayload;
  /** Dedupe `<meter>:<windowStartIso>`. */
  usage_100: UsageNoticePayload;
  /** Dedupe `<windowStartIso>`. Annual plans, per closed allowance month. */
  overage_invoiced: {
    amountCents: number;
    windowStart: string;
    windowEnd: string;
    voiceMinutes: number;
    chatConversationsCount: number;
    hostedInvoiceUrl: string | null;
  };
  /**
   * Dedupe `plan:<requestId>`. Only our own changePlan enqueues it, never the
   * webhook. The forwarding facts are present only when the change drops
   * voice, so the email can print the undo steps.
   */
  plan_changed: {
    planName: string;
    interval: BillingInterval;
    locations: number;
    setupFeeDeltaCents: number;
    hostedInvoiceUrl: string | null;
    hasDroppedChannels: boolean;
    isBeforeStart: boolean;
    /** The package billed now; null before the plan starts. */
    billedPlanId: string | null;
  } & Partial<ForwardingFacts>;
  /** Dedupe `location:<requestId>`. Only our own addLocation enqueues it. */
  location_added: {
    locations: number;
    recurringCents: number;
    setupFeeCents: number;
    hostedInvoiceUrl: string | null;
    isBeforeStart: boolean;
    /** The package billed now; null before the plan starts. */
    billedPlanId: string | null;
  };
  /**
   * Dedupe `disconnected:<sha256(acct)>:<disconnectedAtIso>`, only from the
   * path that stamps the disconnection.
   */
  connect_disconnected: { disconnectedAt: string; wasByWebhook: boolean; source: ConnectSource };
  /** Dedupe `plan_started`: once per billing clinic. Critical. */
  plan_started: {
    /** The package billed: the channels in service. */
    planName: string;
    /** The package bought; the template looks its name up in the catalog. */
    boughtPlanId: string;
    /** The channel whose first answer started the plan, when one did. */
    channel: Channel | null;
    amountCents: number;
    interval: BillingInterval;
    periodEndsOn: string;
    receiptUrl: string | null;
    /** The billed package is smaller than the bought one: billing follows the channels in service. */
    isBilledByChannelsInService: boolean;
  };
  /** Dedupe `step_up:<channel>:<toPriceId>`. */
  price_stepped_up: {
    channel: Channel;
    planName: string;
    amountCents: number;
    interval: BillingInterval;
    /** Annual plans are invoiced at once; monthly ones prorate on the next invoice. */
    isInvoicedNow: boolean;
    hostedInvoiceUrl: string | null;
  };
  /** Dedupe `step_up_reminder:<channel>:<dueDate>`, 7 days before a waiting channel joins. */
  step_up_reminder: {
    channel: Channel;
    joinsOn: string;
    planName: string;
    amountCents: number;
    interval: BillingInterval;
    /** The one thing the clinic still has to do to bring the channel live. */
    waitingOn: ChannelWaitingOn;
  };
  /**
   * Dedupe `<meter>:<windowStartIso>`. Enqueued the moment the hard cap
   * engages, whatever the usage-alerts switch says. Critical.
   */
  allowance_fallback: { meter: UsageMeter; included: number; windowEndsOn: string };
  /** Dedupe `<invoiceId>`. Any paid invoice above $0 no other email covers. */
  receipt: {
    amountCents: number;
    hostedInvoiceUrl: string | null;
    periodStartsOn: string | null;
    periodEndsOn: string | null;
  };
  /** Dedupe `refund:<refundId>`. Never a setup-fee refund: there is none. */
  refund_issued: {
    amountCents: number;
    kind: "first_period_cancel" | "guarantee" | "other";
    refundedAt: string;
  };
  /** Dedupe `<pmId>:<cardExpiresOn>:<renewsOn>`. */
  card_expiring: {
    /** Brand and last four only, e.g. "Visa •••• 4242". */
    cardMasked: string;
    /** The last day of the card's expiry month, ISO date. */
    cardExpiresOn: string;
    renewsOn: string;
  };
  /** Dedupe `connected:<sha256(acct)>:<connectedAtIso>`. */
  connect_connected: { connectedAt: string; source: ConnectSource };
};

// A compile-time check that the payload map and the CHECK list name the same
// kinds: adding a kind to one and not the other fails the typecheck.
type _SameKinds = [BillingNoticeKind] extends [keyof NoticePayloads]
  ? [keyof NoticePayloads] extends [BillingNoticeKind]
    ? true
    : never
  : never;
const _sameKinds: _SameKinds = true;
void _sameKinds;

const MAX_DEDUPE_KEY_LENGTH = 200;

/**
 * Queue a notice for the tenant's clinic, which must be the BILLING clinic
 * (open it with withBillingTenant). INSERT … ON CONFLICT DO NOTHING on
 * (clinic, kind, dedupe_key), so the same event delivered twice, or a job
 * re-run in the same window, queues one email. Returns whether this call
 * inserted it.
 *
 * Choose the dedupe key for "once per what": the invoice id for a payment
 * failure (once per invoice, not per retry), `${meter}:${windowStartIso}` for
 * an allowance threshold, the period end for a renewal notice.
 */
export async function enqueueNotice<K extends BillingNoticeKind>(
  tx: TenantTx,
  kind: K,
  dedupeKey: string,
  payload: NoticePayloads[K],
  options: { sendAfter?: Date } = {},
): Promise<boolean> {
  if (!(BILLING_NOTICE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown billing notice kind: ${String(kind)}`);
  }
  const key = dedupeKey.trim();
  if (!key || key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new Error(
      `A billing notice needs a dedupe key of 1 to ${MAX_DEDUPE_KEY_LENGTH} characters.`,
    );
  }
  const inserted = await tx.db
    .insert(billingNotices)
    .values({
      clinicId: tx.clinicId,
      kind,
      dedupeKey: key,
      payload: payload as Record<string, unknown>,
      ...(options.sendAfter ? { sendAfter: options.sendAfter } : {}),
    })
    .onConflictDoNothing({
      target: [billingNotices.clinicId, billingNotices.kind, billingNotices.dedupeKey],
    })
    .returning({ id: billingNotices.id });
  return inserted.length > 0;
}

/**
 * The sender, which replaced F0's stubs here in M2. It lives with the email
 * platform (lib/email/outbox.ts) and is re-exported under F0's names, so a
 * caller written against F0 (`sendPendingNotices({ clinicId })` after a Stripe
 * event, `runBillingNoticesJob`) keeps working unchanged.
 */
export {
  deliverCriticalAfterCommit,
  runBillingNoticesJob,
  sendCriticalNotices,
  sendPendingNotices,
  type NoticeRunSummary,
  type SendPendingNoticesOptions,
} from "@/lib/email/outbox";

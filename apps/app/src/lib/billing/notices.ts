import type { BillingInterval } from "@healdesk/catalog";

import { billingNotices, BILLING_NOTICE_KINDS, type BillingNoticeKind } from "@/db/schema";
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

/** The allowance-email payload, for both thresholds. */
export type UsageNoticePayload = {
  meter: "voice_minutes" | "chat_conversations";
  used: number;
  /** The POOLED allowance: included × locations. */
  included: number;
  /** ISO date (YYYY-MM-DD) the allowance window ends. */
  windowEndsOn: string;
  overageMode: "allow" | "hard_cap";
  /** The provisional overage rate in cents for this meter on this plan. */
  rateCents: number;
};

type Empty = Record<string, never>;

/**
 * The payload of a kind whose shape is not written yet. Package C defines each
 * shape with its template (Package D for `connect_connected`), replacing this
 * one kind at a time. Payloads carry no PHI: cents, ISO dates, Stripe-hosted
 * URLs, plan and channel names, counts.
 */
export type NoticePayloadPending = Readonly<Record<string, string | number | boolean | null>>;

/**
 * What each kind carries (design §7). No PHI, ever: amounts in cents, ISO
 * dates, Stripe-hosted invoice URLs, plan names, meter names and location
 * counts. Never a treatment, a caller, a conversation or a transcript.
 */
export type NoticePayloads = {
  payment_failed: {
    amountDueCents: number;
    hostedInvoiceUrl: string | null;
    graceEndsAt: string | null;
  };
  payment_action_required: { hostedInvoiceUrl: string | null };
  grace_ending: { graceEndsAt: string; hostedInvoiceUrl: string | null };
  suspended: { hostedInvoiceUrl: string | null };
  restored: Empty;
  cancel_scheduled: { endsAt: string };
  cancel_reversed: Empty;
  canceled: { passThroughDays: number };
  renewal_upcoming: { renewsOn: string; amountCents: number; planName: string };
  usage_80: UsageNoticePayload;
  usage_100: UsageNoticePayload;
  overage_invoiced: { amountCents: number; windowLabel: string };
  plan_changed: { planName: string; interval: BillingInterval };
  location_added: { locations: number };
  connect_disconnected: Empty;
  // The funnel and portal contracts (§3, §5), kinds in lib/email/kinds.ts.
  plan_started: NoticePayloadPending;
  price_stepped_up: NoticePayloadPending;
  step_up_reminder: NoticePayloadPending;
  allowance_fallback: NoticePayloadPending;
  receipt: NoticePayloadPending;
  refund_issued: NoticePayloadPending;
  card_expiring: NoticePayloadPending;
  connect_connected: NoticePayloadPending;
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

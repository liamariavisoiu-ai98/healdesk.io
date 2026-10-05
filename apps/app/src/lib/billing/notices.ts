import type { BillingInterval } from "@healdesk/catalog";

import { billingNotices, BILLING_NOTICE_KINDS, type BillingNoticeKind } from "@/db/schema";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { JOB_BILLING_NOTICES, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
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
 * F0 writes the types and the enqueue; package C replaces the sender stubs at
 * the bottom of this file.
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
  welcome_resend: Empty;
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

export type SendPendingNoticesOptions = {
  /** Only this billing clinic's notices (the immediate send after an event). */
  clinicId?: string;
  now?: Date;
  transport?: EmailTransport;
  limit?: number;
};

/**
 * STUB (package C replaces it). Deliver due notices outside any transaction.
 * Never throws; returns counts.
 */
export async function sendPendingNotices(
  options: SendPendingNoticesOptions = {},
): Promise<{ sent: number; failed: number; skipped: number }> {
  void options;
  return { sent: 0, failed: 0, skipped: 0 };
}

/** STUB (package C replaces it). The hourly backstop sender, through its switch. */
export async function runBillingNoticesJob(
  options: { now?: Date; transport?: EmailTransport } = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_BILLING_NOTICES, async () => "Not built yet.", now);
}

import type { Transaction } from "@/db";
import { billingNotices } from "@/db/schema";
import { PLAN_NOTICE_KINDS, type PlanNoticeKind } from "@/lib/email/kinds";
import type {
  BookingAlertPayload,
  DepositAlertPayload,
  RequestsStillOpenPayload,
} from "@/lib/email/templates/booking_alert";
import type { CalendarStatePayload } from "@/lib/email/templates/calendar_state";
import type { ChannelLivePayload } from "@/lib/email/templates/channel_live";
import type { ChannelReadyPayload } from "@/lib/email/templates/channel_ready";
import type { SettingChangedPayload } from "@/lib/email/templates/setting_changed";
import type { SetupClosedPayload } from "@/lib/email/templates/setup_closed";
import type { SetupReminderPayload } from "@/lib/email/templates/setup_reminder";

/**
 * The plan's own outbox kinds (lib/email/kinds.ts, owner "plan"): their
 * payloads and the one function that queues them.
 *
 * The same outbox as Package C's billing notices, `billing_notices`, and the
 * same rules (Annex X3): the row is written in the transaction that makes
 * the email true, deduplicated on (clinic, kind, dedupe key), and the sender
 * delivers it after commit. A separate payload map from lib/billing/notices.ts
 * because each owner types its own kinds; the CHECK covers both.
 *
 * Takes a `Transaction` and a clinic id rather than a `TenantTx`, the
 * calendar backend's convention, so its transactions can call through
 * notifyCalendarState; from a withTenant() block, pass `tx.db` and
 * `tx.clinicId`. RLS checks the row against the transaction's tenant either
 * way.
 */

/**
 * A kind registered before its package builds it (14 October 2026): the
 * CHECK already takes it, but nothing can queue one until the package named
 * in PENDING_TEMPLATES (lib/email/templates/registry.ts) replaces this with
 * its payload type, beside its template.
 */
type OwedPayload = never;

/** What each plan kind carries. No PHI: counts, ISO dates, channel ids, our own URLs. */
export type PlanNoticePayloads = {
  /** Dedupe `setup_reminder:<n>`, n from 1 to 6. */
  setup_reminder: SetupReminderPayload;
  /** Dedupe `setup_closed`: once per clinic. */
  setup_closed: SetupClosedPayload;
  /** Dedupe: the calendar backend's key for the change. */
  calendar_stopped: CalendarStatePayload;
  /** Dedupe: the calendar backend's key for the change. */
  calendar_reconnected: CalendarStatePayload;
  /** Dedupe `setting_changed:<clinic_settings_history id>`: once per change. */
  setting_changed: SettingChangedPayload;
  /** Dedupe `channel_ready:<channel>:<ready_at>`: once per readiness. */
  channel_ready: ChannelReadyPayload;
  /** Dedupe `channel_live:<channel>`: once per channel, which goes live once. */
  channel_live: ChannelLivePayload;

  // Registered ahead of their packages; each package names its payload here.
  // The live alerts (package F), queued by lib/notices/booking-alerts.ts.
  /** Dedupe `booking_request:request:<id>`: once per request (booking-alerts.ts, dedupeKey). */
  booking_request: BookingAlertPayload;
  /** Dedupe `request_still_open:<clinic-local date>`: once per opening day, with the count. */
  request_still_open: RequestsStillOpenPayload;
  /** Dedupe `request_missed:request:<id>`: once per request that expires. */
  request_missed: BookingAlertPayload;
  /** Dedupe on the appointment, the request or the conversation it is about. */
  deposit_to_collect: DepositAlertPayload;
  /** Dedupe on the conversation, or the call while it is still going: once each. */
  handover: BookingAlertPayload;
  /** Dedupe on the conversation, or the call while it is still going: once each. */
  urgent: BookingAlertPayload;
  /** Dedupe `website_message:request:<id>`: once per message left (lib/chat/contact-form.ts). */
  website_message: BookingAlertPayload;
  /** Dedupe `calendar_check:request:<id>`: once per request. */
  calendar_check: BookingAlertPayload;
  daily_summary: OwedPayload;
  weekly_recap: OwedPayload;
  ai_paused: OwedPayload;
  outage_started: OwedPayload;
  outage_ended: OwedPayload;
  guarantee_miss: OwedPayload;
  website_changes: OwedPayload;
  support_request: OwedPayload;
  terms_notice: OwedPayload;
  subprocessor_notice: OwedPayload;
  incident_report: OwedPayload;
  guarantee_claim_received: OwedPayload;
  guarantee_finding: OwedPayload;
  suspended_for_cause: OwedPayload;
  patient_request: OwedPayload;
  product_update: OwedPayload;
  pass_through_ending: OwedPayload;
  export_ready: OwedPayload;
  export_reminder: OwedPayload;
  assistant_ready: OwedPayload;
  practice_questions_failed: OwedPayload;
};

// The payload map and the registry's plan kinds name the same kinds: adding a
// plan kind to one and not the other fails the typecheck.
type _SameKinds = [PlanNoticeKind] extends [keyof PlanNoticePayloads]
  ? [keyof PlanNoticePayloads] extends [PlanNoticeKind]
    ? true
    : never
  : never;
const _sameKinds: _SameKinds = true;
void _sameKinds;

const MAX_DEDUPE_KEY_LENGTH = 200;

/**
 * Queue a plan notice for `clinicId`, inside the caller's transaction, once
 * per dedupe key. Returns whether this call inserted it.
 */
export async function enqueuePlanNotice<K extends PlanNoticeKind>(
  db: Transaction,
  clinicId: string,
  kind: K,
  dedupeKey: string,
  payload: PlanNoticePayloads[K],
  options: { sendAfter?: Date } = {},
): Promise<boolean> {
  if (!(PLAN_NOTICE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Not a plan notice kind: ${String(kind)}`);
  }
  const key = dedupeKey.trim();
  if (!key || key.length > MAX_DEDUPE_KEY_LENGTH) {
    throw new Error(`A notice needs a dedupe key of 1 to ${MAX_DEDUPE_KEY_LENGTH} characters.`);
  }
  const inserted = await db
    .insert(billingNotices)
    .values({
      clinicId,
      kind,
      dedupeKey: key,
      payload: payload as unknown as Record<string, unknown>,
      ...(options.sendAfter ? { sendAfter: options.sendAfter } : {}),
    })
    .onConflictDoNothing({
      target: [billingNotices.clinicId, billingNotices.kind, billingNotices.dedupeKey],
    })
    .returning({ id: billingNotices.id });
  return inserted.length > 0;
}

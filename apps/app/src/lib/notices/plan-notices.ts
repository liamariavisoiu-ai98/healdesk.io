import type { Transaction } from "@/db";
import { billingNotices } from "@/db/schema";
import { PLAN_NOTICE_KINDS, type PlanNoticeKind } from "@/lib/email/kinds";
import type { CalendarStatePayload } from "@/lib/email/templates/calendar_state";
import type { ChannelReadyPayload } from "@/lib/email/templates/channel_ready";
import type {
  GuaranteeClaimReceivedPayload,
  GuaranteeFindingPayload,
} from "@/lib/email/templates/guarantee_claim";
import type { IncidentReportPayload } from "@/lib/email/templates/incident_report";
import type { ProductUpdatePayload } from "@/lib/email/templates/product_update";
import type { SettingChangedPayload } from "@/lib/email/templates/setting_changed";
import type { SetupClosedPayload } from "@/lib/email/templates/setup_closed";
import type { SetupReminderPayload } from "@/lib/email/templates/setup_reminder";
import type { SubprocessorNoticePayload } from "@/lib/email/templates/subprocessor_notice";
import type { SuspendedForCausePayload } from "@/lib/email/templates/suspended_for_cause";
import type { TermsNoticePayload } from "@/lib/email/templates/terms_notice";

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

  // The operator's notices from /admin (WP7, lib/notices/operator-notices.ts).
  /** Dedupe `terms_notice:<version>`: once per practice per Terms version. */
  terms_notice: TermsNoticePayload;
  /** Dedupe `subprocessor_notice:<provider>:<startsAt>`: once per practice per addition. */
  subprocessor_notice: SubprocessorNoticePayload;
  /** Dedupe `incident_report:<incident id>:<n>`: each report and update once. */
  incident_report: IncidentReportPayload;
  /** Dedupe `guarantee_claim_received:<claimReceivedOn>`: once per claim. */
  guarantee_claim_received: GuaranteeClaimReceivedPayload;
  /** Dedupe `guarantee_finding:<claimReceivedOn>`: one finding per claim. */
  guarantee_finding: GuaranteeFindingPayload;
  /** Dedupe `suspended_for_cause:<suspendedAt>`: once per suspension. */
  suspended_for_cause: SuspendedForCausePayload;
  /** Dedupe `product_update:<code>`: once per practice per update. */
  product_update: ProductUpdatePayload;

  // Registered ahead of their packages; each package names its payload here.
  channel_live: OwedPayload;
  booking_request: OwedPayload;
  request_still_open: OwedPayload;
  request_missed: OwedPayload;
  deposit_to_collect: OwedPayload;
  handover: OwedPayload;
  urgent: OwedPayload;
  website_message: OwedPayload;
  calendar_check: OwedPayload;
  daily_summary: OwedPayload;
  weekly_recap: OwedPayload;
  ai_paused: OwedPayload;
  outage_started: OwedPayload;
  outage_ended: OwedPayload;
  guarantee_miss: OwedPayload;
  website_changes: OwedPayload;
  support_request: OwedPayload;
  patient_request: OwedPayload;
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

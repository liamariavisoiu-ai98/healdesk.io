import type { Transaction } from "@/db";
import { billingNotices } from "@/db/schema";
import { PLAN_NOTICE_KINDS, type PlanNoticeKind } from "@/lib/email/kinds";
import type { AssistantReadyPayload } from "@/lib/email/templates/assistant_ready";
import type { AiPausedPayload } from "@/lib/email/templates/ai_paused";
import type {
  BookingAlertPayload,
  DepositAlertPayload,
  RequestsStillOpenPayload,
} from "@/lib/email/templates/booking_alert";
import type { CalendarStatePayload } from "@/lib/email/templates/calendar_state";
import type { ChannelLivePayload } from "@/lib/email/templates/channel_live";
import type { ChannelReadyPayload } from "@/lib/email/templates/channel_ready";
import type { ExportReadyPayload } from "@/lib/email/templates/export_ready";
import type { ExportReminderPayload } from "@/lib/email/templates/export_reminder";
import type { PassThroughEndingPayload } from "@/lib/email/templates/pass_through_ending";
import type { PatientRequestPayload } from "@/lib/email/templates/patient_request";
import type { DailySummaryPayload } from "@/lib/email/templates/daily_summary";
import type {
  GuaranteeClaimReceivedPayload,
  GuaranteeFindingPayload,
} from "@/lib/email/templates/guarantee_claim";
import type { IncidentReportPayload } from "@/lib/email/templates/incident_report";
import type { PracticeQuestionsFailedPayload } from "@/lib/email/templates/practice_questions_failed";
import type { ProductUpdatePayload } from "@/lib/email/templates/product_update";
import type { SettingChangedPayload } from "@/lib/email/templates/setting_changed";
import type { SetupClosedPayload } from "@/lib/email/templates/setup_closed";
import type { SetupReminderPayload } from "@/lib/email/templates/setup_reminder";
import type { SubprocessorNoticePayload } from "@/lib/email/templates/subprocessor_notice";
import type { SupportRequestPayload } from "@/lib/email/templates/support_request";
import type { SupportReceivedPayload } from "@/lib/email/templates/support_received";
import type { SuspendedForCausePayload } from "@/lib/email/templates/suspended_for_cause";
import type { TermsNoticePayload } from "@/lib/email/templates/terms_notice";
import type { WeeklyRecapPayload } from "@/lib/email/templates/weekly_recap";
import type { WebsiteChangesPayload } from "@/lib/email/templates/website_changes";
import type { ClosedDayBookingsPayload } from "@/lib/email/templates/closed_day_bookings";
import type { AgreementQuestionPayload } from "@/lib/email/templates/agreement_question";
import type { SetupExtendedPayload } from "@/lib/email/templates/setup_extended";
import type { SetupHelpOfferPayload } from "@/lib/email/templates/setup_help_offer";
import type { SetupWaitingOnUsPayload } from "@/lib/email/templates/setup_waiting_on_us";
import type { OutageStartedPayload, OutageEndedPayload } from "@/lib/email/templates/outage";
import type { GuaranteeMissPayload } from "@/lib/email/templates/guarantee_miss";

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

/** What each plan kind carries. No PHI: counts, ISO dates, channel ids, our own URLs. */
export type PlanNoticePayloads = {
  /**
   * Dedupe `setup_reminder:<n>`, n from 1 to 6, before a channel is live;
   * then `setup_reminder:live:<channels>`, the channels it names sorted and
   * joined with "+", each named once (lib/setup/reminders.ts).
   */
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
  /** Dedupe `assistant_ready`: once per clinic, when the build tracker is complete (lib/engine/practice). */
  assistant_ready: AssistantReadyPayload;
  /** Dedupe `practice_questions_failed:<input version>`: once per version of what the cases read. */
  practice_questions_failed: PracticeQuestionsFailedPayload;
  /** Dedupe `channel_live:<channel>`: once per channel, which goes live once. */
  channel_live: ChannelLivePayload;
  /**
   * Dedupe `pause:<paused at>` for the header's pause, `off:<channel>[:<app>]:<off at>`
   * for a channel switched Off, each with `:24h` for its reminder
   * (lib/channels/pause.ts): once per pause, and once more a day into it.
   */
  ai_paused: AiPausedPayload;

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
  /** Dedupe `ended_early:conversation:<id>`: once per call (lib/voice/ended-early.ts). */
  ended_early: BookingAlertPayload;
  /** Dedupe `daily_summary:<clinic-local date>`: once per working day (lib/scheduler/daily-summary.ts). */
  daily_summary: DailySummaryPayload;
  /** Dedupe `weekly_recap:<ISO week of last week's Monday>`: once per week (lib/scheduler/weekly-recap.ts). */
  weekly_recap: WeeklyRecapPayload;
  // The routed/answered counter's notices (lib/channels/answer-notices.ts),
  // with the templates' own payloads (outage.ts, guarantee_miss.ts).
  /** Dedupe `outage_started:<answer_outages.id>`: once per incident (answer-notices.ts); none for a quiet (flapping) one. */
  outage_started: OutageStartedPayload;
  /** Dedupe `outage_ended:<the same answer_outages.id>`: once per incident L17 told of. */
  outage_ended: OutageEndedPayload;
  /** Dedupe `guarantee_miss:<miss_cases.id>`: once per case, the case being one per channel and practice-local day with a first-month miss, on the billing clinic. */
  guarantee_miss: GuaranteeMissPayload;
  /** Dedupe `website_changes:<site_rereads id>`: once per drift check that raised changes (lib/website). */
  website_changes: WebsiteChangesPayload;
  /** Dedupe `support_request:<escalation id>`: once per escalation (lib/support/escalate.ts). */
  support_request: SupportRequestPayload;
  /**
   * Dedupe `patient_request:<id>` when the operator records it, and
   * `patient_request:<id>:reminder:<1|2>` for the sweep's two reminders
   * (lib/patient-rights/patient-requests.ts): once each.
   */
  patient_request: PatientRequestPayload;
  /**
   * After cancellation (lib/offboarding/after-cancellation.ts). Dedupe
   * `pass_through_ending:<7|1>`: once a week ahead and once a day ahead.
   */
  pass_through_ending: PassThroughEndingPayload;
  /** Dedupe `export_ready`: once per clinic, when its service has ended. */
  export_ready: ExportReadyPayload;
  /** Dedupe `export_reminder`: once, a week before the data goes undownloaded. */
  export_reminder: ExportReminderPayload;
  /**
   * Dedupe `closed_day_bookings:<hash of the newly closed dates>`: once per
   * set of days a save closed that already had bookings (lib/portal/knowledge.ts).
   */
  closed_day_bookings: ClosedDayBookingsPayload;
  // Ops automation lane P6f: queued only by the approval inbox's executors
  // (lib/approvals/contact-executors.ts), each under `<kind>:<approval id>`,
  // once per approved item, and help offers once per lifecycle stage entry.
  /** Dedupe `setup_extended:<approval id>`. */
  setup_extended: SetupExtendedPayload;
  /** Dedupe `setup_waiting_on_us:<stage since>`: once per entry into waiting on us. */
  setup_waiting_on_us: SetupWaitingOnUsPayload;
  /** Dedupe `setup_help_offer:<stage>:<stage since>`: once per stage entry (E2). */
  setup_help_offer: SetupHelpOfferPayload;
  /** Dedupe `agreement_question:<approval id>`. */
  agreement_question: AgreementQuestionPayload;
  /**
   * Dedupe `support_received:<case id>`: once per case (lane P7g). Queued by
   * lib/support/inbound/record.ts with the outbox row's id set to the case's
   * id, so its key is `hd-support_received-<case id>-1`.
   */
  support_received: SupportReceivedPayload;
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

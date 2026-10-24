import type { OpsEvent } from "@/lib/ops/notify";

/**
 * The fields each rewritten event is raised with, read from its raise site.
 * The wording lint (tests/alert-wording.test.ts) holds a wording's
 * placeholders to these, plus `clinicName` where the event names a clinic and
 * `percent` where it carries `used` and `included`. Add the event here in the
 * commit that rewrites its wording; a field missing here is a placeholder the
 * alert can never fill.
 */
export const EVENT_FIELDS: Partial<Record<OpsEvent, readonly string[]>> = {
  // lib/ops/promise-ops.ts opSetupRepliesPastDue.
  setup_request_reply_past_due: ["requestId", "source", "business", "promisedOn"],
  // lib/billing/usage-alerts.ts.
  usage_near_cap: ["clinicId", "meter", "windowStart", "used", "included"],
  // lib/ops/calendar-write-alerts.ts.
  calendar_write_stuck: ["clinicId", "appointmentId", "status", "code", "attemptCount"],
  // lib/lifecycle/waves.ts dueWaves.
  lifecycle_decision_due: [
    "clinicId",
    "stepsLeftCount",
    "noProgressDays",
    "setupDays",
    "remainingDays",
    "decision",
    "recommendation",
    "extendDays",
  ],
  // lib/clinic/change-events.ts changeAlertFields.
  clinic_availability_changed: ["clinicId", "section", "count", "written", "deleted"],
  // lib/lifecycle/waves.ts dueWaves, the other eight waves (lane N2d). The
  // day-7 and day-15 waves and the day-22 closing-soon wave share the
  // decision wave's window fields; the waiting-on-us waves carry the hours
  // and days waited, and the long one the extension proposed; the partly-live
  // wave the days and the channels waiting; the two reminder escalations the
  // steps owed, and the unanswered one the reminders delivered.
  lifecycle_no_progress: ["clinicId", "stepsLeftCount", "noProgressDays", "setupDays", "remainingDays"],
  lifecycle_closing_soon: [
    "clinicId",
    "stepsLeftCount",
    "noProgressDays",
    "setupDays",
    "remainingDays",
    "decision",
    "recommendation",
    "extendDays",
  ],
  lifecycle_closing_waiting_on_us: [
    "clinicId",
    "remainingDays",
    "waitedDays",
    "decision",
    "recommendation",
    "extendDays",
  ],
  lifecycle_waiting_on_us: ["clinicId", "waitedHours", "waitedDays"],
  lifecycle_waiting_on_us_long: ["clinicId", "waitedHours", "waitedDays", "recommendation", "extendDays"],
  lifecycle_channel_waiting: ["clinicId", "waitedDays", "channelsWaitingCount"],
  lifecycle_reminder_undelivered: ["clinicId", "stepsLeftCount"],
  lifecycle_reminders_unanswered: ["clinicId", "stepsLeftCount", "noProgressDays", "reminderCount"],
  // lib/ops/digest.ts postDigestSummary: counts, no clinic.
  ops_digest_summary: [
    "decisionsOwedCount",
    "waitingOnUsCount",
    "nearCapCount",
    "atCapCount",
    "slackUnpostedCount",
  ],
};

import { ALLOWED_LOG_KEYS, log, type LogFields } from "@/lib/log";

/**
 * Ops alerting: I1 in Annex X5 of the funnel and portal plan, one call per
 * thing a person at healdesk has to act on. The caller names the event and
 * passes ids and counts, which an operator looks up in the console; nothing
 * in an alert describes a patient or quotes a clinic.
 */

/**
 * Annex X5's "notifyOps fires on" list, less the alerts that watched what the
 * owner's 6 October decisions removed: the setup-fee refund rule, the opening
 * dates and the plan-start backstop. A dated promise past due is one event
 * per promise, so the operator knows which reply is owed without a free-text
 * field.
 */
export const OPS_EVENTS = [
  "provisioning_rejected",
  "provisioning_dead_lettered",
  "paid_intent_without_clinic",
  "duplicate_subscription",
  "practice_question_failed",
  "billing_event_dead_lettered",
  "critical_notice_undelivered",
  "clinic_address_bounced",
  "clinic_address_complained",
  "clinic_address_suppressed",
  "daily_email_count_70",
  "setup_request_reply_past_due",
  "provisioning_follow_up_past_due",
  "support_reply_past_due",
  "practice_question_review_past_due",
  "agreement_unsigned_7_days",
  "no_interactions_48_hours",
  "no_inbound_calls_14_days",
] as const;
export type OpsEvent = (typeof OPS_EVENTS)[number];

/** Ids and counts, under lib/log.ts's keys. Never an address, a name, a number or typed text. */
export type OpsFields = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Tell ops.
 *
 * Until the email platform lands (M2), an alert is one structured line on
 * the error stream, `[healdesk] ops alert {"event":…}`, written through
 * lib/log.ts because that is the only door to the console
 * (tests/no-console.test.ts). In M2 it also mails HEALDESK_OPS_EMAIL, and
 * the 07:00 digest (I2) counts it.
 *
 * It never throws. An alert is raised on the way out of something that has
 * already failed, and one that could throw would replace that failure with
 * its own. A field lib/log.ts does not allow is left out and named in
 * `hint`, so the line still goes.
 */
export async function notifyOps(event: OpsEvent, fields: OpsFields): Promise<void> {
  try {
    const kept: LogFields = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
      if (key !== "event" && ALLOWED_LOG_KEYS.has(key) && scalar) kept[key] = value;
      else dropped.push(key);
    }
    if (dropped.length > 0) kept.hint = `fields left out: ${dropped.join(", ")}`;
    log.error("ops alert", { ...kept, event });
  } catch {
    // Nothing reaches the caller; see above.
  }
}

import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import { assertPayloadAllowed, consoleOrigin, printableClinicName } from "@/lib/email/lint";
import { sendEmail } from "@/lib/email/send";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert, type OpsAlertPayload } from "@/lib/email/templates/ops_alert";
import { ALLOWED_LOG_KEYS, describeError, log, type LogFields } from "@/lib/log";

import { issueTabFor, NO_CLINIC_PAGE } from "./alert-wording/tabs";

/**
 * Ops alerting: I1 in Annex X5 of the funnel and portal plan, one call per
 * thing a person at healdesk has to act on. The caller names the event and
 * passes ids and counts, which an operator looks up in the console; nothing
 * in an alert describes a patient or quotes a clinic. Since 23 October 2026
 * (owner decision D2) the email and the Slack copy (lib/ops/slack.ts) print
 * the clinic's name beside its id, looked up when the alert goes out.
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
  // A practice on an older BAA whose agreement cannot be rendered again, so
  // no re-sign can open for it; and one still answering under a BAA version
  // below the floor, its re-sign unsigned at 7 days, for ops to phone
  // (lib/agreements/resign.ts, wave 2 R11; owner, 19 October 2026).
  "agreement_resign_unrenderable",
  "agreement_below_floor_unsigned",
  "no_interactions_48_hours",
  "no_inbound_calls_14_days",
  // The Stripe build (packages B, C and D, 6 October 2026): each is a thing
  // only a person can finish, raised by the worker or job that found it.
  "billing_request_dead_lettered",
  "billing_request_stuck",
  "setup_closure_skipped_live_channel",
  "location_charged_not_created",
  "connect_event_dead_lettered",
  "overage_invoice_failed",
  "meter_report_failing",
  "first_period_refund_due",
  "voice_fallback_no_direct_line",
  // The voice fall-through (T14): a call that could not start because the
  // database could not be read, and where it went (lib/voice/retell.ts); and
  // a Retell number whose fallback could not be kept on the clinic's direct
  // line (lib/voice/retell-fallback-sync.ts).
  "voice_call_start_failed",
  "retell_fallback_unsynced",
  // Each clinic's Retell agent and AYA number, set up by code
  // (lib/voice/provision.ts): a run that stopped with our reason; the day's
  // cap on numbers bought reached, once a day; a ready agent or number that
  // drifted from what we wrote, once per drift (repaired, or flagged for a
  // person after three repairs); and a release that failed.
  "voice_provision_failed",
  "voice_provision_cap_reached",
  "voice_agent_drift",
  "voice_deprovision_failed",
  // A clinic's direct line is its published number or its AYA number, so
  // a call put through to it would come straight back: the answer gate
  // treats it as no line (lib/billing/answering.ts), once an hour per clinic
  // and decision. And a call refused by the voice line's test mode
  // (lib/voice/test-calls.ts), which means a clinic that is not made up has
  // its calls reaching the voice endpoint before real calls are switched on,
  // or that the test-mode check could not be read; once an hour per clinic.
  "voice_direct_line_loops",
  "voice_test_mode_refused",
  "plan_start_after_cancel",
  // The DMARC review reminder (open item 14; the owner, 6 October 2026):
  // raised once, ever, by the dmarc-review job on the 14th day after Resend
  // first sent as healdesk.io (lib/scheduler/dmarc-review.ts).
  "dmarc_review_due",
  // Offboarding (lib/offboarding, the destruction_clock migration): a clinic
  // on the thirty days with no export recorded as delivered, raised once by
  // the destruction job from day 21; and a subscription deletion processed
  // more than a week after the service ended, which the database's clamp
  // started a week back and no further.
  "export_undelivered_before_destruction",
  "offboarding_started_late",
  // The same from day 21 for a clinic on the export rule (BAA 1.3.0, the
  // DPA), whose agreement promises the export within thirty days, unasked,
  // and whose data then waits for it until the ninety days.
  "export_due_undelivered",
  // The Google Calendar connection (the calendar session; the funnel and
  // portal contract of 6 October 2026 routes its ops alerts here): a
  // location's connection broke and it now takes booking requests. Raised
  // once per breakage by markCalendarBroken (lib/connections/google-calendar.ts),
  // and once per run by the calendar watch for the breakages it found or
  // told, counted.
  "calendar_broken",
  // The calendar watch (lib/scheduler/calendar-watch.ts), once per run for
  // each: connections that missed three probes in a row and now take
  // requests, and degraded connections whose probe passed again; a run that
  // ran out of time before it had probed every connection; and a run in
  // which a step threw.
  "calendar_degraded",
  "calendar_recovered",
  "calendar_watch_incomplete",
  "calendar_watch_failed",
  // The setup wizard (M3): a welcome email (B1) still unsent an hour after
  // provisioning, or one the clinic has moved past before it could go, so
  // the order confirmation has to be sent by hand.
  "welcome_email_unsent",
  // Google refused healdesk's own OAuth client (invalid, unauthorised or
  // deleted), or the Calendar API is disabled in its project: no clinic can
  // connect or keep a calendar until someone fixes the Google Cloud project.
  // Raised by the connect flow's code exchange (lib/connections/google-oauth.ts)
  // and by the calendar watch's probe, with `code` oauth_client or api_disabled.
  "google_oauth_client_rejected",
  // A recorded termination (BAA 1.3.0 clause 17) could not start a
  // location's offboarding or record its billing clinic's cancellation, or
  // recorded the cancellation while the billing-requests job that carries
  // it out is switched off (lib/agreements/termination.ts); `phase` says
  // which.
  "agreement_termination_incomplete",
  // A termination for one of the two reasons BAA 1.3.0 clause 17 ¶3 refunds
  // (lib/agreements/termination.ts), once per billing clinic: the operator
  // previews and confirms the refund on its Billing page.
  "agreement_refund_due",
  // The hourly billing reconcile finished a recorded termination's step that
  // never ran (the process stopped between recording it and finishing):
  // `phase` offboarding or billing, `count` how many (reconcileTerminations
  // in lib/agreements/termination.ts).
  "agreement_termination_finished_late",
  // A location's billing clinic is one in another practice, so the answer
  // gate treats it as having no billing clinic and doesn't answer for it
  // (lib/billing/answering.ts), once per location.
  "billing_pointer_outside_practice",
  // A first-period refund under Terms § 5 recorded the plan's immediate
  // cancellation while the billing-requests job, its only executor, is
  // switched off (commitRefund in lib/billing/stripe-actions.ts).
  "refund_cancel_job_off",
  // An open incident past healdesk's internal 24-hour notice target with no
  // notice recorded (BAA 1.3.0 release gate 5; the agreements promise 60
  // calendar days), once per incident, by the hourly incident-deadlines job
  // (lib/scheduler/incident-deadlines.ts).
  "incident_notice_overdue",
  // The nightly retention purge (lib/scheduler/retention-purge.ts): a clinic
  // whose purge threw (`phase` clinic, with its id), or a run that could not
  // purge at all (`phase` run). A purge that fails silently keeps records
  // past the periods the agreements state.
  "retention_purge_failed",
  // A conversation's transcript could not be emailed to its clinic
  // (lib/conversations/transcript-outbox.ts; the owner's decisions of 13 and
  // 14 October 2026 that transcripts are emailed, never kept): SES refused it,
  // the receiving server would not take it over TLS, or this deployment has
  // no SES to send it with (`retrying`, or SES's event type); its copy was
  // deleted undelivered 30 days after it was queued (`expired`); or SES never
  // answered for a send within 72 hours (`unconfirmed`, which usually means
  // SES's events are not reaching the app). Ids only.
  "transcript_undelivered",
  // Channel events (lib/channels/events.ts): a live channel's first answered
  // conversation could not record its first answer and the plan start or
  // step-up beside it, so billing for that channel has not begun; once an
  // hour per clinic and channel, until a later conversation records it.
  "first_answer_not_recorded",
  // Automatic go-live (lib/channels/events.ts, lib/onboarding/go-live.ts):
  // a synthetic clinic whose part is done, or whose agreement is the
  // problem, cannot go live, so it stays as it is. Once per clinic and
  // reason (`code`, the first of go-live's codes), with how many there are.
  "go_live_held",
  // Website chat's widget opened from the clinic's own website while the
  // channel waits on its line there: an operator looks at the site and
  // confirms it, because an Origin header proves nothing. Once per clinic.
  "web_widget_to_confirm",
  // A change of a clinic's one address (lib/sign-in/address-change.ts, plan
  // Part D5): due, and held back because Stripe would not take the new
  // email (`code` stripe or stripe_unconfigured), retried each hour; or
  // closed without effect because the new address became another sign-in's,
  // or the sign-in's own address moved some other way (`code`).
  "address_change_stalled",
  "address_change_failed",
  // /sign-in/help (plan Part D5): a request that sent no link, as structured
  // fields only: `code` says why (no account, billing detail not matched,
  // Stripe unavailable), with the clinic's id when the address is one.
  "sign_in_help_unmatched",
  // Connection health (lib/scheduler/connection-health.ts): a connection
  // revoked or in error, the one finding sent at once since WP5 folded the
  // job's email into the 07:00 ops digest (Annex X6). Once per connection
  // and state; every finding is in the digest every morning.
  "connection_broken",
  // E6, "Your data has been destroyed", could not reach the address
  // captured at destruction (lib/offboarding/after-cancellation.ts): the
  // mail provider refused it (`phase` rejected), this side refused to send
  // it (`refused`), or a week of hourly attempts passed (`expired`). The
  // address is cleared either way, so ops writes to the practice by hand.
  "destruction_notice_undelivered",
  // A vendor's business associate agreement in the chain (the owner's
  // decision of 19 October 2026; lib/compliance/vendor-coverage.ts), `code`
  // naming the vendor (anthropic, retell, aws, database_host): its recorded
  // expiry is 30 or 7 days away (`phase`, with `expiresOn`), once each; or it
  // has lapsed, withdrawn on /admin/compliance or past that expiry, which
  // stops AYA where that vendor serves and asks for an incident.
  "vendor_agreement_expiring",
  "vendor_agreement_lapsed",
  // Closing a leaving clinic's account (lib/offboarding/account-closure.ts):
  // its data is destroyed and its pass-through over, but the closure waits on
  // a person (`code`: voice_agent, incident_open, critical_notice or
  // stripe_connect), once per clinic and code; or the closure threw, every
  // hour it does.
  "account_closure_waiting",
  "account_closure_failed",
  // Revoking a leaving clinic's Meta access (lib/meta/revoke.ts): Meta kept
  // refusing to take the app off a Page or WhatsApp account (`phase`
  // retries, once per connection after META_REVOKE_ALERT_AFTER tries), or
  // still refused it on the last try before destruction deleted the token
  // (`phase` destruction).
  "meta_revoke_failed",
  // ...and healdesk could not end a subscription at Meta itself, once per
  // connection: no Page or account on record (`code` no_asset_on_record),
  // no token to ask with (no_token), or a clinic in service holds a
  // connection of the same kind that names no Page or account, so the asset
  // was left subscribed in case it is theirs (asset_unverified). Ids only.
  "meta_revoke_by_hand",
  // L32, a patient's request passed to its practice (BAA 1.5.1 clause 14:
  // within five business days), by the hourly sweep in
  // lib/patient-rights/patient-requests.ts, once per request each: nobody at
  // the practice has marked it received by the fourth business day, the day
  // before its reply-by day; and the reply-by day has passed unmarked.
  "patient_request_due_soon",
  "patient_request_past_due",
  // An urgent message's alert to the clinic (L12) could not be queued, so
  // the clinic has not been emailed and /api/health cannot see it: raised by
  // lib/notices/booking-alerts.ts (urgentAlertNotQueued), with the clinic,
  // the channel and the conversation when it has one. Ids only.
  "urgent_alert_not_queued",
  // /sign-in/help's I3 access requests to hello@ reached the day's cap
  // (lib/sign-in/help.ts ACCESS_REQUEST_DAILY_CAP): once a UTC day, with the
  // cap as `count` and the day as `windowStart`; the requests past it are in
  // the security log and in sign_in_help_unmatched.
  "access_requests_capped",
  // sendEmail refused a direct kind before sending it (lib/email/send.ts):
  // its payload or the clinic name it printed is outside the allowlist, or a
  // link in it is not one an email may carry. Once a UTC day per kind and
  // clinic (`windowStart`), so a refusal that would otherwise only be a log
  // line reaches a person, and one that returns after a fix is heard again.
  "email_refused",
  // The signer's copy of the agreement (P6) is still owed: withheld by
  // apps/web's rules for an address no setup link confirmed (one already
  // went to the address that day, the names on it are not safe to mail, the
  // day's copies are spent) or not sent (failed, or no transport). Relayed by
  // apps/web, once per address and day and ten a day in all, with the
  // agreement's id and the code.
  "agreement_copy_withheld",
  // The hourly location-quantity check (lib/billing/location-quantity.ts):
  // Stripe bills an account for a number of locations other than its active
  // ones (plus one being added whose charge is recorded), once per episode,
  // keyed on the clinic and when the episode was first seen (`windowStart`),
  // with both counts; and the end of that episode, once, the first hour the
  // two agree again. The check only reads Stripe: a person decides which
  // side is wrong.
  "location_quantity_drift",
  "location_quantity_agrees",
  // Phone joined an account's package (in service, or due after its wait)
  // while the account has more than one location or one being added, so
  // the step-up into phone is held, never charged: phone per location is the
  // extra-locations plan's slice 2. Once per account and channel, by the
  // hourly reconcile or the billing-requests worker.
  "step_up_phone_held",
  // A billing clinic's meter reached the 90% mark (USAGE_ALERT_PERCENT) or
  // its whole allowance in the open window (lib/billing/usage-alerts.ts):
  // once per clinic, meter and window (`windowStart`), with `used` and
  // `included`, whatever the clinic's own Usage alerts switch says, since
  // this one is ours (owner, 23 October 2026; design E2).
  "usage_near_cap",
  "usage_cap_reached",
  // A booking still on whose Google Calendar write ended `failed`, or
  // `unknown` at its five attempts or past the desk sweep's look-back
  // (lib/ops/calendar-write-alerts.ts, hourly): once per write and state,
  // with the appointment's id, its status, Google's reason as `code` and the
  // attempts. The desk was already told to add it by hand. When one run
  // finds more than a handful not yet told (the first run, or a wide
  // outage), one calendar_writes_stuck_many with the count instead, and
  // each of them is recorded as told.
  "calendar_write_stuck",
  "calendar_writes_stuck_many",
  // A clinic changed its weekly hours, its closed days, a location's hours,
  // its named providers or their services, or a change file or psql edit did
  // (lib/clinic/change-events.ts; ops automation E4, 23 October 2026). From
  // the minute sweep after the change committed, one per clinic and kind an
  // hour: `section` the kind, `count` the changes, and for closed days
  // `written` added and `deleted` taken off. Never a date or a name.
  "clinic_availability_changed",
  // The lifecycle watch (lib/lifecycle/waves.ts; design E2, 23 October
  // 2026): its ops waves, once each by their own key (raiseOpsAlertKeyed).
  // Routine ones are Slack alone; the five escalations, a stalled setup's
  // day-22 decision, two business days waiting on us, a reminder that did
  // not arrive, two that arrived with nothing moving, and a clinic waiting
  // on us near its window's end, also go to the ops address (owner decision
  // D5). Ids, counts and closed words only.
  "lifecycle_no_progress",
  "lifecycle_closing_soon",
  "lifecycle_decision_due",
  "lifecycle_waiting_on_us",
  "lifecycle_waiting_on_us_long",
  "lifecycle_channel_waiting",
  "lifecycle_reminder_undelivered",
  "lifecycle_reminders_unanswered",
  // A clinic waiting on us on day 27 or 30 of its window, which closes it
  // anyway: an escalation, proposing the days it waited as the extension.
  "lifecycle_closing_waiting_on_us",
  // The 07:00 digest's one line in Slack (lib/ops/digest.ts): its counts,
  // once a UTC day, never emailed (the digest itself is the email).
  "ops_digest_summary",
  // A call or a website chat answered while AYA knows no service: none in
  // Knowledge (`code` none: the website was never read, or the read found
  // none) or none approved yet (`code` awaiting_approval: the practice
  // questions have not passed the current version). Hourly per clinic and
  // channel while it lasts (lib/assistant/menu-check.ts). The demo clinic's
  // test calls of 23 October 2026 ran like this unseen.
  "assistant_knows_no_services",
  // The approval inbox (lib/approvals/proposers.ts; ops automation Phase 6,
  // lane P6a): items waiting for the owner's yes past their due time, once,
  // or every 4 hours for a legal clock (owner decision D18), one alert per
  // kind with the count. No clinic: the items are listed on one page.
  "approval_waiting",
  // The same reminder for an email to a clinic waiting in the approval
  // inbox (lane P6f: the BAA re-sign chase, the agreement question, the
  // setup notices): once past its due time, with the kind and the count.
  "clinic_email_waiting",
  // The patient-rights tracker's daily watch (lib/scheduler/rights-watch.ts;
  // ops automation lane P6c, owner decision D19), once per request each,
  // with the clinic's id and the request's: a request with no route to run
  // on the host (no contact id until the portal route exists); one due
  // within two business days; one past its due day. Not a patient's own
  // request already recorded on the host, which patient_request_due_soon and
  // patient_request_past_due cover.
  "rights_request_blocked",
  "rights_request_due_soon",
  "rights_request_overdue",
  // The weekly compliance pack (lib/compliance-pack/job.ts; ops automation
  // lane P6h, owner decision D20): the pointer to a week's stored pack with
  // its five headline numbers, once per week and emailed to the ops address;
  // and the same week failing twice in a row, once per week. No clinic.
  "compliance_pack_ready",
  "compliance_pack_failed",
  // The incident assistant's items in the approval inbox (lib/approvals/
  // incident-kinds.ts; ops automation lane P6i, owner decision D18): an
  // incident batch or report waiting for the owner's yes, on arrival and
  // every 4 hours while it waits, one alert per kind with the count. No
  // clinic: the items are listed on one page.
  "incident_step_waiting",
  // A support reply the owner approved that every try failed to send
  // (lib/support/send.ts; ops automation lane P7c): six tries on the email
  // outbox's schedule, then the sending stops and the clinic has not heard.
  // Once an hour per clinic; the clinic and the count of tries, no words.
  "support_reply_dead",
  // The support cases' watch (lib/support/watch.ts; ops automation lane
  // P7e): a case that still needs us past its reply-by day, once per case
  // (it replaces support_reply_past_due for every chat escalation that is a
  // case); and a case of urgency `now`, once per case, which Slack posts.
  // The clinic, the case's id and ref, and its reply-by day; never words.
  "support_case_past_due",
  "support_case_now",
] as const;
export type OpsEvent = (typeof OPS_EVENTS)[number];

/** Ids and counts, under lib/log.ts's keys. Never an address, a name, a number or typed text. */
export type OpsFields = Readonly<Record<string, string | number | boolean | null>>;

/** Identical alerts inside this window are one email (Annex X3). */
export const OPS_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Tell ops.
 *
 * Three things, in an order chosen so the first cannot be lost to the others:
 *
 *   1. one structured line on the error stream, `[healdesk] ops alert
 *      {"event":…}`, through lib/log.ts (the only door to the console,
 *      tests/no-console.test.ts). Every call writes it, deduplicated or not:
 *      the log is the trail that survives a mail outage;
 *   2. a row in ops_alerts, the ops log. An identical alert (the same event
 *      about the same ids; counters and free text do not count) raised again
 *      within an hour bumps that row's `repeats` instead of mailing again. The
 *      table is shared by every process, so the web tier, the worker and the
 *      voice process together send one email, not one each;
 *   3. the I1 email to HEALDESK_OPS_EMAIL (falling back to
 *      HEALDESK_ADMIN_EMAIL, as the watchdog's digest does), through
 *      sendEmail, with ids, counts and categories only, keyed
 *      `hd-ops_alert-<row id>-1`.
 *
 * It never throws. An alert is raised on the way out of something that has
 * already failed, and one that could throw would replace that failure with
 * its own. A field lib/log.ts does not allow is left out and named in
 * `hint`, so the line still goes; if the database is unreachable, the dedupe
 * falls back to this process's memory and the email still goes.
 */
export async function notifyOps(event: OpsEvent, fields: OpsFields): Promise<void> {
  try {
    const kept = loggable(fields);
    log.error("ops alert", { ...kept, event });
    await raise(event, kept, "hour");
  } catch {
    // Nothing reaches the caller; see above.
  }
}

/**
 * The same alert, raised at most once for its key, ever: for a condition that
 * happens once rather than a state that persists. A notice going late is
 * detected by every minute's sender and every health probe until it goes;
 * ops needs to hear it once. Logs only when it raises, for the same reason.
 * Never throws.
 *
 * `display` is what the alert may print but is not about: a setup
 * requester's business name and the day our reply was promised by (lane N1).
 * Kept on the alert's row and in its email and Slack copy under the same
 * allowlist as every field, but never in the log line, and never part of the
 * alert's identity, so the key stays what it was before they were sent.
 */
export async function notifyOpsOnce(
  event: OpsEvent,
  fields: OpsFields,
  display: OpsFields = {},
): Promise<void> {
  try {
    const kept = loggable(fields);
    if (await raise(event, kept, "once", display)) log.error("ops alert", { ...kept, event });
  } catch {
    // Nothing reaches the caller; see notifyOps.
  }
}

/**
 * notifyOps for a caller that must know the alert was recorded before it
 * marks its own row as told (lib/clinic/change-events.ts): the same log line,
 * one-hour dedupe and email, but a database that cannot record the alert
 * throws here, with no in-memory fallback, so the caller leaves its row for
 * the next sweep. An email that fails is recorded on the alert's row, as
 * notifyOps records it, and the alert stands.
 */
export async function notifyOpsOrThrow(event: OpsEvent, fields: OpsFields): Promise<void> {
  const kept = loggable(fields);
  const now = new Date();
  const recorded = emailable(kept);
  const alertId = await claimAlert(event, dedupeKeyOf(recorded), recorded, "hour", now);
  log.error("ops alert", { ...kept, event });
  if (alertId) await mail(event, recorded, alertId, now);
}

/** lib/log.ts's keys only, scalars only; anything else is named in `hint` and left out. */
function loggable(fields: OpsFields): LogFields {
  const kept: LogFields = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
    if (key !== "event" && ALLOWED_LOG_KEYS.has(key) && scalar) kept[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) kept.hint = `fields left out: ${dropped.join(", ")}`;
  return kept;
}

/** Free text: logged, scrubbed, never emailed. */
const FREE_TEXT = new Set(["reason", "error", "hint", "subject"]);

/** Counters describe an alert; they do not make it a different one. */
const NOT_IDENTITY = new Set([
  "count",
  "written",
  "matched",
  "exceptions",
  "deleted",
  "attempts",
  "attempt",
  "failures",
  "processed",
  "deferred",
  "olderThanDays",
  "months",
  "ms",
  "units",
  "lateDays",
  "locationCount",
  "billedCount",
  "used",
  "included",
]);

/** What the email may carry: each field the payload allowlist accepts on its own. */
function emailable(fields: LogFields): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || FREE_TEXT.has(key)) continue;
    try {
      assertPayloadAllowed({ [key]: value }, "ops_alert");
      out[key] = value;
    } catch {
      // Not an id, a count or a category: it stays in the log line only.
    }
  }
  return out;
}

/** The alert's identity: its ids and categories, sorted. Hashed when long. */
function dedupeKeyOf(fields: Record<string, string | number | boolean | null>): string {
  const key = Object.entries(fields)
    .filter(([name]) => !NOT_IDENTITY.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join(";");
  return key.length <= 400 ? key : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

/** Raised in this process, when the ops log could not be reached: event|key → when. */
const raisedInMemory = new Map<string, number>();

/** Record the alert, unless an identical one is inside its window; mail it if recorded. */
async function raise(
  event: OpsEvent,
  kept: LogFields,
  window: "hour" | "once",
  display: OpsFields = {},
): Promise<boolean> {
  const now = new Date();
  const identity = emailable(kept);
  const dedupeKey = dedupeKeyOf(identity);
  const fields = { ...emailable(display), ...identity };

  let alertId: string | null;
  try {
    alertId = await claimAlert(event, dedupeKey, fields, window, now);
  } catch (error) {
    log.warn("ops log unreachable; deduplicating this alert in memory", {
      event,
      error: describeError(error),
    });
    const memoryKey = `${event}|${dedupeKey}`;
    const last = raisedInMemory.get(memoryKey);
    if (last !== undefined && (window === "once" || now.getTime() - last < OPS_DEDUPE_WINDOW_MS)) {
      return false;
    }
    raisedInMemory.set(memoryKey, now.getTime());
    alertId = randomUUID();
  }
  if (!alertId) return false;

  await mail(event, fields, alertId, now);
  return true;
}

/**
 * Insert the alert's row, or bump the row of an identical one still inside
 * its window. Serialised per (event, key) by a transaction-scoped advisory
 * lock, so two processes raising the same alert at once record one row and
 * send one email.
 */
async function claimAlert(
  event: OpsEvent,
  dedupeKey: string,
  fields: Record<string, string | number | boolean | null>,
  window: "hour" | "once",
  now: Date,
): Promise<string | null> {
  return unsafeDb.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ops_alert|${event}|${dedupeKey}`}, 0))`,
    );
    const same = and(
      eq(opsAlerts.event, event),
      eq(opsAlerts.dedupeKey, dedupeKey),
      window === "hour"
        ? gt(opsAlerts.raisedAt, new Date(now.getTime() - OPS_DEDUPE_WINDOW_MS))
        : undefined,
    );
    const [recent] = await tx
      .select({ id: opsAlerts.id })
      .from(opsAlerts)
      .where(same)
      .orderBy(desc(opsAlerts.raisedAt))
      .limit(1);
    if (recent) {
      await tx
        .update(opsAlerts)
        .set({ repeats: sql`${opsAlerts.repeats} + 1`, lastRaisedAt: now })
        .where(eq(opsAlerts.id, recent.id));
      return null;
    }
    const [inserted] = await tx
      .insert(opsAlerts)
      .values({ event, dedupeKey, fields, raisedAt: now, lastRaisedAt: now })
      .returning({ id: opsAlerts.id });
    return inserted?.id ?? null;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The clinic's name for an alert about it, or null: business data, which the
 * owner allowed in ops email and Slack beside its id and counts (decision D2,
 * 23 October 2026). Read when the alert goes out, never stored on its row,
 * through the scheduler's definer, the one clinic listing the runtime role
 * may make without a tenant. A name the email rule would refuse (an address,
 * a link, a long number in it) is left out. Never throws: an alert without
 * the name still goes.
 */
export async function opsClinicName(clinicId: unknown): Promise<string | null> {
  if (typeof clinicId !== "string" || !UUID.test(clinicId)) return null;
  try {
    const result = await unsafeDb.execute<{ name: string | null }>(
      sql`select name from app_clinics_overview() where id = ${clinicId}::uuid`,
    );
    return printableClinicName(result.rows[0]?.name);
  } catch {
    return null;
  }
}

/** The alert's anchor on its tab, `#<event>-<alert id>`, when the id is a uuid. */
function issueAnchor(event: OpsEvent, alertId: string | null | undefined): string {
  return typeof alertId === "string" && UUID.test(alertId) ? `#${event}-${alertId.toLowerCase()}` : "";
}

/**
 * The one console link for an alert, which its email and its Slack copy
 * both print (owner decision D3, 23 October 2026): the console's one issue
 * shape, `<HEALDESK_CONSOLE_ORIGIN>/admin/clinics/<clinic id>/<tab>#<event>-<alert id>`
 * (apps/web lib/admin/issue-link.ts `issueLink`), the tab the one that owns
 * the event (./alert-wording/tabs.ts, held to apps/web's `issueTabFor` by a
 * test), the alert id its ops_alerts row's. Ids alone in the URL. An alert
 * about no clinic opens the page that owns it (NO_CLINIC_PAGE), or links
 * nowhere. Null when the origin is unset, which turns links off. The console
 * stays behind its own sign-in.
 */
export function opsConsoleLink(
  event: OpsEvent,
  fields: Readonly<Record<string, unknown>>,
  alertId?: string | null,
): string | null {
  const origin = consoleOrigin();
  if (!origin) return null;
  const path = opsConsolePath(event, fields, alertId);
  return path ? `${origin}${path}` : null;
}

/**
 * The same page as opsConsoleLink, as a path with no origin: the ops inbox's
 * button on the console itself (lib/ops/inbox/ops-alerts.ts), which needs no
 * HEALDESK_CONSOLE_ORIGIN. Without an alert id it opens the tab with no
 * issue named. Null when the alert names no clinic and no page owns it.
 */
export function opsConsolePath(
  event: OpsEvent,
  fields: Readonly<Record<string, unknown>>,
  alertId?: string | null,
): string | null {
  const clinicId = fields.clinicId;
  if (typeof clinicId === "string" && UUID.test(clinicId)) {
    return `/admin/clinics/${clinicId.toLowerCase()}/${issueTabFor(event)}${issueAnchor(event, alertId)}`;
  }
  return NO_CLINIC_PAGE[event] ?? null;
}

/**
 * Of these alerts, the ones not yet raised: no ops_alerts row holds their
 * key, ever. For a sweep that would otherwise mail one alert per row on its
 * first run (lib/ops/calendar-write-alerts.ts).
 */
export async function opsAlertsNotYetRaised(
  event: OpsEvent,
  list: readonly OpsFields[],
): Promise<OpsFields[]> {
  if (list.length === 0) return [];
  const keyed = list.map((fields) => ({ fields, key: dedupeKeyOf(emailable(loggable(fields))) }));
  const rows = await unsafeDb
    .selectDistinct({ key: opsAlerts.dedupeKey })
    .from(opsAlerts)
    .where(
      and(
        eq(opsAlerts.event, event),
        inArray(
          opsAlerts.dedupeKey,
          keyed.map((k) => k.key),
        ),
      ),
    );
  const seen = new Set(rows.map((r) => r.key));
  return keyed.filter((k) => !seen.has(k.key)).map((k) => k.fields);
}

/**
 * Record these alerts as told without telling anyone: a summary alert has
 * just said how many there are. Each gets its row under its own key, so a
 * later notifyOpsOnce for it is the no-op it would have been had it gone,
 * with no email and no Slack post (its next try is never). Returns how many
 * it recorded; one already there is left alone. Serialised per key as
 * claimAlert is.
 */
export async function coverOpsAlerts(
  event: OpsEvent,
  list: readonly OpsFields[],
  now: Date = new Date(),
): Promise<number> {
  let covered = 0;
  for (const raw of list) {
    const fields = emailable(loggable(raw));
    const dedupeKey = dedupeKeyOf(fields);
    const inserted = await unsafeDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ops_alert|${event}|${dedupeKey}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: opsAlerts.id })
        .from(opsAlerts)
        .where(and(eq(opsAlerts.event, event), eq(opsAlerts.dedupeKey, dedupeKey)))
        .limit(1);
      if (existing) return false;
      await tx.insert(opsAlerts).values({
        event,
        dedupeKey,
        fields,
        raisedAt: now,
        lastRaisedAt: now,
        lastError: "Covered by a summary alert.",
        slackError: "covered by a summary alert",
        slackNextAt: sql`'infinity'::timestamptz`,
      });
      return true;
    });
    if (inserted) covered += 1;
  }
  return covered;
}

/** Where alerts go. Never a clinic's address. */
function opsAddress(): string | null {
  const configured =
    process.env.HEALDESK_OPS_EMAIL?.trim() || process.env.HEALDESK_ADMIN_EMAIL?.trim();
  return configured ? configured : null;
}

/** The I1 email. Records what happened on the alert's row. Never throws. */
async function mail(
  event: OpsEvent,
  fields: Record<string, string | number | boolean | null>,
  alertId: string,
  raisedAt: Date,
): Promise<void> {
  let outcome: { sentAt: Date; messageId: string } | { lastError: string };
  const to = opsAddress();
  if (!to) {
    log.warn("ops alert not emailed: HEALDESK_OPS_EMAIL is not set", { event });
    outcome = { lastError: "HEALDESK_OPS_EMAIL is not set." };
  } else {
    try {
      // The clinic's name beside its id (owner decision D2), looked up now
      // and never stored on the alert's row.
      const clinicName = await opsClinicName(fields.clinicId);
      // And its console link (D3), the one the Slack copy prints too.
      const consoleUrl = opsConsoleLink(event, fields, alertId);
      const payload: OpsAlertPayload = {
        ...fields,
        ...(clinicName ? { clinicName } : {}),
        ...(consoleUrl ? { consoleUrl } : {}),
        event,
      };
      const rendered = renderOpsAlert(payload, {
        clinicName: null,
        audience: "patients",
        reason: OPS_REASON,
        raisedAt,
        timeZone: "UTC",
      });
      const result = await sendEmail({
        to,
        kind: "ops_alert",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        deliveryId: alertId,
        idempotencyKey: `hd-ops_alert-${alertId}-1`,
      });
      outcome =
        result.status === "sent"
          ? { sentAt: new Date(), messageId: result.messageId }
          : { lastError: `${result.status}: ${result.reason}`.slice(0, 300) };
      if (result.status === "failed") {
        log.warn("ops alert email failed", { event, reason: result.reason });
      }
    } catch (error) {
      outcome = { lastError: describeError(error) };
      log.warn("ops alert email failed", { event, error: describeError(error) });
    }
  }

  try {
    await unsafeDb.update(opsAlerts).set(outcome).where(eq(opsAlerts.id, alertId));
  } catch {
    // The row may be the in-memory fallback's, with nothing to update.
  }
}

/**
 * An alert raised once for a key the caller owns, rather than one made from
 * its fields: the lifecycle watch's waves (lib/lifecycle/watch.ts) and the
 * digest's Slack line (lib/ops/digest.ts). Returns the alert's row id whether
 * it was raised now or before, so a wave's ledger row can point at it and a
 * replayed run raises nothing twice. Emailed to the ops address only with
 * `email` (an escalation: owner decision D5 keeps routine waves to Slack);
 * the ops-slack sweep posts every row either way. Null when the ops log
 * cannot be reached, and the caller tries again on its next run. Never
 * throws.
 */
export async function raiseOpsAlertKeyed(
  event: OpsEvent,
  fields: OpsFields,
  options: { key: string; email: boolean },
): Promise<string | null> {
  try {
    const now = new Date();
    const kept = loggable(fields);
    // Stored and mailed by the email's own allowlist, key by key, so a count
    // the log line does not name (a wave's days, the digest's totals) still
    // reaches the alert; the log line keeps lib/log.ts's keys.
    const emailed = emailable(fields);
    const dedupeKey = `key:${options.key}`.slice(0, 400);
    const claimed = await unsafeDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ops_alert|${event}|${dedupeKey}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: opsAlerts.id })
        .from(opsAlerts)
        .where(and(eq(opsAlerts.event, event), eq(opsAlerts.dedupeKey, dedupeKey)))
        .limit(1);
      if (existing) return { id: existing.id, raised: false };
      const [inserted] = await tx
        .insert(opsAlerts)
        .values({ event, dedupeKey, fields: emailed, raisedAt: now, lastRaisedAt: now })
        .returning({ id: opsAlerts.id });
      return { id: inserted!.id, raised: true };
    });
    if (claimed.raised) {
      log.error("ops alert", { ...kept, event });
      if (options.email) await mail(event, emailed, claimed.id, now);
    }
    return claimed.id;
  } catch (error) {
    log.warn("ops alert not recorded", { event, error: describeError(error) });
    return null;
  }
}

import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail } from "@/lib/email/send";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderOpsAlert, type OpsAlertPayload } from "@/lib/email/templates/ops_alert";
import { ALLOWED_LOG_KEYS, describeError, log, type LogFields } from "@/lib/log";

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
  // The Google Calendar connection (the calendar session; the funnel and
  // portal contract of 6 October 2026 routes its ops alerts here): a
  // location's connection broke and it now takes booking requests. Raised
  // once per breakage by markCalendarBroken (lib/connections/google-calendar.ts).
  "calendar_broken",
  // The setup wizard (M3): a welcome email (B1) still unsent an hour after
  // provisioning, or one the clinic has moved past before it could go, so
  // the order confirmation has to be sent by hand.
  "welcome_email_unsent",
  // Google refused healdesk's own OAuth client (invalid, unauthorised or
  // deleted): no clinic can connect or keep a calendar until someone fixes
  // the Google Cloud project. Raised by the connect flow's code exchange
  // (lib/connections/google-oauth.ts).
  "google_oauth_client_rejected",
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
 */
export async function notifyOpsOnce(event: OpsEvent, fields: OpsFields): Promise<void> {
  try {
    const kept = loggable(fields);
    if (await raise(event, kept, "once")) log.error("ops alert", { ...kept, event });
  } catch {
    // Nothing reaches the caller; see notifyOps.
  }
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
async function raise(event: OpsEvent, kept: LogFields, window: "hour" | "once"): Promise<boolean> {
  const now = new Date();
  const fields = emailable(kept);
  const dedupeKey = dedupeKeyOf(fields);

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
      const payload: OpsAlertPayload = { ...fields, event };
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

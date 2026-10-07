import { asc, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { emailDailyQuota, opsAlerts } from "@/db/schema";
import { quotaDay } from "@/lib/email/quota";
import { scrub } from "@/lib/log";
import { notifyOpsOnce, type OpsEvent } from "@/lib/ops/notify";

import { JOB_DMARC_REVIEW, runJob, type JobOutcome } from "./jobs";

/**
 * The DMARC review reminder, which the owner asked for on 6 October 2026: an
 * alert "two weeks after resend starts sending".
 *
 * healdesk.io's DMARC record says p=none: receivers send reports on mail sent
 * as healdesk.io and act on none of it. Once the aggregate reports show only
 * Resend and the owner's own mail sending as healdesk.io, the record moves to
 * p=quarantine, which stops others impersonating hello@ (open item 14 and
 * Annex X2 of docs/design/funnel-onboarding-portal-2026-10-06.md). Nothing in
 * the product reads those reports or changes that record, so without this job
 * the step waits on someone remembering it two weeks after the first email.
 *
 * Daily at 08 UTC (tick.ts), behind its switch: while nothing has been sent it
 * does nothing; until the 14th UTC day after Resend's first send it waits; on
 * that day it raises one ops alert, ever; after that it is silent, however
 * often it runs. "Ever" is the ops log's: a run that finds the alert there
 * stops before reading anything else, so neither a second email nor a bumped
 * repeat count can follow, even if the first-send day it would find has moved.
 */

/** Two weeks of aggregate reports. */
export const DMARC_REVIEW_AFTER_DAYS = 14;

export const DMARC_REVIEW_EVENT = "dmarc_review_due" satisfies OpsEvent;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC day Resend first sent as healdesk.io, as apps/app's own records show
 * it, or null when they show no send at all. The earlier of:
 *
 *   - the day of the earliest successful send in report_deliveries, the ledger
 *     of every email to a clinic. A row says "sent" only when the transport
 *     accepted the email, and the email platform's transport is Resend
 *     (HEALDESK_EMAIL_TRANSPORT=resend, Annex X3); the console stub records
 *     "skipped". The ledger FORCEs row-level security, so
 *     app_first_email_sent_at() walks the clinics for it and returns that one
 *     timestamp, never a row;
 *   - the earliest day in email_daily_quota with a count above zero. The count
 *     is Resend's x-resend-daily-quota header, which covers the whole account,
 *     apps/web's mail included, so a day on which apps/app sent anything also
 *     shows what apps/web sent that day. A count of zero is not taken as a
 *     send: a refused request reports it on a day nothing has gone yet, and
 *     leaving a day out can only make the alert later. Resend sends the header
 *     on the free plan only; after a move to Pro the ledger decides alone.
 *
 * apps/web's own sends (the nurture emails, the contact, review and setup
 * request acknowledgements) are recorded only in its Google Sheet, which
 * apps/app cannot read. If apps/web sent first, the day found here is later
 * than the real one, and the alert comes late, on more than 14 days of
 * reports, rather than early. Ops alerts and sign-in links keep their state on
 * their own rows, not in the ledger; the quota header counts them on the free
 * plan.
 *
 * Days are UTC calendar days, as Resend counts its quota day. The day comes
 * out of Postgres as text in one fixed format, so no driver or session setting
 * decides what a date looks like.
 */
export async function resendFirstSendingDay(): Promise<string | null> {
  // least() ignores nulls: null only when neither record shows a send.
  const result = await unsafeDb.execute<{ first_day: string | null }>(
    sql`select to_char(
          least(
            (app_first_email_sent_at() at time zone 'UTC')::date,
            (select min(${emailDailyQuota.day}) from ${emailDailyQuota} where ${emailDailyQuota.used} > 0)
          ),
          'YYYY-MM-DD') as first_day`,
  );
  return result.rows[0]?.first_day ?? null;
}

export type DmarcReviewCheck =
  | { status: "nothing_sent" }
  | { status: "waiting"; firstDay: string; days: number; dueDay: string }
  | {
      status: "raised";
      firstDay: string;
      days: number;
      /** False when the ops log could not be written and notifyOpsOnce fell back to memory. */
      recorded: boolean;
      emailed: boolean;
      error: string | null;
    }
  | { status: "already_raised"; raisedOn: string; emailed: boolean };

/** One run's decision. Raises the alert when it is due; reads, and writes nothing else. */
export async function checkDmarcReview(now: Date = new Date()): Promise<DmarcReviewCheck> {
  const earlier = await raisedAlert();
  if (earlier) {
    return {
      status: "already_raised",
      raisedOn: quotaDay(earlier.raisedAt),
      emailed: earlier.sentAt !== null,
    };
  }

  const firstDay = await resendFirstSendingDay();
  if (!firstDay) return { status: "nothing_sent" };

  const days = Math.round((dayStart(quotaDay(now)) - dayStart(firstDay)) / DAY_MS);
  if (days < DMARC_REVIEW_AFTER_DAYS) {
    const dueDay = new Date(dayStart(firstDay) + DMARC_REVIEW_AFTER_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return { status: "waiting", firstDay, days, dueDay };
  }

  // The day is the alert's one fact: where the reports to read begin. It is
  // also the alert's identity in the ops log, which only matters to two runs
  // racing each other; the check above is what makes it once, ever.
  await notifyOpsOnce(DMARC_REVIEW_EVENT, { windowStart: firstDay });

  // notifyOpsOnce never throws and returns nothing, so the ops log is where
  // its outcome is read back, for the console's note.
  const alert = await raisedAlert();
  return {
    status: "raised",
    firstDay,
    days,
    recorded: alert !== undefined,
    emailed: Boolean(alert?.sentAt),
    error: alert?.lastError ?? null,
  };
}

/** The job: one run, its outcome recorded on the job row for the console. */
export async function runDmarcReviewJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(JOB_DMARC_REVIEW, async () => noteFor(await checkDmarcReview(now)), now);
}

/** The first dmarc_review_due alert in the ops log, whatever its fields. */
async function raisedAlert(): Promise<
  { raisedAt: Date; sentAt: Date | null; lastError: string | null } | undefined
> {
  const [row] = await unsafeDb
    .select({
      raisedAt: opsAlerts.raisedAt,
      sentAt: opsAlerts.sentAt,
      lastError: opsAlerts.lastError,
    })
    .from(opsAlerts)
    .where(eq(opsAlerts.event, DMARC_REVIEW_EVENT))
    .orderBy(asc(opsAlerts.raisedAt))
    .limit(1);
  return row;
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** "today", "1 day ago", "13 days ago". */
function ago(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The job row's last-run note: what happened, in the console's words. Never an address. */
function noteFor(check: DmarcReviewCheck): string {
  switch (check.status) {
    case "nothing_sent":
      return "No email sent through Resend is on record yet; nothing to do.";
    case "waiting":
      return (
        `Resend first sent on ${check.firstDay}, ${ago(check.days)}; ` +
        `the DMARC review is due on ${check.dueDay}.`
      );
    case "raised": {
      const raised =
        `Resend first sent on ${check.firstDay}, ${ago(check.days)}: ` +
        "raised the DMARC review alert";
      if (!check.recorded) {
        // Whether its email went is not known, and with no row to find, a
        // process that starts afresh would raise it again.
        return `${raised}, but the ops log could not record it, so a later run may raise it again.`;
      }
      if (check.emailed) return `${raised} and emailed it.`;
      const why = scrub(check.error ?? "no error was recorded")
        .slice(0, 200)
        .replace(/\.?$/, ".");
      return `${raised}, but its email did not go: ${why}`;
    }
    case "already_raised":
      return (
        `The DMARC review alert was raised on ${check.raisedOn}` +
        (check.emailed ? "" : ", but its email did not go") +
        "; nothing more to do."
      );
  }
}

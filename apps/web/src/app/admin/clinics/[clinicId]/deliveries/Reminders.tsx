import { Chip, Empty, Failure, Section } from "@/components/admin/ui";
import type { ClinicBillingView, LifecycleWave, OpsResult } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The Deliveries tab's "Reminders" section (ops automation wave 2, lane A3):
 * every reminder the clinic was sent and every wave sent to ops about it,
 * newest first, one line each: what in words, to whom, when, and whether it
 * arrived, in the words apps/app gives.
 *
 * Two sources, merged so a reminder is listed once. The lifecycle watch's
 * ledger (listLifecycleWaves) holds the clinic's reminders with delivered
 * or bounced per wave, and every ops wave; but the watch is a job seeded
 * off, and the setup reminders go out whether it runs or not, as
 * `setup_reminder` notices in the outbox. So the outbox's notices are the
 * reminders when the watch has no row for them, and a notice the watch did
 * record is shown from its wave row alone (the same send, matched by the
 * minutes between queueing). The sentence that the six reminders are in the
 * list is therefore true with the watch off; what the watch adds is said
 * in one line only while it has added nothing.
 *
 * Every wave key apps/app can produce has words here (lib/lifecycle/waves.ts,
 * lib/setup/reminders.ts); one it does not know prints "Other alert", never
 * the key. Receipts without words: never an email body.
 */

const TARGET_WORDS: Record<LifecycleWave["target"], string> = {
  clinic_email: "the clinic",
  ops_email: "ops email",
  slack: "Slack",
};

const OUTCOME: Record<LifecycleWave["outcome"], { words: string; tone: Tone }> = {
  delivered: { words: "delivered", tone: "ok" },
  sent: { words: "sent", tone: "info" },
  pending: { words: "pending", tone: "muted" },
  bounced: { words: "bounced", tone: "bad" },
  failed: { words: "failed", tone: "bad" },
  skipped: { words: "skipped", tone: "muted" },
};

const STAGE_WORDS: Record<LifecycleWave["stage"], string> = {
  not_started: "not started",
  in_setup: "in setup",
  waiting_on_us: "waiting on us",
  partly_live: "partly live",
  live: "live",
  closed: "closed",
};

/**
 * A wave's key as words. The day-22, 27 and 30 waves are the decision alert
 * or the closing-soon alert, as the event of the alert the wave carried says
 * (`event`, lane A4). A wave with no event (a skipped one raises no alert,
 * or an older apps/app) falls back to the escalation flag: apps/app escalates
 * exactly the decision alert.
 */
export function waveWords(wave: string, escalated = false, event: string | null = null): string {
  const [name = "", detail = ""] = wave.split(":", 2);
  if (name === "setup_reminder") {
    if (detail === "live" || wave.startsWith("setup_reminder:live:")) return "Setup reminder after a channel went live";
    return /^\d+$/.test(detail) ? `Setup reminder ${detail} of 6` : "Setup reminder";
  }
  const dayBand = /^day_(22|27|30)$/.exec(name);
  if (dayBand) {
    const decision =
      event === "lifecycle_decision_due" ? true : event === "lifecycle_closing_soon" ? false : escalated;
    return `${decision ? "Decision alert" : "Closing-soon alert"}, day ${dayBand[1]}`;
  }
  switch (name) {
    case "day_7":
      return "No-progress alert, day 7";
    case "day_15":
      return "No-progress alert, day 15";
    case "wait_4h":
      return "Waiting-on-us alert, 4 hours";
    case "wait_1bd":
      return "Waiting-on-us alert, 1 business day";
    case "wait_2bd":
      return "Waiting-on-us alert, 2 business days";
    case "wait_close_27":
      return "Closing warning while waiting on us, day 27";
    case "wait_close_30":
      return "Closing warning while waiting on us, day 30";
    case "live_7":
      return "Channel still waiting, 7 days after going live";
    case "live_14":
      return "Channel still waiting, 14 days after going live";
    case "undelivered":
      return "Undelivered-reminder alert";
    case "unanswered":
      return "Reminders-unanswered alert";
    default:
      return "Other alert";
  }
}

/** The outcome in words: a skip says why, as the alert wording promises. */
export function outcomeWords(wave: LifecycleWave): { words: string; tone: Tone } {
  if (wave.outcome === "skipped") {
    if (wave.skippedBecause === "snoozed") return { words: "snoozed", tone: "muted" };
    if (wave.skippedBecause === "let_close") return { words: "skipped: let it close", tone: "muted" };
  }
  return OUTCOME[wave.outcome];
}

function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** "2026-10-16 09:00 UTC", the billing view's form, as an instant; NaN when it is not one. */
function noticeInstant(at: string): number {
  return Date.parse(at.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/, "$1T$2:00Z"));
}

export const SETUP_REMINDER_KIND = "setup_reminder";
/** A notice and a reminder wave queued within this long of each other are the same send. */
export const SAME_SEND_MS = 10 * 60 * 1000;

type Notice = ClinicBillingView["notices"][number];

/** One line of the merged ledger. */
export type ReminderLine = {
  id: string;
  at: string;
  words: string;
  to: string;
  outcome: { words: string; tone: Tone };
  stage: string | null;
  escalated: boolean;
  manualBy: string | null;
  detail: string | null;
};

function fromWave(wave: LifecycleWave): ReminderLine {
  return {
    id: wave.id,
    at: wave.sentAt ?? wave.queuedAt,
    words: waveWords(wave.wave, wave.escalated, wave.event),
    to: TARGET_WORDS[wave.target],
    outcome: outcomeWords(wave),
    stage: STAGE_WORDS[wave.stage],
    escalated: wave.escalated,
    manualBy: wave.manualBy,
    detail: null,
  };
}

function fromNotice(notice: Notice, index: number): ReminderLine {
  const queued = noticeInstant(notice.createdAt);
  return {
    id: `notice:${index}:${notice.createdAt}`,
    at: Number.isNaN(queued) ? notice.createdAt : new Date(queued).toISOString(),
    words: "Setup reminder",
    to: "the clinic",
    outcome: notice.sentAt ? { words: "sent", tone: "info" } : notice.attempts > 0 ? { words: "not sent yet", tone: "warn" } : { words: "queued", tone: "muted" },
    stage: null,
    escalated: false,
    manualBy: null,
    detail: `${notice.sentAt ? `sent ${notice.sentAt}` : `due ${notice.sendAfter}`}${notice.attempts > 0 ? ` · ${notice.attempts} ${notice.attempts === 1 ? "attempt" : "attempts"}` : ""}${notice.lastError ? ` · ${notice.lastError}` : ""}`,
  };
}

/** The waves and the outbox's reminders as one list, newest first, a send listed once. */
export function mergeReminders(waves: LifecycleWave[], notices: Notice[]): ReminderLine[] {
  const reminderWaves = waves.filter((w) => w.wave.startsWith("setup_reminder") && w.target === "clinic_email");
  const unmatched = notices
    .filter((n) => n.kind === SETUP_REMINDER_KIND)
    .filter((n) => {
      const queued = noticeInstant(n.createdAt);
      if (Number.isNaN(queued)) return true;
      return !reminderWaves.some((w) => Math.abs(Date.parse(w.queuedAt) - queued) <= SAME_SEND_MS);
    });
  const lines = [...waves.map(fromWave), ...unmatched.map(fromNotice)];
  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export function Reminders({ waves, billing }: { waves: OpsResult<LifecycleWave[]>; billing: OpsResult<ClinicBillingView> }) {
  const lines = mergeReminders(waves.ok ? waves.data : [], billing.ok ? billing.data.notices : []);
  const bothFailed = !waves.ok && !billing.ok;
  return (
    <Section id="reminders" title={`Reminders${bothFailed ? "" : ` — ${lines.length}`}`}>
      <p className="text-muted text-sm">The clinic&rsquo;s six setup reminders are in this list, with every wave sent to ops about it. Newest first.</p>
      {!waves.ok ? <Failure failure={waves} what="the ops waves" /> : null}
      {!billing.ok ? <Failure failure={billing} what="the setup reminders in the outbox" /> : null}
      {waves.ok && waves.data.length === 0 ? (
        <p className="text-muted mt-2 text-sm">Ops alerts about this clinic&rsquo;s setup appear here once the lifecycle watch is switched on.</p>
      ) : null}
      {bothFailed ? null : lines.length === 0 ? (
        <Empty>No reminder sent yet.</Empty>
      ) : (
        <ul className="mt-3 grid gap-1 text-sm">
          {lines.map((line) => (
            <li key={line.id} className="border-line flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-1.5">
              <span className="font-medium">{line.words}</span>
              <span className="text-muted">to {line.to}</span>
              <span className="text-muted">{when(line.at)}</span>
              <Chip tone={line.outcome.tone}>{line.outcome.words}</Chip>
              {line.escalated ? <Chip tone="warn">escalated</Chip> : null}
              {line.manualBy ? <span className="text-muted">sent by hand by {line.manualBy}</span> : null}
              {line.detail ? <span className="text-muted text-xs">{line.detail}</span> : null}
              {line.stage ? <span className="text-muted ml-auto text-xs">{line.stage}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

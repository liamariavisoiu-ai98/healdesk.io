import { Chip, Empty, Failure, Section } from "@/components/admin/ui";
import type { LifecycleWave, OpsResult } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The Deliveries tab's "Reminders" section (ops automation wave 2, lane A3):
 * the lifecycle watch's ledger for one clinic, one line per reminder or ops
 * wave, newest first: what went, to whom, when, and whether it arrived, in
 * the words apps/app gives (a wave skipped for a snooze reads "snoozed"). The
 * clinic's six setup reminders are in it (D4), beside every wave to ops. The
 * lifecycle alerts link here (`#reminders`).
 *
 * Receipts without words: a wave key, a target, two times and an outcome;
 * never an email body.
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

/** A wave's key as words: `setup_reminder:3` is "Setup reminder 3 of 6", `day_22:…` the day-22 decision alert. */
export function waveWords(wave: string): string {
  const [name, detail] = wave.split(":", 2);
  switch (name) {
    case "setup_reminder":
      return detail ? `Setup reminder ${detail} of 6` : "Setup reminder";
    case "day_22":
      return "Day-22 decision alert";
    case "wait_4h":
      return "Waiting-on-us alert (4 hours)";
    default:
      return (name ?? wave).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
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

export function Reminders({ waves }: { waves: OpsResult<LifecycleWave[]> }) {
  const newestFirst = waves.ok ? [...waves.data].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : a.queuedAt > b.queuedAt ? -1 : 0)) : [];
  return (
    <Section id="reminders" title={`Reminders${waves.ok ? ` — ${newestFirst.length}` : ""}`}>
      <p className="text-muted text-sm">The clinic&rsquo;s six setup reminders are in this list, with every wave sent to ops about it. Newest first.</p>
      {!waves.ok ? (
        <Failure failure={waves} what="the reminders" />
      ) : newestFirst.length === 0 ? (
        <Empty>No reminder or ops wave yet.</Empty>
      ) : (
        <ul className="mt-3 grid gap-1 text-sm">
          {newestFirst.map((wave) => {
            const outcome = outcomeWords(wave);
            return (
              <li key={wave.id} className="border-line flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-1.5">
                <span className="font-medium">{waveWords(wave.wave)}</span>
                <span className="text-muted">to {TARGET_WORDS[wave.target]}</span>
                <span className="text-muted">{when(wave.sentAt ?? wave.queuedAt)}</span>
                <Chip tone={outcome.tone}>{outcome.words}</Chip>
                {wave.escalated ? <Chip tone="warn">escalated</Chip> : null}
                {wave.manualBy ? <span className="text-muted">sent by hand by {wave.manualBy}</span> : null}
                <span className="text-muted ml-auto text-xs">{STAGE_WORDS[wave.stage]}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

"use client";

import { onDay, PHRASE_WORDS } from "@/components/admin/approval-words";
import { extendedWords } from "@/components/admin/extension-words";
import { useState } from "react";

import { ActionButton, Section } from "@/components/admin/ui";
import type {
  ContactPhrase,
  ExtendDeadlineOutcome,
  LifecycleIgnoreOutcome,
  LifecycleNoticeKind,
  LifecycleRow,
  LifecycleWriteOutcome,
  OpsResult,
  ProposeOutcome,
} from "@/lib/admin/ops-client";

/**
 * The Setup tab's "Setup window" card (ops automation wave 2, lane A3), for
 * a clinic the lifecycle watch covers: the stage in words, the window's end
 * and the days left, the last progress, the decision so far, the snooze, and
 * the recommendation sentence the watch computed, shown as it came (never
 * recomputed here). The lifecycle alerts link here (`#setup-window`) and
 * quote the four controls: "Extend the setup window", "Offered a call",
 * "Let it close" and "Snooze alerts".
 *
 * The deadline is the billing view's (`setupDeadlineIso`), the live value
 * the Billing tab's own control uses, not the watch's hourly snapshot: an
 * extension names the deadline the page showed and apps/app refuses once it
 * has moved, so a replay cannot add the days twice, and a page re-rendered
 * after an extension shows the new one and extends from it. Extend is drawn
 * only while the plan has not started (apps/app refuses it after); the
 * three decision controls only in the stages a decision applies to.
 *
 * "Let it close" asks once, with a sentence that is true: the decision only
 * silences the day-27 and day-30 warnings (apps/app lib/lifecycle/waves.ts);
 * the window still closes on its last day and every other alert continues.
 * "Snooze alerts" mutes the routine ops waves for 3, 7 or 14 days; an
 * escalation is never snoozed, and the clinic's own reminders never are (D6).
 *
 * What the header and the summary above already say (the stage chip, the
 * steps and channels left) is not said again here.
 *
 * "Do not watch this account" (Phase 5, lane P5b) is for healdesk's own test
 * accounts, which look like paying clinics to the lifecycle watch. It puts the
 * account on the watch's ignore list (apps/app lib/lifecycle/ignore.ts),
 * which exactly these read: the watch itself, so no setup-window wave goes
 * to ops; Home's "needs a decision" and "ready to go live" rows; and the
 * alert list, which drops the watch's waves for it. Nothing else reads the
 * list: the clinic still gets its setup reminder emails every five days
 * (lib/setup/reminders.ts), the account still closes at the end of its setup
 * window unless the window is extended (the setup closure does not read it),
 * and its calendar, voice and billing alerts still arrive. A clearly
 * secondary control, asking once with that sentence. The card still draws
 * for an account that is not watched, with apps/app's own recommendation
 * sentence saying so, and offers the way back; the decision controls and the
 * snooze row are not drawn then, since no wave is owed.
 *
 * The four proposals (ops automation lane P6j; the operations are lane
 * P6f's, apps/app lib/ops/notice-ops.ts) each only PROPOSE an email to the
 * clinic, with its draft, for the owner's yes under Queues › Approvals;
 * nothing is sent from here. "Propose more time" proposes an extension by
 * the days in the field and the email telling the clinic (on approve, the
 * extension runs first and the email goes only if it went through); it is
 * drawn beside "Extend the setup window", which extends at once with no
 * email, in the stages still inside the window. "Propose: we are finishing
 * it" is drawn only while the clinic waits on us (apps/app refuses it in any
 * other stage), once per entry into that stage, and extends nothing (owner
 * decision D6). "Offer a five-minute call" is drawn while setup is still
 * open, partly live included, once per stage entry. "Send the next reminder
 * now" proposes the next of the six setup reminders sooner, never a seventh,
 * and apps/app refuses it when it is night at the clinic, a reminder went in
 * the last five days, the next would be the sixth (sent only on the last
 * day), a channel is live or the window is over; each refusal is shown in
 * apps/app's own sentence. The watch's recommendation sentence already on
 * the card is the advice beside them; nothing is recomputed here.
 */

export const LET_CLOSE_CONFIRM =
  "The clinic's setup window will still close on its last day. The day-27 and day-30 warnings to ops stop; other alerts about this clinic continue.";

export const IGNORE_CONFIRM =
  "For healdesk's own test accounts. Ops stops getting this account's setup-window alerts, and it leaves Home's decision and go-live rows. The clinic still gets its setup reminder emails every five days, the account still closes at the end of its setup window unless the window is extended, and its calendar, voice and billing alerts still arrive.";

export const IGNORED_DONE = "Not watched (internal): no more setup-window alerts to ops for this account. Its reminder emails and its closing day are unchanged.";
export const WATCHED_DONE = "Watched again: setup-window alerts to ops and Home's decision and go-live rows resume for this account.";

/** The one sentence over the four proposals: what each does, and what none does. */
export const PROPOSALS_WORDS = "Each of these only proposes an email, with its draft, for your yes under Queues › Approvals. Nothing is sent from here.";

export const PROPOSED_WORDS = "Proposed: waiting for your yes under Queues › Approvals.";

/** What "Send the next reminder now" proposed: which of the six, and its own day. */
export function reminderProposedWords(data: ProposeOutcome): string | null {
  if (data.status !== "proposed") return null;
  if (data.reminderNumber === undefined || data.normallyDueOn === undefined) return PROPOSED_WORDS;
  return `Proposed: reminder ${data.reminderNumber} of 6, normally due ${onDay(data.normallyDueOn)}, waiting for your yes under Queues › Approvals.`;
}

export type ProposeNotice = (input: { kind: LifecycleNoticeKind; days?: number; phrase?: ContactPhrase }) => Promise<OpsResult<ProposeOutcome>>;
export type PullReminder = () => Promise<OpsResult<ProposeOutcome>>;

/** The stages a setup notice applies to (apps/app lib/ops/notice-ops.ts SETUP_STAGES, HELP_STAGES). */
const SETUP_STAGES: ReadonlySet<LifecycleRow["stage"]> = new Set(["not_started", "in_setup", "waiting_on_us"]);
const HELP_STAGES: ReadonlySet<LifecycleRow["stage"]> = new Set(["not_started", "in_setup", "waiting_on_us", "partly_live"]);

const PHRASES = Object.keys(PHRASE_WORDS) as ContactPhrase[];

/** The ignore outcome as the one button pattern reads it. */
function asIgnoreStatus(result: OpsResult<LifecycleIgnoreOutcome>): OpsResult<{ status: string; ignored: boolean; auditRecorded: boolean }> {
  if (!result.ok) return result;
  return { ok: true, data: { status: "saved", ignored: result.data.ignored, auditRecorded: result.data.auditRecorded } };
}

const STAGE_WORDS: Record<LifecycleRow["stage"], string> = {
  not_started: "not started",
  in_setup: "in setup",
  waiting_on_us: "waiting on us",
  partly_live: "partly live",
  live: "live",
  closed: "closed",
};

/** The stages a decision about the setup window applies to. */
const DECIDABLE: ReadonlySet<LifecycleRow["stage"]> = new Set(["not_started", "in_setup", "waiting_on_us"]);

export const SNOOZE_DAYS = [3, 7, 14] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

/** The window's end as the Billing tab shows it, and the instant an extension names. */
export type WindowDeadline = { at: string; iso: string };

export type ExtendWindow = (input: { days: number; fromDeadline: string }) => Promise<OpsResult<ExtendDeadlineOutcome>>;

function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole days from `now` to the deadline, never below zero; null when either cannot be read. */
export function daysLeft(deadlineIso: string, nowIso: string): number | null {
  const end = Date.parse(deadlineIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(end) || Number.isNaN(now)) return null;
  return Math.max(0, Math.ceil((end - now) / 86_400_000));
}

/** The extension's default: the watch's recommended days, held to the form's 1 to 30. */
export function defaultExtendDays(recommended: number | null): number {
  if (recommended === null || !Number.isFinite(recommended)) return 7;
  return Math.min(30, Math.max(1, Math.round(recommended)));
}

function decisionWords(row: LifecycleRow): string {
  const when = row.decidedAt ? day(row.decidedAt) : null;
  const by = row.decidedBy ? `, ${row.decidedBy}` : "";
  switch (row.decision) {
    case "none":
      return "none yet";
    case "extension_offered":
      return `a call was offered${when ? ` (${when}${by})` : ""}`;
    case "let_close":
      return `let it close${when ? ` (${when}${by})` : ""}`;
    case "extended":
      return when ? `Extended on ${when}${by}` : "extended";
  }
}

/**
 * `LifecycleWriteOutcome` as the one button pattern reads it: a status word,
 * and whether the audit entry was written, which ActionButton turns into its
 * shared warning (UNAUDITED) after the button's own sentence.
 */
function asStatus(
  result: OpsResult<LifecycleWriteOutcome>,
): OpsResult<{ status: string; message?: string; auditRecorded?: boolean }> {
  if (!result.ok) return result;
  return result.data.outcome === "saved"
    ? { ok: true, data: { status: "saved", auditRecorded: result.data.auditRecorded } }
    : { ok: true, data: { status: "refused", message: "This clinic is not watched, so nothing was recorded." } };
}

export function SetupWindow({
  row,
  deadline,
  canExtend,
  now,
  onExtend,
  onDecide,
  onSnooze,
  onSetIgnored,
  onProposeNotice,
  onPullReminder,
}: {
  row: LifecycleRow;
  /** The billing view's setup deadline; null when the clinic has none (or the billing read failed). */
  deadline: WindowDeadline | null;
  /** The Billing tab's own rule: the plan has not started and the account is open. */
  canExtend: boolean;
  /** The server's clock, ISO, so the days left are the same on both renders. */
  now: string;
  onExtend: ExtendWindow;
  onDecide: (decision: "extension_offered" | "let_close") => Promise<OpsResult<LifecycleWriteOutcome>>;
  onSnooze: (days: SnoozeDays) => Promise<OpsResult<LifecycleWriteOutcome>>;
  onSetIgnored: (ignored: boolean) => Promise<OpsResult<LifecycleIgnoreOutcome>>;
  onProposeNotice: ProposeNotice;
  onPullReminder: PullReminder;
}) {
  const advice = row.recommendation;
  const [days, setDays] = useState(String(defaultExtendDays(advice.days)));
  const [snooze, setSnooze] = useState<SnoozeDays>(7);
  const [phrase, setPhrase] = useState<ContactPhrase>(PHRASES[0]!);
  const left = deadline ? daysLeft(deadline.iso, now) : null;
  const ignored = row.ignored === true;
  // Nothing is owed for an account that is not watched: no decision to record.
  const decidable = !ignored && DECIDABLE.has(row.stage);
  const extendable = canExtend && deadline !== null;
  // The proposals, each in the stages apps/app accepts it; none for an account on the ignore list (apps/app refuses).
  const canProposeTime = !ignored && extendable && SETUP_STAGES.has(row.stage);
  const canProposeWaiting = !ignored && row.stage === "waiting_on_us";
  const canProposeCall = !ignored && HELP_STAGES.has(row.stage);
  const canPullReminder = !ignored && SETUP_STAGES.has(row.stage);
  const proposals = canProposeTime || canProposeWaiting || canProposeCall || canPullReminder;
  const proposed = (data: ProposeOutcome) => (data.status === "proposed" ? PROPOSED_WORDS : null);

  return (
    <Section id="setup-window" title="Setup window">
      <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
        <dt className="text-muted">Stage</dt>
        <dd>
          {STAGE_WORDS[row.stage]} since {day(row.stageSince)}
        </dd>
        <dt className="text-muted">Window ends</dt>
        <dd>{deadline ? `${deadline.at}${left !== null ? `: ${left} ${left === 1 ? "day" : "days"} left` : ""}` : "no setup deadline on the billing account"}</dd>
        <dt className="text-muted">Last progress</dt>
        <dd>{row.lastProgressAt ? day(row.lastProgressAt) : "none recorded"}</dd>
        <dt className="text-muted">Decision so far</dt>
        <dd>{decisionWords(row)}</dd>
        {!ignored ? (
          <>
            <dt className="text-muted">Routine ops alerts</dt>
            <dd>{row.snoozedUntil ? `snoozed until ${day(row.snoozedUntil)}${row.snoozedBy ? ` by ${row.snoozedBy}` : ""}` : "on"}</dd>
          </>
        ) : null}
      </dl>

      <p className="border-line mt-3 border-t pt-3 text-sm">{advice.reason}</p>

      {extendable || decidable ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {extendable ? (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => event.preventDefault()}>
              <label className="text-sm">
                <span className="text-muted block text-xs font-bold uppercase">Days (1–30)</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                  aria-label="Days to extend by"
                  className="border-line mt-1 w-24 rounded-sm border px-3 py-2"
                />
              </label>
              <ActionButton
                label="Extend the setup window"
                variant="primary"
                run={() => onExtend({ days: Number(days), fromDeadline: deadline.iso })}
                done={extendedWords}
              />
              {canProposeTime ? <ActionButton label="Propose more time" run={() => onProposeNotice({ kind: "setup_extended", days: Number(days) })} done={proposed} /> : null}
            </form>
          ) : null}
          {decidable ? (
            <>
              <ActionButton label="Offered a call" run={async () => asStatus(await onDecide("extension_offered"))} done={() => "Recorded: a call was offered."} />
              <ActionButton
                label="Let it close"
                variant="destructive"
                confirm={LET_CLOSE_CONFIRM}
                run={async () => asStatus(await onDecide("let_close"))}
                done={() => "Recorded: the window closes on its last day; the day-27 and day-30 warnings stop."}
              />
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  <span className="text-muted block text-xs font-bold uppercase">For</span>
                  <select
                    value={snooze}
                    onChange={(event) => setSnooze(Number(event.target.value) as SnoozeDays)}
                    aria-label="Snooze for"
                    className="border-line mt-1 rounded-sm border bg-white px-3 py-2"
                  >
                    {SNOOZE_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d} days
                      </option>
                    ))}
                  </select>
                </label>
                <ActionButton label="Snooze alerts" run={async () => asStatus(await onSnooze(snooze))} done={() => `Routine ops alerts snoozed for ${snooze} days.`} />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {proposals ? (
        <div className="border-line mt-4 border-t pt-3">
          <p className="text-sm">{PROPOSALS_WORDS}</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            {canProposeWaiting || canProposeCall ? (
              <label className="text-sm">
                <span className="text-muted block text-xs font-bold uppercase">What the email names</span>
                <select
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value as ContactPhrase)}
                  aria-label="What the email names"
                  className="border-line mt-1 rounded-sm border bg-white px-3 py-2"
                >
                  {PHRASES.map((p) => (
                    <option key={p} value={p}>
                      {PHRASE_WORDS[p]}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {canProposeWaiting ? (
              <ActionButton label="Propose: we are finishing it" run={() => onProposeNotice({ kind: "setup_waiting_on_us", phrase })} done={proposed} />
            ) : null}
            {canProposeCall ? <ActionButton label="Offer a five-minute call" run={() => onProposeNotice({ kind: "setup_help_offer", phrase })} done={proposed} /> : null}
            {canPullReminder ? <ActionButton label="Send the next reminder now" run={() => onPullReminder()} done={reminderProposedWords} /> : null}
          </div>
        </div>
      ) : null}

      <div className="border-line mt-4 border-t pt-3">
        <IgnoreControl ignored={ignored} onSetIgnored={onSetIgnored} />
      </div>
    </Section>
  );
}

/** The one control that puts a test account on the watch's ignore list, or takes it off. */
function IgnoreControl({ ignored, onSetIgnored }: { ignored: boolean; onSetIgnored: (ignored: boolean) => Promise<OpsResult<LifecycleIgnoreOutcome>> }) {
  return ignored ? (
    <ActionButton label="Watch this account again" run={async () => asIgnoreStatus(await onSetIgnored(false))} done={() => WATCHED_DONE} />
  ) : (
    <ActionButton label="Do not watch this account" confirm={IGNORE_CONFIRM} run={async () => asIgnoreStatus(await onSetIgnored(true))} done={() => IGNORED_DONE} />
  );
}

/**
 * The card for a clinic still in setup that the watch has not seen yet (its
 * hourly tick is behind a switch seeded off, so a clinic can be weeks into
 * setup with no row): one line saying so, and the ignore control, so a test
 * account can be marked before the watch ever chases it. `ignored` is the
 * ignore list's own row, read apart from the watch; a mark set this way is
 * drawn here and can be undone here.
 */
export function SetupWatchStub({
  ignored,
  onSetIgnored,
}: {
  ignored: boolean;
  onSetIgnored: (ignored: boolean) => Promise<OpsResult<LifecycleIgnoreOutcome>>;
}) {
  return (
    <Section id="setup-window" title="Setup window">
      <p className="text-sm">
        {ignored ? "Not watched (internal): one of healdesk's own test accounts, and not on the setup watch yet." : "Not on the setup watch yet."}
      </p>
      <div className="mt-3">
        <IgnoreControl ignored={ignored} onSetIgnored={onSetIgnored} />
      </div>
    </Section>
  );
}

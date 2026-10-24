"use client";

import { useState } from "react";

import { ActionButton, CodeField, Failure, isCompleteCode, Section, type ActionOutcome } from "@/components/admin/ui";
import { isPermanentRefusal, problemsWords, scrubContact, somethingGone, voiceStatusWords } from "@/components/admin/voice-words";
import type { OpsResult, VoiceAgentReportView, VoiceAgentStatusView } from "@/lib/admin/ops-client";
import type { ClearVoiceDriftFlagEntry, RetryVoiceAgentEntry } from "@/lib/admin/voice-drift";

/**
 * The Setup tab's "Voice agent" card (ops automation Phase 5, lane P5b;
 * design E3 §2.4): one clinic's Retell set-up in words, and the three
 * controls the voice alerts quote. "Retry" runs one more provisioning run
 * under every guard a scheduled run has; it can buy a phone number, so it
 * goes through lib/admin/voice-drift.ts with a fresh code from the
 * operator's authenticator, checked on this app before anything crosses,
 * and asks once more when a number may be bought. "Check against Retell"
 * reads the agent and number back (GET requests, never a call placed) and
 * says what differs. "Clear flag and recheck" is drawn only while the clinic
 * is flagged as drifted and enters the same way, with the same code field.
 *
 * Never a phone number: apps/app sends whether one is held, the ops client
 * drops the number a ready retry binds, and the one free-text field here
 * (our own last reason) is scrubbed of anything shaped like one. A button
 * that the state does not allow is not drawn, and the line beside says why:
 * a ready agent has nothing to retry; one being set up or released is left
 * to finish; a released one has nothing left to read back.
 */

export type VoiceAgentActions = {
  retry: (code: string) => Promise<OpsResult<RetryVoiceAgentEntry>>;
  check: () => Promise<OpsResult<{ agents: VoiceAgentStatusView[]; report: VoiceAgentReportView | null }>>;
  clearFlag: (code: string) => Promise<OpsResult<ClearVoiceDriftFlagEntry>>;
};

// True to the drift-flag clear in apps/app lib/voice/provision.ts: the repair count is reset with the flag, so the check it runs repairs what re-applying can, and flags again only what it cannot put back; the nightly check's three-repair rule then applies as before.
export const CLEAR_FLAG_CONFIRM =
  "Clears the drift flag and runs the Retell check once: what can be put right is written again, and in that check the flag comes back only if the agent or number is missing at Retell (on later nights, as before).";
export const BUY_NUMBER_CONFIRM = "This may buy a phone number for the clinic.";

function day(iso: string): string {
  return iso.slice(0, 10);
}

type Said = { status: "done" | "refused"; message: string };

const done = (message: string): OpsResult<Said> => ({ ok: true, data: { status: "done", message } });
const refused = (message: string): OpsResult<Said> => ({ ok: true, data: { status: "refused", message } });

/** What a retry found already there (apps/app answers `already` only for these three). */
const ALREADY_WORDS: Record<VoiceAgentStatusView["status"], string> = {
  ready: "the agent is already ready",
  deprovisioning: "the agent is being released",
  released: "the agent and number were already given back",
  pending: "the agent is queued for its first run",
  provisioning: "the agent is being set up",
  failed: "the agent's set-up failed",
};

/** A retry's outcome as one sentence: ready, already set up, not allowed (for good, or yet) and why, failed, code refused. */
export function retryWords(result: OpsResult<RetryVoiceAgentEntry>): OpsResult<Said> {
  if (!result.ok) return result;
  const r = result.data;
  switch (r.outcome) {
    case "ready":
      return done(`Ready: the agent is set up${r.adopted ? ", adopting the agent the clinic already had" : ""}, and a number is held.`);
    case "already":
      return done(`Nothing was run: ${ALREADY_WORDS[r.status]}.`);
    case "not_eligible":
      return refused(`${isPermanentRefusal(r.reason) ? "Not allowed" : "Not allowed yet"}: ${scrubContact(r.reason)}.`);
    case "switched_off":
      return refused("Not allowed yet: the owner's switch for voice provisioning is off.");
    case "no_key":
      return refused("Not allowed yet: no Retell key is on the host.");
    case "deferred":
      return refused("Not allowed today: the daily cap on numbers bought is reached. The scheduled run tries tomorrow.");
    case "failed":
      return refused(`Failed (${r.code.replace(/_/g, " ")}): ${scrubContact(r.reason)}.`);
    case "retry":
      return refused(`Not done this time: ${scrubContact(r.reason)}. The hourly run tries again while the voice provisioning switch is on.`);
    case "code_refused":
      return refused(r.message);
    case "not_found":
      return refused("No such clinic.");
  }
}

/** The read-back as one sentence: matches, differs and how, or was not read. */
export function checkWords(result: OpsResult<{ agents: VoiceAgentStatusView[]; report: VoiceAgentReportView | null }>): OpsResult<Said> {
  if (!result.ok) return result;
  const report = result.data.report;
  if (report === null) return refused("Retell was not read back.");
  if (!report.checked) return refused(`Retell was not read: ${report.note ? scrubContact(report.note) : "no reason given"}.`);
  if (report.ok) return done("Matches Retell: the agent and the number are as we set them.");
  return refused(`Differs from Retell: ${problemsWords(report.problems)}.`);
}

/** Who acts when the check finds the agent or the number gone at Retell: the nightly check cannot put either back. */
export const GONE_AT_RETELL =
  "The nightly check cannot put that back: ask Retell support what happened to it, or have whoever maintains the engine release this clinic's voice set-up and run provisioning again.";

/** The clear's outcome as one sentence: cleared (and what the check found), still drifted with the problem and who acts, code refused. */
export function clearWords(result: OpsResult<ClearVoiceDriftFlagEntry>): OpsResult<Said> {
  if (!result.ok) return result;
  const r = result.data;
  switch (r.outcome) {
    case "cleared":
      switch (r.check) {
        case "clean":
          return done("Flag cleared. The check ran: Retell matches our settings.");
        case "repaired":
          return done(`Flag cleared. The check ran and repaired Retell: ${problemsWords(r.problems)}.`);
        case "skipped":
          return done("Flag cleared. The check was skipped this time; the nightly one runs next.");
        case "failed":
          return done("Flag cleared, but the check could not run. The nightly one runs next.");
      }
      break;
    case "still_drifted":
      return refused(`Still drifted: ${problemsWords(r.problems)}. The flag stays.${somethingGone(r.problems) ? ` ${GONE_AT_RETELL}` : ""}`);
    case "code_refused":
      return refused(r.message);
    case "not_flagged":
      return done("Not flagged: nothing to clear.");
    case "not_found":
      return refused("No such clinic.");
  }
  return refused("The answer could not be read.");
}

/**
 * Whether a retry is a thing to offer in this state, and the one line that
 * says why when it is not. A `provisioning` row with a last reason is a run
 * that stopped, so it may be retried; one without is a run in progress.
 */
export function retryAllowed(agent: VoiceAgentStatusView | null): { allowed: boolean; why: string | null } {
  if (agent === null) return { allowed: true, why: null };
  switch (agent.status) {
    case "pending":
    case "failed":
      return { allowed: true, why: null };
    case "provisioning":
      return agent.lastError ? { allowed: true, why: null } : { allowed: false, why: "Nothing to retry while it is being set up: wait for the run to finish." };
    case "ready":
      return { allowed: false, why: "Nothing to retry: the agent is ready." };
    case "deprovisioning":
      return { allowed: false, why: "Nothing to retry while it is being released." };
    case "released":
      return { allowed: false, why: "Nothing to retry: the agent and number were given back." };
  }
}

/** A retry may buy a number when none is held yet: before the first run, or after a run that stopped before the number. */
export function mayBuyNumber(agent: VoiceAgentStatusView | null): boolean {
  return agent === null || !agent.hasNumber;
}

/** The read-back has something to compare while the agent is kept; a released or releasing set-up has nothing left. */
export function checkAllowed(agent: VoiceAgentStatusView | null): boolean {
  return agent !== null && agent.status !== "released" && agent.status !== "deprovisioning";
}

const sentence = (said: ActionOutcome) => said.message ?? null;

export function VoiceAgentCard({ read, actions }: { read: OpsResult<VoiceAgentStatusView[]>; actions: VoiceAgentActions }) {
  const [code, setCode] = useState("");
  const agent = read.ok ? (read.data[0] ?? null) : null;
  const retry = retryAllowed(agent);
  const flagged = agent?.driftFlaggedAt ?? null;
  const needsCode = read.ok && (retry.allowed || flagged !== null);
  // The status line already carries the reason for a run that stopped; the row would say it twice.
  const problemInStatus = agent?.status === "provisioning" && Boolean(agent.lastError);

  return (
    <Section id="voice" title="Voice agent">
      {!read.ok ? <Failure failure={read} what="the voice agent" /> : null}
      {read.ok && agent === null ? (
        <p className="text-sm">
          No voice set-up has been scheduled for this clinic. Retry starts one when apps/app allows it (the first invoice paid, billing in good standing, a package
          with phone); otherwise it says why not.
        </p>
      ) : null}
      {agent ? (
        <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
          <dt className="text-muted">Status</dt>
          <dd>{voiceStatusWords(agent)}</dd>
          <dt className="text-muted">Phone number</dt>
          <dd>{agent.hasNumber ? "one is held" : "none held yet"}</dd>
          {!problemInStatus ? (
            <>
              <dt className="text-muted">Last problem</dt>
              <dd>{agent.lastError ? scrubContact(agent.lastError) : "none recorded"}</dd>
            </>
          ) : null}
          <dt className="text-muted">Drift</dt>
          <dd>
            {flagged
              ? `Flagged on ${day(flagged)}: Retell no longer matched our settings and the nightly check skips it until the flag is cleared${agent.driftRepairs > 0 ? ` (repaired ${agent.driftRepairs} ${agent.driftRepairs === 1 ? "time" : "times"} before)` : ""}.`
              : agent.driftRepairs > 0
                ? `Not flagged; repaired ${agent.driftRepairs} ${agent.driftRepairs === 1 ? "time" : "times"} by the nightly check.`
                : "Not flagged."}
          </dd>
        </dl>
      ) : null}

      {read.ok ? (
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => event.preventDefault()}>
          {needsCode ? <CodeField value={code} onChange={setCode} /> : null}
          {retry.allowed ? (
            <ActionButton
              label="Retry"
              confirm={mayBuyNumber(agent) ? BUY_NUMBER_CONFIRM : undefined}
              disabled={!isCompleteCode(code)}
              run={async () => retryWords(await actions.retry(code))}
              done={sentence}
            />
          ) : (
            <p className="text-muted text-sm">{retry.why}</p>
          )}
          {checkAllowed(agent) ? <ActionButton label="Check against Retell" run={async () => checkWords(await actions.check())} done={sentence} /> : null}
          {flagged ? (
            <ActionButton
              label="Clear flag and recheck"
              confirm={CLEAR_FLAG_CONFIRM}
              disabled={!isCompleteCode(code)}
              run={async () => clearWords(await actions.clearFlag(code))}
              done={sentence}
            />
          ) : null}
        </form>
      ) : null}
    </Section>
  );
}

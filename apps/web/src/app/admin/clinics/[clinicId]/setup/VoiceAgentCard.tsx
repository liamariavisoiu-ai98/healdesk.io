"use client";

import { useState } from "react";

import { ActionButton, CodeField, Failure, isCompleteCode, Section, type ActionOutcome } from "@/components/admin/ui";
import { problemsWords, scrubContact, VOICE_ENGINE_WORDS, VOICE_STATUS_WORDS } from "@/components/admin/voice-words";
import type {
  OpsResult,
  RetryVoiceAgentOutcome,
  VoiceAgentReportView,
  VoiceAgentStatusView,
} from "@/lib/admin/ops-client";
import type { ClearVoiceDriftFlagEntry } from "@/lib/admin/voice-drift";

/**
 * The Setup tab's "Voice agent" card (ops automation Phase 5, lane P5b;
 * design E3 §2.4): one clinic's Retell set-up in words, and the three
 * controls the voice alerts quote. "Retry" runs one more provisioning run
 * under every guard a scheduled run has; "Check against Retell" reads the
 * agent and number back (GET requests, never a call placed) and says what
 * differs; "Clear flag and recheck" is drawn only while the clinic is
 * flagged as drifted, and asks for a fresh code from the operator's
 * authenticator, checked on this app before anything crosses
 * (lib/admin/voice-drift.ts), the way the Account tab's device acts do.
 *
 * Never a phone number: apps/app sends whether one is held, the ops client
 * drops the number a ready retry binds, and the one free-text field here
 * (our own last reason) is scrubbed of anything shaped like one. A button
 * that the state does not allow is not drawn, and the line beside says why:
 * a ready agent has nothing to retry; one being set up or released is left
 * to finish.
 */

export type VoiceAgentActions = {
  retry: () => Promise<OpsResult<RetryVoiceAgentOutcome>>;
  check: () => Promise<OpsResult<{ agents: VoiceAgentStatusView[]; report: VoiceAgentReportView | null }>>;
  clearFlag: (code: string) => Promise<OpsResult<ClearVoiceDriftFlagEntry>>;
};

export const CLEAR_FLAG_CONFIRM = "Clears the drift flag and runs the Retell check once. The flag comes back if Retell still differs.";

function day(iso: string): string {
  return iso.slice(0, 10);
}

type Said = { status: "done" | "refused"; message: string };

const done = (message: string): OpsResult<Said> => ({ ok: true, data: { status: "done", message } });
const refused = (message: string): OpsResult<Said> => ({ ok: true, data: { status: "refused", message } });

/** A retry's outcome as one sentence: ready, already set up, not allowed yet and why, or failed. */
export function retryWords(result: OpsResult<RetryVoiceAgentOutcome>): OpsResult<Said> {
  if (!result.ok) return result;
  const r = result.data;
  switch (r.outcome) {
    case "ready":
      return done(`Ready: the agent is set up${r.adopted ? ", adopting the agent the clinic already had" : ""}, and a number is held.`);
    case "already":
      return done(`Already ${VOICE_STATUS_WORDS[r.status].toLowerCase()}: nothing was run.`);
    case "not_eligible":
      return refused(`Not allowed yet: ${scrubContact(r.reason)}.`);
    case "switched_off":
      return refused("Not allowed yet: the owner's switch for voice provisioning is off.");
    case "no_key":
      return refused("Not allowed yet: no Retell key is on the host.");
    case "deferred":
      return refused("Not allowed today: the daily cap on numbers bought is reached. The scheduled run tries tomorrow.");
    case "failed":
      return refused(`Failed (${r.code.replace(/_/g, " ")}): ${scrubContact(r.reason)}.`);
    case "retry":
      return refused(`Not done this time: ${scrubContact(r.reason)}. The scheduled run tries again.`);
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

/** The clear's outcome as one sentence: cleared (and what the check found), still drifted, code refused. */
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
      return refused(`Still drifted: ${problemsWords(r.problems)}. The flag stays.`);
    case "code_refused":
      return refused(r.message);
    case "not_flagged":
      return done("Not flagged: nothing to clear.");
    case "not_found":
      return refused("No such clinic.");
  }
  return refused("The answer could not be read.");
}

/** Whether a retry is a thing to offer in this state, and the one line that says why when it is not. */
export function retryAllowed(agent: VoiceAgentStatusView | null): { allowed: boolean; why: string | null } {
  if (agent === null) return { allowed: true, why: null };
  switch (agent.status) {
    case "pending":
    case "failed":
      return { allowed: true, why: null };
    case "ready":
      return { allowed: false, why: "Nothing to retry: the agent is ready." };
    case "provisioning":
      return { allowed: false, why: "Nothing to retry while it is being set up: wait for the run to finish." };
    case "deprovisioning":
      return { allowed: false, why: "Nothing to retry while it is being released." };
    case "released":
      return { allowed: false, why: "Nothing to retry: the agent and number were given back." };
  }
}

const sentence = (said: ActionOutcome) => said.message ?? null;

export function VoiceAgentCard({ read, actions }: { read: OpsResult<VoiceAgentStatusView[]>; actions: VoiceAgentActions }) {
  const [code, setCode] = useState("");
  const agent = read.ok ? (read.data[0] ?? null) : null;
  const retry = retryAllowed(agent);
  const flagged = agent?.driftFlaggedAt ?? null;

  return (
    <Section id="voice" title="Voice agent">
      {!read.ok ? <Failure failure={read} what="the voice agent" /> : null}
      {read.ok && agent === null ? (
        <p className="text-sm">No voice set-up has been scheduled for this clinic. Retry starts one if its package has phone and its first invoice is paid; otherwise it says why not.</p>
      ) : null}
      {agent ? (
        <dl className="grid gap-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
          <dt className="text-muted">Status</dt>
          <dd>{VOICE_STATUS_WORDS[agent.status]}</dd>
          <dt className="text-muted">Phone number</dt>
          <dd>{agent.hasNumber ? "one is held" : "none held yet"}</dd>
          <dt className="text-muted">Engine</dt>
          <dd>{VOICE_ENGINE_WORDS[agent.engine]}</dd>
          <dt className="text-muted">Last problem</dt>
          <dd>{agent.lastError ? scrubContact(agent.lastError) : "none recorded"}</dd>
          <dt className="text-muted">Attempts</dt>
          <dd>{agent.attempts}</dd>
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
        <div className="mt-3 flex flex-wrap items-start gap-3">
          {retry.allowed ? (
            <ActionButton label="Retry" run={async () => retryWords(await actions.retry())} done={sentence} />
          ) : (
            <p className="text-muted text-sm">{retry.why}</p>
          )}
          {agent ? <ActionButton label="Check against Retell" run={async () => checkWords(await actions.check())} done={sentence} /> : null}
        </div>
      ) : null}

      {flagged ? (
        <form className="border-line mt-4 flex flex-wrap items-end gap-3 border-t pt-4" onSubmit={(event) => event.preventDefault()}>
          <CodeField value={code} onChange={setCode} />
          <ActionButton
            label="Clear flag and recheck"
            confirm={CLEAR_FLAG_CONFIRM}
            disabled={!isCompleteCode(code)}
            run={async () => clearWords(await actions.clearFlag(code))}
            done={sentence}
          />
        </form>
      ) : null}
    </Section>
  );
}

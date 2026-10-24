import type { RightsAskedFor, RightsKind, RightsRowView, RightsState, RightsVerification } from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

/**
 * The plain words the Patient rights page puts on apps/app's rights tracker
 * (ops automation lane P6b; the operations are lane P6c's, apps/app
 * lib/ops/rights-ops.ts and lib/rights/tracker.ts). Every value here is a
 * closed code of apps/app's, read in its source by `rights-words.test.ts`:
 * the kinds, how a request was verified and what a patient asked for
 * (db/schema.ts), and a row's state (lib/rights/tracker.ts). Nothing here
 * names a person, a contact id or anything typed: the rows carry none. Types
 * only from ops-client, so a client component may import this
 * (lib/admin/client-imports.test.ts).
 */

export const RIGHTS_KIND_WORDS: Record<RightsKind, string> = {
  erasure: "Erasure",
  amendment: "Amendment to a record",
  correction: "Correction of contact details",
  export: "Export",
  patient_request: "A patient's own request, to pass on",
};

/** What a patient asked healdesk for (db/schema.ts PATIENT_REQUEST_KINDS and its comment). */
export const ASKED_FOR_WORDS: Record<RightsAskedFor, string> = {
  access: "to see their information",
  amendment: "to have it corrected",
  accounting: "to be told who it was disclosed to",
  deletion: "to have it deleted",
  other: "something else about it",
};

/** How the request was verified before it was recorded (docs/handover.md, "Deletion requests", step 2). */
export const VERIFICATION_WORDS: Record<RightsVerification, string> = {
  notice_address: "It came from the clinic's notice address",
  phone_confirmed: "Confirmed with the clinic by phone",
  unverified: "Not verified yet",
};

export const STATE_WORDS: Record<RightsState, { label: string; tone: Tone }> = {
  on_time: { label: "On time", tone: "ok" },
  due_soon: { label: "Due soon", tone: "warn" },
  overdue: { label: "Overdue", tone: "bad" },
  blocked: { label: "Blocked", tone: "bad" },
  done: { label: "Done", tone: "muted" },
};

/** The one sentence above the table: the tracker tracks; nothing here runs, schedules or triggers a task. */
export const RUNS_NOTHING = "This page runs nothing. You run each command yourself.";

/**
 * Why Mark done is not offered for an erasure whose deletion still owes its
 * Retell step: apps/app refuses the close (lib/rights/tracker.ts closeIntake,
 * RETELL_OUTSTANDING), and the step is recorded on the clinic's Care tab.
 */
export const RETELL_NOT_RECORDED = "The deletion at Retell is not recorded yet: record it on the clinic's Care tab first.";

export const MARK_DONE_CONFIRM = "Closes this request as done. It cannot be reopened from here.";

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** A calendar day, YYYY-MM-DD, as "21 Oct 2026". */
export function onDay(isoDay: string): string {
  const [year, month, day] = isoDay.split("-").map(Number) as [number, number, number];
  return DAY.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** The kind, and for a patient's own request what was asked. */
export function kindWords(row: Pick<RightsRowView, "kind" | "askedFor">): string {
  const kind = RIGHTS_KIND_WORDS[row.kind];
  return row.kind === "patient_request" && row.askedFor ? `${kind}: ${ASKED_FOR_WORDS[row.askedFor]}` : kind;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Business days left, as apps/app counts them (lib/rights/clocks.ts
 * daysLeftFor: Monday to Friday in UTC, 0 on the due day, at most -1 once
 * past). Never "0 days left" while overdue: a negative count reads as days
 * past, and an overdue row that somehow carries 0 reads "past its day".
 */
export function daysLeftWords(row: Pick<RightsRowView, "daysLeft" | "state">): string {
  if (row.daysLeft === null) return "";
  if (row.daysLeft < 0) return `${plural(-row.daysLeft, "business day", "business days")} past`;
  if (row.state === "overdue") return "past its day";
  if (row.daysLeft === 0) return "due today";
  return `${plural(row.daysLeft, "business day", "business days")} left`;
}

/**
 * An erasure's Retell step (lib/rights/tracker.ts retellStep): recorded, or
 * outstanding, which is recorded on the clinic's Care tab; "not run yet" for
 * an open erasure the host has not run (no step exists until it has). Null
 * for every other kind, and for a done row whose deletion record has since
 * gone, which carries no step to speak of.
 */
export function retellWords(row: Pick<RightsRowView, "kind" | "retellStep" | "state">): string | null {
  if (row.kind !== "erasure") return null;
  if (row.retellStep === "stamped") return "recorded";
  if (row.retellStep === "outstanding") return "outstanding: record it on the clinic's Care tab";
  return row.state === "done" ? null : "not run yet";
}

/**
 * The note beside, or in place of, a row's command: apps/app's own fixed
 * sentence whenever it sends one (a blocked request; an operator address the
 * task would not take; a patient's own request, whose command is shown with
 * the note that the practice's side is chased separately), else, when there
 * is no command either, why nothing is owed here.
 */
export function commandNoteWords(row: Pick<RightsRowView, "command" | "commandNote" | "state" | "source" | "kind" | "recordId">): string | null {
  if (row.commandNote !== null) return row.commandNote;
  if (row.command !== null) return null;
  if (row.state === "done") return null;
  if (row.kind === "erasure" && row.recordId !== null) return "Nothing to run: the deletion has run on the host.";
  if (row.kind === "patient_request" && row.recordId !== null) return "Nothing to run: it is on the host, passed to the practice.";
  return "No command for this request.";
}

/**
 * An intake recorded with the patient request it became (lib/rights/
 * tracker.ts: a linked `patient_request` intake): its row's state and days
 * follow the request, done only once the practice marks it received, so
 * closing the intake leaves the row open.
 */
export function followsPractice(row: Pick<RightsRowView, "kind" | "intakeId" | "recordId">): boolean {
  return row.kind === "patient_request" && row.intakeId !== null && row.recordId !== null;
}

/** The second press on Mark done, saying when the row stays open anyway. */
export function markDoneConfirm(row: Pick<RightsRowView, "kind" | "intakeId" | "recordId">): string {
  return followsPractice(row) ? "Closes this intake as done. The row stays open until the practice marks the request received." : MARK_DONE_CONFIRM;
}

/**
 * How a row with no intake of its own closes (lib/rights/tracker.ts): a
 * deletion is done once its Retell step is recorded, a patient's request
 * once the practice marks it received. Null for an intake, which has Mark
 * done, and for a row already done.
 */
export function closesWords(row: Pick<RightsRowView, "intakeId" | "state" | "source" | "kind" | "recordId">): string | null {
  if (row.intakeId !== null || row.state === "done") return null;
  if (row.kind === "erasure") return "Done once its Retell step is recorded";
  if (row.kind === "patient_request") return "Done once the practice marks it received";
  return null;
}

/** The outcome of Mark done in one line (apps/app closeRightsIntake), true to what the row then does. */
export function closedWords(
  data: { outcome: "closed" | "already_closed"; status: "done" | "not_applicable" },
  row: Pick<RightsRowView, "kind" | "intakeId" | "recordId">,
): string {
  if (data.outcome === "closed") {
    return followsPractice(row) ? "Marked done. The row stays open until the practice marks the request received." : "Marked done.";
  }
  return data.status === "done" ? "It was already marked done." : "It was already closed as not applicable.";
}

/** The outcome of Record a request in one line (apps/app recordRightsIntake). */
export function recordedWords(data: { outcome: "recorded" | "already_recorded"; dueOn: string }): string {
  return data.outcome === "recorded"
    ? `Recorded. It is due on ${onDay(data.dueOn)}.`
    : `Already recorded from this form, so nothing was added. It is due on ${onDay(data.dueOn)}.`;
}

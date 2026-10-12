/**
 * The closed sets the care page's patient-rights section shows, on their own
 * so the client console can import them (lib/admin/ops-client.ts is
 * server-only; see incident-classes.ts).
 *
 * Nothing in apps/web takes a patient's identifier or words: a deletion, an
 * amendment and a correction are entered in apps/app's own shell (npm run
 * ops:erase-person, ops:amend-record, ops:amend-contact; docs/handover.md),
 * never through a Vercel server action (review of 12 October 2026). What the
 * page reads back is ids, dates, counts and these labels, and its reader
 * refuses anything else, so free text could not reach the screen even if
 * apps/app sent it.
 */

/** Who asked, as apps/app labels it (lib/patient-rights/requesters.ts). */
export const REQUESTER_LABELS = [
  "The practice",
  "The person, through the practice",
  "A legal representative, through the practice",
] as const;

/** How a subcontractor step went: the id sent, and the label apps/app reads back (ERASURE_STEP_OUTCOMES). */
export const ERASURE_STEP_OUTCOMES = {
  deleted: "Deleted in the vendor's console",
  nothing_held: "The vendor held nothing for the person",
} as const;
export type ErasureStepOutcome = keyof typeof ERASURE_STEP_OUTCOMES;

/** The scripts the operator runs in the app's shell, and where the runbook says how. */
export const PATIENT_ENTRY_SCRIPTS = {
  erase: "npm run ops:erase-person -w @healdesk/app",
  amendRecord: "npm run ops:amend-record -w @healdesk/app",
  amendContact: "npm run ops:amend-contact -w @healdesk/app",
} as const;

export const HANDOVER_URL =
  "https://github.com/liamariavisoiu-ai98/healdesk.io/blob/main/docs/handover.md";

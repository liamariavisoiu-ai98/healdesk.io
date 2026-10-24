import { PATIENT_REQUEST_KINDS, PATIENT_REQUESTERS, type PatientRequestKind, type PatientRequester } from "@/db/schema";

import type { RightsKind } from "./clocks";

/**
 * The prepared command for a rights request (ops automation lane P6c;
 * design E6 item 16): the exact `run-task.sh` line docs/handover.md gives
 * for each kind, for the owner to copy into AWS CloudShell and run himself.
 * Nothing here runs, schedules or triggers it: this builds a string.
 *
 * Built from ids, fixed task names and fixed words only, each checked
 * against the same pattern infra/aws/scripts/run-task.sh checks it with
 * before any AWS call: a uuid (`is_uuid`), who asked from the closed three
 * (`check_requester`), the fields to clear from fullName, phone and email,
 * what a patient asked for from the closed five, a day as YYYY-MM-DD, and
 * the operator's address (`check_operator`, at most 254 characters,
 * `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`, then lower-cased as
 * the script does). None of those patterns admits a space, a quote, a `$`,
 * a backtick, a `;`, a `|`, a `&`, a `<` or a `>`, so no value can carry a
 * shell metacharacter into the line; the whole line is checked again
 * against SAFE_LINE before it is returned, and a line that fails is never
 * returned.
 *
 * What the host can and cannot run (handover, "Reaching the app's shell"):
 *
 *   - patient_request: `patient-request <clinic id> <asked for> <operator>
 *     <received on> [contact id]`: needs no contact id;
 *   - erasure: `erase-person <clinic id> <contact id> <who asked> <operator>
 *     <received on>`;
 *   - export: `patient-export <clinic id> <contact id> <who asked>`;
 *   - correction: `amend-contact <clinic id> <contact id> <fields to clear>
 *     <who asked> <operator>`: clearing fields only, since new values are
 *     patient data and cannot be passed on the host;
 *   - amendment: none, ever, contact id or not. `ops:amend-record` takes the
 *     practice's words, which cannot be typed or passed on the host; they
 *     wait for the portal (NO_ROUTE_AMENDMENT). A correction with new values
 *     rather than fields to clear is the same (NO_ROUTE_CORRECTION).
 *
 * Every kind but patient_request needs a contact id, and nothing on the AWS
 * host turns a request that arrives as words into one: that waits for the
 * portal route (owner decision D19). Without one, the request is blocked
 * and the command is replaced by NO_ROUTE.
 */

export const RUN_TASK = "bash infra/aws/scripts/run-task.sh";

/** What a blocked request shows in place of its command (D19). */
export const NO_ROUTE = "No portal route yet turns this request into a contact id";

/** What an amendment shows: it needs the practice's words, which no route takes on the host (D19). */
export const NO_ROUTE_AMENDMENT = "No portal route yet takes the practice's words for an amendment on the host";

/** What a correction with new values shows: only clearing a field runs on the host. */
export const NO_ROUTE_CORRECTION = "No portal route yet takes a correction's new values on the host";

/** What a request shows when this host's operator address is not one the task would accept. */
export const NO_OPERATOR = "The operator address on this host is not one the task accepts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** run-task.sh's check_operator, character for character. */
const OPERATOR = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const OPERATOR_MAX = 254;
const CLEARABLE = ["fullName", "phone", "email"] as const;
export type ClearableField = (typeof CLEARABLE)[number];

/** The whole line: the script, a task name, then words of ids, closed words, days and one address. */
const SAFE_LINE = /^bash infra\/aws\/scripts\/run-task\.sh [a-z-]+( [A-Za-z0-9@._%+,-]+)+$/;

export type CommandInput = {
  kind: RightsKind;
  clinicId: string;
  /** YYYY-MM-DD: when the request reached us. */
  receivedOn: string;
  /** What a patient asked for: a patient_request only. */
  askedFor?: PatientRequestKind | null;
  /** The contact the request is about, by id: none until the portal route exists. */
  contactId?: string | null;
  /** Who asked, from the closed three. */
  requestedBy?: PatientRequester | null;
  /** A correction's fields to clear. */
  clearFields?: readonly ClearableField[] | null;
  /** The operator's address, as run-task.sh's check_operator requires it. */
  operator: string;
  /**
   * Today's UTC date, YYYY-MM-DD (now's, when omitted). The day passed to the
   * host is never later: an intake may be dated a day ahead of UTC for a
   * clinic east of it, and the task would read a later received time as now.
   */
  today?: string;
};

export type PreparedCommand =
  | { command: string; note: null; blocked: false }
  | { command: null; note: string; blocked: boolean };

export function safeOperator(value: unknown): string | null {
  if (typeof value !== "string" || value.length > OPERATOR_MAX || !OPERATOR.test(value)) return null;
  return value.toLowerCase();
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function requester(value: unknown): PatientRequester | null {
  return (PATIENT_REQUESTERS as readonly unknown[]).includes(value) ? (value as PatientRequester) : null;
}

function blocked(note: string = NO_ROUTE): PreparedCommand {
  return { command: null, note, blocked: true };
}

function line(task: string, words: readonly string[]): PreparedCommand {
  const built = [RUN_TASK, task, ...words].join(" ");
  if (!SAFE_LINE.test(built)) throw new Error("A prepared command failed its own check.");
  return { command: built, note: null, blocked: false };
}

/**
 * The command for one request, or why there is none. Throws only on input
 * no caller in this repository sends (a clinic id or a day that is not
 * one): the tracker reads both from the database.
 */
export function prepareCommand(input: CommandInput): PreparedCommand {
  const clinicId = uuid(input.clinicId);
  if (!clinicId) throw new Error("A prepared command needs the clinic's uuid.");
  if (!ISO_DAY.test(input.receivedOn)) throw new Error("A prepared command needs the day received, YYYY-MM-DD.");
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DAY.test(today)) throw new Error("A prepared command needs today's UTC date, YYYY-MM-DD.");
  const received = input.receivedOn > today ? today : input.receivedOn;
  const contactId = input.contactId ? uuid(input.contactId) : null;
  const who = requester(input.requestedBy);

  // Blocked first: a request with no route is blocked whatever the operator.
  switch (input.kind) {
    case "amendment":
      return blocked(NO_ROUTE_AMENDMENT);
    case "erasure":
    case "export":
      if (!contactId || !who) return blocked();
      break;
    case "correction": {
      const fields = input.clearFields ?? [];
      if (!contactId || !who) return blocked();
      if (fields.length === 0 || !fields.every((f) => (CLEARABLE as readonly string[]).includes(f))) {
        return blocked(NO_ROUTE_CORRECTION);
      }
      break;
    }
    case "patient_request":
      if (!(PATIENT_REQUEST_KINDS as readonly unknown[]).includes(input.askedFor)) {
        throw new Error("A patient request's command needs what was asked, from the closed five.");
      }
      break;
  }

  const operator = safeOperator(input.operator);
  if (!operator) return { command: null, note: NO_OPERATOR, blocked: false };

  switch (input.kind) {
    case "erasure":
      return line("erase-person", [clinicId, contactId!, who!, operator, received]);
    case "export":
      return line("patient-export", [clinicId, contactId!, who!]);
    case "correction":
      return line("amend-contact", [clinicId, contactId!, [...new Set(input.clearFields!)].join(","), who!, operator]);
    case "patient_request":
      return line("patient-request", [
        clinicId,
        input.askedFor as string,
        operator,
        received,
        ...(contactId ? [contactId] : []),
      ]);
  }
}

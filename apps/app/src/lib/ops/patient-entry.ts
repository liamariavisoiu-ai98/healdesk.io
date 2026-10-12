import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { toE164 } from "@healdesk/connectors";

import { unsafeDb } from "@/db";
import { AMENDMENT_TARGET_KINDS, type AmendmentTargetKind } from "@/db/schema";
import { assertNoPhi, PhiInAuditError, recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import {
  AMENDMENT_MAX_LENGTH,
  amendmentCarriesIdentifier,
  appendAmendment,
} from "@/lib/patient-rights/amendments";
import {
  ErasureContactNotFound,
  erasePerson,
  totalErased,
  type ErasureCounts,
  type ErasureKept,
} from "@/lib/patient-rights/erasure";
import { amendContact } from "@/lib/patient-rights/export";
import {
  isPatientRequester,
  REQUESTER_LABELS,
  type PatientRequester,
} from "@/lib/patient-rights/requesters";
import { withTenant } from "@/lib/tenant";

/**
 * Patient data entered by an operator: a deletion request's number and
 * address, an amendment's words, a contact's corrected details.
 *
 * These are entered on the app host, never through apps/web. The care page
 * used to take them in forms, and each crossed a Vercel server action into
 * the signed ops request: a patient's identifier, or the practice's words
 * about them, through a host with no business associate agreement (review of
 * 12 October 2026). The approved plan already settles how an operator enters
 * patient data: "from a trusted shell ... never through apps/web". So each
 * is a script in apps/app/scripts (npm run ops:erase-person, ops:amend-record,
 * ops:amend-contact -w @healdesk/app), run in the app's own shell
 * (docs/handover.md, "Deletion requests", "Amendments"), and the care page
 * keeps only what carries no patient data: the deletion records, their
 * subcontractor steps and deadlines, and counts.
 *
 * Two ways in, and neither puts patient data where it is kept:
 *
 *   - on the AWS host: by contact id, through run-task.sh only. There is no
 *     interactive shell there (no ECS Exec, by design; a Fargate one-off task
 *     has no stdin; RDS is private, with no bastion), and run-task's command
 *     and environment overrides are recorded by CloudTrail, so a script runs
 *     as a one-off task with ids and closed choices in its environment
 *     (HEALDESK_ERASURE_*, HEALDESK_AMEND_*; `optionsFrom` below) and never a
 *     number, an address or words. A deletion names the person by a
 *     contact's id, and the one-step rule runs from that contact's details,
 *     read inside the transaction. A correction there can clear fields, and
 *     nothing more: an amendment's words and a contact's corrected details
 *     are themselves patient data, and wait for the M5 portal, which takes
 *     them from the practice behind step-up;
 *   - on a development machine, against a development database: the same
 *     options as arguments, and the patient data typed at a prompt (or piped
 *     to stdin), never in argv, so none of it lands in a shell's history or a
 *     process listing. The prompt is refused where NODE_ENV is production,
 *     as it is in the image (`typedEntryAllowed`).
 *
 * The functions here are what the scripts call, with the same library
 * functions, inside the same tenant transactions, writing the same audit
 * rows, log lines and security events the ops envelope wrote, and returning
 * ids and counts only.
 */

/** Who is at the shell: their healdesk work address, the label every row they write carries. */
export type ShellOperator = { label: string };

const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EMAIL_LENGTH = 320;

function actor(operator: ShellOperator) {
  return { type: "service", serviceName: operator.label } as const;
}

async function clinicFor(clinicId: string) {
  if (!UUID_SHAPED.test(clinicId)) return undefined;
  return (await listClinics()).find((c) => c.id === clinicId);
}

/**
 * The security event, as the ops envelope's `audit` wrote it, attributed to
 * the operator at the shell. Never throws: the act is done, and a failure to
 * record it is logged and reported back instead.
 */
async function securityEvent(
  operator: ShellOperator,
  event: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  try {
    await recordSecurityEvent(unsafeDb, {
      event,
      actorLabel: operator.label,
      userId: null,
      organizationId: null,
      ipAddress: null,
      userAgent: "ops-shell",
      metadata,
    });
    return true;
  } catch (error) {
    log.error("ops shell: could not record event", { event, error: describeError(error) });
    return false;
  }
}

/** Who asked, from the closed set; the message lists the three. */
function requester(value: string | undefined): PatientRequester | { error: string } {
  if (isPatientRequester(value)) return value;
  return {
    error: `Who asked? One of: ${Object.entries(REQUESTER_LABELS)
      .map(([id, label]) => `${id} (${label})`)
      .join("; ")}.`,
  };
}

/** A past moment, or now when omitted. */
function pastMoment(value: string | undefined, what: string): Date | undefined | { error: string } {
  if (!value) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 60_000) {
    return { error: `${what}: a past date and time, in ISO form.` };
  }
  return at;
}

// -----------------------------------------------------------------------------
// Deletion on request
// -----------------------------------------------------------------------------

export type ShellEraseOutcome =
  | {
      status: "erased";
      erasureId: string;
      dueBy: string;
      rows: number;
      deleted: ErasureCounts;
      /** What stayed because a thread the person was on also booked for someone else: counts only. */
      kept: ErasureKept;
      /** The numbers and addresses taken as the person's: those given, and every one on a contact they matched. */
      identifiers: { phones: number; emails: number };
    }
  | { status: "error"; message: string };

/**
 * Delete one person at a clinic, and record the request without them
 * (docs/handover.md, "Deletion requests"). The number and the address are
 * normalised, used and dropped: they reach no log line, no audit row and no
 * reply. The `person data erased` log line, written once the deletion has
 * committed, is the record outside the database that a restore to an
 * earlier point needs (docs/handover.md, "Restoring").
 */
export async function erasePersonFromShell(input: {
  clinicId: string;
  /** A contact's id: the way in on the AWS host, in place of a typed number and address. */
  contactId?: string;
  phone?: string;
  email?: string;
  requestedBy: string | undefined;
  receivedAt?: string;
  operator: ShellOperator;
}): Promise<ShellEraseOutcome> {
  const error = (message: string): ShellEraseOutcome => ({ status: "error", message });
  const clinic = await clinicFor(input.clinicId);
  if (!clinic) return error("No such clinic.");
  if (clinic.destroyedAt) {
    return error("This clinic's data has already been destroyed; there is no one left to delete.");
  }
  const contactId = input.contactId?.trim() || undefined;
  if (contactId && !UUID_SHAPED.test(contactId)) return error("A contact's id is a uuid.");
  const rawPhone = input.phone?.trim() || undefined;
  const rawEmail = input.email?.trim() || undefined;
  if (contactId && (rawPhone || rawEmail)) {
    return error("Name the person by a contact's id, or by their number and address, not both.");
  }
  const phone = rawPhone ? toE164(rawPhone) : undefined;
  if (rawPhone && !phone) {
    return error(
      "That is not a telephone number we can match. Give it in international form: +1 and ten digits for a US number.",
    );
  }
  const email = rawEmail?.toLowerCase();
  if (email && (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPED.test(email))) {
    return error("That is not an email address.");
  }
  if (!contactId && !phone && !email) {
    return error(
      "Give a contact's id, or the person's telephone number, their email address, or both.",
    );
  }
  const requestedBy = requester(input.requestedBy);
  if (typeof requestedBy !== "string") return error(requestedBy.error);
  const receivedAt = pastMoment(input.receivedAt, "When did the request reach us?");
  if (receivedAt && !(receivedAt instanceof Date)) return error(receivedAt.error);

  let result: Awaited<ReturnType<typeof erasePerson>>;
  try {
    result = await withTenant({ clinicId: clinic.id, actor: actor(input.operator) }, (tx) =>
      erasePerson(tx, { contactId, phone, email, requestedBy, receivedAt }),
    );
  } catch (thrown) {
    if (thrown instanceof ErasureContactNotFound) return error(thrown.message);
    throw thrown;
  }
  const rows = totalErased(result.deleted);
  log.info("person data erased", { clinicId: clinic.id, erasureId: result.erasureId, count: rows });
  await securityEvent(input.operator, "person_erased", {
    clinicSlug: clinic.slug,
    erasureId: result.erasureId,
    rows,
    deposits: result.deleted.deposits,
  });
  return {
    status: "erased",
    erasureId: result.erasureId,
    dueBy: result.dueBy.toISOString(),
    rows,
    deleted: result.deleted,
    kept: result.kept,
    identifiers: result.identifiers,
  };
}

// -----------------------------------------------------------------------------
// Amendments on Practice's direction
// -----------------------------------------------------------------------------

export type ShellAmendOutcome =
  | { status: "amended"; amendmentId: string; recordedAt: string }
  | { status: "error"; message: string };

/**
 * Append Practice's amendment to a booking request, a conversation or an
 * appointment (BAA 1.3.0 clause 14(b); docs/handover.md, "Amendments"). The
 * words are stored in record_amendments only: no log line, audit row or
 * reply carries them. The `record amended` log line names the amendment and
 * the clinic, so a restore that loses it is noticed.
 */
export async function amendRecordFromShell(input: {
  clinicId: string;
  targetKind: string | undefined;
  targetId: string | undefined;
  amendment: string | undefined;
  requestedBy: string | undefined;
  requestedAt?: string;
  operator: ShellOperator;
}): Promise<ShellAmendOutcome> {
  const error = (message: string): ShellAmendOutcome => ({ status: "error", message });
  const clinic = await clinicFor(input.clinicId);
  if (!clinic) return error("No such clinic.");
  if (clinic.destroyedAt) return error("This clinic's data has already been destroyed.");
  const kind = input.targetKind;
  if (!kind || !(AMENDMENT_TARGET_KINDS as readonly string[]).includes(kind)) {
    return error(`Which kind of record? One of: ${AMENDMENT_TARGET_KINDS.join(", ")}.`);
  }
  const targetId = input.targetId;
  if (!targetId || !UUID_SHAPED.test(targetId)) {
    return error("Which record? Give its id from the patient's export.");
  }
  const text = input.amendment?.trim();
  if (!text) return error("Give the amendment as the practice directed it.");
  if (text.length > AMENDMENT_MAX_LENGTH) {
    return error(`An amendment is at most ${AMENDMENT_MAX_LENGTH} characters.`);
  }
  if (amendmentCarriesIdentifier(text)) {
    return error(
      "An amendment never carries a telephone number or an email address: it can sit on someone else's record, where a deletion would not find it. Correct a contact's number or address with ops:amend-contact instead.",
    );
  }
  const requestedBy = requester(input.requestedBy);
  if (typeof requestedBy !== "string") return error(requestedBy.error);
  const requestedAt = pastMoment(input.requestedAt, "When did the practice ask?");
  if (requestedAt && !(requestedAt instanceof Date)) return error(requestedAt.error);

  const outcome = await withTenant({ clinicId: clinic.id, actor: actor(input.operator) }, (tx) =>
    appendAmendment(tx, {
      target: { kind: kind as AmendmentTargetKind, id: targetId },
      amendment: text,
      requestedBy,
      requestedAt,
      recordedBy: input.operator.label,
    }),
  );
  if (outcome.status === "not_found") {
    return error(`No such ${kind.replace("_", " ")} at this clinic.`);
  }
  log.info("record amended", { clinicId: clinic.id, amendmentId: outcome.id, kind });
  await securityEvent(input.operator, "record_amended", {
    clinicSlug: clinic.slug,
    amendmentId: outcome.id,
    targetKind: kind,
  });
  return {
    status: "amended",
    amendmentId: outcome.id,
    recordedAt: outcome.recordedAt.toISOString(),
  };
}

export type ContactField = "fullName" | "phone" | "email";
export const CONTACT_FIELDS: readonly ContactField[] = ["fullName", "phone", "email"];

export type ShellCorrectOutcome =
  { status: "corrected"; fields: ContactField[] } | { status: "error"; message: string };

/**
 * Correct a contact's name, number or address in place, or clear one, on
 * Practice's direction (BAA 1.3.0 clause 14(b): "Where the record can be
 * changed, healdesk corrects its own copy"). A field is cleared only when
 * `clear` names it; an empty value changes nothing. The audit row says which
 * fields changed and who asked; the reply names the fields, never values.
 */
export async function amendContactFromShell(input: {
  clinicId: string;
  contactId: string | undefined;
  fullName?: string;
  phone?: string;
  email?: string;
  clear?: readonly string[];
  requestedBy: string | undefined;
  operator: ShellOperator;
}): Promise<ShellCorrectOutcome> {
  const error = (message: string): ShellCorrectOutcome => ({ status: "error", message });
  const clinic = await clinicFor(input.clinicId);
  if (!clinic) return error("No such clinic.");
  if (clinic.destroyedAt) return error("This clinic's data has already been destroyed.");
  const contactId = input.contactId;
  if (!contactId || !UUID_SHAPED.test(contactId)) {
    return error("Which contact? Give its id from the patient's export.");
  }
  const changes: { fullName?: string | null; phone?: string | null; email?: string | null } = {};
  const fullName = input.fullName?.trim();
  if (fullName) {
    if (fullName.length > 200) return error("A name is at most 200 characters.");
    changes.fullName = fullName;
  }
  const rawPhone = input.phone?.trim();
  if (rawPhone) {
    const phone = toE164(rawPhone);
    if (!phone) {
      return error(
        "That is not a telephone number we can store. Give it in international form: +1 and ten digits for a US number.",
      );
    }
    changes.phone = phone;
  }
  const rawEmail = input.email?.trim();
  if (rawEmail) {
    const email = rawEmail.toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPED.test(email))
      return error("That is not an email address.");
    changes.email = email;
  }
  for (const value of input.clear ?? []) {
    const field = CONTACT_FIELDS.find((name) => name === value);
    if (!field) return error("Only fullName, phone or email can be cleared.");
    if (changes[field] !== undefined && changes[field] !== null) {
      return error("A field is either corrected or cleared, not both.");
    }
    changes[field] = null;
  }
  if (Object.keys(changes).length === 0) {
    return error(
      "Give the corrected name, telephone number or email address, or say which to clear.",
    );
  }
  const requestedBy = requester(input.requestedBy);
  if (typeof requestedBy !== "string") return error(requestedBy.error);

  const found = await withTenant({ clinicId: clinic.id, actor: actor(input.operator) }, (tx) =>
    amendContact(tx, contactId, changes, requestedBy),
  );
  if (!found) return error("No such contact at this clinic.");
  const fields = (Object.keys(changes) as ContactField[]).sort();
  log.info("contact corrected", { clinicId: clinic.id, contactId, field: fields.join(",") });
  await securityEvent(input.operator, "contact_corrected", {
    clinicSlug: clinic.slug,
    contactId,
    fields: fields.join(","),
  });
  return { status: "corrected", fields };
}

// -----------------------------------------------------------------------------
// The shell: arguments without patient data, and the prompt
// -----------------------------------------------------------------------------

/**
 * The line a script prints when it fails, built from describeError (lib/log),
 * never the error's own message. A failed query's message from drizzle is
 * "Failed query: …" with its parameters, and an erasure's parameters are the
 * person's address and the patterns built from their number's digits; on the
 * AWS host a task's stderr goes to its CloudWatch log, so printing the
 * message wrote the person's details there (review of 12 October 2026).
 * describeError keeps the database's own reason and drops the query.
 */
export function scriptFailure(script: string, error: unknown): string {
  return `[healdesk] ${script} failed: ${describeError(error)}`;
}

/**
 * Whether patient data may be typed at a prompt here: on a development
 * machine only. The image runs with NODE_ENV=production, and on the AWS host
 * nothing is typed: by contact id, through run-task.sh only.
 */
export function typedEntryAllowed(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "production";
}

/**
 * The script's options: each `--name value` argument and, for a one-off
 * task on the AWS host, the same option from the environment variable
 * `envKeys` names for it (HEALDESK_ERASURE_CONTACT_ID for `--contact`, say).
 * An argument wins over the environment. Only ids and closed choices are
 * read this way, and refusePatientDataInArgs checks every one.
 */
export function optionsFrom(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  envKeys: Readonly<Record<string, string>>,
): Map<string, string | true> {
  const args = parseArgs(argv);
  for (const [name, key] of Object.entries(envKeys)) {
    if (args.has(name)) continue;
    const value = env[key]?.trim();
    if (value) args.set(name, value);
  }
  return args;
}

/** `--name value` pairs and bare `--flag`s, and nothing positional. */
export function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--"))
      throw new Error(`Unexpected argument; give options as --name value.`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(token.slice(2), next);
      i++;
    } else {
      out.set(token.slice(2), true);
    }
  }
  return out;
}

const TIME_OPTIONS = new Set(["received-at", "requested-at"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Refuse patient data on the command line: anything shaped like a telephone
 * number or an email address, in any argument but the operator's own
 * address. It would land in the shell's history and in every process
 * listing while the script runs. The patient's details are typed at the
 * prompt instead.
 */
export function refusePatientDataInArgs(args: Map<string, string | true>): void {
  for (const [name, value] of args) {
    if (name === "operator" || value === true) continue;
    // A time is a time: an ISO date is digit-heavy enough to look like a
    // number, so it is checked for its own shape instead.
    if (TIME_OPTIONS.has(name) && ISO_TIME.test(value)) continue;
    try {
      assertNoPhi(value, `--${name}`);
    } catch (error) {
      if (error instanceof PhiInAuditError) {
        throw new Error(
          `--${name} looks like a telephone number or an email address. Patient details are never given on the command line; the script asks for them.`,
        );
      }
      throw error;
    }
  }
}

/** The operator's address: required, and a work address, never a patient's. */
export function shellOperator(args: Map<string, string | true>): ShellOperator {
  const label = args.get("operator");
  if (typeof label !== "string" || !EMAIL_SHAPED.test(label) || label.length > MAX_EMAIL_LENGTH) {
    throw new Error(
      "--operator <your healdesk work address> is required; every row this writes names it.",
    );
  }
  return { label: label.toLowerCase() };
}

/**
 * Ask each question in turn and read one line per answer, from a terminal
 * or from piped stdin, writing the questions to `output` (stderr in the
 * scripts, so stdout carries only the result). Nothing read is echoed back.
 * A blank line is an empty answer.
 */
export async function askLines(
  questions: readonly string[],
  io: { input: Readable; output: Writable },
): Promise<string[]> {
  const rl = createInterface({ input: io.input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const answers: string[] = [];
  try {
    for (const question of questions) {
      io.output.write(question);
      const next = await lines.next();
      answers.push(next.done ? "" : String(next.value));
    }
  } finally {
    rl.close();
  }
  return answers;
}

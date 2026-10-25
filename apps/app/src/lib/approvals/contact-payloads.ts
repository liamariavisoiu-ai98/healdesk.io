import { CHANNELS, type Channel } from "@healdesk/catalog";

import { CHANNEL_WAITING_ON } from "@/db/schema";
import { NOTES, PHRASES, type NoteCode, type PhraseCode } from "@/lib/email/templates/contact-words";
import type { ChannelNextStep } from "@/lib/setup/channels";

/**
 * The clinic-contact kinds' payloads and editable fields (ops automation lane
 * P6f), stored in ops_approvals.payload: ids, closed codes, counts, dates
 * and, for the draft to be rendered again from the owner's edit without a
 * database read, the context the email renders in (the clinic's printable
 * name, its audience and time zone). The name is already in the draft's
 * text, so the payload adds nothing the row did not hold.
 *
 * Owner decision D12: no typed text reaches an email. What the owner may
 * change is a closed set of fields per kind (EDITABLE): a day count, a
 * phrase code, a note code. Each is checked here against its range or list;
 * anything else, or any extra key, is refused.
 *
 * No imports from ./kinds.ts, which imports this file.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^(?:[a-z]{2,8}\/)?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,20})?$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
/** The payload CHECK's digit-run rule (drizzle/0119), so a name it would refuse is never offered to it. */
const DIGIT_RUN = /[0-9]([ ().-]{0,2}[0-9]){6,}/;
const NEXT_STEPS: readonly ChannelNextStep[] = ["finish_setup", "preparing", "none", ...CHANNEL_WAITING_ON];

export const AUDIENCES = ["patients", "clients"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** What an email renders in: the clinic's name as an email may print it, its audience and its zone. */
export type RenderContext = { clinicName: string | null; audience: Audience; timeZone: string };

/** A clinic name the payload may hold: printable already, and nothing the payload CHECK refuses. */
export function storableName(name: string | null): string | null {
  if (!name || name.includes("@") || DIGIT_RUN.test(name) || name.length > 120) return null;
  return name;
}

// -----------------------------------------------------------------------------
// The editable fields
// -----------------------------------------------------------------------------

export type ChaseFields = { note: NoteCode | null };
export type QuestionFields = { note: NoteCode | null };
export type ExtendFields = { days: number; note: NoteCode | null };
export type NoticeFields = { phrase: PhraseCode; note: NoteCode | null };

export type ContactFields = {
  baa_resign_chase: ChaseFields;
  agreement_question: QuestionFields;
  setup_extended: ExtendFields;
  setup_waiting_on_us: NoticeFields;
  setup_help_offer: NoticeFields;
};
export type DraftKind = keyof ContactFields;
export const DRAFT_KINDS: readonly DraftKind[] = [
  "baa_resign_chase",
  "agreement_question",
  "setup_extended",
  "setup_waiting_on_us",
  "setup_help_offer",
];

export function isDraftKind(kind: string): kind is DraftKind {
  return (DRAFT_KINDS as readonly string[]).includes(kind);
}

/** One field the owner may change, as the screen offers it. */
export type EditableField =
  | { field: "days"; type: "days"; min: 1; max: 30 }
  | { field: "phrase"; type: "choice"; options: readonly PhraseCode[]; optional: false }
  | { field: "note"; type: "choice"; options: readonly NoteCode[]; optional: true };

export const EXTEND_MIN_DAYS = 1;
export const EXTEND_MAX_DAYS = 30;

/**
 * The approved closing sentences each kind may carry: none that repeats a
 * line its template already prints (the chase and the question already ask
 * for a reply; the help offer already offers a call).
 */
export const NOTES_BY_KIND: Readonly<Record<DraftKind, readonly NoteCode[]>> = {
  baa_resign_chase: ["call_offer", "thanks_sign"],
  agreement_question: ["call_offer", "thanks"],
  setup_extended: ["call_offer", "thanks"],
  setup_waiting_on_us: ["thanks", "reply_questions"],
  setup_help_offer: ["thanks", "reply_questions"],
};

const NOTE_FIELD = (kind: DraftKind): EditableField => ({
  field: "note",
  type: "choice",
  options: NOTES_BY_KIND[kind],
  optional: true,
});
const PHRASE_FIELD: EditableField = { field: "phrase", type: "choice", options: PHRASES, optional: false };
const DAYS_FIELD: EditableField = { field: "days", type: "days", min: EXTEND_MIN_DAYS, max: EXTEND_MAX_DAYS };

export const EDITABLE: Readonly<Record<DraftKind, readonly EditableField[]>> = {
  baa_resign_chase: [NOTE_FIELD("baa_resign_chase")],
  agreement_question: [NOTE_FIELD("agreement_question")],
  setup_extended: [DAYS_FIELD, NOTE_FIELD("setup_extended")],
  setup_waiting_on_us: [PHRASE_FIELD, NOTE_FIELD("setup_waiting_on_us")],
  setup_help_offer: [PHRASE_FIELD, NOTE_FIELD("setup_help_offer")],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noteOf(kind: DraftKind, value: unknown): NoteCode | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && (NOTES_BY_KIND[kind] as readonly string[]).includes(value)
    ? (value as NoteCode)
    : undefined;
}

export type FieldsResult<K extends DraftKind> = { ok: true; fields: ContactFields[K] } | { ok: false; problems: string[] };

/**
 * The owner's fields for one kind, checked: exactly the kind's keys (a
 * missing note is no note), each in its range or on its list. A string
 * typed into any of them is refused, never printed.
 */
export function parseFields<K extends DraftKind>(kind: K, raw: unknown): FieldsResult<K> {
  if (!isRecord(raw)) return { ok: false, problems: ["the fields are not a set of choices"] };
  const allowed = EDITABLE[kind].map((f) => f.field) as string[];
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return { ok: false, problems: [`only ${allowed.join(" and ")} can be changed in this email`] };
  const problems: string[] = [];
  const note = noteOf(kind, raw.note);
  if (note === undefined) problems.push("the closing sentence must be one of the approved ones, or none");
  let days: number | undefined;
  if (allowed.includes("days")) {
    const d = raw.days;
    if (typeof d !== "number" || !Number.isInteger(d) || d < EXTEND_MIN_DAYS || d > EXTEND_MAX_DAYS) {
      problems.push(`the days must be a whole number from ${EXTEND_MIN_DAYS} to ${EXTEND_MAX_DAYS}`);
    } else days = d;
  }
  let phrase: PhraseCode | undefined;
  if (allowed.includes("phrase")) {
    const p = raw.phrase;
    if (typeof p !== "string" || !(PHRASES as readonly string[]).includes(p)) {
      problems.push("what the email names must be one of the listed parts of setup");
    } else phrase = p as PhraseCode;
  }
  if (problems.length > 0) return { ok: false, problems };
  const n = note ?? null;
  switch (kind) {
    case "setup_extended":
      return { ok: true, fields: { days: days!, note: n } as ContactFields[K] };
    case "setup_waiting_on_us":
    case "setup_help_offer":
      return { ok: true, fields: { phrase: phrase!, note: n } as ContactFields[K] };
    default:
      return { ok: true, fields: { note: n } as ContactFields[K] };
  }
}

// -----------------------------------------------------------------------------
// The payloads
// -----------------------------------------------------------------------------

type Ctx = { clinicName: string | null; audience: Audience; timeZone: string };

export type ContactPayloads = {
  baa_resign_chase: Ctx & {
    clinicId: string;
    resignId: string;
    /** Which seven-day round of chasing it is for: 1 from day 8, 2 from day 15, and so on. */
    round: number;
    /** The version in force, when the record names one; the email then leaves the version out. */
    fromVersion: string | null;
    toVersion: string;
    isAnswering: boolean;
    note: NoteCode | null;
  };
  agreement_question: Ctx & {
    clinicId: string;
    reviewId: string;
    /** Locations the agreement covers, the clinic's own included: where AYA would pause. */
    locations: number;
    isAnswering: boolean;
    note: NoteCode | null;
  };
  setup_extended: Ctx & {
    clinicId: string;
    clinicSlug: string;
    /** The deadline the extension moves, as the proposal read it: a repeat cannot extend twice. */
    fromDeadline: string;
    days: number;
    stepsLeftCount: number;
    rows: { channel: Channel; status: ChannelNextStep }[];
    note: NoteCode | null;
  };
  setup_waiting_on_us: Ctx & {
    clinicId: string;
    /** The lifecycle stage entry it is for: once per entry into waiting on us. */
    stageSince: string;
    phrase: PhraseCode;
    note: NoteCode | null;
  };
  setup_help_offer: Ctx & {
    clinicId: string;
    stage: string;
    /** The lifecycle stage entry it is for: once per entry (E2). */
    stageSince: string;
    phrase: PhraseCode;
    note: NoteCode | null;
  };
  setup_reminder_now: {
    clinicId: string;
    /** Which of the six it pulls forward. */
    reminderNumber: number;
    /** The day it is otherwise due, on the clinic's calendar. */
    normallyDueOn: string;
  };
};

const CTX_KEYS = ["audience", "clinicName", "timeZone"];
const KEYS: Readonly<Record<keyof ContactPayloads, readonly string[]>> = {
  baa_resign_chase: [...CTX_KEYS, "clinicId", "fromVersion", "isAnswering", "note", "resignId", "round", "toVersion"],
  agreement_question: [...CTX_KEYS, "clinicId", "isAnswering", "locations", "note", "reviewId"],
  setup_extended: [...CTX_KEYS, "clinicId", "clinicSlug", "days", "fromDeadline", "note", "rows", "stepsLeftCount"],
  setup_waiting_on_us: [...CTX_KEYS, "clinicId", "note", "phrase", "stageSince"],
  setup_help_offer: [...CTX_KEYS, "clinicId", "note", "phrase", "stage", "stageSince"],
  setup_reminder_now: ["clinicId", "normallyDueOn", "reminderNumber"],
};

function ctxOk(p: Record<string, unknown>): boolean {
  return (
    (p.clinicName === null || (typeof p.clinicName === "string" && storableName(p.clinicName) === p.clinicName)) &&
    typeof p.audience === "string" &&
    (AUDIENCES as readonly string[]).includes(p.audience) &&
    typeof p.timeZone === "string" &&
    TIME_ZONE.test(p.timeZone)
  );
}

const count = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** A contact kind's payload, every key named and checked, or null. */
export function parseContactPayload<K extends keyof ContactPayloads>(kind: K, raw: unknown): ContactPayloads[K] | null {
  if (!isRecord(raw)) return null;
  const p = raw;
  if (Object.keys(p).sort().join(",") !== [...KEYS[kind]].sort().join(",")) return null;
  if (typeof p.clinicId !== "string" || !UUID.test(p.clinicId)) return null;
  if (kind !== "setup_reminder_now" && !ctxOk(p)) return null;
  const note = (k: DraftKind) => noteOf(k, p.note) !== undefined;
  switch (kind) {
    case "baa_resign_chase":
      if (typeof p.resignId !== "string" || !UUID.test(p.resignId)) return null;
      if (!count(p.round, 1, 1000) || typeof p.isAnswering !== "boolean") return null;
      if (p.fromVersion !== null && (typeof p.fromVersion !== "string" || !VERSION.test(p.fromVersion))) return null;
      if (typeof p.toVersion !== "string" || !VERSION.test(p.toVersion)) return null;
      return note(kind) ? (p as ContactPayloads[K]) : null;
    case "agreement_question":
      if (typeof p.reviewId !== "string" || !UUID.test(p.reviewId)) return null;
      if (!count(p.locations, 1, 1000) || typeof p.isAnswering !== "boolean") return null;
      return note(kind) ? (p as ContactPayloads[K]) : null;
    case "setup_extended": {
      if (typeof p.clinicSlug !== "string" || !SLUG.test(p.clinicSlug)) return null;
      if (typeof p.fromDeadline !== "string" || !ISO_INSTANT.test(p.fromDeadline)) return null;
      if (!count(p.days, EXTEND_MIN_DAYS, EXTEND_MAX_DAYS) || !count(p.stepsLeftCount, 0, 100)) return null;
      if (!Array.isArray(p.rows) || p.rows.length > CHANNELS.length) return null;
      for (const row of p.rows) {
        if (!isRecord(row) || Object.keys(row).sort().join(",") !== "channel,status") return null;
        if (!(CHANNELS as readonly unknown[]).includes(row.channel)) return null;
        if (!(NEXT_STEPS as readonly unknown[]).includes(row.status)) return null;
      }
      return note(kind) ? (p as ContactPayloads[K]) : null;
    }
    case "setup_waiting_on_us":
    case "setup_help_offer":
      if (typeof p.stageSince !== "string" || !ISO_INSTANT.test(p.stageSince)) return null;
      if (kind === "setup_help_offer" && (typeof p.stage !== "string" || !/^[a-z_]{1,32}$/.test(p.stage))) return null;
      if (typeof p.phrase !== "string" || !(PHRASES as readonly string[]).includes(p.phrase)) return null;
      return note(kind as DraftKind) ? (p as ContactPayloads[K]) : null;
    case "setup_reminder_now":
      if (!count(p.reminderNumber, 1, 6)) return null;
      if (typeof p.normallyDueOn !== "string" || !ISO_DATE.test(p.normallyDueOn)) return null;
      return p as ContactPayloads[K];
  }
  return null;
}

/** The fields a stored payload holds now, as the owner would edit them. */
export function fieldsOf<K extends DraftKind>(kind: K, payload: ContactPayloads[K]): ContactFields[K] {
  const p = payload as unknown as Record<string, unknown>;
  const note = (p.note ?? null) as NoteCode | null;
  switch (kind) {
    case "setup_extended":
      return { days: p.days as number, note } as ContactFields[K];
    case "setup_waiting_on_us":
    case "setup_help_offer":
      return { phrase: p.phrase as PhraseCode, note } as ContactFields[K];
    default:
      return { note } as ContactFields[K];
  }
}

/** The payload with the owner's fields in place of the proposal's. */
export function withFields<K extends DraftKind>(_kind: K, payload: ContactPayloads[K], fields: ContactFields[K]): ContactPayloads[K] {
  return { ...payload, ...fields };
}

export { NOTES, PHRASES };

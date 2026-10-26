import { ESCALATION_TOPICS, TOPIC_IDS, type EscalationTopic } from "./escalation-fields";

/**
 * The closed lists of a support case (ops automation Phase 7, lane P7a;
 * design E5 §2.2), one source for the schema's CHECK constraints, the ops
 * operations and apps/web's strict readers. Pure: no database, so the schema
 * can import it.
 */

/**
 * Where a case stands.
 *
 *   new            needs someone: nothing drafted yet (every chat escalation
 *                  starts here, and a case the clinic wrote again comes back).
 *   drafting       the drafter (lane P7b) has it.
 *   drafted        a draft waits for the owner's Send.
 *   needs_edit     the draft failed a check, or the drafter gave up.
 *   waiting_clinic we replied; the next move is the clinic's.
 *   snoozed        put aside until snoozed_until.
 *   closed         done, with a closed_reason. Final: a clinic that writes
 *                  again opens a new case.
 */
export const SUPPORT_CASE_STATES = [
  "new",
  "drafting",
  "drafted",
  "needs_edit",
  "waiting_clinic",
  "snoozed",
  "closed",
] as const;
export type SupportCaseState = (typeof SUPPORT_CASE_STATES)[number];

/** The states that still need us: what the console's "Needs you" lists. */
export const NEEDS_US_STATES: readonly SupportCaseState[] = ["new", "drafting", "drafted", "needs_edit"];

/**
 * The moves a case may make, read by the code before every write (the
 * database holds the terminal rule and each state's columns; this holds the
 * rest, so lanes P7b and P7c can add a move without a migration). Closing
 * and snoozing are open from every state but closed.
 */
export const SUPPORT_CASE_MOVES: Readonly<Record<SupportCaseState, readonly SupportCaseState[]>> = {
  new: ["drafting", "drafted", "needs_edit", "waiting_clinic", "snoozed", "closed"],
  drafting: ["drafted", "needs_edit", "new", "snoozed", "closed"],
  drafted: ["drafting", "needs_edit", "waiting_clinic", "snoozed", "closed", "new"],
  needs_edit: ["drafting", "drafted", "waiting_clinic", "snoozed", "closed", "new"],
  waiting_clinic: ["new", "snoozed", "closed"],
  snoozed: ["new", "drafted", "needs_edit", "waiting_clinic", "closed", "snoozed"],
  closed: [],
};

export function canMove(from: SupportCaseState, to: SupportCaseState): boolean {
  return SUPPORT_CASE_MOVES[from].includes(to);
}

/** Where a case came from. Email arrives with the inbound slice (D13); until then only the chat. */
export const SUPPORT_CASE_SOURCES = ["email", "chat"] as const;
export type SupportCaseSource = (typeof SUPPORT_CASE_SOURCES)[number];

/** The case's topic: the chat's escalation topics, so both sources triage alike. */
export const SUPPORT_CASE_CATEGORIES: readonly EscalationTopic[] = TOPIC_IDS;

export const SUPPORT_CASE_URGENCIES = ["now", "today", "this_week"] as const;
export type SupportCaseUrgency = (typeof SUPPORT_CASE_URGENCIES)[number];

/** Most urgent first: a second escalation can raise a case's urgency, never lower it. */
export function moreUrgent(a: SupportCaseUrgency, b: SupportCaseUrgency): SupportCaseUrgency {
  return SUPPORT_CASE_URGENCIES.indexOf(a) <= SUPPORT_CASE_URGENCIES.indexOf(b) ? a : b;
}

/** Why a case was closed (lane brief: a closed list; the console's Close names one). */
export const SUPPORT_CLOSED_REASONS = [
  "replied_by_hand",
  "no_reply_needed",
  "duplicate",
  "not_a_clinic",
  "spam",
  "no_further_reply",
] as const;
export type SupportClosedReason = (typeof SUPPORT_CLOSED_REASONS)[number];

export const SUPPORT_MESSAGE_DIRECTIONS = ["in", "out"] as const;
export type SupportMessageDirection = (typeof SUPPORT_MESSAGE_DIRECTIONS)[number];

/**
 * A message's kind: an inbound email (the inbound slice), a chat escalation
 * (fields only, never words), our fixed acknowledgement, and a composed reply
 * (its draft, then the approved text; lanes P7b and P7c).
 */
export const SUPPORT_MESSAGE_KINDS = ["email", "chat_escalation", "ack", "reply"] as const;
export type SupportMessageKind = (typeof SUPPORT_MESSAGE_KINDS)[number];

/**
 * Triage for a chat escalation (design E5 §2.1, "Triage"): `now` when AYA is
 * not answering or calls ring out, a charge is in question, a device is lost
 * or anything touches security; `today` when something the clinic relies on
 * is broken or blocked; `this_week` for questions and changes. Exhaustive
 * over every topic's symptoms, so a symptom added to the chat's list fails
 * to compile until someone decides its urgency.
 */
export const SYMPTOM_URGENCY: {
  readonly [T in EscalationTopic]: { readonly [S in keyof (typeof ESCALATION_TOPICS)[T]["symptoms"]]: SupportCaseUrgency };
} = {
  forwarding: {
    calls_not_reaching_aya: "now",
    calls_ring_out: "now",
    staff_not_getting_calls: "today",
    caller_id_shows_own_number: "this_week",
    codes_not_working: "today",
    undo_forwarding: "today",
    other: "this_week",
  },
  calendar: {
    wont_connect: "today",
    disconnected: "today",
    bookings_missing: "today",
    wrong_calendar: "today",
    other: "this_week",
  },
  channel: {
    not_live_yet: "this_week",
    website_line_not_working: "now",
    meta_wont_connect: "today",
    whatsapp_payment_method: "this_week",
    answers_wrong: "today",
    other: "this_week",
  },
  plan: {
    move_up_a_step: "this_week",
    move_down_a_step: "this_week",
    add_a_channel: "this_week",
    add_a_location: "this_week",
    cancel: "today",
    other: "this_week",
  },
  billing: {
    invoice_question: "today",
    payment_failed: "today",
    card_change: "this_week",
    refund_question: "today",
    other: "today",
  },
  transcript: {
    not_received: "today",
    send_again_failed: "today",
    other: "this_week",
  },
  sign_in: {
    lost_device: "now",
    passkey_problem: "today",
    authenticator_problem: "today",
    sign_in_link_not_arriving: "today",
    other: "today",
  },
  other: {
    other: "this_week",
  },
};

/** The urgency of a topic and symptom; `this_week` for a pair off the lists. */
export function urgencyFor(topic: string, symptom: string): SupportCaseUrgency {
  const symptoms = (SYMPTOM_URGENCY as Record<string, Record<string, SupportCaseUrgency>>)[topic];
  return symptoms?.[symptom] ?? "this_week";
}

/**
 * A case's ref: five characters of Crockford's base32 alphabet (no I, L, O
 * or U, so it reads aloud and copies without a mistake), printed "HD-7F3KQ".
 * 32^5 is about 33 million, generated in code and retried on a collision.
 * Read back leniently: lower case, a missing prefix, O for 0 and I or L for 1.
 */
export const SUPPORT_REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SUPPORT_REF_LENGTH = 5;
export const SUPPORT_REF_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

export function printRef(ref: string): string {
  return `HD-${ref}`;
}

/** A ref as typed or printed, normalised, or null when it cannot be one. */
export function readRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value
    .trim()
    .toUpperCase()
    .replace(/^HD-?/, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return SUPPORT_REF_PATTERN.test(bare) ? bare : null;
}

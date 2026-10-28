import { CARRIERS, CHANNEL_NAMES, COVERAGE_MODE_OPTIONS, getPlan } from "@healdesk/catalog";

import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import type {
  SupportAccountFactsView,
  SupportActionView,
  SupportCaseCategory,
  SupportCaseFactsView,
  SupportCaseMoveOutcome,
  SupportCaseRowView,
  SupportCaseState,
  SupportCheckId,
  SupportClosedReason,
  SupportDraftSaved,
  SupportDraftView,
  SupportReplyApprovalItem,
  SupportReplyCheckView,
  SupportReplyPreview,
  SupportReplyProposal,
} from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";
import type { TranscriptStatus } from "@/lib/admin/transcript-status";

import { BILLING_STATUS_WORDS, onDay, outcomeWords, whenWords } from "./approval-words";
import { hoursWaited } from "./queue-words";

/**
 * The plain words the Support console (/admin/support, ops automation Phase 7,
 * lane P7d) puts on apps/app's closed codes: a case's states, sources,
 * topics, symptoms, urgencies and closed reasons (lib/support/case-vocab.ts,
 * escalation-fields.ts), the drafter's eight checks and its reasons for
 * writing no draft (lib/support/draft/{checks,store}.ts), the floor checks
 * the send path adds (lib/support/send-checks.ts), the facts panel's codes
 * (lib/support/account-state.ts, whose own words for hello@ these mirror),
 * and the answers the operations and the executor give. Every table is read
 * against apps/app's source by `support-words.test.ts`, so a code added there
 * with no words here fails the build rather than reaching the operator as a
 * code. Types only from ops-client, so the client component may import this
 * (lib/admin/client-imports.test.ts).
 */

// -----------------------------------------------------------------------------
// The case
// -----------------------------------------------------------------------------

/** Where a case stands (lib/support/case-vocab.ts SUPPORT_CASE_STATES). */
export const STATE_WORDS: Record<SupportCaseState, string> = {
  new: "New, no draft yet",
  drafting: "Being drafted",
  drafted: "Drafted",
  needs_edit: "Draft needs an edit",
  waiting_clinic: "Waiting on the clinic",
  snoozed: "Snoozed",
  closed: "Closed",
};

/**
 * One line on what each state means, true to case-vocab.ts and the drafter's
 * store (draft/store.ts: a case is claimed only when it names a clinic; the
 * support-draft job is the one thing that drafts).
 */
export const STATE_NOTES: Record<SupportCaseState, string> = {
  new: "Nothing is drafted yet. The assistant drafts it when the support-draft job runs; a case with no clinic is never drafted.",
  drafting: "The assistant is drafting it now.",
  drafted: "A draft passed every check when it was written.",
  needs_edit: "The draft failed a check, or the assistant could not write one.",
  waiting_clinic: "We replied; the next move is the clinic's.",
  snoozed: "Put aside until the time shown.",
  closed: "Closed, with the reason shown. A clinic that writes again opens a new case.",
};

/** The states that still need us: what "Needs you" lists (case-vocab.ts NEEDS_US_STATES). */
export const NEEDS_YOU_STATES: readonly SupportCaseState[] = ["new", "drafting", "drafted", "needs_edit"];

export const SOURCE_WORDS: Record<SupportCaseRowView["source"], string> = {
  email: "Email",
  chat: "Portal support chat",
};

export const URGENCY_WORDS: Record<SupportCaseRowView["urgency"], string> = {
  now: "Now",
  today: "Today",
  this_week: "This week",
};

export const URGENCY_TONE: Record<SupportCaseRowView["urgency"], Tone> = {
  now: "bad",
  today: "warn",
  this_week: "info",
};

/**
 * Why a case was closed (case-vocab.ts SUPPORT_CLOSED_REASONS). The console's
 * Close offers CLOSE_CHOICES; `no_further_reply` is reserved for the watch
 * that closes a case the clinic never answered (design E5 §2.3, lane P7e).
 */
export const CLOSED_REASON_WORDS: Record<SupportClosedReason, string> = {
  replied_by_hand: "Replied by hand from the mailbox",
  no_reply_needed: "No reply needed",
  duplicate: "Duplicate of another case",
  not_a_clinic: "Not a clinic",
  spam: "Spam",
  no_further_reply: "The clinic did not write again",
};

export const CLOSE_CHOICES: readonly SupportClosedReason[] = ["replied_by_hand", "no_reply_needed", "duplicate", "not_a_clinic", "spam"];

/** The topics, word for word the chat's own (lib/support/escalation-fields.ts ESCALATION_TOPICS labels). */
export const CATEGORY_WORDS: Record<SupportCaseCategory, string> = {
  forwarding: "Call forwarding",
  calendar: "Calendar connection",
  channel: "A channel isn't live or isn't working",
  plan: "Changing the plan",
  billing: "Billing or an invoice",
  transcript: "Getting a transcript sent again",
  sign_in: "Signing in or devices",
  other: "Something else",
};

/** Each topic's symptoms, word for word the chat's own (escalation-fields.ts ESCALATION_TOPICS symptoms). */
export const SYMPTOM_WORDS: Record<SupportCaseCategory, Readonly<Record<string, string>>> = {
  forwarding: {
    calls_not_reaching_aya: "Calls aren't reaching AYA",
    calls_ring_out: "Calls ring out unanswered",
    staff_not_getting_calls: "Staff aren't getting calls they should",
    caller_id_shows_own_number: "Forwarded calls show the practice's own number",
    codes_not_working: "The forwarding codes don't work",
    undo_forwarding: "Help undoing call forwarding",
    other: "Something else",
  },
  calendar: {
    wont_connect: "Google Calendar won't connect",
    disconnected: "The calendar disconnected",
    bookings_missing: "Bookings aren't showing in the calendar",
    wrong_calendar: "Bookings go to the wrong calendar",
    other: "Something else",
  },
  channel: {
    not_live_yet: "A channel isn't live yet",
    website_line_not_working: "The website line isn't working",
    meta_wont_connect: "Instagram or Messenger won't connect",
    whatsapp_payment_method: "WhatsApp's payment method",
    answers_wrong: "AYA's answers need correcting",
    other: "Something else",
  },
  plan: {
    move_up_a_step: "Moving up a usage step",
    move_down_a_step: "Moving down a usage step",
    add_a_channel: "Adding a channel",
    add_a_location: "Adding a location",
    cancel: "Cancelling",
    other: "Something else",
  },
  billing: {
    invoice_question: "A question about an invoice",
    payment_failed: "A payment failed",
    card_change: "Changing the card",
    refund_question: "A question about a refund",
    other: "Something else",
  },
  transcript: {
    not_received: "A transcript didn't arrive",
    send_again_failed: "Send again didn't work",
    other: "Something else",
  },
  sign_in: {
    lost_device: "A device was lost or someone left",
    passkey_problem: "A passkey doesn't work",
    authenticator_problem: "The authenticator app doesn't work",
    sign_in_link_not_arriving: "Sign-in links don't arrive",
    other: "Something else",
  },
  other: { other: "Something else" },
};

/** A symptom in words; one off the topic's list is printed as its own words, never dropped. */
export function symptomWords(category: SupportCaseCategory, symptom: string): string {
  return SYMPTOM_WORDS[category][symptom] ?? symptom.replace(/_/g, " ");
}

/** "Call forwarding: Calls ring out unanswered"; the topic alone when the symptom repeats it ("Something else"). */
export function topicWords(category: SupportCaseCategory, symptom: string): string {
  const what = symptomWords(category, symptom);
  return what === CATEGORY_WORDS[category] ? what : `${CATEGORY_WORDS[category]}: ${what}`;
}

/** "patient details hidden: 2 numbers, 1 email, 1 treatment, 1 clinical match", or null when nothing was hidden. */
export function hiddenWords(hidden: SupportCaseRowView["hidden"]): string | null {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(hidden.numbers, "number", "numbers");
  add(hidden.emails, "email", "emails");
  add(hidden.treatments, "treatment", "treatments");
  add(hidden.clinical, "clinical match", "clinical matches");
  return parts.length > 0 ? `patient details hidden: ${parts.join(", ")}` : null;
}

/** "reply by 28 Oct 2026", "past its reply day (28 Oct 2026)" while the case still needs us. */
export function replyByWords(row: Pick<SupportCaseRowView, "replyByOn" | "pastDue">): string {
  return row.pastDue ? `past its reply day (${onDay(row.replyByOn)})` : `reply by ${onDay(row.replyByOn)}`;
}

/** "opened 3 hours ago", "opened 4 days ago" (apps/app gives the age in whole hours). */
export function ageWords(ageHours: number): string {
  return `opened ${hoursWaited(ageHours)} ago`;
}

/** "2 escalations" for a chat case, "1 email" for an email case. */
export function inboundWords(row: Pick<SupportCaseRowView, "source" | "inboundCount">): string {
  const n = row.inboundCount;
  if (row.source === "chat") return `${n} ${n === 1 ? "escalation" : "escalations"} from the portal chat`;
  return `${n} ${n === 1 ? "email" : "emails"}`;
}

/** The page's sections, in the order the owner reads them, each with its anchor and empty line. */
export const CASE_SECTIONS = [
  { id: "needs-you", title: "Needs you", empty: "Nothing needs you here." },
  { id: "waiting-on-the-clinic", title: "Waiting on the clinic", empty: "Nothing is waiting on a clinic." },
  { id: "snoozed", title: "Snoozed", empty: "Nothing is snoozed." },
  { id: "closed", title: "Closed (30 days)", empty: "Nothing was closed in the last 30 days." },
] as const;
export type CaseSectionId = (typeof CASE_SECTIONS)[number]["id"];

/** Which section a case falls in: by its state. */
export function sectionOf(state: SupportCaseState): CaseSectionId {
  if (NEEDS_YOU_STATES.includes(state)) return "needs-you";
  if (state === "waiting_clinic") return "waiting-on-the-clinic";
  if (state === "snoozed") return "snoozed";
  return "closed";
}

/** The line on a row whose reply waits in the approval inbox for the owner's Send. */
export const REPLY_WAITING = "Reply waiting for your Send";

// -----------------------------------------------------------------------------
// The draft and its checks
// -----------------------------------------------------------------------------

/**
 * Each check's short name (draft/checks.ts CHECK_IDS, then the send path's
 * floor and its own ids, send-checks.ts). The rule sentence shown beside a
 * failed one is apps/app's own, carried in the result.
 */
export const CHECK_NAMES: Record<SupportCheckId | "send_shape" | "send_tone" | "send_copy" | "send_links" | "reply_checks", string> = {
  facts: "Facts",
  screen: "Screen",
  names: "Names",
  clinical: "Clinical",
  promises: "Promises",
  claims: "Claims",
  shape: "Shape",
  other_clinics: "Other practices",
  email_words: "Quotes the email",
  action_claim: "Change made",
  send_shape: "Plain text",
  send_tone: "Tone",
  send_copy: "Copy",
  send_links: "Links",
  reply_checks: "The checks",
};

/** A check's name; an id nobody listed is printed as its own words. */
export function checkName(id: string): string {
  return (CHECK_NAMES as Readonly<Record<string, string>>)[id] ?? id.replace(/_/g, " ");
}

/** The rules that failed, each once, in order (as apps/app's failedRules lists them). */
export function failedRules(checks: readonly SupportReplyCheckView[]): string[] {
  return [...new Set(checks.filter((c) => !c.ok).map((c) => c.rule))];
}

/**
 * Why the drafter wrote no draft (draft/store.ts DRAFT_FAILURES, as
 * draft/run.ts sets each): no model client on this host, the model call
 * failed, the model refused, it proposed no reply, the practice's account
 * could not be read, or the case has had its five drafts (DRAFTS_PER_CASE);
 * and for an email case (lane P7h), the email could not be read, or the
 * draft written from it failed a check and was not kept (read the email in
 * your own mailbox by the case's reference, and write the reply).
 */
export const DRAFT_FAILURE_WORDS: Record<NonNullable<SupportDraftView["failure"]>, string> = {
  model_unavailable: "the model is not available on this host",
  model_failed: "the model call failed",
  model_refused: "the model refused to write one",
  no_proposal: "the model proposed no reply",
  account_unreadable: "the practice's account could not be read",
  draft_limit: "the case has had five drafts, the most a case gets",
  email_unreadable: "the practice's email could not be read, and it is now deleted",
  checks_failed: "the draft written from the practice's email failed a check, so it was not kept",
};

/** How many drafts the assistant writes a case at most (draft/store.ts DRAFTS_PER_CASE). */
export const DRAFTS_PER_CASE = 5;

/** The read tools a fact can come from (draft/tools.ts READ_TOOL_NAMES). */
export const TOOL_WORDS: Record<SupportDraftView["factsUsed"][number]["tool"], string> = {
  get_account_state: "the account's state",
  get_forwarding_steps: "the forwarding steps",
  get_clinic_signals: "the clinic's signals",
  get_case_history: "the case history",
  propose_action: "the proposed change",
};

/** Where a proposed change stands, in a few words (lane D). */
export const ACTION_STATUS_WORDS: Record<SupportActionView["status"], string> = {
  pending: "made when you approve the reply",
  running: "being made now",
  done: "made",
  already: "already set, nothing to change",
  refused: "not made: the clinic's Settings refused it",
  unavailable: "not made: it can't be changed yet",
  not_run: "not made: this case already made a change, or it was dropped from the reply",
};

/** Said after the change when the email was not from the clinic's one sign-in address. */
export const SENDER_NOT_VERIFIED_WORDS = "Sender not verified: the email did not come from the clinic's sign-in address, so the change waits for your approval.";

/** "Proposed change: Website chat → on (made when you approve the reply)." Closed words only. */
export function proposedChangeWords(action: SupportActionView): string {
  const line = `Proposed change: ${action.label} → ${action.value} (${ACTION_STATUS_WORDS[action.status]}).`;
  return action.senderVerified ? line : `${line} ${SENDER_NOT_VERIFIED_WORDS}`;
}

/** The edit option that drops a pending change from the reply (lane D; apps/app saveReplyDraft dropAction). */
export const DROP_CHANGE_LABEL = "Drop the proposed change: save this reply without it, so approving it changes nothing";

export const CONFIDENCE_WORDS: Record<NonNullable<SupportDraftView["confidence"]>, string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

/**
 * Who wrote the draft. The view carries no author, but the drafter's
 * propose_reply schema requires a confidence (draft/tools.ts, `required`)
 * and the drafter stores it (draft/run.ts), while a draft saved from this
 * console's editor stores none (lib/support/send.ts saveReplyDraft writes
 * only `by` and `attempt`): so a confidence means the assistant's draft, and
 * none means a saved edit.
 */
export function draftAuthorWords(draft: Pick<SupportDraftView, "confidence">): string {
  return draft.confidence === null ? "saved from this editor" : `written by the assistant, confidence ${CONFIDENCE_WORDS[draft.confidence]}`;
}

/** "Draft 2, written by the assistant, confidence high"; or why there is none. */
export function draftHeadWords(draft: SupportDraftView | null): string {
  if (draft === null) return "No draft yet.";
  if (draft.failure !== null) return `No draft: ${DRAFT_FAILURE_WORDS[draft.failure]} (${whenWords(draft.createdAt)}).`;
  return `Draft ${draft.version}, ${draftAuthorWords(draft)}, ${whenWords(draft.createdAt)}.`;
}

/** The one line under the Regenerate control, true to draft/store.ts queueRegeneration and send.ts saveReplyDraft. */
export const REGENERATE_NOTE = `Asks the assistant for a new draft: the case goes back to new, and the support-draft job writes the draft when it next runs. The assistant writes at most ${DRAFTS_PER_CASE} drafts a case; drafts saved from this editor do not count.`;

/** The one line under Save draft (lib/ops/support-reply-ops.ts opSaveSupportDraft). */
export const SAVE_NOTE =
  "Saves the text above as the case's next draft and runs the checks on it. A draft that passes every check is proposed for your Send; one that fails waits for an edit. Nothing is sent.";

/** The one line under Check (opPreviewSupportReply): a read. */
export const CHECK_NOTE = "Runs the checks on the text above as Send will, and names any rule it fails. Saves nothing and sends nothing.";

/** The one line under Send (lib/approvals/support-reply.ts sendSupportReply). */
export const SEND_NOTE =
  "Nothing is sent until the code is entered. Send proposes the current draft if it is not waiting already, then approves it with your code: the checks run again on the text above, and if one fails nothing is sent and the rule is named. The reply goes to the practice's one sign-in address, signed The Healdesk Team, under the subject shown. There is no Reject: to not send this reply, Close the case below, which takes a waiting reply off the list unsent.";

/** The second press on Send. */
export const SEND_CONFIRM = "Send this reply? It cannot be undone once the reply has gone.";

/**
 * The subject a reply goes under, fixed per topic and never the owner's or
 * the model's words (apps/app lib/support/send-vocab.ts SUPPORT_REPLY_SUBJECTS,
 * word for word): "Re: <this> (ref HD-7F3KQ)". Shown beside the editor so
 * Send's "under the subject shown" is true before a reply is proposed; the
 * decision itself carries the subject apps/app stored on the item.
 */
export const REPLY_SUBJECTS: Record<SupportCaseCategory, string> = {
  forwarding: "Your call forwarding",
  calendar: "Your calendar connection",
  channel: "Your channels",
  plan: "Your plan",
  billing: "Your billing question",
  transcript: "Your transcripts",
  sign_in: "Signing in",
  other: "Your question to healdesk",
};

export function replySubject(category: SupportCaseCategory, printedRef: string): string {
  return `Re: ${REPLY_SUBJECTS[category]} (ref ${printedRef})`;
}

/** The email adds the sign-off itself (lib/email/templates/support_reply.ts, SUPPORT_SIGN_OFF); a pasted one costs nothing (checks.ts withoutSignOff). */
export const SIGN_OFF_NOTE = "The email signs itself The Healdesk Team; leave the sign-off out of the text.";

/** The longest draft the editor may save (lib/support/send.ts MAX_DRAFT_CHARS). */
export const MAX_REPLY_CHARS = 1500;

/** apps/app's own rule for the text (support-reply-ops.ts TEXT_RULE). */
export const TEXT_RULE = `The text is the reply itself: 1 to ${MAX_REPLY_CHARS.toLocaleString("en-US")} characters.`;

/** A typed reply as apps/app keeps it (send.ts normaliseDraftText), or null when it is empty or too long. */
export function normaliseReply(raw: string): string | null {
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text || [...text].length > MAX_REPLY_CHARS) return null;
  return text;
}

/** The failed rules as one clause: apps/app's eight end in a full stop and the send path's floor does not, so each loses its own. */
export function rulesClause(failed: readonly string[]): string {
  return failed.map((rule) => rule.replace(/\.$/, "")).join("; ");
}

/** What Save draft answered (opSaveSupportDraft): the version, whether every check passed, and whether it is proposed. */
export function saveWords(saved: SupportDraftSaved): string {
  if (!saved.ok) return `Saved as draft ${saved.draftVersion}. It fails: ${rulesClause(saved.failed)}. Edit it and save again.`;
  return `Saved as draft ${saved.draftVersion}. Every check passed${saved.approvalId ? ", and it is proposed for your Send" : ""}.`;
}

/** What Check answered (opPreviewSupportReply). */
export function checkWords(preview: SupportReplyPreview): string {
  return preview.ok ? "Every check passes." : `Fails: ${rulesClause(preview.failed)}.`;
}

/** What Regenerate answered (opRegenerateSupportDraft): queued, or already queued. */
export function regenerateWords(outcome: SupportCaseMoveOutcome): string {
  return outcome.outcome === "done"
    ? "A new draft is asked for: the case is new again, and the support-draft job writes the draft when it next runs."
    : "A new draft was already asked for.";
}

/** What Send answered before any decision: the proposal was refused by the checks. */
export function proposeRefusalWords(proposal: SupportReplyProposal): string {
  return `Nothing was sent: the saved draft fails: ${rulesClause(proposal.failed)}. Edit it, press Save draft, then Send.`;
}

/** What Send may answer: the decision's own entry, or that no reply was proposed. */
export type SendAnswer = ApprovalDecisionEntry | { status: "not_proposed"; message: string };

/**
 * Send's outcome in one line, true to lib/approvals/support-reply.ts
 * sendSupportReply and lib/support/send.ts: sent (the page then draws the
 * case's new state: waiting on the clinic, unless it was snoozed, which
 * case-vocab.ts lets move nowhere but new, drafted, needs_edit or closed);
 * approved but not yet sent, in apps/app's own sentence; not sent, in the
 * executor's words (the rules' names, never the words); or a refusal that
 * changed nothing.
 */
export function sendOutcomeWords(answer: SendAnswer): { ok: boolean; text: string; auditRecorded: boolean | null } {
  switch (answer.status) {
    case "not_proposed":
    case "refused":
    case "code_refused":
      return { ok: false, text: answer.message, auditRecorded: null };
    case "rejected":
      return { ok: false, text: `Rejected: ${outcomeWords(answer.outcomeCode)}. Nothing was sent.`, auditRecorded: answer.auditRecorded };
    case "executed": {
      if (answer.outcomeCode === "sent") {
        return { ok: true, text: "Sent to the practice's one sign-in address.", auditRecorded: answer.auditRecorded };
      }
      return { ok: true, text: answer.message ?? `Approved: ${outcomeWords(answer.outcomeCode)}.`, auditRecorded: answer.auditRecorded };
    }
    case "failed":
      return { ok: false, text: answer.message ?? `Not sent: ${outcomeWords(answer.outcomeCode)}.`, auditRecorded: answer.auditRecorded };
  }
}

/** "Reply waiting for your Send since 3 Nov 2026, 10:01 UTC (draft 2)". */
export function waitingItemWords(item: Pick<SupportReplyApprovalItem, "proposedAt" | "packet">): string {
  const version = item.packet?.facts.draftVersion;
  return `${REPLY_WAITING} since ${whenWords(item.proposedAt)}${version !== undefined ? ` (draft ${version})` : ""}`;
}

// -----------------------------------------------------------------------------
// The case's moves
// -----------------------------------------------------------------------------

/** Snooze only records the time (lib/support/cases.ts snoozeSupportCase); what acts on it is the watch lane P7e builds, so nothing here says the case comes back by itself. */
export const SNOOZE_NOTE = "Puts the case aside, under Snoozed, until the time chosen. Nothing is sent.";
export const ASSIGN_NOTE = "Puts a name on the case so the list says who has it. v1 has one shared sign-in, so it is a label, not an identity.";
export const MATCH_NOTE = "Names the clinic this case is about, once. Until then no draft is written and no reply can go.";
export const CLOSE_NOTE = "Closes the case for good, with the reason chosen. Nothing is sent; a clinic that writes again opens a new case.";
export const CLOSE_CONFIRM = "Close this case? Closed is final.";

export function assignWords(outcome: SupportCaseMoveOutcome, label: string): string {
  return outcome.outcome === "done" ? `Given to ${label}.` : `Already with ${label}.`;
}

export function matchWords(outcome: SupportCaseMoveOutcome, clinicName: string): string {
  return outcome.outcome === "done" ? `Matched to ${clinicName}; the assistant drafts it when the support-draft job next runs.` : `Already matched to ${clinicName}.`;
}

export const CLOSED_WORDS = "Closed.";

export function snoozedWords(untilIso: string): string {
  return `Snoozed until ${whenWords(untilIso)}.`;
}

// -----------------------------------------------------------------------------
// The facts panel (mirrors apps/app lib/support/account-state.ts, written for hello@)
// -----------------------------------------------------------------------------

/** The build stages (lib/setup/tracker.ts StageId), as account-state.ts STAGE_LABELS names them. */
export const STAGE_LABELS: Readonly<Record<string, string>> = {
  agreement: "Agreement signed",
  payment: "Payment",
  website: "Your website read",
  answers: "Your answers set up",
  calendar: "Calendar",
  built: "Assistant built",
  practice_questions: "Practice questions passed",
  go_live: "Going live",
};

/** A stage's state (tracker.ts StageState), as account-state.ts STAGE_WORDS says it. */
export const STAGE_STATE_WORDS: Readonly<Record<string, string>> = {
  done: "done",
  not_done: "not yet",
  info: "for now",
};

/** A channel's status (lib/channels/state.ts ChannelStatus), as account-state.ts CHANNEL_STATUS_WORDS says it. */
export const CHANNEL_STATUS_WORDS: Readonly<Record<string, string>> = {
  off: "off",
  paused: "paused",
  live: "live",
  waiting: "ready on healdesk's side, waiting on the practice",
  setting_up: "being prepared by healdesk",
};

/**
 * What a channel waits on (db/schema.ts CHANNEL_WAITING_ON, plus the two
 * steps lib/setup/channels.ts adds): the practice's one outstanding step,
 * in lib/setup/channels.ts actionLine's words turned from "your" to "its".
 */
export const WAITING_ON_WORDS: Readonly<Record<string, string>> = {
  setup: "finish setup",
  finish_setup: "finish setup",
  preparing: "nothing yet: being prepared on healdesk's side",
  direct_line: "add its direct line, where calls go whenever AYA can't answer",
  forwarding: "set call forwarding on its main line",
  snippet: "paste one line on its website",
  meta_connect: "connect Instagram and Messenger with its Facebook login",
  whatsapp_payment_method: "add a payment method to its WhatsApp account in Meta",
};

/** The connections (account-state.ts ConnectionRow), as CONNECTION_LABELS and CONNECTION_WORDS say them. */
export const CONNECTION_LABELS: Readonly<Record<string, string>> = {
  google_calendar: "Google Calendar",
  payment_account: "Payment account (Stripe)",
};

export const CONNECTION_WORDS: Readonly<Record<string, string>> = {
  not_connected: "not connected",
  active: "connected and working",
  degraded: "connected, with problems (bookings may arrive as requests)",
  error: "broken: bookings arrive as requests until it is reconnected",
  pending: "connecting",
  connected: "connected",
};

/** The usage meters, as account-state.ts METER_LABELS names them. */
export const METER_LABELS: Readonly<Record<string, string>> = {
  voice_minutes: "Voice minutes",
  chat_conversations: "Chat conversations",
};

/** A transcript email's status (lib/admin/transcript-status.ts), as the Deliveries tab names each. */
export const TRANSCRIPT_STATUS_WORDS: Record<TranscriptStatus, string> = {
  open: "chat still going",
  pending: "waiting to send",
  sent: "sent, not confirmed",
  bounced: "bounced",
  delivered: "delivered",
  expired: "deleted after 30 days",
  unconfirmed: "deleted unanswered",
};

/** A code in words from a table, or its own words when nobody listed it. */
function wordsOf(table: Readonly<Record<string, string>>, code: string): string {
  return table[code] ?? code.replace(/_/g, " ");
}

function onOff(value: boolean | null): string {
  return value === null ? "unknown" : value ? "on" : "off";
}

/** A channel's id in the catalog's name ("Phone"); one off the catalog printed as its own words. */
function channelName(code: string): string {
  return (CHANNEL_NAMES as Readonly<Record<string, string>>)[code] ?? code.replace(/_/g, " ");
}

/**
 * The account's facts as label and value pairs, in the order and words
 * account-state.ts describeAccountState gives hello@, less the numbers
 * (a flag says whether each is set) and the practice's name (the page's
 * heading has it).
 */
export function accountLines(a: SupportAccountFactsView): [string, string][] {
  const rows: [string, string][] = [];
  const plan = a.planId ? getPlan(a.planId) : undefined;
  if (a.isClosed) rows.push(["Account", "closed (read-only until its data is destroyed)"]);
  rows.push(["Setup", a.isSetupFinished ? "finished" : `not finished: ${a.setupStepsLeftCount} of 4 steps still to do`]);
  if (a.setupDeadlineAt && !a.isPlanStarted) rows.push(["Setup must be finished by", onDay(a.setupDeadlineAt)]);
  for (const stage of a.stageRows) rows.push([`Build: ${wordsOf(STAGE_LABELS, stage.code)}`, wordsOf(STAGE_STATE_WORDS, stage.status)]);
  for (const channel of a.channelRows) {
    rows.push([
      `Channel: ${channelName(channel.channel)}`,
      `${wordsOf(CHANNEL_STATUS_WORDS, channel.status)}${channel.isEnabled ? "" : " (switched off in Settings)"}${channel.liveAt ? `, live since ${onDay(channel.liveAt)}` : ""}${channel.waitingOn ? `; waiting on the practice to ${wordsOf(WAITING_ON_WORDS, channel.waitingOn)}` : ""}`,
    ]);
  }
  if (a.isPaused) rows.push(["AYA paused", a.pausedUntilAt ? `until ${whenWords(a.pausedUntilAt)}` : "until someone turns her back on"]);
  if (a.mode) {
    rows.push(["Which calls reach AYA", COVERAGE_MODE_OPTIONS.find((m) => m.id === a.mode)?.label ?? a.mode.replace(/_/g, " ")]);
    rows.push(["Phone carrier", CARRIERS.find((c) => c.id === a.carrier)?.name ?? "not given"]);
    rows.push(["Phone system", a.phoneSystem === "voip" ? "cloud phone system" : a.phoneSystem === "landline" ? "landline" : "not given"]);
    rows.push(["Direct line", a.isDirectLineSet ? "set" : "not set"]);
  }
  rows.push(["Main phone number", a.isPublishedPhoneSet ? "set" : "not set"]);
  rows.push(["Urgent-help number", a.isUrgentHelpSet ? "set" : "not set"]);
  rows.push(["Transfer live calls", a.isTransferOn ? "on" : "off"]);
  rows.push(["Daily summary email", onOff(a.isDailySummaryOn)]);
  rows.push(["Take deposits", onOff(a.isDepositsOn)]);
  for (const connection of a.connectionRows) {
    rows.push([wordsOf(CONNECTION_LABELS, connection.resource), wordsOf(CONNECTION_WORDS, connection.status)]);
  }
  rows.push(["Package", plan ? plan.name : (a.planId ?? "none")]);
  if (a.interval) rows.push(["Billing", a.interval === "year" ? "annual" : "monthly"]);
  if (a.status) rows.push(["Subscription status", wordsOf(BILLING_STATUS_WORDS, a.status)]);
  rows.push(["Plan started", a.isPlanStarted ? `yes${a.planStartedAt ? `, on ${onDay(a.planStartedAt)}` : ""}` : "not yet: it starts the day AYA first answers a patient or client"]);
  if (a.isAutoRenewOn !== null) rows.push(["Auto-renew", onOff(a.isAutoRenewOn)]);
  if (a.closesOn) rows.push(["Account closes on", onDay(a.closesOn)]);
  if (a.overageMode) {
    rows.push([
      "When the monthly allowance runs out",
      a.overageMode === "allow" ? "keep going and bill the extra in blocks of 100" : "stop and fall back to the direct line and a contact form",
    ]);
  }
  if (a.isUsageAlertsOn !== null) rows.push(["Usage alerts", onOff(a.isUsageAlertsOn)]);
  if (a.hasOpenInvoice) rows.push(["Unpaid invoice", "yes, see the Billing tab"]);
  if (a.graceEndsAt) rows.push(["Payment grace period ends", onDay(a.graceEndsAt)]);
  for (const usage of a.usageRows) rows.push([`Used this period: ${wordsOf(METER_LABELS, usage.meter)}`, `${usage.used} of ${usage.included}`]);
  rows.push(["The practice's email address", a.isAddressUndeliverable ? "undeliverable: mail to it bounced or was refused" : "deliverable"]);
  return rows;
}

/** An ops alert's event as words: "calendar broken". */
export function alertWords(event: string): string {
  return event.replace(/_/g, " ");
}

/** The alerts of the facts' window as lines: the event, when it was last raised, how often. */
export function alertLines(alerts: NonNullable<SupportCaseFactsView["alerts"]>): string[] {
  return alerts.map((a) => `${alertWords(a.event)}, last ${whenWords(a.lastRaisedAt)}${a.repeats > 1 ? ` (${a.repeats} times)` : ""}`);
}

/** The transcript emails of the window by status, the non-zero ones: "2 delivered, 1 bounced". */
export function transcriptWords(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${wordsOf(TRANSCRIPT_STATUS_WORDS, status)}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** The line when a part of the facts could not be read. */
export const FACTS_NOT_READ: Record<"account" | "alerts" | "transcripts", string> = {
  account: "The account's state could not be read.",
  alerts: "The alerts could not be read.",
  transcripts: "The transcript emails could not be read.",
};

/** The line when the case names no clinic, so there is no account to read. */
export const NO_CLINIC_FACTS = "No clinic is matched yet, so there are no account facts. Match the case to its clinic first.";

/** The heading over the draft's facts (the drafter's facts_used). */
export const DRAFT_FACTS_HEADING = "The facts the draft relies on";

/** The line under that heading when the draft names none (a saved edit, or a failed run). */
export const NO_DRAFT_FACTS = "The draft names no facts.";

/** The line over a draft's questions for ops. */
export const QUESTIONS_HEADING = "The assistant asks you";

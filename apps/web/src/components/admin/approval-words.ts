import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import type {
  ApprovalEventName,
  ApprovalItem,
  ApprovalKind,
  ApproveReason,
  BillingRequestKind,
  BillingStatus,
  ContactFacts,
  ContactNote,
  ContactPhrase,
  ContactRecommendation,
  IncidentApprovalKind,
  OpenResignRow,
  RejectReason,
} from "@/lib/admin/ops-client";
import type { Tone } from "@/lib/admin/strip-types";

import { waited } from "./queue-words";

/**
 * The plain words the Queues page's "Approvals" section puts on apps/app's
 * approval inbox (ops automation Phase 6, lane P6b; the operations are lane
 * P6a's, apps/app lib/ops/approval-ops.ts; the clinic-contact kinds lane
 * P6f's and the incident kinds lane P6i's, both drawn by lane P6j). Every
 * value here is a closed code of apps/app's, read in its source by
 * `approval-words.test.ts`, so a code added there with no words here fails
 * the build rather than reaching the operator as a code: the kinds and the
 * request kinds (db/schema.ts), the approve and reject reasons
 * (lib/approvals/kinds.ts), why a request stopped (lib/approvals/packets.ts),
 * the billing engine's Stripe error families (lib/billing/requests.ts), the
 * event names (db/schema.ts APPROVAL_EVENTS), the outcome codes the
 * executors, the store and the proposers record, the email phrases and
 * closing sentences (lib/email/templates/contact-words.ts), and why a chase
 * or a reminder would send nothing (lib/agreements/open-resigns.ts,
 * lib/approvals/contact-reminders.ts). Types only from ops-client, so a
 * client component may import this (lib/admin/client-imports.test.ts).
 */

/** Every kind the inbox holds: the billing and clinic-contact kinds ops-client lists, and the incident assistant's two. */
export type AnyApprovalKind = ApprovalKind | IncidentApprovalKind;

export const APPROVAL_KIND_WORDS: Record<AnyApprovalKind, string> = {
  billing_request_retry: "Retry a billing change the billing worker gave up on",
  overage_invoice_retry: "Retry an extra-usage invoice that failed",
  billing_event_replay: "Replay a Stripe event that was parked",
  // The emails to a clinic (lane P6f).
  baa_resign_chase: "Chase a practice to sign its updated agreement",
  agreement_question: "Ask a practice which agreement it needs",
  setup_extended: "Give a clinic more time to finish setup, and tell it",
  setup_waiting_on_us: "Tell a clinic we are finishing its setup",
  setup_help_offer: "Offer a clinic a five-minute setup call",
  setup_reminder_now: "Send the next setup reminder sooner",
  // The incident assistant (lane P6i): legal clocks.
  incident_open_batch: "Open an incident at each clinic a vendor's or a channel's incident reached",
  incident_report_send: "Send a practice its incident report",
};

/** The three groups the section draws, in the order the owner reads them: the legal clocks first. */
export const APPROVAL_FAMILIES = ["incident", "contact", "billing"] as const;
export type ApprovalFamily = (typeof APPROVAL_FAMILIES)[number];

export const FAMILY_WORDS: Record<ApprovalFamily, string> = {
  incident: "Incidents: an agreement's clock is running",
  contact: "Emails to clinics",
  billing: "Billing",
};

const FAMILY_OF: Record<AnyApprovalKind, ApprovalFamily> = {
  billing_request_retry: "billing",
  overage_invoice_retry: "billing",
  billing_event_replay: "billing",
  baa_resign_chase: "contact",
  agreement_question: "contact",
  setup_extended: "contact",
  setup_waiting_on_us: "contact",
  setup_help_offer: "contact",
  setup_reminder_now: "contact",
  incident_open_batch: "incident",
  incident_report_send: "incident",
};

export function familyOf(kind: AnyApprovalKind): ApprovalFamily {
  return FAMILY_OF[kind];
}

/** The same words apps/app's alerts use for a request's kind (lib/ops/alert-wording/words.ts REQUEST_KIND_WORDS). */
export const REQUEST_KIND_WORDS: Record<BillingRequestKind, string> = {
  plan_start: "starting the plan",
  step_up: "a price step-up",
  close_setup: "closing an unfinished setup",
  cancel_now: "an immediate cancellation",
};

export const CHANNEL_WORDS: Record<"web" | "meta" | "voice", string> = {
  web: "website chat",
  meta: "Meta",
  voice: "phone",
};

/** Why the billing worker stopped (lib/approvals/packets.ts reasonCode; lib/billing/requests.ts outcomeReason). */
export const STOP_REASON_WORDS: Record<"attempts_exhausted" | "permanent_error", string> = {
  attempts_exhausted: "every try was used",
  permanent_error: "a failure that retrying cannot fix",
};

/** Our billing status for the clinic, as the entitlements row last heard it from Stripe. */
export const BILLING_STATUS_WORDS: Record<BillingStatus, string> = {
  demo: "demo",
  provisioning: "being set up",
  active: "active",
  past_due: "past due",
  suspended: "suspended",
  paused: "paused",
  canceling: "cancelling at the end of its period",
  canceled: "cancelled",
  purged: "purged",
};

/**
 * The billing engine's Stripe error families (lib/billing/requests.ts
 * STRIPE_ERROR_FAMILIES, recorded as `stripe:<family>`), and the same
 * families as Stripe's own raw types and class names, which the overage
 * invoicer records lower-cased (lib/billing/metered-items.ts stripeErrorCode:
 * `<type>:<code>`). One meaning each.
 */
const STRIPE_FAMILY_WORDS: Readonly<Record<string, string>> = {
  card_error: "Stripe refused the card",
  invalid_request: "Stripe refused the request as invalid",
  api_error: "Stripe had an error on its side",
  authentication: "Stripe refused our key",
  permission: "Stripe refused the permission",
  rate_limit: "Stripe asked us to slow down",
  connection: "the connection to Stripe dropped",
  idempotency: "Stripe saw the same request again with different details",
  error: "Stripe answered with an error",
};

const STRIPE_HEAD_WORDS: Readonly<Record<string, string>> = {
  stripecarderror: STRIPE_FAMILY_WORDS.card_error!,
  stripeinvalidrequesterror: STRIPE_FAMILY_WORDS.invalid_request!,
  stripeapierror: STRIPE_FAMILY_WORDS.api_error!,
  stripeauthenticationerror: STRIPE_FAMILY_WORDS.authentication!,
  stripepermissionerror: STRIPE_FAMILY_WORDS.permission!,
  striperatelimiterror: STRIPE_FAMILY_WORDS.rate_limit!,
  stripeconnectionerror: STRIPE_FAMILY_WORDS.connection!,
  stripeidempotencyerror: STRIPE_FAMILY_WORDS.idempotency!,
  invalid_request_error: STRIPE_FAMILY_WORDS.invalid_request!,
  authentication_error: STRIPE_FAMILY_WORDS.authentication!,
  rate_limit_error: STRIPE_FAMILY_WORDS.rate_limit!,
  idempotency_error: STRIPE_FAMILY_WORDS.idempotency!,
  // lib/billing/requests.ts failureOf: the other closed heads it records.
  stripe_not_configured: "no Stripe key is on the host",
  price_not_found: "a price is missing in Stripe",
  internal: "our own code failed",
  // lib/billing/metered-items.ts stripeErrorCode, when the error carried no type.
  unknown: "the cause was not recorded",
};

/**
 * An engine code in words: `stripe:<family>` (a billing request), or
 * `<family or class>[:<Stripe code or status>]` (an overage invoice), with
 * Stripe's own code after it in brackets, since that is the one word the
 * operator looks up. A head this table does not know is printed as its own
 * words, never dropped: the code is apps/app's, written for exactly this.
 */
export function engineWords(code: string): string {
  const [head = "", detail] = code.split(":");
  const family = head === "stripe" ? (detail ? STRIPE_FAMILY_WORDS[detail] : null) : null;
  if (head === "stripe") return family ?? STRIPE_FAMILY_WORDS.error!;
  const words = STRIPE_HEAD_WORDS[head] ?? STRIPE_FAMILY_WORDS[head] ?? `the engine recorded "${head.replace(/_/g, " ")}"`;
  return detail ? `${words} (${detail.replace(/_/g, " ")})` : words;
}

export const APPROVE_REASON_WORDS: Record<ApproveReason, string> = {
  cause_fixed: "The cause is fixed",
  passing_fault: "It was a passing fault",
  owner_checked: "I checked it and it is right",
};

/**
 * The approve reasons that make sense for a kind, the first the default: a
 * billing retry is approved because its cause is fixed or was a passing
 * fault, or because the owner checked it; an email to a clinic or an
 * incident step has no fault behind it, so the one reason is that the owner
 * checked it (the reasons are apps/app's closed list, lib/approvals/kinds.ts
 * APPROVE_REASONS, and every one is accepted for every kind there).
 */
export function approveReasonsFor(kind: AnyApprovalKind): readonly ApproveReason[] {
  return familyOf(kind) === "billing" ? ["cause_fixed", "passing_fault", "owner_checked"] : ["owner_checked"];
}

export const REJECT_REASON_WORDS: Record<RejectReason, string> = {
  not_needed: "Not needed",
  wrong_amount: "The amount is wrong",
  handled_elsewhere: "Handled another way",
  ask_clinic_first: "Ask the clinic first",
  other: "Another reason",
};

/** What happened to an item, as the History tab reads each row (db/schema.ts APPROVAL_EVENTS). */
export const EVENT_WORDS: Record<ApprovalEventName, string> = {
  proposed: "proposed",
  edited: "choices changed",
  approved: "approved",
  rejected: "rejected",
  executed: "went through",
  // The outcome says which failure: the operation's refusal, a process that died before the answer.
  failed: "failed",
  expired: "left the list without running",
  reminded: "reminder sent",
};

/**
 * The outcome codes a row can carry, in words: the owner's reasons (an
 * approved or rejected row), what the executor answered (lib/approvals/
 * executors.ts, contact-executors.ts, incident-kinds.ts), and the store's
 * and proposers' reasons for taking an item off the list
 * (lib/approvals/store.ts, proposers.ts, contact-proposers.ts).
 */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  cause_fixed: "the cause is fixed",
  passing_fault: "a passing fault",
  owner_checked: "checked by the owner",
  not_needed: "not needed",
  wrong_amount: "the amount is wrong",
  handled_elsewhere: "handled another way",
  ask_clinic_first: "ask the clinic first",
  other: "another reason",
  rearmed: "made due again for the billing worker",
  invoiced: "invoiced in Stripe",
  skipped: "nothing to invoice",
  replayed: "the Stripe event was applied again",
  no_longer_needed: "already dealt with since it was proposed",
  retried_automatically: "the job that retries it was switched on, so it is retried by itself",
  malformed_item: "its details could not be read",
  operation_refused: "the operation refused it",
  refused: "the operation refused it",
  stripe_failed: "Stripe did not invoice it",
  threw: "the operation failed partway",
  window_passed: "its window passed",
  clinic_out_of_service: "its clinic left service",
  interrupted: "the process died before the answer came",
  // The clinic-contact executors (apps/app lib/approvals/contact-executors.ts, lane P6f).
  sent: "sent",
  queued: "queued to send",
  already_sent: "it had already been queued, so it was not queued again",
  send_failed: "the email did not go",
  no_public_origin: "no signing link could be made",
  extension_refused: "the extension did not go through, so nothing was emailed",
  extended_email_not_queued: "the deadline moved but the email could not be queued",
  reminder_not_queued: "the reminder was not queued",
  reminder_night: "it was night at the clinic, so the reminder was not sent",
  reminder_too_soon: "a reminder went less than five days before, so this one was not sent",
  superseded_by_next_round: "a newer chase of the same re-sign replaced it",
  // The incident assistant's executors (apps/app lib/approvals/incident-kinds.ts, lane P6i).
  opened: "the incidents were opened",
  partly_opened: "some of the incidents were opened, not all",
};

/** An outcome code in words; one this table does not know is printed as its own words. */
export function outcomeWords(code: string | null): string | null {
  if (code === null) return null;
  return OUTCOME_WORDS[code] ?? code.replace(/_/g, " ");
}

/**
 * The actor on a history row: the operator's account, or one of the two
 * services that propose items (lib/approvals/kinds.ts PROPOSER,
 * lib/approvals/incident-kinds.ts ASSISTANT).
 */
export function actorWords(label: string): string {
  if (label === "approvals-propose") return "the approvals job";
  if (label === "incident-assistant") return "the incident assistant";
  return label;
}

/**
 * The sentence before the code field on an irreversible item, true to what
 * each kind's operation does: a billing request is re-armed for the billing
 * worker, which carries it out; an overage retry has Stripe issue the
 * invoice in the same request; a replay applies the event in the same
 * request (lib/approvals/executors.ts); an email goes or is queued
 * (contact-executors.ts); a batch opens its incidents and a report is
 * emailed in the same request (incident-kinds.ts).
 */
export const IRREVERSIBLE_CONFIRM: Record<AnyApprovalKind, string> = {
  billing_request_retry: "This cannot be undone once the billing worker has carried it out.",
  overage_invoice_retry: "This cannot be undone once Stripe has issued the invoice.",
  billing_event_replay: "This cannot be undone once the event has been applied.",
  baa_resign_chase: "This cannot be undone once the email has gone.",
  agreement_question: "This cannot be undone once the email has gone.",
  setup_extended: "This cannot be undone once the deadline has moved and the email has gone.",
  setup_waiting_on_us: "This cannot be undone once the email has gone.",
  setup_help_offer: "This cannot be undone once the email has gone.",
  setup_reminder_now: "This cannot be undone once the reminder has gone.",
  incident_open_batch: "This cannot be undone once the incidents have been opened.",
  incident_report_send: "This cannot be undone once the report has been emailed.",
};

/**
 * The second press on Approve: every kind's operation runs once, in the
 * same request (lib/approvals/executors.ts). A billing request's operation
 * only re-arms it; the billing worker then carries the change out at its
 * next run, with fresh tries (lib/billing/requests.ts rearmBillingRequest),
 * so that kind's sentence says so, and no other kind's does.
 */
export function approveConfirm(kind: AnyApprovalKind): string {
  const head = "Approve this item? Its operation runs once now.";
  return kind === "billing_request_retry" ? `${head} A billing change is then carried out by the billing worker, with fresh tries.` : head;
}

/**
 * What rejecting a billing item does, true to lib/approvals/store.ts
 * propose() (nothing is proposed again for a subject while a rejected item
 * stands for it) and proposers.ts (a plan start, a step-up or an overage
 * invoice is in the list only while the job that retries it is off:
 * switched on later, that job retries it regardless of the rejection).
 */
export const REJECT_HEAD =
  "Nothing is run now, and this failure is not proposed again. If the job that retries it is switched on later, that job still retries it.";

/**
 * What rejecting each email or incident item does: nothing is sent or
 * opened, and whether it can be proposed again. A chase is the approvals
 * job's, one item per re-sign and seven-day round, so a rejection holds for
 * its round and the next round's chase is proposed when the next seven-day
 * round begins, while the re-sign stays open (contact-proposers.ts;
 * open-resigns.ts chaseRound: round 1 from day 8, 2 from day 15, and so
 * on). The operator's own
 * proposals get a new reference after a rejection (store.ts
 * subjectAfterRejections), so the same button proposes again. An incident
 * scope is never proposed again once rejected (store.ts propose(), as
 * opProposeIncidentBatch says); a report can be proposed again by hand, and
 * the hourly job proposes a first report once only (incident-kinds.ts
 * findIncidentSubjects).
 */
const REJECT_WORDS: Record<Exclude<AnyApprovalKind, "billing_request_retry" | "overage_invoice_retry" | "billing_event_replay">, string> = {
  baa_resign_chase:
    "Nothing is sent. This round's chase is not proposed again; while the re-sign stays open, the approvals job proposes the next round's chase when its next seven-day round begins (day 15, 22, ...).",
  agreement_question: "Nothing is sent. The question can be proposed again.",
  setup_extended: "Nothing is sent and the deadline does not move. It can be proposed again from the clinic's Setup window card.",
  setup_waiting_on_us: "Nothing is sent. It can be proposed again from the clinic's Setup window card.",
  setup_help_offer: "Nothing is sent. It can be proposed again from the clinic's Setup window card.",
  setup_reminder_now: "Nothing is sent now; the reminder still goes on its own day. It can be proposed again from the clinic's Setup window card.",
  incident_open_batch:
    "Nothing is opened, and this scope is not proposed again. To open an incident at one clinic, use its Care tab; a new scope can be proposed from the Incidents page.",
  incident_report_send:
    "Nothing is sent, and the agreement's clock keeps running. The report can be proposed again from the Incidents page, or sent from there with Send report; the hourly job does not propose it again.",
};

/** Where to retry an item that has a clinic by hand: its Billing tab has the same button. */
export const BILLING_TAB_RETRY = "The clinic's Billing tab is where to retry it by hand.";

/**
 * A Stripe event that resolved to no clinic (proposers.ts lists one that no
 * waiting purchase names): the Billing tab lists parked events by resolved
 * clinic, so no tab shows it, and nothing else replays it.
 */
export const NO_CLINIC_EVENT = "This event is on no clinic's Billing tab; Approve here is the only button that replays it.";

/** The same fact once the item is rejected and gone: no button replays it. */
const NO_CLINIC_EVENT_REJECTED = "This event is on no clinic's Billing tab.";

type Subject = { kind: AnyApprovalKind; clinic: ApprovalItem["clinic"] };

/** Whether the item is a Stripe event no clinic's Billing tab lists. */
export function isClinicless(item: Subject): boolean {
  return item.clinic === null && item.kind === "billing_event_replay";
}

/** The second press on Reject: per family, what runs (nothing) and where the subject can still be acted on. */
export function rejectConfirm(item: Subject): string {
  if (familyOf(item.kind) !== "billing") return REJECT_WORDS[item.kind as keyof typeof REJECT_WORDS];
  if (isClinicless(item)) return `${REJECT_HEAD} ${NO_CLINIC_EVENT}`;
  return item.clinic ? `${REJECT_HEAD} ${BILLING_TAB_RETRY}` : REJECT_HEAD;
}

/** The line when apps/app could not read an item's facts (listApprovals `partial`). */
export const FACTS_NOT_READ = "Its facts could not be read, so Approve is not offered. Reload, or reject it.";

/** The line when the subject has moved on since the item was proposed (packet `stillNeeded` false): approving runs nothing. */
export const NO_LONGER_NEEDED = "Already dealt with since it was proposed: approving runs nothing.";

export const EMPTY_WORDS = "Nothing is waiting for your yes.";

/** The job that proposes items (lib/approvals/kinds.ts PROPOSER), as the Jobs page names it. */
export const APPROVALS_JOB = "approvals-propose";

/**
 * Empty with the approvals job's switch off (read from listJobs): that job
 * proposes the billing retries (lib/approvals/proposers.ts) and the re-sign
 * chases (contact-proposers.ts); an incident's first report is proposed by
 * the hourly incident-deadlines job as well (incident-sweep.ts), and the
 * owner's own buttons propose the rest, so those still arrive.
 */
export const EMPTY_JOB_OFF =
  "Nothing is waiting for your yes, but the approvals job is off at System > Jobs, so no billing retry or re-sign chase is being proposed; incident reports and your own proposals still arrive.";

/** The empty line, by whether the approvals job is known to be off (null: its switch could not be read, so nothing extra is said). */
export function emptyWords(proposerOn: boolean | null): string {
  return proposerOn === false ? EMPTY_JOB_OFF : EMPTY_WORDS;
}

/** Cents as a reader reads money: "$80", "$1,200", "$0.90" (as apps/app's packets print it). */
export function dollars(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const WHEN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** An instant as its UTC day, or a YYYY-MM-DD as that day: "31 Oct 2026". */
export function onDay(iso: string): string {
  return DAY.format(new Date(iso));
}

/** An instant to the minute, in UTC: "3 Nov 2026, 10:01 UTC". */
export function whenWords(iso: string): string {
  return `${WHEN.format(new Date(iso))} UTC`;
}

/** A Stripe event's type as words: "invoice.payment_failed" reads "invoice payment failed". */
export function eventTypeWords(type: string): string {
  return type.replace(/[._]/g, " ");
}

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

// -----------------------------------------------------------------------------
// The clinic-contact kinds' closed words (lane P6f)
// -----------------------------------------------------------------------------

/** What a setup notice names, as the operator picks it (apps/app PHRASES; the email prints its own words for each). */
export const PHRASE_WORDS: Record<ContactPhrase, string> = {
  phone: "the phone line",
  website_chat: "website chat",
  meta: "Meta chat (Instagram, Messenger and WhatsApp)",
  calendar: "the Google Calendar connection",
};

/**
 * The approved closing sentences, word for word as the email prints them
 * (apps/app lib/email/templates/contact-words.ts NOTE_WORDS): the owner
 * picks one, or none, and reads exactly what the clinic will.
 */
export const NOTE_WORDS: Record<ContactNote, string> = {
  call_offer: "If it's easier to talk it through, reply with a time that suits you and we'll call.",
  thanks: "Thank you for your patience while we sort this out.",
  reply_questions: "If anything is unclear, reply to this email and we'll help.",
  thanks_sign: "Thank you for taking a moment to sign it.",
};

export const NO_NOTE_WORDS = "No closing sentence";

type ChaseBlock = NonNullable<Extract<ContactFacts, { kind: "baa_resign_chase" }>["blocked"]>;
type ReminderBlock = NonNullable<Extract<ContactFacts, { kind: "setup_reminder_now" }>["blocked"]>;
type StageCode = NonNullable<Extract<ContactFacts, { newLastDay: string | null }>["stage"]>;
type ReviewStatus = NonNullable<Extract<ContactFacts, { kind: "agreement_question" }>["reviewStatus"]>;

/**
 * Why a chase cannot go now (apps/app lib/agreements/open-resigns.ts
 * chaseBlocked): only an updated-version re-sign is chased (a re-sign that
 * replaces a DPA pauses AYA, and its own emails say so), only while version
 * re-signs are switched on, only from day 8 once the re-sign's own
 * reminders (days 0, 3 and 7) have gone, and never within 7 days of the last
 * chase sent.
 */
export const CHASE_BLOCK_WORDS: Record<ChaseBlock, string> = {
  not_baa_version: "this is not a BAA version re-sign: it pauses AYA, and its own emails say so",
  switched_off: "BAA version re-signs are switched off, so the practice is not being asked to sign",
  too_early: "the re-sign's own reminders (days 0, 3 and 7) are not spent yet; a chase can go from day 8, once the day-7 reminder has gone",
  chased_recently: "the practice was chased less than 7 days ago",
};

/**
 * Why "Send the next reminder now" would send nothing (apps/app
 * lib/approvals/contact-reminders.ts reminderPlanIn, and contact-packets.ts
 * `already_queued` when the item's reminder is no longer the next one).
 */
export const REMINDER_BLOCK_WORDS: Record<ReminderBlock, string> = {
  not_billed: "the clinic has no billing row of its own: its reminders are its account's",
  window_over: "the setup window is over",
  live: "a channel is live, so the setup reminders have stopped",
  last_reminder: "the next reminder is the sixth, which goes only on the window's last day",
  night: "it is night at the clinic: it would wait until morning",
  recently_sent: "a reminder went less than five days ago",
  already_queued: "it is no longer the next reminder to send",
};

/** The lifecycle watch's stages (apps/app db/schema.ts LIFECYCLE_STAGES), as the Setup window card words them. */
export const STAGE_WORDS: Record<StageCode, string> = {
  not_started: "not started",
  in_setup: "in setup",
  waiting_on_us: "waiting on us",
  partly_live: "partly live",
  live: "live",
  closed: "closed",
};

/**
 * Why a practice signs again (apps/app db/schema.ts AGREEMENT_RESIGN_REASONS):
 * under a DPA, its answer to the covered-entity question, which stops the DPA
 * covering it and pauses AYA until the BAA is signed; under a BAA, a newer
 * version, which pauses nothing (lib/ops/resign-ops.ts holdsPause).
 */
export const RESIGN_REASON_WORDS: Record<OpenResignRow["reason"], string> = {
  now_covered: "answered Yes, it is covered by HIPAA: its DPA no longer covers it",
  not_sure: "answered Not sure whether HIPAA covers it: its DPA no longer covers it",
  baa_version: "a newer version of the business associate agreement",
};

/** An agreement-kind review's status, as Queues › Agreement checks words a decision (passed: the DPA stands; failed: the BAA was sent). */
export const REVIEW_STATUS_WORDS: Record<ReviewStatus, string> = {
  open: "open",
  passed: "decided: the DPA stands",
  failed: "decided: the BAA was sent to sign",
  superseded: "superseded by a later review",
};

/** The watch's recommended action (apps/app lib/lifecycle/recommend.ts RECOMMENDATIONS); its reason is a fixed sentence, printed as it came. */
export const RECOMMENDATION_WORDS: Record<ContactRecommendation["action"], string> = {
  extend: "extend",
  offer_call: "offer a call",
  let_close: "let it close",
  wait: "wait",
  phone_the_clinic: "phone the clinic",
};

const YES_NO_UNKNOWN: Record<"yes" | "no" | "unknown", string> = { yes: "yes", no: "no", unknown: "not known" };

function contactLines(facts: ContactFacts): [string, string][] {
  switch (facts.kind) {
    case "baa_resign_chase": {
      const lines: [string, string][] = [
        ["Agreement", `${facts.fromVersion ? `from version ${facts.fromVersion}` : "from the version in force"} to version ${facts.toVersion}`],
        ["Re-sign open", `${days(facts.daysOpen)}${facts.startedAt ? `, since ${onDay(facts.startedAt)}` : ""}`],
        ["Last signing email", facts.lastL22SentAt ? onDay(facts.lastL22SentAt) : "none recorded"],
        ["Latest link works until", facts.linkExpiresAt ? whenWords(facts.linkExpiresAt) : "no link sent yet"],
        ["Last chase", facts.lastChaseAt ? onDay(facts.lastChaseAt) : "none yet"],
        ["AYA answering", facts.isAnswering ? "yes" : "no"],
      ];
      if (facts.belowFloor) lines.push(["Phone the practice on", facts.publishedPhoneE164 ?? "no published number on file"]);
      if (facts.blocked) lines.push(["Would send nothing now", CHASE_BLOCK_WORDS[facts.blocked]]);
      return lines;
    }
    case "agreement_question": {
      const lines: [string, string][] = [
        [
          "Review",
          `${facts.reviewStatus ? REVIEW_STATUS_WORDS[facts.reviewStatus] : "not found"}${facts.reviewDueOn ? `; our own day to decide it: ${onDay(facts.reviewDueOn)}` : ""}`,
        ],
        [
          "Agreement in force",
          facts.agreementKind
            ? `${facts.agreementKind === "baa" ? "BAA" : "DPA"}${facts.agreementVersion ? ` ${facts.agreementVersion}` : ""}${facts.signedAt ? `, signed ${onDay(facts.signedAt)}` : ""}`
            : "none on file",
        ],
        ["Covered by HIPAA, as answered at checkout", YES_NO_UNKNOWN[facts.coveredAnswer]],
        ["Website says it takes insurance", facts.siteAcceptsInsurance === "unknown" ? "not read" : YES_NO_UNKNOWN[facts.siteAcceptsInsurance]],
        ["Earlier reviews decided", String(facts.earlierDecisions)],
      ];
      if (facts.openResign) lines.push(["A re-sign is already open", "yes: approving sends nothing"]);
      return lines;
    }
    case "setup_extended":
    case "setup_waiting_on_us":
    case "setup_help_offer": {
      const lines: [string, string][] = [
        ["Stage", facts.stage ? `${STAGE_WORDS[facts.stage]}${facts.stageSince ? ` since ${onDay(facts.stageSince)}` : ""}` : "not on the setup watch"],
        ["Window ends", facts.lastDay ? `${onDay(facts.lastDay)}${facts.remainingDays !== null ? ` (${days(facts.remainingDays)} left)` : ""}` : "no setup deadline"],
      ];
      if (facts.kind === "setup_extended" && facts.newLastDay) lines.push(["If approved, ends", onDay(facts.newLastDay)]);
      if (facts.stepsLeft !== null) lines.push(["Steps left", String(facts.stepsLeft)]);
      if (facts.alreadySent) lines.push(["Already sent for this stage", "yes: approving sends nothing"]);
      if (facts.stageMoved) lines.push(["Stage moved since proposed", "yes: approving sends nothing"]);
      if (facts.recommendation) lines.push(["The setup watch recommends", facts.recommendation.reason]);
      return lines;
    }
    case "setup_reminder_now": {
      const lines: [string, string][] = [
        ["Reminder", `${facts.reminderNumber} of ${facts.ofTotal}, normally due ${onDay(facts.normallyDueOn)}`],
        ["Sent so far", facts.sentSoFar === null ? "not read" : String(facts.sentSoFar)],
      ];
      if (facts.blocked) lines.push(["Would send nothing now", REMINDER_BLOCK_WORDS[facts.blocked]]);
      if (facts.recommendation) lines.push(["The setup watch recommends", facts.recommendation.reason]);
      return lines;
    }
  }
}

/**
 * The packet's facts as label and value pairs, per kind: what the owner
 * decides on, read live by apps/app from the rows the Billing tab reads. For
 * a billing request, whether the billing worker that would carry a re-armed
 * request out is switched on, and for a closure the setup-closure switch
 * too, as one word each: the packet's `effect` already says what an off
 * switch means, and the card prints that sentence once. The other two
 * billing kinds run in the same request as the approval, with no worker in
 * between. An email kind's facts are the re-sign's, the review's, the setup
 * window's or the reminder's, with the setup watch's recommendation as it
 * came (never recomputed here).
 */
export function factLines(item: ApprovalItem): [string, string][] {
  const packet = item.packet;
  if (!packet) return [];
  const facts = packet.facts;
  if (facts.kind === "billing_request_retry") {
    const lines: [string, string][] = [
      ["Change", `${REQUEST_KIND_WORDS[facts.requestKind]}${facts.channel ? `, from the ${CHANNEL_WORDS[facts.channel]} channel` : ""}`],
      ["Tries", `${facts.attempts} of ${facts.maxAttempts}`],
    ];
    if (facts.reasonCode) lines.push(["Stopped because", STOP_REASON_WORDS[facts.reasonCode]]);
    if (facts.lastErrorCode) lines.push(["Last error", engineWords(facts.lastErrorCode)]);
    lines.push(["Billing now", facts.billingStatus ? BILLING_STATUS_WORDS[facts.billingStatus] : "not read"]);
    if (facts.supersededBy) {
      lines.push(["Superseded", `a later ${facts.supersededBy === "cancel_now" ? "cancellation" : "closure"} makes this change moot`]);
    }
    lines.push(["Billing worker", facts.workerOn ? "on" : "off"]);
    if (facts.closureOn !== null) lines.push(["Setup closure switch", facts.closureOn ? "on" : "off"]);
    return lines;
  }
  if (facts.kind === "overage_invoice_retry") {
    const lines: [string, string][] = [
      ["Amount", dollars(facts.amountCents)],
      ["Month from", onDay(facts.windowStart)],
    ];
    if (facts.lastErrorCode) lines.push(["Last error", engineWords(facts.lastErrorCode)]);
    lines.push(["Runs", "at once, in the same request, when approved"]);
    return lines;
  }
  if (facts.kind !== "billing_event_replay") return contactLines(facts);
  return [
    ["Stripe event", eventTypeWords(facts.eventType)],
    ["Failed", `${facts.failures} of ${facts.maxFailures} times`],
    ["Runs", "at once, in the same request, when approved"],
  ];
}

/** The line under a reminder item, whose wording is the reminder's own (contact-packets.ts: its draft is null). */
export const REMINDER_FIXED_WORDS = "The reminder's wording is fixed: nothing in it can be changed.";

/** The heading over a draft: the email exactly as the clinic reads it, the chase's link shown as a placeholder until it is minted at send. */
export const DRAFT_HEADING = "The email as the clinic will read it";

/** The line beside the Edit control: what may change, and what never does (owner decision D12). */
export const EDIT_WORDS = "Only the choices below can change; nothing typed reaches the email.";

/** How long the item has waited since it was proposed, and whether it is past due: "Waiting 2 days, past due". */
export function waitingWords(item: Pick<ApprovalItem, "proposedAt" | "pastDue">, nowIso: string): string {
  const minutes = Math.max(0, (Date.parse(nowIso) - Date.parse(item.proposedAt)) / 60_000);
  return `Waiting ${waited(minutes)}${item.pastDue ? ", past due" : ""}`;
}

/**
 * The item's window (KIND_SPECS expiryDays): past `expiresAt` a decision is
 * refused (approval-ops.ts), and the approvals job's next run moves the
 * item to expired (store.ts expireDue), unrun. Or it waits until decided.
 */
export function expiryWords(item: Pick<ApprovalItem, "expiresAt">): string {
  if (item.expiresAt === null) return "Waits until decided.";
  return `Can no longer be approved after ${whenWords(item.expiresAt)}; the approvals job then takes it off the list.`;
}

export type Decided = {
  /** Whether the item has left the waiting list: a decision was recorded, whatever the operation then did. */
  left: boolean;
  tone: Tone;
  text: string;
  /** Null when no audit row was owed (a refusal). */
  auditRecorded: boolean | null;
};

/**
 * The decision's answer in one line, true to lib/approvals/executors.ts,
 * contact-executors.ts, incident-kinds.ts and approval-ops.ts: a rejection
 * runs nothing and takes the item off the list; an approval that went
 * through says what the operation did, in the operation's own sentence
 * where it gave one (a re-armed request is due again, not carried out: the
 * billing worker does that at its next run; a queued email is sent by the
 * billing-notices job from the outbox); one that did not go through says
 * why in the operation's words; a refusal (already decided, window passed,
 * the code) changes nothing. A rejection's line says what the kind's
 * rejection means (rejectConfirm).
 */
export function decisionWords(entry: ApprovalDecisionEntry, item: Subject): Decided {
  switch (entry.status) {
    case "refused":
    case "code_refused":
      return { left: false, tone: "bad", text: entry.message, auditRecorded: null };
    case "rejected": {
      if (familyOf(item.kind) !== "billing") {
        return { left: true, tone: "ok", text: `Rejected. ${rejectConfirm(item)}`, auditRecorded: entry.auditRecorded };
      }
      const where = isClinicless(item) ? NO_CLINIC_EVENT_REJECTED : item.clinic ? BILLING_TAB_RETRY : null;
      return {
        left: true,
        tone: "ok",
        text: `Rejected. ${REJECT_HEAD}${where ? ` ${where}` : ""}`,
        auditRecorded: entry.auditRecorded,
      };
    }
    case "executed": {
      const said = (() => {
        switch (entry.outcomeCode) {
          case "rearmed":
            return entry.message ?? "Made due again: the billing worker carries it out at its next run if it still applies.";
          case "invoiced":
            return "Invoiced in Stripe.";
          case "skipped":
            return "Nothing was invoiced: the month was already settled, or had nothing to bill.";
          case "replayed":
            return "The Stripe event was applied again.";
          case "sent":
            return entry.message ?? "The email was sent.";
          case "queued":
            return entry.message ?? "The email is queued in the outbox; the billing-notices job sends it.";
          default:
            return entry.message ?? `Went through: ${outcomeWords(entry.outcomeCode)}.`;
        }
      })();
      return { left: true, tone: "ok", text: `Approved. ${said}`, auditRecorded: entry.auditRecorded };
    }
    case "failed":
      return {
        left: true,
        tone: "bad",
        text: `Approved, but it did not go through: ${entry.message ?? `${outcomeWords(entry.outcomeCode)}.`}`,
        auditRecorded: entry.auditRecorded,
      };
  }
}

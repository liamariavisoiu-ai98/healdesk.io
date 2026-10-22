import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  appointments,
  bookingRequests,
  chatThreads,
  clinics,
  contacts,
  conversationFlags,
  conversations,
  recordAmendments,
  type ConversationFlagRow,
} from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import {
  correctionReader,
  flagsOn,
  metaFlags,
  summaryOf,
  type FlagSummary,
} from "@/lib/conversations/flags";
import {
  canResend,
  resendTranscriptIn,
  transcriptReceiptFor,
  type TranscriptReceipt,
} from "@/lib/conversations/transcript-outbox";
import { identifierRef } from "@/lib/identifier-ref";
import { notifyRecordsExported } from "@/lib/notices/setting-changed";
import {
  destructionPlanIn,
  markExportDelivered,
  type DestructionPlan,
} from "@/lib/offboarding/offboarding";
import { amendmentsFor, type RecordAmendment } from "@/lib/patient-rights/amendments";
import { exportClinic, exportPatient } from "@/lib/patient-rights/export";
import { isPatientRequester, type PatientRequester } from "@/lib/patient-rights/requesters";
import { exportReceipt, receiptMatches } from "@/lib/portal/export-receipt";
import type { TenantTx } from "@/lib/tenant";

import {
  CHANNEL_NAMES,
  CONVERSATION_OUTCOMES,
  DAY_CHIPS,
  isDayChip,
  OUTCOME_NAMES,
  type ConversationChannel,
  type ConversationOutcome,
  type DayChip,
} from "./conversation-words";
import {
  logPatientAccess,
  withPatientPage,
  type PatientPage,
  type PatientTx,
} from "./patient-page";

/**
 * The Conversations screen (plan Part F4; spec, "Portal map": "Every call,
 * chat and DM, searchable, with the outcome and whether it produced a
 * booking. The words are not kept ... Second factor required to open one.
 * Export available.").
 *
 * Everything here runs behind requirePatientPage, inside withPatientPage, and
 * writes its access-log row naming the device's passkey in the transaction
 * that reads: the list as shown (one row, its ids), one conversation as
 * opened, a "Send again", an export. Nothing here reads or shows a word of a
 * conversation, because none is kept: a call's or a web chat's transcript is
 * emailed to the clinic when it ends and its sealed copy is deleted once
 * delivery is confirmed (lib/conversations/transcript-outbox.ts). What is
 * shown is the record without the words: the channel, the time, the outcome,
 * the person as the clinic's records name them, any booking request it
 * produced, any amendment the practice directed (BAA 1.5.1 clause 14(b):
 * every screen that shows the record carries it), and the transcript's
 * delivery receipt.
 *
 * Two sources:
 *   - `conversations`, one row per call or web chat;
 *   - `chat_threads`, for Instagram, Messenger and WhatsApp, which write no
 *     conversations row (Meta's channels carry nothing clinical and keep
 *     nothing of what was said). A thread is one person on one channel, with
 *     its current conversation's start, its last message and how many
 *     conversations it has had: only what is stored. Its person is a keyed
 *     reference, so a thread is matched to the booking request it produced
 *     by the same reference made from the request's sender id, and named
 *     only through that request's contact.
 *
 * The outcome is derived from rows, never typed: urgent (the urgent screen
 * matched, conversations.urgent, drizzle/0078), handover (escalated to a
 * person otherwise), booked (an appointment came of it), request (a booking
 * request did), answered (anything else). A Meta thread without a request
 * has no outcome stored, so it shows none.
 *
 * Every row carries its "Flag this answer" flag, if staff put one on it
 * (conversation_flags, lib/conversations/flags.ts), with whether its
 * correction is live; the Flagged filter lists only the flagged ones (spec:
 * "Flagged conversations get their own view in the portal so the clinic can
 * see that its corrections landed"). A Meta thread keeps only each person's
 * latest conversation, so a flag on one it has moved on from is listed from
 * the flag's own record, and cannot be opened.
 */

export {
  CHANNEL_NAMES,
  CONVERSATION_OUTCOMES,
  DAY_CHIPS,
  isDayChip,
  OUTCOME_NAMES,
  type ConversationChannel,
  type ConversationOutcome,
  type DayChip,
};

/** What a row's outcome is derived from. */
export type OutcomeFacts = {
  /** conversations.outcome, as the ingest or web chat recorded it. */
  outcome: string | null;
  urgent: boolean;
  /** The booking request it produced, if any. */
  requestId: string | null;
  /** An appointment came of it: the request was confirmed, or the call booked one. */
  booked: boolean;
};

/**
 * Urgent first, because it is what staff must see; then a handover; then
 * what came of it. A conversation that took a request and asked for a person
 * shows the handover, and its booking link beside it.
 */
export function outcomeOf(facts: OutcomeFacts): ConversationOutcome {
  if (facts.urgent) return "urgent";
  if (facts.outcome === "escalated_to_human") return "handover";
  if (facts.booked) return "booked";
  if (facts.requestId) return "request";
  return "answered";
}

// -----------------------------------------------------------------------------
// Search and the day chips
// -----------------------------------------------------------------------------

/**
 * What a search box holds, read: phone digits, or part of a name. Word search
 * is not offered: no words are kept to search.
 */
export type ConversationSearch =
  { kind: "none" } | { kind: "digits"; digits: string } | { kind: "name"; text: string };

/** The fewest digits a phone search takes, and the fewest letters a name search. */
export const MIN_SEARCH_DIGITS = 3;
export const MIN_SEARCH_LETTERS = 2;
const MAX_SEARCH = 80;

/**
 * Digits when the box holds a number as people write one ("415 555-0134",
 * "+1 (415) 555 0134"), otherwise part of a name; "too_short" below the
 * minimum, so one digit does not list everyone.
 */
export function parseSearch(raw: unknown): ConversationSearch | { kind: "too_short" } {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_SEARCH) : "";
  if (!text) return { kind: "none" };
  if (/^[\d\s().+-]+$/.test(text)) {
    const digits = text.replace(/\D/g, "");
    return digits.length >= MIN_SEARCH_DIGITS ? { kind: "digits", digits } : { kind: "too_short" };
  }
  const name = text.replace(/\s+/g, " ");
  return name.replace(/[^\p{L}]/gu, "").length >= MIN_SEARCH_LETTERS
    ? { kind: "name", text: name }
    : { kind: "too_short" };
}

/** A YYYY-MM-DD date moved by whole days, on the calendar, not by 24-hour steps. */
function addLocalDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The clinic-local dates a chip covers, first and last, inclusive. */
export function dayRange(chip: DayChip, now: Date, timeZone: string): { from: string; to: string } {
  const today = clinicLocalDate(now, timeZone);
  if (chip === "today") return { from: today, to: today };
  if (chip === "yesterday") {
    const yesterday = addLocalDays(today, -1);
    return { from: yesterday, to: yesterday };
  }
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const sinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return { from: addLocalDays(today, -sinceMonday), to: today };
}

/** A LIKE pattern matching `text` anywhere, its own wildcards taken literally. */
function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// -----------------------------------------------------------------------------
// The list
// -----------------------------------------------------------------------------

export type ConversationListItem = {
  /** The conversation's id: a call's or web chat's row, or a Meta thread's current conversation. */
  id: string;
  source: "call_or_chat" | "meta_thread";
  channel: ConversationChannel;
  /** ISO. When a call or chat started; a Meta thread's last message. */
  at: string;
  /** Null for a Meta thread with no request: no outcome is stored for one. */
  outcome: ConversationOutcome | null;
  /** The person as the clinic's records name them: the caller's contact, or the request's. */
  callerName: string | null;
  /** E.164. */
  callerPhone: string | null;
  bookingRequestId: string | null;
  /** The practice directed an amendment to this record or its request. */
  amended: boolean;
  /**
   * The call ended unexpectedly (conversations.ended_early_reason,
   * lib/voice/ended-early.ts): marked "Ended early", so staff can call the
   * person back. False for every chat and Meta thread.
   */
  endedEarly: boolean;
  /** Staff's "Flag this answer" on it, and where its correction stands. */
  flag: FlagSummary | null;
  /**
   * It opens: false only for a flagged Meta conversation its thread has moved
   * on from, which the Flagged view lists from the flag's own record.
   */
  openable: boolean;
};

export type ConversationFilter = {
  search?: ConversationSearch;
  day?: DayChip | null;
  /** Only the conversations staff flagged (the Flagged filter). */
  flagged?: boolean;
};

/** How many rows the list shows: the newest first. Records are kept 90 days. */
export const LIST_LIMIT = 100;

const iso = (value: Date | string): string => new Date(value).toISOString();

/** The person a conversation's booking request names, beside the conversation's own contact. */
const requestContact = alias(contacts, "request_contact");

/**
 * A call's or web chat's first booking request, as a lateral subquery: one
 * row per conversation however many requests it produced.
 */
function firstRequest(tx: TenantTx) {
  return tx.db
    .select({
      id: bookingRequests.id,
      status: bookingRequests.status,
      createdAt: bookingRequests.createdAt,
      appointmentId: bookingRequests.appointmentId,
      contactId: bookingRequests.contactId,
    })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.clinicId, conversations.clinicId),
        eq(bookingRequests.conversationId, conversations.id),
      ),
    )
    .orderBy(asc(bookingRequests.createdAt), asc(bookingRequests.id))
    .limit(1)
    .as("first_request");
}

/**
 * Calls and web chats with their person, their first request, whether an
 * appointment came of them and whether an amendment sits on them: the query
 * builder throughout, inside the page's transaction.
 */
async function callRows(tx: TenantTx, where: SQL[], limit: number) {
  const request = firstRequest(tx);
  return tx.db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      startedAt: conversations.startedAt,
      endedAt: conversations.endedAt,
      outcome: conversations.outcome,
      urgent: conversations.urgent,
      endedEarlyReason: conversations.endedEarlyReason,
      contactId: sql<string | null>`coalesce(${contacts.id}, ${requestContact.id})`,
      callerName: sql<string | null>`coalesce(${contacts.fullName}, ${requestContact.fullName})`,
      callerPhone: sql<string | null>`coalesce(${contacts.phone}, ${requestContact.phone})`,
      requestId: request.id,
      requestStatus: request.status,
      requestCreatedAt: request.createdAt,
      requestAppointmentId: request.appointmentId,
      hasAppointment: exists(
        tx.db
          .select({ one: sql`1` })
          .from(appointments)
          .where(
            and(
              eq(appointments.clinicId, conversations.clinicId),
              eq(appointments.conversationId, conversations.id),
            ),
          ),
      ),
      amended: exists(
        tx.db
          .select({ one: sql`1` })
          .from(recordAmendments)
          .where(
            and(
              eq(recordAmendments.clinicId, conversations.clinicId),
              or(
                eq(recordAmendments.conversationId, conversations.id),
                eq(recordAmendments.bookingRequestId, request.id),
              ),
            ),
          ),
      ),
    })
    .from(conversations)
    .leftJoin(
      contacts,
      and(eq(contacts.clinicId, conversations.clinicId), eq(contacts.id, conversations.contactId)),
    )
    .leftJoinLateral(request, sql`true`)
    .leftJoin(
      requestContact,
      and(
        eq(requestContact.clinicId, conversations.clinicId),
        eq(requestContact.id, request.contactId),
      ),
    )
    .where(and(eq(conversations.clinicId, tx.clinicId), ...where))
    .orderBy(desc(conversations.startedAt), desc(conversations.id))
    .limit(limit);
}

type CallRow = Awaited<ReturnType<typeof callRows>>[number];

function callOutcome(row: CallRow): ConversationOutcome {
  return outcomeOf({
    outcome: row.outcome,
    urgent: row.urgent === true,
    requestId: row.requestId,
    booked: row.requestAppointmentId !== null || row.hasAppointment === true,
  });
}

async function callsAndChats(
  tx: TenantTx,
  filter: Required<ConversationFilter>,
  range: { from: string; to: string } | null,
  timeZone: string,
): Promise<ConversationListItem[]> {
  const where: SQL[] = [];
  if (range) {
    where.push(
      sql`(${conversations.startedAt} at time zone ${timeZone})::date between ${range.from}::date and ${range.to}::date`,
    );
  }
  if (filter.flagged) {
    where.push(
      exists(
        tx.db
          .select({ one: sql`1` })
          .from(conversationFlags)
          .where(
            and(
              eq(conversationFlags.clinicId, conversations.clinicId),
              eq(conversationFlags.conversationId, conversations.id),
            ),
          ),
      ),
    );
  }
  const search = filter.search;
  if (search.kind === "digits") {
    const like = containing(search.digits);
    where.push(
      or(
        sql`regexp_replace(coalesce(${contacts.phone}, ''), '[^0-9]', '', 'g') like ${like}`,
        sql`regexp_replace(coalesce(${requestContact.phone}, ''), '[^0-9]', '', 'g') like ${like}`,
      )!,
    );
  } else if (search.kind === "name") {
    const like = containing(search.text);
    where.push(or(ilike(contacts.fullName, like), ilike(requestContact.fullName, like))!);
  }
  const rows = await callRows(tx, where, LIST_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    source: "call_or_chat",
    channel: callChannel(row.channel),
    at: iso(row.startedAt),
    outcome: callOutcome(row),
    callerName: row.callerName,
    callerPhone: row.callerPhone,
    bookingRequestId: row.requestId,
    amended: row.amended === true,
    endedEarly: row.endedEarlyReason !== null,
    flag: null,
    openable: true,
  }));
}

function callChannel(channel: string): ConversationChannel {
  if (channel === "instagram_dm") return "instagram";
  if (channel in CHANNEL_NAMES) return channel as ConversationChannel;
  return "voice";
}

/** Meta's three channels, which keep a thread and no conversations row. */
const META_CHANNELS = ["messenger", "instagram", "whatsapp"] as const;

/** Meta booking requests made a little before their thread's start still belong to it: two clocks write them. */
const THREAD_MATCH_SLACK_MS = 60 * 60 * 1000;

async function threadRows(tx: TenantTx, where: SQL[], limit: number) {
  return tx.db
    .select({
      conversationId: chatThreads.conversationId,
      channel: chatThreads.channel,
      partyRef: chatThreads.partyRef,
      conversationStartedAt: chatThreads.conversationStartedAt,
      lastInboundAt: chatThreads.lastInboundAt,
      conversationsCount: chatThreads.conversationsCount,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.clinicId, tx.clinicId),
        inArray(chatThreads.channel, [...META_CHANNELS]),
        ...where,
      ),
    )
    .orderBy(desc(chatThreads.lastInboundAt), desc(chatThreads.conversationId))
    .limit(limit);
}

async function metaRequestRows(tx: TenantTx, since: Date) {
  return tx.db
    .select({
      id: bookingRequests.id,
      platform: bookingRequests.platform,
      senderId: bookingRequests.senderId,
      createdAt: bookingRequests.createdAt,
      status: bookingRequests.status,
      appointmentId: bookingRequests.appointmentId,
      contactId: bookingRequests.contactId,
      fullName: contacts.fullName,
      phone: contacts.phone,
      amended: exists(
        tx.db
          .select({ one: sql`1` })
          .from(recordAmendments)
          .where(
            and(
              eq(recordAmendments.clinicId, bookingRequests.clinicId),
              eq(recordAmendments.bookingRequestId, bookingRequests.id),
            ),
          ),
      ),
    })
    .from(bookingRequests)
    .innerJoin(
      contacts,
      and(
        eq(contacts.clinicId, bookingRequests.clinicId),
        eq(contacts.id, bookingRequests.contactId),
      ),
    )
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        eq(bookingRequests.channel, "meta"),
        isNotNull(bookingRequests.platform),
        isNotNull(bookingRequests.senderId),
        gte(bookingRequests.createdAt, since),
      ),
    )
    .orderBy(desc(bookingRequests.createdAt), desc(bookingRequests.id));
}

type ThreadRow = Awaited<ReturnType<typeof threadRows>>[number];
type MetaRequestRow = Awaited<ReturnType<typeof metaRequestRows>>[number];

/** A Meta thread with the request its current conversation produced, if any. */
type MatchedThread = { thread: ThreadRow; request: MetaRequestRow | null };

/**
 * The clinic's Meta threads, each with the newest booking request made in
 * its current conversation. The request names the thread by the platform's
 * sender id; the thread holds only the keyed reference of it
 * (identifierRef("chat_party", …), lib/chat/threads.ts), so the reference is
 * made here from the request's id and compared.
 */
async function metaThreads(tx: TenantTx, where: SQL[], limit: number): Promise<MatchedThread[]> {
  const threads = await threadRows(tx, where, limit);
  if (threads.length === 0) return [];
  const earliest = Math.min(...threads.map((t) => t.conversationStartedAt.getTime()));
  const requests = await metaRequestRows(tx, new Date(earliest - THREAD_MATCH_SLACK_MS));
  const byParty = new Map<string, MetaRequestRow[]>();
  for (const request of requests) {
    const ref = identifierRef("chat_party", tx.clinicId, `${request.platform}:${request.senderId}`);
    byParty.set(ref, [...(byParty.get(ref) ?? []), request]);
  }
  return threads.map((thread) => {
    const started = thread.conversationStartedAt.getTime() - THREAD_MATCH_SLACK_MS;
    const request =
      (byParty.get(thread.partyRef) ?? []).find((r) => r.createdAt.getTime() >= started) ?? null;
    return { thread, request };
  });
}

function metaChannel(channel: string): ConversationChannel {
  return (META_CHANNELS as readonly string[]).includes(channel)
    ? (channel as ConversationChannel)
    : "messenger";
}

function threadItem({ thread, request }: MatchedThread): ConversationListItem {
  return {
    id: thread.conversationId,
    source: "meta_thread",
    channel: metaChannel(thread.channel),
    at: iso(thread.lastInboundAt),
    outcome: request ? (request.appointmentId !== null ? "booked" : "request") : null,
    callerName: request?.fullName ?? null,
    callerPhone: request?.phone ?? null,
    bookingRequestId: request?.id ?? null,
    amended: request?.amended === true,
    endedEarly: false,
    flag: null,
    openable: true,
  };
}

/**
 * The Flagged view's Meta rows: each flag on a Meta conversation, as its
 * thread shows it while the thread is still on that conversation, and from
 * the flag's own record (channel, start, outcome; nobody named) once the
 * thread has moved on. Newest flag first.
 */
async function flaggedMetaItems(tx: TenantTx, limit: number): Promise<ConversationListItem[]> {
  const flags = await metaFlags(tx, limit);
  if (flags.length === 0) return [];
  const ids = flags.map((f) => f.threadConversationId!);
  const current = new Map(
    (await metaThreads(tx, [inArray(chatThreads.conversationId, ids)], ids.length)).map((m) => [
      m.thread.conversationId,
      m,
    ]),
  );
  const state = await correctionReader(tx);
  return flags.map((flag): ConversationListItem => {
    const matched = current.get(flag.threadConversationId!);
    if (matched) return { ...threadItem(matched), flag: summaryOf(flag, state) };
    return flagOnlyItem(flag, summaryOf(flag, state));
  });
}

function flagOnlyItem(flag: ConversationFlagRow, summary: FlagSummary): ConversationListItem {
  return {
    id: flag.threadConversationId!,
    source: "meta_thread",
    channel: metaChannel(flag.channel),
    at: iso(flag.conversationStartedAt),
    outcome: flag.outcome ?? null,
    callerName: null,
    callerPhone: null,
    bookingRequestId: null,
    amended: false,
    endedEarly: false,
    flag: summary,
    openable: false,
  };
}

function matchesSearch(item: ConversationListItem, search: ConversationSearch): boolean {
  if (search.kind === "none") return true;
  if (search.kind === "digits")
    return (item.callerPhone ?? "").replace(/\D/g, "").includes(search.digits);
  return (item.callerName ?? "").toLowerCase().includes(search.text.toLowerCase());
}

/** The clinic's own time zone, which the day chips count in, unless the caller has it already. */
export type ListOptions = { timeZone?: string; now?: Date };

async function clinicTimeZone(tx: TenantTx): Promise<string> {
  const [clinic] = await tx.db
    .select({ timeZone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return clinic?.timeZone ?? "America/New_York";
}

/**
 * The list as shown: calls, web chats and Meta threads, newest first, at
 * most LIST_LIMIT, narrowed by a day chip and a search. Reads inside the
 * patient page's transaction; the caller logs it (readConversationList).
 */
export async function listConversations(
  tx: PatientTx,
  filter: ConversationFilter,
  options: ListOptions = {},
): Promise<ConversationListItem[]> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? (await clinicTimeZone(tx));
  const full: Required<ConversationFilter> = {
    search: filter.search ?? { kind: "none" },
    day: filter.day ?? null,
    flagged: filter.flagged === true,
  };
  const range = full.day ? dayRange(full.day, now, timeZone) : null;
  const calls = await callsAndChats(tx, full, range, timeZone);
  let threads: ConversationListItem[];
  if (full.flagged) {
    // The flags first, then their threads: a flag outlives its thread's move
    // to a newer conversation, so the day chip reads the row as shown.
    threads = (await flaggedMetaItems(tx, LIST_LIMIT)).filter(
      (item) =>
        matchesSearch(item, full.search) &&
        (!range ||
          (clinicLocalDate(new Date(item.at), timeZone) >= range.from &&
            clinicLocalDate(new Date(item.at), timeZone) <= range.to)),
    );
  } else {
    const threadWhere = range
      ? [
          sql`(${chatThreads.lastInboundAt} at time zone ${timeZone})::date between ${range.from}::date and ${range.to}::date`,
        ]
      : [];
    // A search reads further back, since a thread is named only through its
    // request, which is matched here rather than in SQL.
    threads = (
      await metaThreads(tx, threadWhere, full.search.kind === "none" ? LIST_LIMIT : 2000)
    )
      .map(threadItem)
      .filter((item) => matchesSearch(item, full.search));
  }
  const rows = [...calls, ...threads]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, LIST_LIMIT);
  return withFlags(tx, rows);
}

/** Each row with its flag, read in one query for the rows as shown. */
async function withFlags(
  tx: TenantTx,
  rows: ConversationListItem[],
): Promise<ConversationListItem[]> {
  const flags = await flagsOn(
    tx,
    rows.filter((r) => r.flag === null).map((r) => r.id),
  );
  return rows.map((row) => (row.flag ? row : { ...row, flag: flags.get(row.id) ?? null }));
}

/**
 * The list behind the step-up, with its access row: one row for the list as
 * shown, naming every conversation on it, and one for the booking requests it
 * links to.
 */
export async function readConversationList(
  page: PatientPage,
  filter: ConversationFilter,
  options: ListOptions = {},
): Promise<ConversationListItem[]> {
  return withPatientPage(page, async (tx) =>
    logList(tx, await listConversations(tx, filter, options)),
  );
}

async function logList(
  tx: PatientTx,
  rows: ConversationListItem[],
): Promise<ConversationListItem[]> {
  await logPatientAccess(tx, {
    action: "read",
    resourceType: "conversation",
    resourceIds: rows.map((r) => r.id),
  });
  const requests = rows.map((r) => r.bookingRequestId).filter((id): id is string => id !== null);
  if (requests.length > 0) {
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "booking_request",
      resourceIds: [...new Set(requests)],
    });
  }
  return rows;
}

// -----------------------------------------------------------------------------
// One conversation
// -----------------------------------------------------------------------------

export type ShownAmendment = Pick<RecordAmendment, "id" | "amendment" | "requestedBy"> & {
  recordedAt: string;
  /** Which record it amends: the conversation, or the booking request it produced. */
  on: "conversation" | "booking_request";
};

export type ConversationDetail = {
  id: string;
  source: "call_or_chat" | "meta_thread";
  channel: ConversationChannel;
  /** ISO. A call's or chat's start; a Meta thread's current conversation's start. */
  startedAt: string;
  /** ISO. When a call or chat ended; a Meta thread's last message. */
  endedAt: string | null;
  outcome: ConversationOutcome | null;
  callerName: string | null;
  callerPhone: string | null;
  /** The contact a per-person export is made for, when the records name one. */
  contactId: string | null;
  request: { id: string; status: string; createdAt: string } | null;
  /** A Meta thread: how many conversations this person has had on the channel. */
  conversationsCount: number | null;
  /** The transcript's delivery: calls and web chats only, and only when one was queued. */
  receipt: (TranscriptReceipt & { id: string }) | null;
  /** "Send again" applies: the copy is still held, and the chat is over. */
  canSendAgain: boolean;
  amendments: ShownAmendment[];
  /** Staff's "Flag this answer" on it, and where its correction stands. */
  flag: FlagSummary | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

async function readCallOrChat(tx: TenantTx, id: string): Promise<ConversationDetail | null> {
  const [row] = await callRows(tx, [eq(conversations.id, id)], 1);
  if (!row) return null;
  const receipt = await transcriptReceiptFor(tx, row.id);
  return {
    id: row.id,
    source: "call_or_chat",
    channel: callChannel(row.channel),
    startedAt: iso(row.startedAt),
    endedAt: row.endedAt ? iso(row.endedAt) : null,
    outcome: callOutcome(row),
    callerName: row.callerName,
    callerPhone: row.callerPhone,
    contactId: row.contactId,
    request:
      row.requestId && row.requestStatus && row.requestCreatedAt
        ? { id: row.requestId, status: row.requestStatus, createdAt: iso(row.requestCreatedAt) }
        : null,
    conversationsCount: null,
    receipt,
    canSendAgain: receipt !== null && canResend(receipt.status),
    amendments: await shownAmendments(tx, row.id, row.requestId),
    flag: (await flagsOn(tx, [row.id])).get(row.id) ?? null,
  };
}

async function readThread(tx: TenantTx, id: string): Promise<ConversationDetail | null> {
  const [matched] = await metaThreads(tx, [eq(chatThreads.conversationId, id)], 1);
  if (!matched) return null;
  const item = threadItem(matched);
  const { thread, request } = matched;
  return {
    id: item.id,
    source: "meta_thread",
    channel: item.channel,
    startedAt: iso(thread.conversationStartedAt),
    endedAt: iso(thread.lastInboundAt),
    outcome: item.outcome,
    callerName: item.callerName,
    callerPhone: item.callerPhone,
    contactId: request?.contactId ?? null,
    request: request
      ? { id: request.id, status: request.status, createdAt: iso(request.createdAt) }
      : null,
    conversationsCount: thread.conversationsCount,
    receipt: null,
    canSendAgain: false,
    amendments: await shownAmendments(tx, null, request?.id ?? null),
    flag: (await flagsOn(tx, [item.id])).get(item.id) ?? null,
  };
}

async function shownAmendments(
  tx: TenantTx,
  conversationId: string | null,
  requestId: string | null,
): Promise<ShownAmendment[]> {
  const shown: ShownAmendment[] = [];
  const add = (on: ShownAmendment["on"], rows: RecordAmendment[] | undefined) => {
    for (const a of rows ?? []) {
      shown.push({
        id: a.id,
        amendment: a.amendment,
        requestedBy: a.requestedBy,
        recordedAt: a.recordedAt.toISOString(),
        on,
      });
    }
  };
  if (conversationId) {
    add(
      "conversation",
      (await amendmentsFor(tx, "conversation", [conversationId])).get(conversationId),
    );
  }
  if (requestId) {
    add(
      "booking_request",
      (await amendmentsFor(tx, "booking_request", [requestId])).get(requestId),
    );
  }
  return shown.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
}

/** One conversation, read inside the page's transaction, or null when this clinic has none by that id. */
export async function findConversation(
  tx: TenantTx,
  id: string,
): Promise<ConversationDetail | null> {
  if (!isConversationId(id)) return null;
  return (await readCallOrChat(tx, id)) ?? (await readThread(tx, id));
}

/** The access rows for one open: the conversation, its receipt and its request, each by id. */
async function logOpened(tx: PatientTx, detail: ConversationDetail): Promise<void> {
  await logPatientAccess(tx, {
    action: "read",
    resourceType: "conversation",
    resourceId: detail.id,
  });
  if (detail.receipt) {
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "transcript_email",
      resourceId: detail.receipt.id,
    });
  }
  if (detail.request) {
    await logPatientAccess(tx, {
      action: "read",
      resourceType: "booking_request",
      resourceId: detail.request.id,
    });
  }
}

/**
 * One conversation behind the step-up, with its access rows. Null for an id
 * this clinic does not hold, another clinic's included: the page answers
 * "not found", and an access row records the attempt by the id asked for.
 */
export async function readConversation(
  page: PatientPage,
  id: string,
): Promise<ConversationDetail | null> {
  if (!isConversationId(id)) return null;
  return withPatientPage(page, async (tx) => {
    const detail = await findConversation(tx, id);
    if (detail) await logOpened(tx, detail);
    else
      await logPatientAccess(tx, { action: "read", resourceType: "conversation", resourceId: id });
    return detail;
  });
}

// -----------------------------------------------------------------------------
// Send again
// -----------------------------------------------------------------------------

export type SendAgainResult =
  | { status: "queued" }
  | { status: "delivered" }
  | { status: "gone" }
  | { status: "open" }
  | { status: "not_found" };

/**
 * "Send again": the transcript goes to the clinic's address once more, from
 * its sealed copy, for as long as the copy lasts (until delivery is
 * confirmed, or its 30 days or 72 hours run out). Behind the step-up, with
 * the access row and the outbox's own row in one transaction. It is queued,
 * as the operator console's resend is: the outbox's every-minute run sends
 * it, so nothing here reaches the database outside withPatientPage. Never
 * another address: the outbox sends only to the clinic's.
 */
export async function sendTranscriptAgain(
  page: PatientPage,
  conversationId: string,
): Promise<SendAgainResult> {
  if (!isConversationId(conversationId)) return { status: "not_found" };
  return withPatientPage(page, async (tx): Promise<SendAgainResult> => {
    const receipt = await transcriptReceiptFor(tx, conversationId);
    // By the receipt's id when there is one; otherwise the attempt, by the conversation asked about.
    await logPatientAccess(
      tx,
      receipt
        ? { action: "read", resourceType: "transcript_email", resourceId: receipt.id }
        : { action: "read", resourceType: "conversation", resourceId: conversationId },
    );
    if (!receipt) return { status: "not_found" };
    if (receipt.status === "delivered") return { status: "delivered" };
    return { status: (await resendTranscriptIn(tx, conversationId)).outcome };
  });
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

export type ExportStanding = {
  /** The account has closed: offboarding has started. */
  closed: boolean;
  /** The records were destroyed: nothing is left to export. */
  destroyed: boolean;
  deliveredAt: Date | null;
  /**
   * Once closed: when the records are deleted if the complete export is
   * downloaded now (a download that arrives in full records the export as
   * delivered), by the rule of the agreement the service ended under.
   */
  deletedFromIfDownloaded: Date | null;
};

/** When a closed clinic's records go if its export is delivered now. */
export function deletionAfterDelivery(
  plan: DestructionPlan,
  deliveredAt: Date | null,
  now: Date,
): Date {
  if (plan.rule === "thirty_days" || deliveredAt) return plan.destroyDueAt;
  return new Date(
    Math.min(plan.latestDestroyAt.getTime(), Math.max(plan.exportDueBy.getTime(), now.getTime())),
  );
}

/** Where the clinic stands for an export: business data, read in the page's own transaction. */
async function exportStandingIn(tx: TenantTx, now: Date): Promise<ExportStanding> {
  const [clinic] = await tx.db
    .select({
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      exportDeliveredAt: clinics.exportDeliveredAt,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic)
    return { closed: false, destroyed: false, deliveredAt: null, deletedFromIfDownloaded: null };
  const plan = clinic.offboardingStartedAt ? await destructionPlanIn(tx) : null;
  return {
    closed: clinic.offboardingStartedAt !== null,
    destroyed: clinic.destroyedAt !== null,
    deliveredAt: clinic.exportDeliveredAt,
    deletedFromIfDownloaded: plan
      ? deletionAfterDelivery(plan, clinic.exportDeliveredAt, now)
      : null,
  };
}

/**
 * The Conversations screen as it first renders: the list (logged as
 * readConversationList logs it) and where the clinic stands for an export,
 * in one transaction behind the step-up, so the page reads nothing outside
 * withPatientPage.
 */
export async function readConversationsScreen(
  page: PatientPage,
  options: ListOptions = {},
): Promise<{ rows: ConversationListItem[]; standing: ExportStanding }> {
  const now = options.now ?? new Date();
  return withPatientPage(page, async (tx) => {
    const rows = await logList(tx, await listConversations(tx, {}, { ...options, now }));
    return { rows, standing: await exportStandingIn(tx, now) };
  });
}

export type ExportResult =
  | {
      ok: true;
      filename: string;
      /** The bundle, as JSON: the same shape the operator's export writes. */
      body: string;
      /**
       * A closed clinic's whole export only: the receipt the browser sends
       * back, with the digest of what it received, so that a download that
       * arrived in full records the export as delivered (confirmClinicExport).
       * Null otherwise: an open account's download, or one person's, is not
       * the export the agreements owe.
       */
      receipt: string | null;
    }
  | { ok: false; reason: "destroyed" | "not_found" | "no_details" | "requester" };

function stamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * The whole clinic's records, as the JSON bundle the operator's export
 * writes (exportClinic): every patient row, every amendment, the access log.
 * Behind the step-up and logged as an export; O4 tells the clinic's address
 * (in the outbox, in this transaction). The bundle is written out in full
 * inside the transaction, so a bundle that cannot be produced whole leaves no
 * row and no email. After cancellation it is the complete export the
 * agreements owe (E4 points here), but producing it records nothing: it
 * carries a receipt, and only the browser's report that the whole file
 * arrived (confirmClinicExport) records it as delivered, which sets the
 * destruction date (lib/offboarding/offboarding.ts).
 */
export async function exportClinicRecords(
  page: PatientPage,
  now: Date = new Date(),
): Promise<ExportResult> {
  return withPatientPage(page, async (tx) => {
    const [clinic] = await tx.db
      .select({
        slug: clinics.slug,
        offboardingStartedAt: clinics.offboardingStartedAt,
        destroyedAt: clinics.destroyedAt,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic || clinic.destroyedAt) {
      // Nothing to export: the attempt is a read that found nothing, not an export.
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "clinic_bundle",
        resourceId: tx.clinicId,
      });
      return { ok: false, reason: clinic ? "destroyed" : "not_found" };
    }
    const bundle = await exportClinic(tx, "practice", "portal_download");
    await logPatientAccess(tx, {
      action: "export",
      resourceType: "clinic_bundle",
      resourceId: tx.clinicId,
    });
    const body = JSON.stringify(bundle, null, 2);
    await notifyRecordsExported(tx, {
      field: "clinic_export",
      exportId: randomUUID(),
      actorLabel: page.stepUp.deviceLabel,
      at: now,
    });
    return {
      ok: true,
      filename: `healdesk-records-${clinic.slug}-${stamp(now)}.json`,
      body,
      receipt: clinic.offboardingStartedAt ? exportReceipt(tx.clinicId, body, now) : null,
    };
  });
}

export type ConfirmExportResult =
  | { ok: true; deliveredAt: Date }
  | { ok: false; reason: "incomplete" | "destroyed" | "open" };

/**
 * The browser has the whole export: `receipt` is the one exportClinicRecords
 * handed it with the file, `digest` the SHA-256 it computed over the file it
 * received. A digest that matches the file the server produced, for this
 * clinic, within the receipt's time, records the export as delivered
 * (markExportDelivered): the stamp the destruction clock reads, once, and
 * only while the clinic is closed and not destroyed. Anything else records
 * nothing: a partial, altered or stale download is not a delivery, and the
 * clinic downloads again. Behind the same step-up, and logged in the access
 * log as the export reaching that device.
 */
export async function confirmClinicExport(
  page: PatientPage,
  receipt: unknown,
  digest: unknown,
  now: Date = new Date(),
): Promise<ConfirmExportResult> {
  if (!receiptMatches(receipt, page.portal.clinicId, digest, now)) {
    return { ok: false, reason: "incomplete" };
  }
  return withPatientPage(page, async (tx) => {
    const [clinic] = await tx.db
      .select({ offboardingStartedAt: clinics.offboardingStartedAt, destroyedAt: clinics.destroyedAt })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic || clinic.destroyedAt || !clinic.offboardingStartedAt) {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "clinic_bundle",
        resourceId: tx.clinicId,
      });
      return { ok: false, reason: clinic && !clinic.destroyedAt ? "open" : "destroyed" };
    }
    await logPatientAccess(tx, {
      action: "export",
      resourceType: "clinic_bundle",
      resourceId: tx.clinicId,
    });
    const deliveredAt = await markExportDelivered(
      tx,
      "downloaded in full by the clinic from Conversations in the portal",
    );
    return { ok: true, deliveredAt };
  });
}

/**
 * One person's records, from a conversation that names them (exportPatient):
 * how a clinic answers that person's request to see what is held. Who asked
 * is chosen from the closed set, never typed. By the conversation's contact
 * id (exportPatient's `contactId`): that contact, and every contact under the
 * same number or address, so every record of theirs is in it, and the
 * conversation's own contact even with neither. Behind the step-up and logged
 * as an export of the contacts it holds; O4 tells the clinic's address. The
 * file is named by the time only, never the person.
 */
export async function exportPersonRecords(
  page: PatientPage,
  conversationId: string,
  requestedBy: unknown,
  now: Date = new Date(),
): Promise<ExportResult> {
  if (!isPatientRequester(requestedBy)) return { ok: false, reason: "requester" };
  const asked: PatientRequester = requestedBy;
  if (!isConversationId(conversationId)) return { ok: false, reason: "not_found" };
  return withPatientPage(page, async (tx) => {
    const detail = await findConversation(tx, conversationId);
    if (!detail?.contactId) {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "conversation",
        resourceId: conversationId,
      });
      return { ok: false, reason: detail ? "no_details" : "not_found" };
    }
    const bundle = await exportPatient(tx, { contactId: detail.contactId, requestedBy: asked });
    await logPatientAccess(tx, {
      action: "export",
      resourceType: "patient_bundle",
      resourceIds: bundle.contacts.map((c) => c.id),
    });
    const body = JSON.stringify(bundle, null, 2);
    await notifyRecordsExported(tx, {
      field: "person_export",
      exportId: randomUUID(),
      actorLabel: page.stepUp.deviceLabel,
      at: now,
    });
    return {
      ok: true,
      filename: `healdesk-person-records-${stamp(now)}.json`,
      body,
      receipt: null,
    };
  });
}

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { clinics, contacts } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import {
  canResend,
  resendTranscriptIn,
  sendQueuedTranscriptNow,
  transcriptReceiptFor,
  type TranscriptReceipt,
  type TranscriptSendOptions,
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
 * produced, any amendment the practice directed (BAA 1.5.0 clause 14(b):
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
 * matched, conversations.urgent, drizzle/0077), handover (escalated to a
 * person otherwise), booked (an appointment came of it), request (a booking
 * request did), answered (anything else). A Meta thread without a request
 * has no outcome stored, so it shows none.
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
};

export type ConversationFilter = { search?: ConversationSearch; day?: DayChip | null };

/** How many rows the list shows: the newest first. Records are kept 90 days. */
export const LIST_LIMIT = 100;

/** Meta booking requests made a little before their thread's start still belong to it: two clocks write them. */
const THREAD_MATCH_SLACK = sql`interval '1 hour'`;

type CallRow = {
  id: string;
  channel: string;
  started_at: Date | string;
  outcome: string | null;
  urgent: boolean;
  caller_name: string | null;
  caller_phone: string | null;
  request_id: string | null;
  booked: boolean;
  amended: boolean;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

async function callsAndChats(
  tx: TenantTx,
  filter: Required<ConversationFilter>,
  range: { from: string; to: string } | null,
  timeZone: string,
): Promise<ConversationListItem[]> {
  const where = [sql`c.clinic_id = ${tx.clinicId}::uuid`];
  if (range) {
    where.push(
      sql`(c.started_at at time zone ${timeZone})::date between ${range.from}::date and ${range.to}::date`,
    );
  }
  const search = filter.search;
  if (search.kind === "digits") {
    const like = containing(search.digits);
    where.push(sql`(regexp_replace(coalesce(ct.phone, ''), '[^0-9]', '', 'g') like ${like}
                    or regexp_replace(coalesce(rc.phone, ''), '[^0-9]', '', 'g') like ${like})`);
  } else if (search.kind === "name") {
    const like = containing(search.text);
    where.push(sql`(ct.full_name ilike ${like} or rc.full_name ilike ${like})`);
  }
  const result = await tx.db.execute<CallRow>(sql`
    select c.id, c.channel::text as channel, c.started_at, c.outcome::text as outcome, c.urgent,
           coalesce(ct.full_name, rc.full_name) as caller_name,
           coalesce(ct.phone, rc.phone) as caller_phone,
           br.id as request_id,
           (br.appointment_id is not null
              or exists (select 1 from appointments a
                          where a.clinic_id = c.clinic_id and a.conversation_id = c.id)) as booked,
           exists (select 1 from record_amendments ra
                    where ra.clinic_id = c.clinic_id
                      and (ra.conversation_id = c.id or ra.booking_request_id = br.id)) as amended
      from conversations c
      left join contacts ct on ct.clinic_id = c.clinic_id and ct.id = c.contact_id
      left join lateral (
        select b.id, b.appointment_id, b.contact_id
          from booking_requests b
         where b.clinic_id = c.clinic_id and b.conversation_id = c.id
         order by b.created_at, b.id
         limit 1
      ) br on true
      left join contacts rc on rc.clinic_id = c.clinic_id and rc.id = br.contact_id
     where ${sql.join(where, sql` and `)}
     order by c.started_at desc, c.id desc
     limit ${LIST_LIMIT}
  `);
  return result.rows.map((row) => ({
    id: row.id,
    source: "call_or_chat",
    channel: callChannel(row.channel),
    at: iso(row.started_at),
    outcome: outcomeOf({
      outcome: row.outcome,
      urgent: row.urgent === true,
      requestId: row.request_id,
      booked: row.booked === true,
    }),
    callerName: row.caller_name,
    callerPhone: row.caller_phone,
    bookingRequestId: row.request_id,
    amended: row.amended === true,
  }));
}

function callChannel(channel: string): ConversationChannel {
  if (channel === "instagram_dm") return "instagram";
  if (channel in CHANNEL_NAMES) return channel as ConversationChannel;
  return "voice";
}

type ThreadRow = {
  conversation_id: string;
  channel: "messenger" | "instagram" | "whatsapp";
  party_ref: string;
  conversation_started_at: Date | string;
  last_inbound_at: Date | string;
  conversations_count: number;
};

type MetaRequestRow = {
  id: string;
  platform: string;
  sender_id: string;
  created_at: Date | string;
  booked: boolean;
  full_name: string | null;
  phone: string | null;
  amended: boolean;
};

/** A Meta thread with the request its current conversation produced, if any. */
type MatchedThread = { thread: ThreadRow; request: MetaRequestRow | null };

/**
 * The clinic's Meta threads, each with the newest booking request made in
 * its current conversation. The request names the thread by the platform's
 * sender id; the thread holds only the keyed reference of it
 * (identifierRef("chat_party", …), lib/chat/threads.ts), so the reference is
 * made here from the request's id and compared.
 */
async function metaThreads(
  tx: TenantTx,
  where: ReturnType<typeof sql>[],
  limit: number,
): Promise<MatchedThread[]> {
  const threads = await tx.db.execute<ThreadRow>(sql`
    select t.conversation_id, t.channel, t.party_ref, t.conversation_started_at,
           t.last_inbound_at, t.conversations_count
      from chat_threads t
     where t.clinic_id = ${tx.clinicId}::uuid
       and t.channel in ('messenger', 'instagram', 'whatsapp')
       ${where.length ? sql`and ${sql.join(where, sql` and `)}` : sql``}
     order by t.last_inbound_at desc, t.conversation_id desc
     limit ${limit}
  `);
  if (threads.rows.length === 0) return [];
  const earliest = threads.rows
    .map((t) => new Date(t.conversation_started_at).getTime())
    .reduce((a, b) => Math.min(a, b));
  const requests = await tx.db.execute<MetaRequestRow>(sql`
    select b.id, b.platform, b.sender_id, b.created_at,
           (b.appointment_id is not null) as booked,
           ct.full_name, ct.phone,
           exists (select 1 from record_amendments ra
                    where ra.clinic_id = b.clinic_id and ra.booking_request_id = b.id) as amended
      from booking_requests b
      join contacts ct on ct.clinic_id = b.clinic_id and ct.id = b.contact_id
     where b.clinic_id = ${tx.clinicId}::uuid
       and b.channel = 'meta' and b.platform is not null and b.sender_id is not null
       and b.created_at >= ${new Date(earliest)}::timestamptz - ${THREAD_MATCH_SLACK}
     order by b.created_at desc, b.id desc
  `);
  const byParty = new Map<string, MetaRequestRow[]>();
  for (const request of requests.rows) {
    const ref = identifierRef(
      "chat_party",
      tx.clinicId,
      `${request.platform}:${request.sender_id}`,
    );
    byParty.set(ref, [...(byParty.get(ref) ?? []), request]);
  }
  const slackMs = 60 * 60 * 1000;
  return threads.rows.map((thread) => {
    const started = new Date(thread.conversation_started_at).getTime() - slackMs;
    const request =
      (byParty.get(thread.party_ref) ?? []).find(
        (r) => new Date(r.created_at).getTime() >= started,
      ) ?? null;
    return { thread, request };
  });
}

function threadItem({ thread, request }: MatchedThread): ConversationListItem {
  return {
    id: thread.conversation_id,
    source: "meta_thread",
    channel: thread.channel,
    at: iso(thread.last_inbound_at),
    outcome: request ? (request.booked ? "booked" : "request") : null,
    callerName: request?.full_name ?? null,
    callerPhone: request?.phone ?? null,
    bookingRequestId: request?.id ?? null,
    amended: request?.amended === true,
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
  };
  const range = full.day ? dayRange(full.day, now, timeZone) : null;
  const calls = await callsAndChats(tx, full, range, timeZone);
  const threadWhere = range
    ? [
        sql`(t.last_inbound_at at time zone ${timeZone})::date between ${range.from}::date and ${range.to}::date`,
      ]
    : [];
  // A search reads further back, since a thread is named only through its
  // request, which is matched here rather than in SQL.
  const threads = (
    await metaThreads(tx, threadWhere, full.search.kind === "none" ? LIST_LIMIT : 2000)
  )
    .map(threadItem)
    .filter((item) => matchesSearch(item, full.search));
  return [...calls, ...threads]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, LIST_LIMIT);
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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

type DetailRow = {
  id: string;
  channel: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  outcome: string | null;
  urgent: boolean;
  contact_id: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  request_id: string | null;
  request_status: string | null;
  request_created_at: Date | string | null;
  booked: boolean;
};

async function readCallOrChat(tx: TenantTx, id: string): Promise<ConversationDetail | null> {
  const result = await tx.db.execute<DetailRow>(sql`
    select c.id, c.channel::text as channel, c.started_at, c.ended_at, c.outcome::text as outcome, c.urgent,
           coalesce(ct.id, rc.id) as contact_id,
           coalesce(ct.full_name, rc.full_name) as caller_name,
           coalesce(ct.phone, rc.phone) as caller_phone,
           br.id as request_id, br.status as request_status, br.created_at as request_created_at,
           (br.appointment_id is not null
              or exists (select 1 from appointments a
                          where a.clinic_id = c.clinic_id and a.conversation_id = c.id)) as booked
      from conversations c
      left join contacts ct on ct.clinic_id = c.clinic_id and ct.id = c.contact_id
      left join lateral (
        select b.id, b.status, b.created_at, b.appointment_id, b.contact_id
          from booking_requests b
         where b.clinic_id = c.clinic_id and b.conversation_id = c.id
         order by b.created_at, b.id
         limit 1
      ) br on true
      left join contacts rc on rc.clinic_id = c.clinic_id and rc.id = br.contact_id
     where c.clinic_id = ${tx.clinicId}::uuid and c.id = ${id}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  const receipt = await transcriptReceiptFor(tx, row.id);
  return {
    id: row.id,
    source: "call_or_chat",
    channel: callChannel(row.channel),
    startedAt: iso(row.started_at),
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    outcome: outcomeOf({
      outcome: row.outcome,
      urgent: row.urgent === true,
      requestId: row.request_id,
      booked: row.booked === true,
    }),
    callerName: row.caller_name,
    callerPhone: row.caller_phone,
    contactId: row.contact_id,
    request:
      row.request_id && row.request_status && row.request_created_at
        ? { id: row.request_id, status: row.request_status, createdAt: iso(row.request_created_at) }
        : null,
    conversationsCount: null,
    receipt,
    canSendAgain: receipt !== null && canResend(receipt.status),
    amendments: await shownAmendments(tx, row.id, row.request_id),
  };
}

async function readThread(tx: TenantTx, id: string): Promise<ConversationDetail | null> {
  const [matched] = await metaThreads(tx, [sql`t.conversation_id = ${id}::uuid`], 1);
  if (!matched) return null;
  const { thread, request } = matched;
  let status: { status: string; contactId: string } | null = null;
  if (request) {
    const found = await tx.db.execute<{ status: string; contact_id: string }>(
      sql`select status, contact_id from booking_requests
           where clinic_id = ${tx.clinicId}::uuid and id = ${request.id}::uuid`,
    );
    const row = found.rows[0];
    status = row ? { status: row.status, contactId: row.contact_id } : null;
  }
  return {
    id: thread.conversation_id,
    source: "meta_thread",
    channel: thread.channel,
    startedAt: iso(thread.conversation_started_at),
    endedAt: iso(thread.last_inbound_at),
    outcome: request ? (request.booked ? "booked" : "request") : null,
    callerName: request?.full_name ?? null,
    callerPhone: request?.phone ?? null,
    contactId: status?.contactId ?? null,
    request:
      request && status
        ? { id: request.id, status: status.status, createdAt: iso(request.created_at) }
        : null,
    conversationsCount: Number(thread.conversations_count),
    receipt: null,
    canSendAgain: false,
    amendments: await shownAmendments(tx, null, request?.id ?? null),
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
  | { status: "sent" }
  | { status: "queued" }
  | { status: "delivered" }
  | { status: "gone" }
  | { status: "open" }
  | { status: "not_found" };

/**
 * "Send again": the transcript goes to the clinic's address once more, from
 * its sealed copy, for as long as the copy lasts (until delivery is
 * confirmed, or its 30 days or 72 hours run out). Behind the step-up, with
 * the access row and the outbox's own row in one transaction; then, after
 * commit, a send straight away if the outbox's job is on (otherwise the next
 * minute's run takes it). Never another address: the outbox sends only to the
 * clinic's.
 */
export async function sendTranscriptAgain(
  page: PatientPage,
  conversationId: string,
  deps: Pick<TranscriptSendOptions, "transport"> = {},
): Promise<SendAgainResult> {
  if (!isConversationId(conversationId)) return { status: "not_found" };
  const done = await withPatientPage(page, async (tx) => {
    const receipt = await transcriptReceiptFor(tx, conversationId);
    // By the receipt's id when there is one; otherwise the attempt, by the conversation asked about.
    await logPatientAccess(
      tx,
      receipt
        ? { action: "read", resourceType: "transcript_email", resourceId: receipt.id }
        : { action: "read", resourceType: "conversation", resourceId: conversationId },
    );
    if (!receipt) return { status: "not_found" as const, id: null };
    if (receipt.status === "delivered") return { status: "delivered" as const, id: null };
    const resent = await resendTranscriptIn(tx, conversationId);
    return { status: resent.outcome, id: resent.id };
  });
  if (done.status !== "queued") return { status: done.status };
  const sent = await sendQueuedTranscriptNow(page.portal.clinicId, done.id, deps);
  return sent === "sent" ? { status: "sent" } : { status: "queued" };
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
   * downloaded now (a download records the export as delivered), by the rule
   * of the agreement the service ended under.
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
      /** Set when this download recorded a closed clinic's export as delivered. */
      deliveredAt: Date | null;
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
 * agreements owe, so this download records it as delivered
 * (markExportDelivered), which sets the destruction date
 * (lib/offboarding/offboarding.ts).
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
    const deliveredAt = clinic.offboardingStartedAt
      ? await markExportDelivered(tx, "downloaded by the clinic from Conversations in the portal")
      : null;
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
      deliveredAt,
    };
  });
}

/**
 * One person's records, from a conversation that names them (exportPatient):
 * how a clinic answers that person's request to see what is held. Who asked
 * is chosen from the closed set, never typed. Found by the contact's number
 * and address, so every record under the same details is in it. Behind the
 * step-up and logged as an export of the contacts it holds; O4 tells the
 * clinic's address. The file is named by the time only, never the person.
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
    const contact = detail?.contactId
      ? (
          await tx.db
            .select({ id: contacts.id, phone: contacts.phone, email: contacts.email })
            .from(contacts)
            .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, detail.contactId)))
            .limit(1)
        )[0]
      : undefined;
    if (!detail || !contact || (!contact.phone && !contact.email)) {
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "conversation",
        resourceId: conversationId,
      });
      return { ok: false, reason: detail ? "no_details" : "not_found" };
    }
    const bundle = await exportPatient(tx, {
      ...(contact.phone ? { phone: contact.phone } : {}),
      ...(contact.email ? { email: contact.email } : {}),
      requestedBy: asked,
    });
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
      deliveredAt: null,
    };
  });
}

import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";

import { answerOutages, missCases, missedContacts } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { printRef } from "@/lib/support/case-vocab";
import { withTenant } from "@/lib/tenant";

import { MISS_CASE_STATUSES, type MissCaseStatus } from "./routed-words";

/**
 * The records behind the counter's notices, as /admin's Queues › Misses and
 * outages reads and moves them (lib/channels/answer-notices.ts opens both;
 * docs/design/launch-readiness-2026-10-27/gate-b-notice-workflows.md):
 *
 *   - `listAnswerCases`: every outage incident and every miss case, open
 *     first, as ids, channel ids, counts, days and times, each clinic read in
 *     its own tenant. Never a caller, a number or a word.
 *   - `setMissCaseStatus`: the owner's move of a miss case (open, looking,
 *     explained, closed). Closed is final: a new miss opens a new case.
 *   - `linkMissCaseReply`: the support inbound path's hook (lib/support/
 *     inbound/handle.ts): a reply carrying a miss case's ref joins the case
 *     to the support case it opened or joined, once.
 */

const MAX_LISTED = 200;

export type OutageView = {
  outageId: string;
  clinicId: string;
  clinicSlug: string;
  status: "open" | "closed";
  channels: string[];
  startedAt: string;
  lastFailureAt: string;
  openedAt: string;
  replyByAt: string;
  escalations: number;
  endedAt: string | null;
  callCount: number | null;
  chatCount: number | null;
};

export type MissCaseView = {
  caseId: string;
  clinicId: string;
  clinicSlug: string;
  ref: string;
  channel: string;
  missedOn: string;
  firstMissedAt: string;
  missCount: number;
  status: MissCaseStatus;
  openedAt: string;
  replyByOn: string;
  statusAt: string;
  /** Whether the clinic has replied: its reply is a support case in Queues › Support. */
  replied: boolean;
};

export type AnswerCases = { outages: OutageView[]; missCases: MissCaseView[]; unreadClinics: number };

export async function listAnswerCases(actor: ActorContext, request?: RequestContext): Promise<AnswerCases> {
  const out: AnswerCases = { outages: [], missCases: [], unreadClinics: 0 };
  for (const clinic of await listClinics()) {
    try {
      const rows = await withTenant({ clinicId: clinic.id, actor, request }, async (tx) => ({
        outages: await tx.db
          .select()
          .from(answerOutages)
          .where(eq(answerOutages.clinicId, tx.clinicId))
          .orderBy(desc(answerOutages.openedAt))
          .limit(MAX_LISTED),
        cases: await tx.db
          .select()
          .from(missCases)
          .where(eq(missCases.clinicId, tx.clinicId))
          .orderBy(desc(missCases.openedAt))
          .limit(MAX_LISTED),
      }));
      for (const o of rows.outages) {
        out.outages.push({
          outageId: o.id,
          clinicId: o.clinicId,
          clinicSlug: clinic.slug,
          status: o.status,
          channels: [...o.channels],
          startedAt: o.startedAt.toISOString(),
          lastFailureAt: o.lastFailureAt.toISOString(),
          openedAt: o.openedAt.toISOString(),
          replyByAt: o.replyByAt.toISOString(),
          escalations: o.escalations,
          endedAt: o.endedAt?.toISOString() ?? null,
          callCount: o.callCount,
          chatCount: o.chatCount,
        });
      }
      for (const m of rows.cases) {
        out.missCases.push({
          caseId: m.id,
          clinicId: m.clinicId,
          clinicSlug: clinic.slug,
          ref: printRef(m.ref),
          channel: m.channel,
          missedOn: m.missedOn,
          firstMissedAt: m.firstMissedAt.toISOString(),
          missCount: m.missCount,
          status: m.status,
          openedAt: m.openedAt.toISOString(),
          replyByOn: m.replyByOn,
          statusAt: m.statusAt.toISOString(),
          replied: m.supportCaseId !== null,
        });
      }
    } catch (error) {
      out.unreadClinics += 1;
      log.error("answer cases not read", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  out.outages.sort((a, b) =>
    a.status !== b.status ? (a.status === "open" ? -1 : 1) : b.openedAt.localeCompare(a.openedAt),
  );
  out.missCases.sort((a, b) =>
    (a.status === "closed") !== (b.status === "closed") ? (a.status === "closed" ? 1 : -1) : b.openedAt.localeCompare(a.openedAt),
  );
  out.outages = out.outages.slice(0, MAX_LISTED);
  out.missCases = out.missCases.slice(0, MAX_LISTED);
  return out;
}

export function isMissCaseStatus(value: unknown): value is MissCaseStatus {
  return typeof value === "string" && (MISS_CASE_STATUSES as readonly string[]).includes(value);
}

export type MissCaseMove = { status: "moved" | "already" | "closed" | "not_found" | "bad_note" };

/** The longest closing note: one or two short lines. */
export const CLOSING_NOTE_MAX = 280;

/**
 * The owner's closing note, as the clinic will read it in the portal: one
 * or two plain lines, never emailed. Null when it is not one (empty, too
 * long, an address, a link or markup), which the database's check refuses
 * too (missed_contacts_note_check).
 */
export function closingNoteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.replace(/\s+/g, " ").trim();
  if (note.length === 0 || note.length > CLOSING_NOTE_MAX) return null;
  if (/[@<>]|https?:|www\./i.test(note)) return null;
  return note;
}

/**
 * The owner's move of one miss case. A closed case stays closed. Marking it
 * explained may carry the closing note, which every missed contact of the
 * case then shows the clinic, at whichever of the practice's locations it is.
 */
export async function setMissCaseStatus(
  clinicId: string,
  caseId: string,
  status: MissCaseStatus,
  actor: ActorContext,
  options: { note?: unknown; now?: Date } = {},
): Promise<MissCaseMove> {
  const now = options.now ?? new Date();
  const hasNote = options.note !== undefined && options.note !== null && options.note !== "";
  const note = hasNote ? closingNoteOf(options.note) : null;
  if (hasNote && (note === null || status !== "explained")) return { status: "bad_note" };
  const moved = await withTenant({ clinicId, actor }, async (tx): Promise<MissCaseMove> => {
    const [row] = await tx.db
      .select({ status: missCases.status })
      .from(missCases)
      .where(and(eq(missCases.id, caseId), eq(missCases.clinicId, tx.clinicId)))
      .limit(1);
    if (!row) return { status: "not_found" };
    if (row.status === "closed") return { status: "closed" };
    if (row.status === status && !note) return { status: "already" };
    await tx.db
      .update(missCases)
      .set({ status, statusAt: now, closedAt: status === "closed" ? now : null })
      .where(and(eq(missCases.id, caseId), eq(missCases.clinicId, tx.clinicId), ne(missCases.status, "closed")));
    tx.audit.record({ action: "update", resourceType: "miss_case", resourceId: caseId, metadata: { status, note: note ? "set" : "none" } });
    return { status: "moved" };
  });
  if (moved.status === "moved" && note) {
    // The case's missed contacts, at the practice's billing clinic and each location.
    const practice = (await listClinics()).filter((c) => c.id === clinicId || c.billingClinicId === clinicId);
    for (const location of practice) {
      await withTenant({ clinicId: location.id, actor }, (tx) =>
        tx.db
          .update(missedContacts)
          .set({ closingNote: note })
          .where(and(eq(missedContacts.clinicId, tx.clinicId), eq(missedContacts.missCaseId, caseId))),
      );
    }
  }
  return moved;
}

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "support-inbound" };

/**
 * A reply to L21: its subject is the email's, "Looking into a call from
 * Monday 5 October" (email/templates/guarantee_miss.ts), behind the clinic's
 * mail program's "Re:". The noun and the words after "from"; null for any
 * other subject.
 */
export function missReplyOf(subject: string): { noun: "call" | "message"; when: string } | null {
  const m = /\blooking into a (call|message) from (.{3,60})$/i.exec(subject.trim());
  if (!m) return null;
  return { noun: m[1]!.toLowerCase() as "call" | "message", when: m[2]!.toLowerCase() };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "5 october", from a case's YYYY-MM-DD day, as L21's subject prints it (without the weekday or a year). */
function dayPhrase(missedOn: string): string {
  const [, month, day] = missedOn.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]}`;
}

/** How far back a reply may be to a miss: a month and a little. */
const REPLY_WINDOW_DAYS = 40;

/**
 * The open miss case of `clinicId` a reply to L21 is about: its channel by
 * the subject's noun (a call is phone; a message website chat or Meta), its
 * day by the subject's day, the newest first; failing the day, the newest
 * open case of the channel. Null when the subject is not a reply to L21 or
 * the clinic has no such case.
 */
async function missCaseForReply(
  tx: { db: import("@/db").Transaction; clinicId: string },
  subject: string,
  now: Date,
): Promise<{ id: string; supportCaseId: string | null } | null> {
  const reply = missReplyOf(subject);
  if (!reply) return null;
  const since = new Date(now.getTime() - REPLY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await tx.db
    .select({ id: missCases.id, missedOn: missCases.missedOn, supportCaseId: missCases.supportCaseId })
    .from(missCases)
    .where(
      and(
        eq(missCases.clinicId, tx.clinicId),
        ne(missCases.status, "closed"),
        inArray(missCases.channel, reply.noun === "call" ? ["voice"] : ["web", "meta"]),
        gte(missCases.missedOn, since),
      ),
    )
    .orderBy(desc(missCases.missedOn), desc(missCases.openedAt));
  const onTheDay = rows.find((r) => new RegExp(`\\b${dayPhrase(r.missedOn)}\\b`).test(reply.when));
  const found = onTheDay ?? rows[0];
  return found ? { id: found.id, supportCaseId: found.supportCaseId } : null;
}

/**
 * The open support case an earlier reply to the same L21 opened, so a
 * second reply joins it rather than opening another (lib/support/inbound/
 * handle.ts). Null when there is none.
 */
export async function supportCaseIdForMissReply(clinicId: string, subject: string, now: Date = new Date()): Promise<string | null> {
  if (!missReplyOf(subject)) return null;
  return withTenant({ clinicId, actor: LINK_ACTOR }, async (tx) => (await missCaseForReply(tx, subject, now))?.supportCaseId ?? null);
}

/**
 * A reply to L21, recorded on `supportCaseId` for the clinic `clinicId`: the
 * miss case it is about takes the support case, if it has none yet. Returns
 * how many it joined (0 or 1).
 */
export async function linkMissCaseReply(
  clinicId: string,
  subject: string,
  supportCaseId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!missReplyOf(subject)) return 0;
  return withTenant({ clinicId, actor: LINK_ACTOR }, async (tx) => {
    const found = await missCaseForReply(tx, subject, now);
    if (!found || found.supportCaseId) return 0;
    const rows = await tx.db
      .update(missCases)
      .set({ supportCaseId })
      .where(and(eq(missCases.clinicId, tx.clinicId), eq(missCases.id, found.id), isNull(missCases.supportCaseId)))
      .returning({ id: missCases.id });
    return rows.length;
  });
}

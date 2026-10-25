import { randomInt } from "node:crypto";

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { supportCases, supportMessages, type SupportCase } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import { describeError, log } from "@/lib/log";
import { replyByPassed } from "@/lib/reply-by";
import { withTenant } from "@/lib/tenant";

import {
  canMove,
  moreUrgent,
  NEEDS_US_STATES,
  printRef,
  SUPPORT_REF_ALPHABET,
  SUPPORT_REF_LENGTH,
  urgencyFor,
  type SupportCaseSource,
  type SupportCaseState,
  type SupportCaseUrgency,
  type SupportClosedReason,
  type SupportMessageDirection,
  type SupportMessageKind,
} from "./case-vocab";
import type { EscalationFields } from "./escalation-fields";

/**
 * The support team's cases (ops automation Phase 7, lane P7a; design E5
 * §2.2): the record every request becomes, with a state and a reply-by day,
 * so the owner works from a list of cases instead of a mailbox. Lanes P7b
 * (the drafter) and P7c (the send path and the console) build on what is
 * exported here.
 *
 * ## A chat escalation, as a case
 *
 * `recordChatEscalation` is called by escalate_to_support once I3 has
 * reached hello@ (lib/support/escalate.ts). It stores the escalation's
 * request id and its fields, which are ids from fixed lists: never a word of
 * the chat (the tables' CHECKs hold that too). The rule for a second one:
 *
 *   - the same request id again (a retried call) is the same case and the
 *     same message, unchanged: `already_recorded`;
 *   - otherwise, while the clinic has an OPEN chat case on the same topic,
 *     the escalation joins it as a new message: `joined`. Its urgency is the
 *     more urgent of the two; a case that was waiting on the clinic or
 *     snoozed comes back to `new`, because the clinic needs us again; and the
 *     reply-by day stays the earliest promise still owed, or becomes the new
 *     L25's day when the case was waiting on the clinic (we had replied, so
 *     the old promise was kept);
 *   - otherwise a new case: `opened`. A partial unique index allows one open
 *     chat case per clinic and topic, so two escalations racing each other
 *     cannot open two: the loser joins the winner's.
 *
 * A different topic is a different case: "calls ring out" and "an invoice
 * question" are two things to answer, each with its own reply.
 *
 * ## Writes
 *
 * Every write that names a clinic runs in that clinic's tenant: the table is
 * platform-wide (no RLS) so the console can list across clinics, and its
 * guard refuses a clinic it cannot see from the tenant, or one that has
 * left. The operator's moves (snooze, assign, match, close) check the case's
 * state first (SUPPORT_CASE_MOVES) and write with a compare-and-set on it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** How many times a new case tries another ref after a collision. */
const REF_TRIES = 6;

/** A fresh ref: five characters of Crockford base32, from the CSPRNG. */
export function newSupportRef(pick: (max: number) => number = randomInt): string {
  let ref = "";
  for (let i = 0; i < SUPPORT_REF_LENGTH; i += 1) {
    ref += SUPPORT_REF_ALPHABET[pick(SUPPORT_REF_ALPHABET.length)];
  }
  return ref;
}

function pgErrorOf(error: unknown): { code?: string; constraint?: string } {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return {};
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") {
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

function isUnique(error: unknown, constraint: string): boolean {
  const pg = pgErrorOf(error);
  return pg.code === "23505" && pg.constraint === constraint;
}

// -----------------------------------------------------------------------------
// The chat's hand-off
// -----------------------------------------------------------------------------

export type ChatCaseOutcome = {
  outcome: "opened" | "joined" | "already_recorded";
  caseId: string;
  ref: string;
};

/** A chat escalation's fields as the message keeps them: ids from fixed lists, nulls for what does not apply. */
export function escalationFieldsJson(fields: EscalationFields): Record<string, string | null> {
  return {
    topic: fields.topic,
    symptom: fields.symptom,
    carrier: fields.carrier,
    phoneSystem: fields.phoneSystem,
    mode: fields.mode,
    channel: fields.channel,
  };
}

/**
 * Record one chat escalation as a case (see the header for the rule), in the
 * clinic's tenant. Idempotent per request id. Throws on a database failure:
 * the caller decides what that means for the escalation.
 */
export async function recordChatEscalation(input: {
  clinicId: string;
  actor: ActorContext;
  requestId: string;
  fields: EscalationFields;
  /** L25's day: replyByDay(now). */
  replyByOn: string;
  now: Date;
}): Promise<ChatCaseOutcome> {
  // Two tries: the second runs only when another escalation opened the
  // clinic's case on this topic between our look and our insert.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
        recordIn(tx.db, input),
      );
    } catch (error) {
      if (attempt === 0 && isUnique(error, "support_cases_open_chat_key")) continue;
      throw error;
    }
  }
  throw new Error("unreachable");
}

async function recordIn(
  db: Transaction,
  input: { clinicId: string; requestId: string; fields: EscalationFields; replyByOn: string; now: Date },
): Promise<ChatCaseOutcome> {
  const [seen] = await db
    .select({ caseId: supportMessages.caseId, ref: supportCases.ref })
    .from(supportMessages)
    .innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId))
    .where(eq(supportMessages.requestId, input.requestId))
    .limit(1);
  if (seen) return { outcome: "already_recorded", caseId: seen.caseId, ref: seen.ref };

  const urgency = urgencyFor(input.fields.topic, input.fields.symptom);
  const [open] = await db
    .select()
    .from(supportCases)
    .where(
      and(
        eq(supportCases.subjectClinicId, input.clinicId),
        eq(supportCases.source, "chat"),
        eq(supportCases.category, input.fields.topic),
        ne(supportCases.state, "closed"),
      ),
    )
    .limit(1)
    .for("update");

  let caseId: string;
  let ref: string;
  let outcome: ChatCaseOutcome["outcome"];
  if (open) {
    const comesBack = open.state === "waiting_clinic" || open.state === "snoozed";
    await db
      .update(supportCases)
      .set({
        urgency: moreUrgent(open.urgency, urgency),
        lastInboundAt: input.now,
        updatedAt: input.now,
        ...(comesBack ? { state: "new" as const, snoozedUntil: null } : {}),
        ...(open.state === "waiting_clinic" ? { replyByOn: input.replyByOn } : {}),
      })
      .where(eq(supportCases.id, open.id));
    caseId = open.id;
    ref = open.ref;
    outcome = "joined";
  } else {
    const opened = await insertCase(db, {
      subjectClinicId: input.clinicId,
      source: "chat",
      category: input.fields.topic,
      symptom: input.fields.symptom,
      urgency,
      replyByOn: input.replyByOn,
      now: input.now,
    });
    caseId = opened.id;
    ref = opened.ref;
    outcome = "opened";
  }

  await db.insert(supportMessages).values({
    caseId,
    direction: "in",
    kind: "chat_escalation",
    requestId: input.requestId,
    fieldsJson: escalationFieldsJson(input.fields),
    receivedAt: input.now,
    createdAt: input.now,
  });
  return { outcome, caseId, ref };
}

/**
 * Insert a new case with a fresh ref, retrying another ref on a collision
 * (each try in its own savepoint, since a unique violation aborts the
 * transaction). For lane P7c's inbound slice too.
 */
export async function insertCase(
  db: Transaction,
  input: {
    subjectClinicId: string | null;
    source: SupportCaseSource;
    category: string;
    symptom: string;
    urgency: SupportCaseUrgency;
    replyByOn: string;
    now: Date;
    newRef?: () => string;
  },
): Promise<{ id: string; ref: string }> {
  const next = input.newRef ?? (() => newSupportRef());
  for (let attempt = 1; ; attempt += 1) {
    const ref = next();
    try {
      return await db.transaction(async (sp) => {
        const [row] = await sp
          .insert(supportCases)
          .values({
            ref,
            subjectClinicId: input.subjectClinicId,
            source: input.source,
            category: input.category,
            symptom: input.symptom,
            urgency: input.urgency,
            replyByOn: input.replyByOn,
            openedAt: input.now,
            lastInboundAt: input.now,
            updatedAt: input.now,
          })
          .returning({ id: supportCases.id, ref: supportCases.ref });
        return row!;
      });
    } catch (error) {
      if (attempt < REF_TRIES && isUnique(error, "support_cases_ref_key")) continue;
      throw error;
    }
  }
}

// -----------------------------------------------------------------------------
// Reading, for the console (lib/ops/support-case-ops.ts)
// -----------------------------------------------------------------------------

export const SUPPORT_CASES_LIST_MAX = 200;

export type SupportCaseFilter = SupportCaseState | "open" | "needs_us" | "all";

export type SupportCaseRow = {
  id: string;
  /** Printed: "HD-7F3KQ". */
  ref: string;
  clinicId: string | null;
  clinicName: string | null;
  source: SupportCaseSource;
  category: string;
  symptom: string;
  urgency: SupportCaseUrgency;
  state: SupportCaseState;
  assigneeLabel: string | null;
  openedAt: string;
  /** Whole hours since it opened. */
  ageHours: number;
  replyByOn: string;
  /** The reply-by day has passed in New York while the case still needs us. */
  pastDue: boolean;
  snoozedUntil: string | null;
  lastInboundAt: string;
  lastOutboundAt: string | null;
  closedAt: string | null;
  closedReason: SupportClosedReason | null;
  phiSuspected: boolean;
  hidden: { numbers: number; emails: number; treatments: number; clinical: number };
  /** How many escalations or emails came in on it. */
  inboundCount: number;
};

function rowOf(
  c: SupportCase,
  names: Map<string, string | null>,
  inbound: Map<string, number>,
  now: Date,
): SupportCaseRow {
  return {
    id: c.id,
    ref: printRef(c.ref),
    clinicId: c.subjectClinicId,
    clinicName: c.subjectClinicId ? (names.get(c.subjectClinicId) ?? null) : null,
    source: c.source,
    category: c.category,
    symptom: c.symptom,
    urgency: c.urgency,
    state: c.state,
    assigneeLabel: c.assigneeLabel,
    openedAt: c.openedAt.toISOString(),
    ageHours: Math.max(0, Math.floor((now.getTime() - c.openedAt.getTime()) / HOUR_MS)),
    replyByOn: c.replyByOn,
    pastDue: NEEDS_US_STATES.includes(c.state) && replyByPassed(c.replyByOn, now),
    snoozedUntil: c.snoozedUntil ? c.snoozedUntil.toISOString() : null,
    lastInboundAt: c.lastInboundAt.toISOString(),
    lastOutboundAt: c.lastOutboundAt ? c.lastOutboundAt.toISOString() : null,
    closedAt: c.closedAt ? c.closedAt.toISOString() : null,
    closedReason: c.closedReason,
    phiSuspected: c.phiSuspected,
    hidden: {
      numbers: c.hiddenNumbers,
      emails: c.hiddenEmails,
      treatments: c.hiddenTreatments,
      clinical: c.clinicalMatches,
    },
    inboundCount: inbound.get(c.id) ?? 0,
  };
}

async function clinicNames(): Promise<Map<string, string | null>> {
  const result = await unsafeDb.execute<{ id: string; name: string | null }>(
    sql`select id, name from app_clinics_overview()`,
  );
  return new Map(result.rows.map((r) => [String(r.id), r.name ?? null]));
}

async function inboundCounts(caseIds: string[]): Promise<Map<string, number>> {
  if (caseIds.length === 0) return new Map();
  const rows = await unsafeDb
    .select({ caseId: supportMessages.caseId, n: sql<number>`count(*)::int` })
    .from(supportMessages)
    .where(and(inArray(supportMessages.caseId, caseIds), eq(supportMessages.direction, "in")))
    .groupBy(supportMessages.caseId);
  return new Map(rows.map((r) => [r.caseId, Number(r.n)]));
}

/** Which of these clinics are demo clinics (app_clinic_is_demo is an invoker: one tenant read each). */
async function demoClinics(clinicIds: string[], actor: ActorContext): Promise<Set<string>> {
  const demo = new Set<string>();
  for (const clinicId of clinicIds) {
    try {
      if (await withTenant({ clinicId, actor }, (tx) => isDemoClinic(tx))) demo.add(clinicId);
    } catch (error) {
      log.warn("support case clinic not read", { clinicId, error: describeError(error) });
    }
  }
  return demo;
}

/**
 * The cases for the console, most urgent work first: the ones that need us
 * by reply-by day, then the rest newest first. `open` is every state but
 * closed; `needs_us` is new, drafting, drafted and needs_edit. Closed cases
 * are listed for 30 days. Cases of demo clinics only when asked.
 */
export async function listSupportCases(options: {
  filter: SupportCaseFilter;
  limit: number;
  includeDemo: boolean;
  actor: ActorContext;
  now: Date;
}): Promise<{ rows: SupportCaseRow[]; count: number; truncated: boolean }> {
  const closedSince = new Date(options.now.getTime() - 30 * DAY_MS);
  const where =
    options.filter === "all"
      ? sql`(${supportCases.state} <> 'closed' or ${supportCases.closedAt} > ${closedSince})`
      : options.filter === "open"
        ? ne(supportCases.state, "closed")
        : options.filter === "needs_us"
          ? inArray(supportCases.state, [...NEEDS_US_STATES])
          : options.filter === "closed"
            ? and(eq(supportCases.state, "closed"), sql`${supportCases.closedAt} > ${closedSince}`)
            : eq(supportCases.state, options.filter);
  const cases = await unsafeDb
    .select()
    .from(supportCases)
    .where(where)
    .orderBy(
      sql`case when ${supportCases.state} in ('new', 'drafting', 'drafted', 'needs_edit') then 0 else 1 end`,
      sql`case ${supportCases.urgency} when 'now' then 0 when 'today' then 1 else 2 end`,
      asc(supportCases.replyByOn),
      desc(supportCases.openedAt),
      asc(supportCases.id),
    )
    .limit(SUPPORT_CASES_LIST_MAX * 2);

  let kept = cases;
  if (!options.includeDemo) {
    const clinics = [...new Set(cases.map((c) => c.subjectClinicId).filter((id): id is string => id !== null))];
    const demo = await demoClinics(clinics, options.actor);
    kept = cases.filter((c) => !c.subjectClinicId || !demo.has(c.subjectClinicId));
  }
  const page = kept.slice(0, options.limit);
  const [names, inbound] = await Promise.all([clinicNames(), inboundCounts(page.map((c) => c.id))]);
  return {
    rows: page.map((c) => rowOf(c, names, inbound, options.now)),
    count: page.length,
    // Also when the fetch itself hit its cap: demo cases left out may have hidden real ones further down.
    truncated: kept.length > options.limit || cases.length === SUPPORT_CASES_LIST_MAX * 2,
  };
}

export type SupportMessageRow = {
  id: string;
  direction: SupportMessageDirection;
  kind: SupportMessageKind;
  at: string;
  /** A chat escalation's fields (ids from fixed lists); null on every other kind. */
  fields: Record<string, string | null> | null;
  /** Whether a draft or an approved text is on it, never the text (lanes P7b, P7c). */
  hasDraft: boolean;
  draftVersion: number | null;
  approvedAt: string | null;
  sentAt: string | null;
};

/** One case and what passed on it, without a word of text. Null when there is no such case. */
export async function readSupportCase(
  caseId: string,
  now: Date,
): Promise<{ row: SupportCaseRow; messages: SupportMessageRow[] } | null> {
  const [c] = await unsafeDb.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1);
  if (!c) return null;
  const messages = await unsafeDb
    .select({
      id: supportMessages.id,
      direction: supportMessages.direction,
      kind: supportMessages.kind,
      createdAt: supportMessages.createdAt,
      fieldsJson: supportMessages.fieldsJson,
      draftVersion: supportMessages.draftVersion,
      approvedAt: supportMessages.approvedAt,
      sentAt: supportMessages.sentAt,
    })
    .from(supportMessages)
    .where(eq(supportMessages.caseId, caseId))
    .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
  const names = await clinicNames();
  const inbound = new Map([[c.id, messages.filter((m) => m.direction === "in").length]]);
  return {
    row: rowOf(c, names, inbound, now),
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      kind: m.kind,
      at: m.createdAt.toISOString(),
      fields: m.kind === "chat_escalation" ? (m.fieldsJson ?? null) : null,
      hasDraft: m.draftVersion !== null,
      draftVersion: m.draftVersion,
      approvedAt: m.approvedAt ? m.approvedAt.toISOString() : null,
      sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    })),
  };
}

// -----------------------------------------------------------------------------
// The operator's moves
// -----------------------------------------------------------------------------

export type CaseMoveOutcome =
  | { outcome: "done"; ref: string; clinicId: string | null; from: SupportCaseState; to: SupportCaseState }
  | { outcome: "unchanged"; ref: string; clinicId: string | null; state: SupportCaseState }
  | { outcome: "not_found" }
  | { outcome: "closed"; ref: string }
  | { outcome: "not_allowed"; ref: string; state: SupportCaseState };

/** Read the case FOR UPDATE, decide, write: one transaction, so two operators cannot both move it. */
async function move(
  caseId: string,
  decide: (c: SupportCase) =>
    | { write: Partial<typeof supportCases.$inferInsert>; to: SupportCaseState }
    | { unchanged: true }
    | { refuse: true },
): Promise<CaseMoveOutcome> {
  return unsafeDb.transaction(async (tx) => {
    const [c] = await tx.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1).for("update");
    if (!c) return { outcome: "not_found" as const };
    if (c.state === "closed") return { outcome: "closed" as const, ref: printRef(c.ref) };
    const decision = decide(c);
    if ("refuse" in decision) return { outcome: "not_allowed" as const, ref: printRef(c.ref), state: c.state };
    if ("unchanged" in decision) {
      return { outcome: "unchanged" as const, ref: printRef(c.ref), clinicId: c.subjectClinicId, state: c.state };
    }
    if (decision.to !== c.state && !canMove(c.state, decision.to)) {
      return { outcome: "not_allowed" as const, ref: printRef(c.ref), state: c.state };
    }
    await tx
      .update(supportCases)
      .set(decision.write)
      .where(and(eq(supportCases.id, c.id), eq(supportCases.state, c.state)));
    return { outcome: "done" as const, ref: printRef(c.ref), clinicId: c.subjectClinicId, from: c.state, to: decision.to };
  });
}

/** Put a case aside until `until`; a snoozed case may be snoozed again to a new time. */
export function snoozeSupportCase(caseId: string, until: Date, now: Date): Promise<CaseMoveOutcome> {
  return move(caseId, () => ({
    to: "snoozed",
    write: { state: "snoozed", snoozedUntil: until, updatedAt: now },
  }));
}

/** Give a case to a name from HEALDESK_OPS_PEOPLE (a label; v1 has one operator sign-in). */
export function assignSupportCase(caseId: string, label: string, now: Date): Promise<CaseMoveOutcome> {
  return move(caseId, (c) =>
    c.assigneeLabel === label ? { unchanged: true } : { to: c.state, write: { assigneeLabel: label, updatedAt: now } },
  );
}

/**
 * Close a case, with its reason. The inbound text's deletion day is set now
 * (30 days after close, 7 when phi_suspected; the sweep is follow-up S7);
 * a chat case holds no text, so its day is set all the same and finds none.
 */
export async function closeSupportCase(caseId: string, reason: SupportClosedReason, now: Date): Promise<CaseMoveOutcome> {
  const outcome = await move(caseId, (c) => ({
    to: "closed",
    write: {
      state: "closed",
      closedAt: now,
      closedReason: reason,
      snoozedUntil: null,
      inboundTextDeleteAfter: new Date(now.getTime() + (c.phiSuspected ? 7 : 30) * DAY_MS),
      updatedAt: now,
    },
  }));
  // Lane P7e: a closed case leaves no reply waiting for the owner's yes (outcome case_closed).
  if (outcome.outcome === "done") await (await import("./wire")).expireAfterClose(caseId, now);
  return outcome;
}

export type MatchOutcome =
  | CaseMoveOutcome
  | { outcome: "already_matched"; ref: string; clinicId: string }
  | { outcome: "clinic_gone"; ref: string };

/**
 * Name the clinic an unmatched case is about (an email nobody matched; the
 * inbound slice). Once only: a case that names a clinic, which every chat
 * case does, is refused. Written in that clinic's tenant, so the guard can
 * refuse a clinic that has left.
 */
export async function matchSupportCase(
  caseId: string,
  clinicId: string,
  actor: ActorContext,
  now: Date,
): Promise<MatchOutcome> {
  const [c] = await unsafeDb.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1);
  if (!c) return { outcome: "not_found" };
  if (c.state === "closed") return { outcome: "closed", ref: printRef(c.ref) };
  if (c.subjectClinicId) {
    return c.subjectClinicId === clinicId
      ? { outcome: "unchanged", ref: printRef(c.ref), clinicId, state: c.state }
      : { outcome: "already_matched", ref: printRef(c.ref), clinicId: c.subjectClinicId };
  }
  try {
    const updated = await withTenant({ clinicId, actor }, async (tx) =>
      tx.db
        .update(supportCases)
        .set({ subjectClinicId: clinicId, updatedAt: now })
        .where(
          and(
            eq(supportCases.id, caseId),
            sql`${supportCases.subjectClinicId} is null`,
            ne(supportCases.state, "closed"),
          ),
        )
        .returning({ id: supportCases.id }),
    );
    if (updated.length === 0) return matchSupportCase(caseId, clinicId, actor, now);
    return { outcome: "done", ref: printRef(c.ref), clinicId, from: c.state, to: c.state };
  } catch (error) {
    if (pgErrorOf(error).code === "42501") return { outcome: "clinic_gone", ref: printRef(c.ref) };
    throw error;
  }
}

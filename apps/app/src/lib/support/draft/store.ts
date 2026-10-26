import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { supportCases, supportMessages, type SupportCase } from "@/db/schema";

import { printRef, type SupportCaseState } from "../case-vocab";
import { CHECK_IDS, CHECK_RULES, type CheckId, type FactsUsed, type ReplyChecks } from "./checks";
import { CONFIDENCE_LEVELS, type Confidence, type HandoffReason } from "./tools";

/**
 * Where a support draft is kept (lane P7b): a `support_messages` row of kind
 * `reply`, direction `out`, with `draft_text` and `draft_version`, the facts
 * it rests on in `facts_json` and its checks in `checks_json`. Nothing here
 * sends: lane P7c's approve-and-send reads the current draft
 * (readCurrentDraft) and sets the approved text.
 *
 * ## Versions and attempts
 *
 * Every row a draft run writes carries `facts_json.by = "drafter"` and
 * `facts_json.attempt`, the version it was given: the case's highest
 * version so far, counting every reply row (the drafter's and an operator's
 * saved edit, lane P7c), plus one. A run that produced a draft writes that
 * number as `draft_version` too. A run that failed (no model, a refusal, no
 * proposal, a timeout) writes a row with no text and no version (the
 * table's CHECK ties them together), and `facts_json.failure` says why: the
 * case's needs_edit reason, shown in the console.
 *
 * A run writes only when, inside one transaction with the case locked, the
 * case is still `drafting` and no row has reached its version: so a run
 * retried after its lease ran out, or one racing it, writes once per (case,
 * version), and a case an operator closed or snoozed meanwhile is left alone.
 *
 * At most DRAFTS_PER_CASE drafter attempts per case; past it the job writes
 * one `draft_limit` note and leaves the case to a person.
 */

export const DRAFTS_PER_CASE = 5;
/** How long a claimed case stays `drafting` before another run may take it: a run is bounded well inside this. */
export const DRAFT_LEASE_MS = 10 * 60 * 1000;
export const DRAFTER_MARK = "drafter";

export const DRAFT_FAILURES = [
  "model_unavailable",
  "model_failed",
  "model_refused",
  "no_proposal",
  "account_unreadable",
  "draft_limit",
] as const;
export type DraftFailure = (typeof DRAFT_FAILURES)[number];

/** What a draft's `facts_json` holds. */
export type DraftFactsJson = {
  by: typeof DRAFTER_MARK;
  attempt: number;
  failure?: DraftFailure;
  factsUsed?: FactsUsed[];
  questionsForOps?: string[];
  confidence?: Confidence;
  /** The model's own reading of the case: shown nowhere as the case's, and never written to it. */
  proposal?: { category: string; symptom: string; urgency: string; handoffReasons: HandoffReason[] };
  /** The read tools the run called, in order. */
  toolsRun?: string[];
};

export type ClaimedCase = {
  id: string;
  ref: string;
  clinicId: string;
  source: SupportCase["source"];
  category: string;
  symptom: string;
  urgency: SupportCase["urgency"];
  state: SupportCaseState;
  openedAt: Date;
  replyByOn: string;
  /** The version this run writes. */
  version: number;
  /** Drafter attempts already on the case. */
  attempts: number;
  /** The latest chat escalation's fields, ids from fixed lists. */
  fields: Record<string, string | null> | null;
};

async function versionAndAttempts(db: Transaction | typeof unsafeDb, caseId: string): Promise<{ top: number; attempts: number }> {
  const [row] = await db
    .select({
      top: sql<number>`coalesce(max(coalesce(${supportMessages.draftVersion}, (${supportMessages.factsJson}->>'attempt')::int)), 0)::int`,
      attempts: sql<number>`count(*) filter (where ${supportMessages.factsJson}->>'by' = ${DRAFTER_MARK} and coalesce(${supportMessages.factsJson}->>'failure', '') <> 'draft_limit')::int`,
    })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "reply"), eq(supportMessages.direction, "out")));
  return { top: Number(row?.top ?? 0), attempts: Number(row?.attempts ?? 0) };
}

/** How many drafter attempts a case has had (failures included, the limit's own note not). */
export async function draftAttempts(caseId: string): Promise<number> {
  return (await versionAndAttempts(unsafeDb, caseId)).attempts;
}

/**
 * Take one case to draft: the most urgent `new` case that names a clinic, or
 * a `drafting` one whose run went quiet past the lease. Compare-and-set on
 * the same condition, so two runs never take the same case. Null when
 * there is nothing to draft.
 */
export async function claimCaseToDraft(now: Date, only?: string): Promise<ClaimedCase | null> {
  const stale = new Date(now.getTime() - DRAFT_LEASE_MS);
  const due = sql`(${supportCases.state} = 'new' or (${supportCases.state} = 'drafting' and ${supportCases.updatedAt} < ${stale}))`;
  const candidates = await unsafeDb
    .select()
    .from(supportCases)
    .where(and(due, isNotNull(supportCases.subjectClinicId), only ? eq(supportCases.id, only) : undefined))
    .orderBy(
      sql`case ${supportCases.urgency} when 'now' then 0 when 'today' then 1 else 2 end`,
      asc(supportCases.replyByOn),
      asc(supportCases.openedAt),
      asc(supportCases.id),
    )
    .limit(5);
  for (const c of candidates) {
    const taken = await unsafeDb
      .update(supportCases)
      .set({ state: "drafting", updatedAt: now })
      .where(and(eq(supportCases.id, c.id), due))
      .returning({ id: supportCases.id });
    if (taken.length === 0) continue;
    const { top, attempts } = await versionAndAttempts(unsafeDb, c.id);
    const [latest] = await unsafeDb
      .select({ fields: supportMessages.fieldsJson })
      .from(supportMessages)
      .where(and(eq(supportMessages.caseId, c.id), eq(supportMessages.kind, "chat_escalation")))
      .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
      .limit(1);
    return {
      id: c.id,
      ref: c.ref,
      clinicId: c.subjectClinicId!,
      source: c.source,
      category: c.category,
      symptom: c.symptom,
      urgency: c.urgency,
      state: "drafting",
      openedAt: c.openedAt,
      replyByOn: c.replyByOn,
      version: top + 1,
      attempts,
      fields: latest?.fields ?? null,
    };
  }
  return null;
}

export type DraftWrite =
  | {
      kind: "draft";
      text: string;
      checks: ReplyChecks;
      facts: Omit<DraftFactsJson, "by" | "attempt" | "failure">;
    }
  | { kind: "failure"; failure: DraftFailure };

/**
 * Write a run's outcome and move the case: `drafted` when every check
 * passed, `needs_edit` otherwise. Written once per (case, version): false
 * when the case is no longer this run's (see the header), and nothing is
 * written then.
 */
export async function recordDraft(claimed: Pick<ClaimedCase, "id" | "version">, write: DraftWrite, now: Date): Promise<{ written: boolean; state: SupportCaseState | null; messageId: string | null }> {
  return unsafeDb.transaction(async (tx) => {
    const [c] = await tx.select().from(supportCases).where(eq(supportCases.id, claimed.id)).limit(1).for("update");
    if (!c || c.state !== "drafting") return { written: false, state: c?.state ?? null, messageId: null };
    const { top } = await versionAndAttempts(tx, claimed.id);
    if (top >= claimed.version) return { written: false, state: c.state, messageId: null };

    const base = { by: DRAFTER_MARK, attempt: claimed.version } as const;
    const values: typeof supportMessages.$inferInsert =
      write.kind === "draft"
        ? {
            caseId: claimed.id,
            direction: "out",
            kind: "reply",
            draftText: write.text,
            draftVersion: claimed.version,
            factsJson: { ...base, ...write.facts } satisfies DraftFactsJson,
            checksJson: write.checks,
            createdAt: now,
          }
        : {
            caseId: claimed.id,
            direction: "out",
            kind: "reply",
            factsJson: { ...base, failure: write.failure } satisfies DraftFactsJson,
            checksJson: null,
            createdAt: now,
          };
    const [row] = await tx.insert(supportMessages).values(values).returning({ id: supportMessages.id });
    const state: SupportCaseState = write.kind === "draft" && write.checks.ok ? "drafted" : "needs_edit";
    await tx
      .update(supportCases)
      .set({ state, updatedAt: now })
      .where(and(eq(supportCases.id, claimed.id), eq(supportCases.state, "drafting")));
    return { written: true, state, messageId: row!.id };
  });
}

/** Put a claimed case back to `new` without writing anything (the run never reached the model). */
export async function releaseClaim(caseId: string, now: Date): Promise<void> {
  await unsafeDb
    .update(supportCases)
    .set({ state: "new", updatedAt: now })
    .where(and(eq(supportCases.id, caseId), eq(supportCases.state, "drafting")));
}

// -----------------------------------------------------------------------------
// Reading the current draft (the console, lane P7c's send path)
// -----------------------------------------------------------------------------

export type SupportDraftView = {
  messageId: string;
  /** Null only for a failed run, which has no text. */
  version: number | null;
  text: string | null;
  checks: { id: CheckId; ok: boolean; rule: string }[];
  factsUsed: FactsUsed[];
  questionsForOps: string[];
  confidence: Confidence | null;
  createdAt: string;
  /** Why the last run wrote no draft; null for a draft. */
  failure: DraftFailure | null;
};

function checksOf(value: unknown): SupportDraftView["checks"] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    const id = (r as { id?: unknown }).id;
    if (!(CHECK_IDS as readonly unknown[]).includes(id)) return [];
    return [{ id: id as CheckId, ok: (r as { ok?: unknown }).ok === true, rule: CHECK_RULES[id as CheckId] }];
  });
}

function factsOf(value: unknown): FactsUsed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f) => {
    const { tool, field, value: v } = (f ?? {}) as Record<string, unknown>;
    return typeof tool === "string" && typeof field === "string" && typeof v === "string" ? [{ tool, field, value: v }] : [];
  });
}

/**
 * The newest reply row on a case that is a draft or a failed run, as the
 * console shows it, or null when there is none. Never an inbound text.
 */
export async function readDraftView(caseId: string): Promise<SupportDraftView | null> {
  const [row] = await unsafeDb
    .select()
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.caseId, caseId),
        eq(supportMessages.kind, "reply"),
        eq(supportMessages.direction, "out"),
        sql`(${supportMessages.draftVersion} is not null or ${supportMessages.factsJson}->>'failure' is not null)`,
      ),
    )
    .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
    .limit(1);
  if (!row) return null;
  const facts = (row.factsJson ?? {}) as Partial<DraftFactsJson>;
  const failure = (DRAFT_FAILURES as readonly unknown[]).includes(facts.failure) ? (facts.failure as DraftFailure) : null;
  const confidence = (CONFIDENCE_LEVELS as readonly unknown[]).includes(facts.confidence) ? (facts.confidence as Confidence) : null;
  return {
    messageId: row.id,
    version: row.draftVersion,
    text: row.draftText,
    checks: checksOf(row.checksJson),
    factsUsed: factsOf(facts.factsUsed),
    questionsForOps: Array.isArray(facts.questionsForOps) ? facts.questionsForOps.filter((q): q is string => typeof q === "string") : [],
    confidence,
    createdAt: row.createdAt.toISOString(),
    failure: row.draftVersion === null ? (failure ?? "no_proposal") : null,
  };
}

/** The current draft with text (the newest row with a version), for the send path. */
export async function readCurrentDraft(caseId: string): Promise<{
  messageId: string;
  version: number;
  text: string;
  facts: FactsUsed[];
} | null> {
  const [row] = await unsafeDb
    .select({ id: supportMessages.id, version: supportMessages.draftVersion, text: supportMessages.draftText, facts: supportMessages.factsJson })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "reply"), isNotNull(supportMessages.draftVersion)))
    .orderBy(desc(supportMessages.draftVersion), desc(supportMessages.createdAt))
    .limit(1);
  if (!row || row.version === null || row.text === null) return null;
  return { messageId: row.id, version: row.version, text: row.text, facts: factsOf((row.facts as Partial<DraftFactsJson> | null)?.factsUsed) };
}

// -----------------------------------------------------------------------------
// Regenerate: an operator's act, which only queues
// -----------------------------------------------------------------------------

export type RegenerateOutcome =
  | { outcome: "queued"; ref: string; clinicId: string; from: SupportCaseState; attempts: number }
  | { outcome: "already_queued"; ref: string; clinicId: string | null }
  | { outcome: "not_found" }
  | { outcome: "closed"; ref: string }
  | { outcome: "no_clinic"; ref: string }
  | { outcome: "limit"; ref: string; attempts: number }
  | { outcome: "not_allowed"; ref: string; state: SupportCaseState };

/** The states a regeneration may be asked from: a draft is there, or a run gave up. */
export const REGENERATE_FROM: readonly SupportCaseState[] = ["drafted", "needs_edit"];

/**
 * Ask for a new draft: the case goes back to `new` and the support-draft
 * job takes it on its next fire. Refused on a closed case, a case with no
 * clinic, one with DRAFTS_PER_CASE attempts already, and one that is being
 * drafted, waiting on the clinic or snoozed.
 */
export async function queueRegeneration(caseId: string, now: Date): Promise<RegenerateOutcome> {
  return unsafeDb.transaction(async (tx) => {
    const [c] = await tx.select().from(supportCases).where(eq(supportCases.id, caseId)).limit(1).for("update");
    if (!c) return { outcome: "not_found" as const };
    const ref = printRef(c.ref);
    if (c.state === "closed") return { outcome: "closed" as const, ref };
    if (!c.subjectClinicId) return { outcome: "no_clinic" as const, ref };
    if (c.state === "new") return { outcome: "already_queued" as const, ref, clinicId: c.subjectClinicId };
    const { attempts } = await versionAndAttempts(tx, c.id);
    if (attempts >= DRAFTS_PER_CASE) return { outcome: "limit" as const, ref, attempts };
    if (!REGENERATE_FROM.includes(c.state)) return { outcome: "not_allowed" as const, ref, state: c.state };
    await tx
      .update(supportCases)
      .set({ state: "new", updatedAt: now })
      .where(and(eq(supportCases.id, c.id), inArray(supportCases.state, [...REGENERATE_FROM])));
    return { outcome: "queued" as const, ref, clinicId: c.subjectClinicId, from: c.state, attempts };
  });
}

/** Cases still `drafting` past the lease: for the tests and the job's note. */
export async function staleDraftingCount(now: Date): Promise<number> {
  const [row] = await unsafeDb
    .select({ n: sql<number>`count(*)::int` })
    .from(supportCases)
    .where(and(eq(supportCases.state, "drafting"), lt(supportCases.updatedAt, new Date(now.getTime() - DRAFT_LEASE_MS))));
  return Number(row?.n ?? 0);
}

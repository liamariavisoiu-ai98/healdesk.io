import { and, count, desc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";

import { agentConfigs, conversationFlags, type ConversationFlagRow } from "@/db/schema";
import { CORRECTION_STATES, type CorrectionState } from "@/lib/portal/conversation-words";
import type { TenantTx } from "@/lib/tenant";

/**
 * The records behind "Flag this answer" (conversation_flags, drizzle/0093;
 * spec, "When the agent gets something wrong"). Each function reads or
 * writes inside the caller's tenant transaction: the portal's patient page
 * (lib/portal/flag-answer.ts, lib/portal/conversations.ts), so every read
 * has its access row beside it.
 *
 * Whether a correction is live is read from the clinic's knowledge, not
 * stored: a correction is a quick answer tagged with its flag's id
 * (KnowledgeAnswer.flagId), and the clinic may edit or remove it in
 * Knowledge like any other. It is live while the tagged answer is in the
 * list AYA reads and the agent's words are approved (lib/assistant/facts.ts
 * reads quick answers only then), waiting while the list holds it and the
 * approval is not yet given again (an edit before go-live clears it), and
 * removed once the list no longer holds it.
 */

/** Two flags from one clinic in seven days is the alert (I4). */
export const FLAG_WINDOW_DAYS = 7;

export { CORRECTION_STATES, type CorrectionState };

/** A flag as Conversations shows it: when, and where its correction stands. */
export type FlagSummary = {
  id: string;
  /** ISO. */
  flaggedAt: string;
  correction: CorrectionState;
};

type CorrectionFacts = Pick<ConversationFlagRow, "id" | "correctedAt">;

/** Reads the clinic's quick answers once and says where any flag's correction stands. */
export async function correctionReader(
  tx: TenantTx,
): Promise<(flag: CorrectionFacts) => CorrectionState> {
  const [row] = await tx.db
    .select({ quickAnswers: agentConfigs.quickAnswers, approvedAt: agentConfigs.approvedAt })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const tagged = new Set(
    (row?.quickAnswers ?? []).map((a) => a.flagId?.toLowerCase()).filter(Boolean),
  );
  const approved = row?.approvedAt != null;
  return (flag) => {
    if (!flag.correctedAt) return "none";
    if (!tagged.has(flag.id.toLowerCase())) return "removed";
    return approved ? "live" : "waiting";
  };
}

/** The id Conversations shows for a flag's conversation. */
export function shownIdOf(
  row: Pick<ConversationFlagRow, "conversationId" | "threadConversationId">,
): string {
  return (row.conversationId ?? row.threadConversationId)!;
}

export function summaryOf(
  row: ConversationFlagRow,
  state: (flag: CorrectionFacts) => CorrectionState,
): FlagSummary {
  return { id: row.id, flaggedAt: row.flaggedAt.toISOString(), correction: state(row) };
}

/** The flags on these conversations, by the id Conversations shows each by. */
export async function flagsOn(
  tx: TenantTx,
  ids: readonly string[],
): Promise<Map<string, FlagSummary>> {
  const out = new Map<string, FlagSummary>();
  if (ids.length === 0) return out;
  const rows = await tx.db
    .select()
    .from(conversationFlags)
    .where(
      and(
        eq(conversationFlags.clinicId, tx.clinicId),
        or(
          inArray(conversationFlags.conversationId, [...ids]),
          inArray(conversationFlags.threadConversationId, [...ids]),
        ),
      ),
    );
  if (rows.length === 0) return out;
  const state = await correctionReader(tx);
  for (const row of rows) out.set(shownIdOf(row), summaryOf(row, state));
  return out;
}

/** The flag on one conversation, as stored, or null. */
export async function flagRowOn(
  tx: TenantTx,
  conversationId: string,
): Promise<ConversationFlagRow | null> {
  const [row] = await tx.db
    .select()
    .from(conversationFlags)
    .where(
      and(
        eq(conversationFlags.clinicId, tx.clinicId),
        or(
          eq(conversationFlags.conversationId, conversationId),
          eq(conversationFlags.threadConversationId, conversationId),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The clinic's flags on Meta conversations, newest first: what the Flagged view lists beside calls and chats. */
export async function metaFlags(tx: TenantTx, limit: number): Promise<ConversationFlagRow[]> {
  return tx.db
    .select()
    .from(conversationFlags)
    .where(
      and(
        eq(conversationFlags.clinicId, tx.clinicId),
        isNotNull(conversationFlags.threadConversationId),
      ),
    )
    .orderBy(desc(conversationFlags.flaggedAt), desc(conversationFlags.id))
    .limit(limit);
}

/**
 * The clinic's flags in the seven days to now, by the database's clock
 * (flagged_at is the database's own, drizzle/0093), the one just written
 * included.
 */
export async function recentFlagCount(tx: TenantTx): Promise<number> {
  const [row] = await tx.db
    .select({ n: count() })
    .from(conversationFlags)
    .where(
      and(
        eq(conversationFlags.clinicId, tx.clinicId),
        gt(
          conversationFlags.flaggedAt,
          sql`clock_timestamp() - make_interval(days => ${FLAG_WINDOW_DAYS})`,
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { chatThreads, clinics, conversationFlags, type KnowledgeAnswer } from "@/db/schema";
import { readChannelStates } from "@/lib/channels/state";
import { recentFlagCount } from "@/lib/conversations/flags";
import type { SendEmailOptions } from "@/lib/email/send";
import type { FlagAlertPayload } from "@/lib/email/templates/flag_alert";
import { sendFlagAlert } from "@/lib/ops/flag-alert";
import {
  KNOWLEDGE_LIMITS,
  KnowledgeError,
  readKnowledge,
  saveQuickAnswers,
  validateAnswer,
  validateQuickAnswers,
} from "@/lib/setup/knowledge";
import type { TenantTx } from "@/lib/tenant";

import { appliesWhen } from "./applies";
import type { ConversationChannel } from "./conversation-words";
import { findConversation, isConversationId, type ConversationDetail } from "./conversations";
import { knowledgeWriteOptions, practiceQuestionsSeam, rewriteWithout } from "./knowledge";
import { logPatientAccess, withPatientPage, type PatientPage } from "./patient-page";

/**
 * "Flag this answer" (spec, "When the agent gets something wrong": "Every
 * conversation in the portal carries a Flag this answer control. One click,
 * optional note. A flag writes the correction into the clinic's quick answers
 * immediately ... The flag also opens an internal ticket"; plan Part F4).
 *
 * Behind the patient page's step-up, in one withPatientPage transaction with
 * its access row: the conversation is found as the clinic's own (another
 * clinic's is "not found"), the flag recorded (conversation_flags, one per
 * conversation), and the correction, when staff typed one, written into the
 * quick answers tagged with the flag's id, through the writer Knowledge uses,
 * which screens it as Knowledge screens every quick answer, and the practice
 * questions asked to run again (practiceQuestionsSeam), never taking AYA
 * offline. Nothing is copied from the conversation: none of its words is
 * kept, and the correction is only what staff typed.
 *
 * Once that transaction has committed, the ticket: I4 to ops with ids and
 * counts (lib/ops/flag-alert.ts), whose subject marks the second flag from
 * the clinic in seven days as the alert. A flag that rolls back opens none.
 *
 * A conversation already flagged takes its correction later, once; after
 * that the correction is a quick answer like any other, changed in
 * Knowledge.
 */

export type FlagInput = { question?: unknown; answer?: unknown };

export type FlagAnswerResult =
  | { status: "flagged"; flagId: string; corrected: boolean; flagsCount: number; toast: string }
  | { status: "corrected"; flagId: string; toast: string }
  | { status: "already_flagged"; flagId: string }
  | { status: "already_corrected"; flagId: string }
  | {
      status: "refused";
      /** "question" or "answer" (the correction's), or "quickAnswers" (the list is full). */
      field: string;
      message: string;
      /** The refused text without what was refused, when that passes. */
      rewrite?: string;
    }
  | { status: "closed" }
  | { status: "not_found" };

type Correction = { kind: "none" } | { kind: "answer"; answer: KnowledgeAnswer };

/** The correction as typed: none when both boxes are empty, else one screened quick answer. */
export function parseCorrection(
  input: FlagInput | null | undefined,
): Correction | Extract<FlagAnswerResult, { status: "refused" }> {
  const question = typeof input?.question === "string" ? input.question : "";
  const answer = typeof input?.answer === "string" ? input.answer : "";
  if (question.trim() === "" && answer.trim() === "") return { kind: "none" };
  try {
    return { kind: "answer", answer: validateAnswer({ question, answer }, "correction") };
  } catch (error) {
    if (!(error instanceof KnowledgeError)) throw error;
    const field = error.field.endsWith(".question") ? "question" : "answer";
    const rewrite = rewriteWithout(field === "question" ? question : answer);
    return {
      status: "refused",
      field,
      message: error.message,
      ...(rewrite ? { rewrite } : {}),
    };
  }
}

/** The channel family each conversation channel bills and is bought as. */
const CHANNEL_FAMILY: Record<ConversationChannel, Channel> = {
  voice: "voice",
  web_chat: "web",
  web_form: "web",
  // A legacy value no v1 path writes (texting is not a v1 channel): a phone number's channel.
  sms: "voice",
  instagram: "meta",
  messenger: "meta",
  whatsapp: "meta",
};

/** A question as a key: lower case, spacing collapsed (lib/website/diff.ts keyOf's rule). */
function questionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The correction into the quick answers, tagged with its flag: in place of
 * one asking the same question (two answers to one question would contradict
 * each other), else at the end. The whole list goes through
 * validateQuickAnswers, as a Knowledge save does, and the practice questions
 * are asked to run again.
 */
async function applyCorrection(
  tx: TenantTx,
  flagId: string,
  correction: KnowledgeAnswer,
  now: Date,
): Promise<void> {
  const { quickAnswers } = await readKnowledge(tx.db, tx.clinicId);
  const tagged: KnowledgeAnswer = { ...correction, flagId };
  const key = questionKey(correction.question);
  const at = quickAnswers.findIndex((a) => questionKey(a.question) === key);
  const next =
    at >= 0 ? quickAnswers.map((a, i) => (i === at ? tagged : a)) : [...quickAnswers, tagged];
  if (next.length > KNOWLEDGE_LIMITS.quickAnswers) {
    throw new KnowledgeError(
      "quickAnswers",
      `Your quick answers are full (${KNOWLEDGE_LIMITS.quickAnswers}). Remove one in Knowledge, then add this correction.`,
    );
  }
  await saveQuickAnswers(tx, validateQuickAnswers(next), now, await knowledgeWriteOptions(tx));
  await practiceQuestionsSeam(tx, "quick_answers", now);
}

/** "AYA uses it from now on", or "Applies when phone opens": quick answers reach phone and website chat. */
async function appliesLine(tx: TenantTx, now: Date): Promise<string> {
  const states = await readChannelStates(tx.db, tx.clinicId, now);
  const bought = states.filter((s) => (CHANNELS as readonly Channel[]).includes(s.channel));
  return appliesWhen(bought, ["voice", "web"]) ?? "AYA uses it from the next call or chat.";
}

/** The Meta thread a flagged Meta conversation belongs to, while it is still that thread's conversation. */
async function threadOf(
  tx: TenantTx,
  detail: ConversationDetail,
): Promise<{ partyRef: string } | null> {
  const [thread] = await tx.db
    .select({ partyRef: chatThreads.partyRef })
    .from(chatThreads)
    .where(and(eq(chatThreads.clinicId, tx.clinicId), eq(chatThreads.conversationId, detail.id)))
    .limit(1);
  return thread ?? null;
}

type Done = { result: FlagAnswerResult; alert: FlagAlertPayload | null };

/**
 * Flag one conversation, with or without a correction, or add the
 * correction to one flagged already. Behind the step-up; the ticket goes to
 * ops after the flag commits. `options.email` reaches the ticket's sender
 * (a fake transport in tests).
 */
export async function flagAnswer(
  page: PatientPage,
  conversationId: string,
  input: FlagInput | null | undefined,
  options: { now?: Date; email?: SendEmailOptions } = {},
): Promise<FlagAnswerResult> {
  if (!isConversationId(conversationId)) return { status: "not_found" };
  const correction = parseCorrection(input);
  if ("status" in correction) return correction;
  const now = options.now ?? new Date();

  let done: Done;
  try {
    done = await withPatientPage(page, async (tx): Promise<Done> => {
      const detail = await findConversation(tx, conversationId);
      // The open the flag is made from, by the id asked about when there is none.
      await logPatientAccess(tx, {
        action: "read",
        resourceType: "conversation",
        resourceId: detail?.id ?? conversationId,
      });
      if (!detail) return { result: { status: "not_found" }, alert: null };

      const [clinic] = await tx.db
        .select({ offboardingStartedAt: clinics.offboardingStartedAt })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic || clinic.offboardingStartedAt) {
        return { result: { status: "closed" }, alert: null };
      }

      const [existing] = await tx.db
        .select({ id: conversationFlags.id, correctedAt: conversationFlags.correctedAt })
        .from(conversationFlags)
        .where(
          and(
            eq(conversationFlags.clinicId, tx.clinicId),
            detail.source === "call_or_chat"
              ? eq(conversationFlags.conversationId, detail.id)
              : eq(conversationFlags.threadConversationId, detail.id),
          ),
        )
        .limit(1);

      if (existing) {
        if (correction.kind === "none") {
          return { result: { status: "already_flagged", flagId: existing.id }, alert: null };
        }
        if (existing.correctedAt) {
          return { result: { status: "already_corrected", flagId: existing.id }, alert: null };
        }
        await applyCorrection(tx, existing.id, correction.answer, now);
        await tx.db
          .update(conversationFlags)
          .set({ correctedAt: now })
          .where(
            and(eq(conversationFlags.clinicId, tx.clinicId), eq(conversationFlags.id, existing.id)),
          );
        tx.audit.record({
          action: "update",
          resourceType: "conversation_flag",
          resourceId: existing.id,
          metadata: { corrected: true },
        });
        return {
          result: {
            status: "corrected",
            flagId: existing.id,
            toast: `Your correction is in Quick answers. ${await appliesLine(tx, now)}`,
          },
          alert: null,
        };
      }

      const thread = detail.source === "meta_thread" ? await threadOf(tx, detail) : null;
      if (detail.source === "meta_thread" && !thread) {
        return { result: { status: "not_found" }, alert: null };
      }
      const [flag] = await tx.db
        .insert(conversationFlags)
        .values({
          clinicId: tx.clinicId,
          source: detail.source,
          conversationId: detail.source === "call_or_chat" ? detail.id : null,
          threadConversationId: detail.source === "meta_thread" ? detail.id : null,
          threadPartyRef: thread?.partyRef ?? null,
          channel: detail.channel,
          outcome: detail.outcome,
          conversationStartedAt: new Date(detail.startedAt),
          correctedAt: correction.kind === "answer" ? now : null,
        })
        // A second click racing the first meets the one-per-conversation
        // index and becomes the first's flag, not an error.
        .onConflictDoNothing()
        .returning({ id: conversationFlags.id, flaggedAt: conversationFlags.flaggedAt });
      if (!flag) {
        const [raced] = await tx.db
          .select({ id: conversationFlags.id })
          .from(conversationFlags)
          .where(
            and(
              eq(conversationFlags.clinicId, tx.clinicId),
              detail.source === "call_or_chat"
                ? eq(conversationFlags.conversationId, detail.id)
                : eq(conversationFlags.threadConversationId, detail.id),
            ),
          )
          .limit(1);
        return {
          result: raced ? { status: "already_flagged", flagId: raced.id } : { status: "not_found" },
          alert: null,
        };
      }
      if (correction.kind === "answer") await applyCorrection(tx, flag.id, correction.answer, now);
      const flagsCount = await recentFlagCount(tx);
      tx.audit.record({
        action: "create",
        resourceType: "conversation_flag",
        resourceId: flag.id,
        metadata: { corrected: correction.kind === "answer", flagsInWindow: flagsCount },
      });

      const corrected = correction.kind === "answer";
      return {
        result: {
          status: "flagged",
          flagId: flag.id,
          corrected,
          flagsCount,
          toast: corrected
            ? `Flagged, and your correction is in Quick answers. ${await appliesLine(tx, now)} healdesk has been told.`
            : "Flagged. healdesk has been told. If you know the right answer, add it below and AYA uses it.",
        },
        alert: {
          flagId: flag.id,
          clinicId: tx.clinicId,
          conversationId: detail.id,
          channel: CHANNEL_FAMILY[detail.channel],
          outcome: detail.outcome,
          hasCorrection: corrected,
          flagsCount,
          flaggedAt: flag.flaggedAt.toISOString(),
        },
      };
    });
  } catch (error) {
    if (error instanceof KnowledgeError) {
      // Nothing was written: the flag and its access row rolled back with the refused correction.
      return { status: "refused", field: error.field, message: error.message };
    }
    throw error;
  }

  if (done.alert) await sendFlagAlert(done.alert, { now, ...options.email });
  return done.result;
}

import { findClinicalContent } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { agentConfigs } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicDefaultDepositUsd } from "@/lib/billing/deposits";
import {
  KnowledgeError,
  neverSayWithDefaults,
  readKnowledge,
  saveNeverSay,
  savePolicies,
  savePromotions,
  saveQuickAnswers,
  saveServices,
  validateNeverSay,
  validatePolicies,
  validatePromotions,
  validateQuickAnswers,
  validateServices,
} from "@/lib/setup/knowledge";
import { PracticeError, saveBasics, saveHours } from "@/lib/setup/practice";
import { readSetupState } from "@/lib/setup/state";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { appliesWhen } from "./applies";

/**
 * Knowledge (plan Part F3; spec, "Knowledge: quick edits, no re-scrape
 * needed"): the practice, its prices, promotions, quick answers, never-say
 * and hours. Each section saves on its own, through the writers the setup
 * wizard uses (lib/setup/knowledge.ts and practice.ts), which screen every
 * text with findClinicalContent and name the phrase they refuse. Knowledge
 * adds the offer of a rewrite: the same text without the sentence that was
 * refused, when what is left passes, so the clinic can take it in one tap.
 *
 * Edits apply at once. The practice questions that check AYA against this
 * knowledge are the engine's (M4): `practiceQuestionsSeam` below is where a
 * save asks for them to run again, in the background, never taking AYA
 * offline (Part F3).
 */

export const KNOWLEDGE_SECTIONS = [
  "practice",
  "policies",
  "prices",
  "promotions",
  "quick_answers",
  "never_say",
  "never_say_defaults",
  "hours",
] as const;
export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number];

export function isKnowledgeSection(value: unknown): value is KnowledgeSection {
  return typeof value === "string" && (KNOWLEDGE_SECTIONS as readonly string[]).includes(value);
}

export type KnowledgeContext = { clinicId: string; userId: string; actorLabel: string };

export type KnowledgeResult =
  | { ok: true; toast: string }
  | {
      ok: false;
      field: string;
      message: string;
      /** The refused text without what was refused, when that passes: "Try this instead". */
      rewrite?: string;
    };

export async function saveKnowledge(
  ctx: KnowledgeContext,
  section: unknown,
  input: unknown,
  now: Date = new Date(),
): Promise<KnowledgeResult> {
  if (!isKnowledgeSection(section)) {
    return { ok: false, field: "section", message: "That isn't part of Knowledge." };
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  try {
    const toast = await withTenant({ clinicId: ctx.clinicId, actor }, async (tx) => {
      const state = await readSetupState(tx, { userId: ctx.userId, now });
      if (!state) throw new KnowledgeError("section", "This clinic could not be found.");
      if (state.clinic.offboardingStartedAt) {
        throw new KnowledgeError(
          "section",
          "This account has closed, so its knowledge can't change.",
        );
      }
      const said = await write(
        tx,
        section,
        body,
        state.clinic.specialty,
        state.clinic.timezone,
        now,
      );
      await practiceQuestionsSeam(tx, section);
      const applies = appliesWhen(state.channels);
      return applies ? `${said} ${applies}` : `${said} AYA uses it from now on.`;
    });
    return { ok: true, toast };
  } catch (error) {
    if (error instanceof KnowledgeError || error instanceof PracticeError) {
      const rewrite = rewriteFor(section, body, error.field);
      return rewrite
        ? { ok: false, field: error.field, message: error.message, rewrite }
        : { ok: false, field: error.field, message: error.message };
    }
    throw error;
  }
}

async function write(
  tx: TenantTx,
  section: KnowledgeSection,
  body: Record<string, unknown>,
  specialty: string,
  timeZone: string,
  now: Date,
): Promise<string> {
  switch (section) {
    case "practice":
      await saveBasics(
        tx,
        {
          name: body.name,
          address: body.address,
          phone: body.phone,
          website: body.website,
          timezone: body.timezone,
        },
        now,
      );
      return "Your practice's details are saved.";

    case "policies": {
      const policies = validatePolicies(body.policies);
      await savePolicies(tx, policies, now);
      return policies.length === 1 ? "One policy saved." : `${policies.length} policies saved.`;
    }

    case "prices": {
      // Every row here shows its deposit, and a blank one reads "None": no
      // deposit, stored as 0, which BD27 reads as none even when the clinic
      // has a default (null would mean that default). The wizard's Deposits
      // screen stores "None" the same way (lib/setup/save.ts).
      const services = validateServices(body.services, specialty).map((service) =>
        service.depositUsd === null || service.depositUsd === undefined
          ? { ...service, depositUsd: 0 }
          : service,
      );
      await saveServices(tx, services, now);
      return services.length === 1
        ? "One service saved. AYA quotes only the prices listed here."
        : `${services.length} services saved. AYA quotes only the prices listed here.`;
    }

    case "promotions": {
      const promotions = validatePromotions(body.promotions);
      await savePromotions(tx, promotions, now);
      return promotions ? "Promotions saved." : "Promotions cleared: AYA has none to mention.";
    }

    case "quick_answers": {
      const answers = validateQuickAnswers(body.quickAnswers);
      await saveQuickAnswers(tx, answers, now);
      return answers.length === 1
        ? "One quick answer saved."
        : `${answers.length} quick answers saved.`;
    }

    case "never_say": {
      const phrases = validateNeverSay(body.neverSay);
      await saveNeverSay(tx, phrases, now);
      return phrases.length === 1
        ? "One phrase AYA never says."
        : `${phrases.length} phrases AYA never says.`;
    }

    case "never_say_defaults": {
      // The clinical defaults back at the top, with the clinic's own after them.
      const { neverSay } = await readKnowledge(tx.db, tx.clinicId);
      const restored = neverSayWithDefaults(neverSay);
      await saveNeverSay(tx, restored, now);
      return "The defaults are back on the never-say list, with your own phrases after them.";
    }

    case "hours":
      await saveHours(tx, { hours: body.hours, closures: body.closures }, timeZone, now);
      return "Hours saved. AYA tells people when you're open, and phone follows them.";
  }
}

/**
 * The deposit Knowledge shows on a price row, in dollars, or "" for none: the
 * service's own amount, or, for a row that follows the clinic default
 * (`depositUsd` null, BD27), that default, so the screen shows what AYA asks
 * for and saving the row as it stands keeps it. A 0 is none.
 */
export function depositShown(own: number | null | undefined, clinicDefault: number | null): string {
  if (own !== null && own !== undefined) return own > 0 ? String(own) : "";
  return clinicDefault !== null && clinicDefault > 0 ? String(clinicDefault) : "";
}

/** The clinic default deposit (agent_configs.deposit_policy), or null when it has none. */
export async function readClinicDefaultDeposit(
  clinicId: string,
  actor: ActorContext,
): Promise<number | null> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .select({ policy: agentConfigs.depositPolicy })
      .from(agentConfigs)
      .where(eq(agentConfigs.clinicId, tx.clinicId))
      .limit(1);
    return clinicDefaultDepositUsd(row?.policy);
  });
}

/**
 * M4's seam: a knowledge change asks for the practice questions to run again
 * (plan Part G), debounced, in the background. A failure there shows "We're
 * double-checking your change" on Home, calls notifyOps, and never takes AYA
 * offline. Nothing runs the questions in this build, so there is nothing to
 * ask for yet.
 */
export async function practiceQuestionsSeam(
  tx: TenantTx,
  section: KnowledgeSection,
): Promise<void> {
  void tx;
  void section;
}

// -----------------------------------------------------------------------------
// "Try this instead"
// -----------------------------------------------------------------------------

/**
 * The refused text with the sentences the clinical screen refuses taken out,
 * when what is left is not empty and passes. Null when there is nothing to
 * offer: the clinic rewrites it itself, with the phrase named.
 */
export function rewriteWithout(text: string): string | null {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  const kept = sentences.filter((s) => findClinicalContent({ s }).length === 0);
  const rewrite = kept.join("").replace(/\s+/g, " ").trim();
  if (!rewrite || rewrite === text.trim()) return null;
  return findClinicalContent({ rewrite }).length === 0 ? rewrite : null;
}

/** The text a refusal was about, by the field the writer named, and its rewrite. */
function rewriteFor(
  section: KnowledgeSection,
  body: Record<string, unknown>,
  field: string,
): string | null {
  const indexed = /^(\w+)\[(\d+)\](?:\.(question|answer))?$/.exec(field);
  if (section === "promotions" && typeof body.promotions === "string") {
    return rewriteWithout(body.promotions);
  }
  if (section === "policies" && indexed?.[1] === "policies" && Array.isArray(body.policies)) {
    const text = body.policies[Number(indexed[2])];
    return typeof text === "string" ? rewriteWithout(text) : null;
  }
  if (
    section === "quick_answers" &&
    indexed?.[1] === "quickAnswers" &&
    Array.isArray(body.quickAnswers)
  ) {
    const row = (body.quickAnswers[Number(indexed[2])] ?? {}) as Record<string, unknown>;
    const text = row[indexed[3] ?? "answer"];
    return typeof text === "string" ? rewriteWithout(text) : null;
  }
  return null;
}

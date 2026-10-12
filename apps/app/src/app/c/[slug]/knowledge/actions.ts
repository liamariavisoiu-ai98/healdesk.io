"use server";

import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { saveKnowledge, type KnowledgeResult } from "@/lib/portal/knowledge";

/**
 * Knowledge's one server action (plan Part F3). It calls requirePortal(slug)
 * itself; lib/portal/knowledge.ts validates, screens and writes inside the
 * clinic's tenant. Knowledge edits need no step-up (spec: "toggles, billing
 * and knowledge edits do not require it").
 */
export async function saveKnowledgeAction(
  slug: string,
  section: string,
  input: unknown,
): Promise<KnowledgeResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  return saveKnowledge(
    { clinicId: portal.clinicId, userId: portal.userId, actorLabel: actor.label },
    section,
    input,
  );
}

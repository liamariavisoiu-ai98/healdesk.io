"use server";

import { revalidatePath } from "next/cache";

import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { saveKnowledge, type KnowledgeResult } from "@/lib/portal/knowledge";
import { decideWebsiteChange, type WebsiteChangeResult } from "@/lib/website/store";
import { addKnowledgeFileRows, type FileAddResult } from "@/lib/knowledge-file/flow";

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

/**
 * "Changes on your website" (plan Part F3): confirm a change into Knowledge,
 * through the same writers and screens as the forms above, or ignore it for
 * good. No step-up, like every Knowledge edit; lib/website/store.ts decides
 * inside the clinic's tenant.
 */
export async function decideWebsiteChangeAction(
  slug: string,
  changeId: string,
  decision: string,
): Promise<WebsiteChangeResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  return decideWebsiteChange(
    { clinicId: portal.clinicId, userId: portal.userId, actorLabel: actor.label },
    changeId,
    decision,
  );
}

/**
 * "Add from a file" (portal redesign, owner, 1 November 2026): add the rows
 * the clinic chose from a file it uploaded, each section through the same
 * writer and screens as its form above (lib/knowledge-file/flow.ts). No
 * step-up, like every edit on Your practice.
 */
export async function addKnowledgeFileAction(slug: string, rows: unknown): Promise<FileAddResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const result = await addKnowledgeFileRows(
    { clinicId: portal.clinicId, userId: portal.userId, actorLabel: actor.label },
    rows,
  );
  // The sections below the card read what was just added on the page's next render.
  if (result.ok) revalidatePath(`/c/${portal.clinicSlug}/knowledge`);
  return result;
}


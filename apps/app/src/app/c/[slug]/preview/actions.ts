"use server";

import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { sessionBinding } from "@/lib/portal/step-up";
import { previewTurn, type PreviewReply } from "@/lib/preview/talk";

import { requestMeta } from "../request-meta";

/**
 * Talk to your AYA's one server action: a message in the preview, answered
 * (lib/preview/talk.ts). It calls requirePortal(slug) itself, so a sign-in
 * without this practice gets "not found", as on every portal page. Nothing
 * in the preview is about a patient, so no step-up.
 *
 * The device it counts against is this browser's sign-in session, by the
 * SHA-256 of its session token (sessionBinding), or its address when there
 * is no session token to read.
 */
export async function talkToAyaAction(slug: string, input: unknown): Promise<PreviewReply> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const binding = await sessionBinding(portal);
  const deviceKey = binding
    ? binding.sessionTokenHash.toString("hex")
    : `address:${(await requestMeta()).ipAddress ?? "unknown"}`;
  return previewTurn(
    {
      clinicId: portal.clinicId,
      userId: portal.userId,
      deviceKey,
      actor: { type: "user", userId: portal.userId, label: actor.label },
    },
    input,
    { responder: anthropicAssistantResponder() },
  );
}

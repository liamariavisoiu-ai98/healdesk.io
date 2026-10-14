"use server";

import type { ActorContext } from "@/lib/audit";
import { sendStepsOn } from "@/lib/notices/steps-sent";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { voiceForwardingReady } from "@/lib/setup/forwarding";
import { loadSetupState } from "@/lib/setup/state";

/**
 * Setup step 4's "Email these to my office manager" (plan Part E; O11 in
 * Annex X5): the forwarding steps, sent on to the address the clinic types.
 *
 * The browser sends only the address. Whether there are steps to send, and
 * AYA's number in them, are read here from what is stored, with the same
 * gate that decides whether the screen shows them (voiceForwardingReady):
 * a forged request before voice is ready gets the refusal, never a number.
 * lib/notices/steps-sent.ts keeps its own limits (three a day per clinic, an
 * address that asked to stop) and words the email from catalog ids only.
 */

export type SendStepsResult = { ok: true; message: string } | { ok: false; message: string };

export async function emailForwardingSteps(slug: string, to: unknown): Promise<SendStepsResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const who: ActorContext = { type: "user", userId: portal.userId, label: actor.label };
  const state = await loadSetupState({
    clinicId: portal.clinicId,
    userId: portal.userId,
    actor: who,
  });
  const voice = state?.channels.find((c) => c.channel === "voice");
  if (
    !state ||
    state.clinic.offboardingStartedAt ||
    !voiceForwardingReady({
      voice,
      assistantNumberE164: state.clinic.assistantNumberE164,
      directLineE164: state.settings.directLineE164,
    })
  ) {
    return {
      ok: false,
      message: "Phone isn't ready for call forwarding yet, so there are no steps to send.",
    };
  }
  const result = await sendStepsOn({
    clinicId: portal.clinicId,
    channel: "voice",
    to,
    actor: who,
    ayaNumberE164: state.clinic.assistantNumberE164,
  });
  switch (result.status) {
    case "sent":
      return { ok: true, message: `Sent to ${result.to}.` };
    case "refused":
    case "failed":
      return { ok: false, message: result.message };
  }
}

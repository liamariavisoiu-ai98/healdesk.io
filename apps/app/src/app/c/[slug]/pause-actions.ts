"use server";

import { refresh } from "next/cache";

import { ClinicSettingsError } from "@/lib/billing/settings";
import { pauseAya, PauseError, resumeAya } from "@/lib/channels/pause";
import { isPauseChoice, pauseClock } from "@/lib/channels/pause-words";
import type { ActorContext } from "@/lib/audit";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { withTenant } from "@/lib/tenant";

/**
 * The header's AYA is answering switch (plan Part F0), on every screen. Each
 * action calls requirePortal(slug) itself; lib/channels/pause.ts writes the
 * pause, its channel_events row and L15 in the clinic's tenant.
 *
 * No step-up, as the spec puts it only where calls and money go somewhere
 * new: a pause sends calls to the direct line the clinic already chose. The
 * pause is stamped with the device whose passkey is live on this session,
 * or the sign-in without one (lib/portal/actor.ts), which is what the banner
 * and L15 name.
 *
 * Each answers in words for the switch's polite status region, and refreshes
 * the page, so the banner, the status words and the switch itself are read
 * again from what was written. A refusal is answered in words; anything else
 * is thrown, for the switch to say something went wrong.
 */

export type PauseActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function pauseAyaAction(slug: string, choice: string): Promise<PauseActionResult> {
  const portal = await requirePortal(String(slug));
  if (!isPauseChoice(choice)) return { ok: false, message: "Choose how long to pause AYA." };
  const actor = await portalActor(portal);
  const context: ActorContext = { type: "user", userId: portal.userId, label: actor.label };
  const now = new Date();
  try {
    const { settings, timeZone } = await withTenant(
      { clinicId: portal.clinicId, actor: context },
      (tx) => pauseAya(tx, { choice, actorLabel: actor.label, now }),
    );
    refresh();
    const until = settings.aiPausedUntil;
    return {
      ok: true,
      message: until
        ? `AYA is paused until ${pauseClock(until, timeZone, now)}. She starts answering again by herself then.`
        : "AYA is paused until someone turns her back on here.",
    };
  } catch (error) {
    if (error instanceof PauseError || error instanceof ClinicSettingsError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

export async function resumeAyaAction(slug: string): Promise<PauseActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const context: ActorContext = { type: "user", userId: portal.userId, label: actor.label };
  try {
    await withTenant({ clinicId: portal.clinicId, actor: context }, (tx) =>
      resumeAya(tx, { actorLabel: actor.label }),
    );
    refresh();
    return { ok: true, message: "AYA is answering again." };
  } catch (error) {
    if (error instanceof PauseError || error instanceof ClinicSettingsError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

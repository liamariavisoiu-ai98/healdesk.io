"use server";

import { disconnectStripeConnect } from "@/lib/billing/connect";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { saveSetting, SENSITIVE_SETTINGS, isSettingKey } from "@/lib/portal/settings";
import { stepUpPath, touchStepUp } from "@/lib/portal/step-up";

/**
 * Settings' server actions (plan Part F2). Each calls requirePortal(slug)
 * itself; lib/portal/settings.ts validates and writes inside the clinic's
 * tenant and words the consequence.
 *
 * A change that needs a passkey step-up and has none answers with the
 * step-up page's address instead of redirecting from inside the action, so
 * the page can say why first; the step-up comes back to Settings, where the
 * change is made again. A change made under a live step-up counts as
 * activity on it.
 */

export type SettingActionResult =
  { ok: true; toast: string } | { ok: false; message: string; stepUpHref?: string };

function settingsPath(slug: string): string {
  return `/c/${slug}/settings`;
}

export async function saveSettingAction(
  slug: string,
  key: string,
  value: unknown,
): Promise<SettingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const result = await saveSetting(
    {
      clinicId: portal.clinicId,
      userId: portal.userId,
      actorLabel: actor.label,
      steppedUp: actor.steppedUp,
    },
    key,
    value,
  );
  if (result.ok) {
    if (actor.steppedUp && isSettingKey(key) && SENSITIVE_SETTINGS.has(key)) {
      await touchStepUp(portal);
    }
    return { ok: true, toast: result.toast };
  }
  return result.needsStepUp
    ? {
        ok: false,
        message: result.message,
        stepUpHref: stepUpPath(portal.clinicSlug, settingsPath(portal.clinicSlug)),
      }
    : { ok: false, message: result.message };
}

/**
 * Disconnect the clinic's Stripe account (Settings → Payments), behind a
 * passkey step-up: connecting or disconnecting the payment account is where
 * money goes (plan Part D4). Package D's disconnect switches deposits off
 * first, closes the open deposit links, revokes our access where no other
 * clinic uses the account, and emails the clinic (O14).
 */
export async function disconnectPaymentsAction(slug: string): Promise<SettingActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!actor.steppedUp) {
    return {
      ok: false,
      message:
        "Disconnecting your payment account needs Face ID or your screen lock on a device you've added.",
      stepUpHref: stepUpPath(portal.clinicSlug, settingsPath(portal.clinicSlug)),
    };
  }
  await touchStepUp(portal);
  const result = await disconnectStripeConnect({
    clinicId: portal.clinicId,
    actorLabel: actor.label,
    source: "portal",
    actor: { type: "user", userId: portal.userId, label: actor.label },
  });
  switch (result.status) {
    case "disconnected":
      return {
        ok: true,
        toast:
          result.uncheckedLinks > 0
            ? "Your Stripe account is disconnected and deposits are off. Some open payment links couldn't be checked, so we've flagged them for your team in case they were paid."
            : "Your Stripe account is disconnected and deposits are off. AYA books without asking for a deposit.",
      };
    case "not_connected":
      return { ok: true, toast: "No Stripe account is connected." };
    case "deauthorize_failed":
      return {
        ok: false,
        message:
          "Deposits are off, but Stripe didn't confirm the disconnection. Try again in a minute, or email hello@healdesk.io.",
      };
  }
}

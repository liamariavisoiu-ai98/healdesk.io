"use server";

import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
import { stepUpPath, touchStepUp } from "@/lib/portal/step-up";
import { requestAddressChange, stopAddressChange } from "@/lib/sign-in/address-change";

import { requestMeta } from "../request-meta";

/**
 * Settings → Sign-in: changing the clinic's one address (plan Part D4, D5).
 *
 * Asking for a change is a sensitive change: it needs a passkey step-up on
 * this session, checked here, because the address is where every sign-in
 * link goes. The new address then confirms with the link we email it, and
 * the change takes effect 72 hours later (lib/sign-in/address-change.ts).
 *
 * Stopping one needs no step-up. It keeps everything as it is, and the
 * person it exists for, whoever holds the old address, may have no device
 * with a passkey at hand: they sign in with a link to the old address and
 * stop it from any browser.
 */

export type AddressActionResult =
  { ok: true; toast: string } | { ok: false; message: string; stepUpHref?: string };

export async function requestAddressChangeAction(
  slug: string,
  newEmail: string,
): Promise<AddressActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  if (!actor.steppedUp) {
    return {
      ok: false,
      message:
        "Changing the clinic's address needs Face ID or your screen lock on a device you've added.",
      stepUpHref: stepUpPath(portal.clinicSlug, `/c/${portal.clinicSlug}/settings`),
    };
  }
  await touchStepUp(portal);
  const meta = await requestMeta();
  const outcome = await requestAddressChange({
    clinicId: portal.clinicId,
    userId: portal.userId,
    newEmail: String(newEmail ?? ""),
    requestedBy: actor.label,
    actor: { type: "user", userId: portal.userId, label: actor.label },
    request: {
      ipAddress: meta.ipAddress ?? undefined,
      userAgent: meta.userAgent ?? undefined,
    },
  });
  if (outcome.status === "refused") return { ok: false, message: outcome.message };
  return outcome.emailed
    ? {
        ok: true,
        toast: `We've emailed a link to ${outcome.change.newEmail}. Nothing changes until it's used.`,
      }
    : {
        ok: true,
        toast:
          "The change is recorded, but the email to the new address didn't go. Stop the change and ask again in a minute.",
      };
}

export async function stopAddressChangeAction(slug: string): Promise<AddressActionResult> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  const meta = await requestMeta();
  const outcome = await stopAddressChange({
    clinicId: portal.clinicId,
    stoppedBy: "clinic",
    label: actor.label,
    actor: { type: "user", userId: portal.userId, label: actor.label },
    request: {
      ipAddress: meta.ipAddress ?? undefined,
      userAgent: meta.userAgent ?? undefined,
    },
  });
  return outcome.status === "stopped"
    ? { ok: true, toast: "Change stopped. The clinic's address stays as it is." }
    : { ok: true, toast: "There was no change under way." };
}

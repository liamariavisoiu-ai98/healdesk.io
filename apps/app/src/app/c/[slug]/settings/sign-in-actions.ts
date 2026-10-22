"use server";

import { removePasskey } from "@/lib/factors/passkeys";
import { someoneLeft } from "@/lib/factors/someone-left";
import { regenerateBackupCodes } from "@/lib/factors/totp";
import { requirePortal } from "@/lib/portal/access";
import { portalAudience } from "@/lib/portal/audience";
import { sessionBinding, stepUpPath } from "@/lib/portal/step-up";

import { requestMeta } from "../request-meta";

/**
 * Settings → Sign-in's server actions (plan Part D3 and F2): removing a
 * device, "Someone left", and a fresh set of backup codes. Each calls
 * requirePortal(slug) itself, and each needs a passkey step-up on this
 * session, which lib/factors checks again inside its own transaction, so
 * the page's view of the step-up is never what decides.
 */

export type SignInActionResult =
  | { ok: true; toast: string; signedOut?: boolean; backupCodes?: string[] }
  | { ok: false; message: string; stepUpHref?: string };

const SIGNED_OUT = "Your sign-in has ended. Sign in again to continue.";

function stepUp(slug: string, message: string): SignInActionResult {
  return { ok: false, message, stepUpHref: stepUpPath(slug, `/c/${slug}/settings`) };
}

export async function removeDeviceAction(
  slug: string,
  factorId: string,
): Promise<SignInActionResult> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: SIGNED_OUT };
  const result = await removePasskey({
    session,
    factorId: String(factorId),
    request: await requestMeta(),
  });
  if (!result.ok) {
    return result.reason === "needs_step_up"
      ? stepUp(
          portal.clinicSlug,
          "Removing a device needs Face ID or your screen lock on a device you've added.",
        )
      : { ok: false, message: "That device isn't on this sign-in any more. Reload the page." };
  }
  // A vet's devices open its clients' details, as Settings words them.
  const one = (await portalAudience(portal)) === "clients" ? "client" : "patient";
  return {
    ok: true,
    toast: result.endedThisSession
      ? "Device removed. This browser stepped up with it, so it's signed out too."
      : `Device removed. It can no longer open ${one} details, and its sessions have ended.`,
    signedOut: result.endedThisSession,
  };
}

export async function someoneLeftAction(
  slug: string,
  factorIds: unknown,
): Promise<SignInActionResult> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: SIGNED_OUT };
  const ids = Array.isArray(factorIds) ? factorIds.filter((id) => typeof id === "string") : [];
  const result = await someoneLeft({
    session,
    removeFactorIds: ids,
    request: await requestMeta(),
  });
  if (!result.ok) {
    return result.reason === "needs_step_up"
      ? stepUp(
          portal.clinicSlug,
          "“Someone left” needs Face ID or your screen lock on a device you've added.",
        )
      : { ok: false, message: "The list of devices changed. Reload the page and try again." };
  }
  return {
    ok: true,
    toast: "Everyone is signed out, and the backup is reset.",
    signedOut: true,
  };
}

export async function newBackupCodesAction(slug: string): Promise<SignInActionResult> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: SIGNED_OUT };
  const result = await regenerateBackupCodes({
    userId: portal.userId,
    sessionTokenHash: session.sessionTokenHash,
    request: await requestMeta(),
  });
  if (!result.ok) {
    return stepUp(
      portal.clinicSlug,
      "New backup codes need Face ID or your screen lock on a device you've added.",
    );
  }
  return {
    ok: true,
    toast: "Ten new backup codes. The old ones no longer work.",
    backupCodes: result.backupCodes,
  };
}

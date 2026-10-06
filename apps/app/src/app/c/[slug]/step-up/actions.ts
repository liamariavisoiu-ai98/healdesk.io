"use server";

import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

import { finishPasskeyAuthentication, startPasskeyAuthentication } from "@/lib/factors/passkeys";
import { requirePortal } from "@/lib/portal/access";
import { portalNext, sessionBinding } from "@/lib/portal/step-up";

import { requestMeta } from "../request-meta";

/**
 * A passkey step-up (plan Part D2), in the two halves a WebAuthn ceremony
 * needs. Each half calls requirePortal(slug) itself, and `next` is checked
 * again here (portalNext), whatever the page passed along.
 */

const SIGNED_OUT = "Your sign-in has ended. Sign in again to continue.";

export type BeginStepUp =
  { ok: true; options: PublicKeyCredentialRequestOptionsJSON } | { ok: false; message: string };

export async function beginStepUp(slug: string): Promise<BeginStepUp> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: SIGNED_OUT };
  const started = await startPasskeyAuthentication({ session });
  if (started.ok) return { ok: true, options: started.options };
  return {
    ok: false,
    message:
      started.reason === "no_passkey"
        ? "This sign-in has no device added yet. Add this one first."
        : "Too many attempts in a row. Wait a few minutes and try again.",
  };
}

export type FinishStepUp = { ok: true; next: string } | { ok: false; message: string };

export async function finishStepUp(
  slug: string,
  input: { response?: unknown; next?: unknown },
): Promise<FinishStepUp> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: SIGNED_OUT };
  const finished = await finishPasskeyAuthentication({
    session,
    response: input?.response,
    request: await requestMeta(),
  });
  if (finished.ok) return { ok: true, next: portalNext(portal.clinicSlug, input?.next) };
  return {
    ok: false,
    message:
      finished.reason === "challenge"
        ? "That took a little too long. Try again."
        : finished.reason === "revoked" || finished.reason === "unknown_credential"
          ? "That passkey isn't on this sign-in any more. Use another device, or add this one."
          : "We couldn't confirm the unlock. Try again.",
  };
}

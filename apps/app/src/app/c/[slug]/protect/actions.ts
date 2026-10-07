"use server";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import {
  finishPasskeyRegistration,
  startPasskeyRegistration,
  type RegistrationFinish,
  type RegistrationStart,
} from "@/lib/factors/passkeys";
import { requirePortal } from "@/lib/portal/access";
import { portalNext, sessionBinding } from "@/lib/portal/step-up";

import { requestMeta } from "../request-meta";

/**
 * Adding this device's passkey (plan Part D3), in the two halves a WebAuthn
 * ceremony needs: options before the browser asks for the unlock, and the
 * passkey after. Each half calls requirePortal(slug) itself; whether this
 * session may add a device at all is decided in lib/factors (authority.ts),
 * never by what the page showed.
 */

type Refusal =
  | Exclude<RegistrationStart, { ok: true }>["reason"]
  | Exclude<RegistrationFinish, { ok: true }>["reason"];

const MESSAGES: Record<Refusal, string> = {
  needs_step_up:
    "This sign-in already has a device that opens patient details. Confirm with that device first, or enter a code from your authenticator app.",
  code_incorrect: "That code didn't work. Check it and try again.",
  code_locked: "Too many wrong codes in a row. Code entry is paused for 15 minutes.",
  too_many_attempts: "Too many attempts in a row. Wait a few minutes and try again.",
  label_invalid: 'Give this device a name of up to 60 characters, like "Front desk Mac".',
  challenge: "That took a little too long. Try again.",
  not_verified: "We couldn't confirm the unlock. Try again.",
  already_registered: "This device is already added. Confirm with it instead.",
};

export type BeginAddDevice =
  { ok: true; options: PublicKeyCredentialCreationOptionsJSON } | { ok: false; message: string };

export async function beginAddDevice(
  slug: string,
  input: { code?: unknown },
): Promise<BeginAddDevice> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: "Your sign-in has ended. Sign in again to continue." };
  const code = typeof input?.code === "string" && input.code.trim() ? input.code : null;
  const started = await startPasskeyRegistration({ session, code, request: await requestMeta() });
  return started.ok
    ? { ok: true, options: started.options }
    : { ok: false, message: MESSAGES[started.reason] };
}

export type FinishAddDevice = { ok: true; next: string } | { ok: false; message: string };

export async function finishAddDevice(
  slug: string,
  input: { label?: unknown; response?: unknown; next?: unknown },
): Promise<FinishAddDevice> {
  const portal = await requirePortal(String(slug));
  const session = await sessionBinding(portal);
  if (!session) return { ok: false, message: "Your sign-in has ended. Sign in again to continue." };
  const finished = await finishPasskeyRegistration({
    session,
    response: input?.response,
    deviceLabel: input?.label,
    request: await requestMeta(),
  });
  return finished.ok
    ? { ok: true, next: portalNext(portal.clinicSlug, input?.next) }
    : { ok: false, message: MESSAGES[finished.reason] };
}

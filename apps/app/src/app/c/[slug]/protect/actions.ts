"use server";

import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { cookies } from "next/headers";

import {
  finishPasskeyRegistration,
  startPasskeyRegistration,
  type RegistrationFinish,
  type RegistrationStart,
} from "@/lib/factors/passkeys";
import { requirePortal } from "@/lib/portal/access";
import { portalAudience } from "@/lib/portal/audience";
import { portalNext, sessionBinding } from "@/lib/portal/step-up";
import { isPayingBrowser, PAYING_BROWSER_COOKIE } from "@/lib/sign-in/paying-browser";

import { requestMeta } from "../request-meta";

import { HUMAN_ROUTE } from "./copy";

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

const MESSAGES: Record<Exclude<Refusal, "needs_step_up">, string> = {
  no_device: `This sign-in has no device to confirm with. Enter a code from your authenticator app or a backup code. ${HUMAN_ROUTE}`,
  code_incorrect: "That code didn't work. Check it and try again.",
  code_locked: "Too many wrong codes in a row. Code entry is paused for 15 minutes.",
  too_many_attempts: "Too many attempts in a row. Wait a few minutes and try again.",
  label_invalid: 'Give this device a name of up to 60 characters, like "Front desk Mac".',
  challenge: "That took a little too long. Try again.",
  not_verified: "We couldn't confirm the unlock. Try again.",
  already_registered: "This device is already added. Confirm with it instead.",
};

/**
 * What finishing says when the basis the page was given is gone (a link of
 * the human route spent in another tab, a step-up lapsed, a clinic gone live
 * mid-way): not "a device already exists", which may be untrue.
 */
const BASIS_GONE = "This device can't be added that way any more. Reload the page to see what it needs.";

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
  const started = await startPasskeyRegistration({
    session,
    code,
    request: await requestMeta(),
    payingBrowser: await payingBrowser(portal.userId),
  });
  if (started.ok) return { ok: true, options: started.options };
  return {
    ok: false,
    message:
      started.reason === "needs_step_up"
        ? await needsStepUp(portal)
        : MESSAGES[started.reason],
  };
}

/** The one refusal that names whose details a device opens: a vet's are its clients'. */
async function needsStepUp(portal: Parameters<typeof portalAudience>[0]): Promise<string> {
  const one = (await portalAudience(portal)) === "clients" ? "client" : "patient";
  return `This sign-in already has a device that opens ${one} details. Confirm with that device first, or enter a code from your authenticator app.`;
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
    // Whether this is the browser that paid, which alone adds a first
    // passkey without the device email (O3), and, for its seven days, the
    // sign-in's first passkey ever after go-live (lib/sign-in/paying-browser.ts).
    payingBrowser: await payingBrowser(portal.userId),
  });
  if (finished.ok) return { ok: true, next: portalNext(portal.clinicSlug, input?.next) };
  return {
    ok: false,
    message: finished.reason === "needs_step_up" ? BASIS_GONE : MESSAGES[finished.reason],
  };
}

/** Whether this request comes from the browser that paid, inside its window. */
async function payingBrowser(userId: string): Promise<boolean> {
  return isPayingBrowser(userId, (await cookies()).get(PAYING_BROWSER_COOKIE)?.value);
}

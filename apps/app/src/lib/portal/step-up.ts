import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { unsafeDb } from "@/db";
import type { SessionBinding } from "@/lib/factors/passkeys";
import {
  endStepUps as endStepUpRows,
  findLiveStepUp,
  hashSessionToken,
  type LiveStepUp,
} from "@/lib/factors/step-ups";
import { isSafeRedirect } from "@/lib/sign-in/links";

import { currentSessionToken, type PortalContext } from "./access";

/**
 * The second factor in front of patient pages and sensitive changes (plan
 * Part D2-D4). The clinic's sign-in is shared and started by a link from an
 * inbox, so the session alone never opens a transcript: a page asks for a
 * passkey step-up on top, from a device the clinic added, and gets back which
 * device it was, for the access log.
 *
 * The rows and the clock live in lib/factors/step-ups.ts. A step-up holds
 * while it has been active in the last 15 minutes and is at most 8 hours old;
 * every successful check counts as activity.
 */

/**
 * `patient_pages`: Conversations, Bookings and transcripts, held open for 15
 * minutes idle and 8 hours at most. `sensitive_change`: the direct line and
 * transfer number, the clinic's address, shortening retention, Stripe
 * connect and disconnect, disconnecting a connected Google Calendar or
 * putting its bookings in another Google account (which the calendar
 * callback checks; a first connection and a reconnect of the same account
 * need none), adding or removing a device, exports.
 */
export type StepUpPurpose = "patient_pages" | "sensitive_change";

/**
 * The passkey that stepped up, and its device's name, which the access log
 * records; `at` is when the passkey was used, not when it was last checked.
 * `stepUpId` is the step_ups row, and `expiresInMs` how long it stays live if
 * nothing touches it again (15 minutes idle or the 8-hour limit, whichever is
 * sooner), counted from this check on the database's clock.
 */
export type StepUp = {
  passkeyId: string;
  deviceLabel: string;
  at: Date;
  stepUpId: string;
  expiresInMs: number;
};

/** The request header src/proxy.ts sets to the path being asked for, for `next`. */
export const PATH_HEADER = "x-healdesk-path";

/**
 * A passkey step-up on this session, live enough for `purpose`, touched so
 * activity keeps it open. Without one, the browser goes to
 * `/c/<slug>/step-up?next=<this page>` and comes back after one tap: redirect()
 * throws, so a caller never runs on without a step-up.
 *
 * Both purposes have the same rule today, and only a passkey satisfies it:
 * the authenticator backup enrols a new device's passkey and never opens a
 * patient page or makes a sensitive change (lib/factors/step-ups.ts holds
 * that for every caller). Patient pages come through requirePatientPage
 * (patient-page.ts), which adds the access log. The returned device label is
 * what the access log and a channel event's `actor` record, so a shared
 * sign-in still says which device did what.
 *
 * `returnTo` is the page to come back to; without it the path the proxy saw
 * is used, and either must be a path on this clinic's portal, or the clinic's
 * Home is.
 */
export async function requireStepUp(
  ctx: PortalContext,
  purpose: StepUpPurpose,
  options: { returnTo?: string } = {},
): Promise<StepUp> {
  void purpose;
  const binding = await sessionBinding(ctx);
  const live = binding ? await findLiveStepUp(unsafeDb, binding, { touch: true }) : null;
  if (live) return asStepUp(live);
  const here = options.returnTo ?? (await headers()).get(PATH_HEADER);
  redirect(stepUpPath(ctx.clinicSlug, here));
}

/**
 * "Keep open": count this as activity without asking for anything. The step-up
 * that is still live, or null once it has lapsed.
 */
export async function touchStepUp(ctx: PortalContext): Promise<StepUp | null> {
  const binding = await sessionBinding(ctx);
  const live = binding ? await findLiveStepUp(unsafeDb, binding, { touch: true }) : null;
  return live ? asStepUp(live) : null;
}

/**
 * End step-ups: a sign-in's ("Someone left"), a session's (by its Better
 * Auth token; sign-out does this itself, lib/auth.ts), or those made with
 * one passkey (removing a device; lib/factors/passkeys.ts does this itself).
 * Returns how many ended.
 */
export async function endStepUps(
  scope: { userId: string } | { sessionToken: string } | { factorId: string },
): Promise<number> {
  if ("sessionToken" in scope) {
    return endStepUpRows({ sessionTokenHash: hashSessionToken(scope.sessionToken) });
  }
  return endStepUpRows(scope);
}

/** This request's session, as the factor tables refer to it, or null when there is none. */
export async function sessionBinding(ctx: PortalContext): Promise<SessionBinding | null> {
  const token = await currentSessionToken();
  return token ? { userId: ctx.userId, sessionTokenHash: hashSessionToken(token) } : null;
}

/**
 * Where a page sends the browser for a step-up. `next` must be this clinic's
 * own portal; anything else, or nothing, comes back to the clinic's Home.
 */
export function stepUpPath(slug: string, next: string | null | undefined): string {
  return `/c/${slug}/step-up?next=${encodeURIComponent(portalNext(slug, next))}`;
}

/**
 * A `next` that may be followed after a step-up or adding a device: a safe
 * same-origin path (isSafeRedirect) inside `/c/<slug>`, or the clinic's Home.
 * A path that URL parsing would change (`/c/glow/../other`, an encoded dot, a
 * fragment) is refused rather than resolved, so the prefix check is made on
 * the path the browser will actually follow.
 */
export function portalNext(slug: string, next: unknown): string {
  const home = `/c/${slug}`;
  if (!isSafeRedirect(next)) return home;
  const resolved = new URL(next, "http://portal.invalid");
  if (
    resolved.origin !== "http://portal.invalid" ||
    `${resolved.pathname}${resolved.search}` !== next
  ) {
    return home;
  }
  return next === home || next.startsWith(`${home}/`) || next.startsWith(`${home}?`) ? next : home;
}

function asStepUp(live: LiveStepUp): StepUp {
  return {
    passkeyId: live.factorId,
    deviceLabel: live.deviceLabel,
    at: live.createdAt,
    stepUpId: live.id,
    expiresInMs: live.expiresInMs,
  };
}

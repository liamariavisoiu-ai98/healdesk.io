"use server";

import { redirect } from "next/navigation";

import { disconnect } from "@/lib/connections/google-calendar";
import { startGoogleConnect } from "@/lib/connections/google-oauth";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { requireStepUp } from "@/lib/portal/step-up";
import { noticeForRefusal, type CalendarNotice } from "@/lib/setup/calendar";

import { requestMeta } from "../request-meta";

/**
 * Setup step 3.1's two buttons (plan Part E; contracts §6): Sign in with
 * Google, and Disconnect. Each is a form posting to this app with the
 * clinic's slug, which requirePortal checks against the sign-in, and each
 * ends in a redirect from outside any try/catch: to Google, to the step-up,
 * or back to the step with `?calendar=` naming what happened, a word from a
 * closed set (lib/setup/calendar.ts).
 *
 * Signing in asks for no step-up, first time or again: the step-up rule
 * covers where calls and money go, and a reconnect of the same account
 * changes neither. Replacing the connected account with another does need
 * one (the portal plan's "step-up to change"), and only Google's answer
 * says which account came back, so the calendar session's callback asks for
 * it there: without a passkey step-up live on the session that returns,
 * another account ends `different_account` (C18). The step tells the clinic
 * to confirm it's them first. Disconnect asks for the step-up here, because
 * after it anyone with the inbox could connect another account as a first
 * connection, which would get round the callback's check.
 */

export async function connectCalendar(form: FormData): Promise<void> {
  const portal = await requirePortal(String(form.get("slug") ?? ""));
  const setup = `/c/${portal.clinicSlug}/setup`;
  const ticked = form.get("disclosure") === "accepted";
  const version = form.get("disclosureVersion");
  let destination: string;
  try {
    const { authUrl } = await startGoogleConnect({
      clinicId: portal.clinicId,
      // The callback comes back here, with ?calendar=<outcome>.
      returnTo: setup,
      // The version of the notice the box was ticked under; unticked, none,
      // which startGoogleConnect refuses as `disclosure`.
      disclosureVersion: ticked && typeof version === "string" ? version : "",
      userId: portal.userId,
    });
    destination = authUrl;
  } catch (error) {
    const notice = noticeForRefusal(error);
    if (notice === "failed") {
      log.error("setup calendar sign-in did not start", {
        clinicId: portal.clinicId,
        error: describeError(error),
      });
    }
    destination = `${setup}?s=calendar&calendar=${notice}`;
  }
  redirect(destination);
}

export async function disconnectCalendar(form: FormData): Promise<void> {
  const portal = await requirePortal(String(form.get("slug") ?? ""));
  const here = `/c/${portal.clinicSlug}/setup?s=calendar`;
  const stepUp = await requireStepUp(portal, "sensitive_change", { returnTo: here });
  const meta = await requestMeta();
  let notice: CalendarNotice;
  try {
    // Already disconnected is the same answer: nothing is connected.
    await disconnect(portal.clinicId, {
      actor: { type: "user", userId: portal.userId, label: stepUp.deviceLabel },
      request: { ipAddress: meta.ipAddress ?? undefined, userAgent: meta.userAgent ?? undefined },
    });
    notice = "disconnected";
  } catch (error) {
    log.error("setup calendar disconnect failed", {
      clinicId: portal.clinicId,
      error: describeError(error),
    });
    notice = "disconnect_failed";
  }
  redirect(`${here}&calendar=${notice}`);
}

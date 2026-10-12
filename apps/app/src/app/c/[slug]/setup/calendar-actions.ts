"use server";

import { redirect } from "next/navigation";

import { disconnect, getCalendarConnection } from "@/lib/connections/google-calendar";
import { startGoogleConnect } from "@/lib/connections/google-oauth";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { portalActor } from "@/lib/portal/actor";
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
 * Connecting the first time needs no step-up: the step-up rule covers where
 * calls and money go, and a value set for the first time never needs one
 * (plan Part D4). Once a calendar is connected, a reconnect may put the
 * bookings in another Google account and a disconnect takes the calendar
 * away (after which anyone with the inbox could connect one again), so both
 * ask for the passkey step-up, as Settings → Calendar's change does (plan
 * Part F2) and as the direct line's change does here.
 */

export async function connectCalendar(form: FormData): Promise<void> {
  const portal = await requirePortal(String(form.get("slug") ?? ""));
  const setup = `/c/${portal.clinicSlug}/setup`;
  const actor = await portalActor(portal);
  const current = await getCalendarConnection(portal.clinicId, {
    actor: { type: "user", userId: portal.userId, label: actor.label },
  });
  if (current.status !== "not_connected") {
    await requireStepUp(portal, "sensitive_change", { returnTo: `${setup}?s=calendar` });
  }

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

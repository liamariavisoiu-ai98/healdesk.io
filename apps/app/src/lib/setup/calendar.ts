/**
 * Setup step 3 and the tracker's calendar stage, behind one seam (plan Part
 * E, 3.1 and 3.2; contracts §6; docs/design/google-calendar-2026-10-05.md §2
 * on calendar/integrate-c1c2).
 *
 * The calendar session builds the Google connection: `getCalendarConnection
 * (clinicId)`, `startGoogleConnect({ clinicId, returnTo, disclosureVersion })
 * → { authUrl }` from a server action on this app, the callback returning to
 * exactly `/c/<slug>/setup` with `?calendar=<outcome>`, and for named
 * providers `listProviderCalendars`, `saveProviders` and
 * `setProviderServices`. None of it is in this build, and before its C19 no
 * real clinic could connect anyway (a 1.2.1 clinic resolves to
 * `needs_election`). So step 3 ships the funnel plan's line, "Bookings arrive
 * as requests your team confirms.", with no button: a button that goes
 * nowhere would break the rule that every link works the day it ships.
 *
 * When the backend lands, this file is where it plugs in, and nowhere else:
 * `calendarStep` returns `{ kind: "connect", … }` from
 * `getCalendarConnection`, the step-3 screen renders
 * GOOGLE_CALENDAR_DISCLOSURE above an unticked box and the Google-branded
 * button, whose server action calls `startGoogleConnect` with
 * `returnTo: /c/<slug>/setup`, and `providersAvailable` turns true once the
 * calendar is connected and the provider functions exist.
 */

/** What step 3 can offer the clinic now. */
export type CalendarStep =
  /** The connection is not available: bookings arrive as requests the team confirms. */
  | { kind: "requests_only" }
  /**
   * Reserved for the backend: whether a calendar is connected and healthy,
   * and the "Right now" sentence its `effectiveBookingMode` gives.
   */
  | { kind: "connect"; connected: boolean; healthy: boolean; rightNow: string };

export async function calendarStep(clinicId: string): Promise<CalendarStep> {
  void clinicId;
  return { kind: "requests_only" };
}

/**
 * Whether the provider functions (`listProviderCalendars`, `saveProviders`,
 * `setProviderServices`) exist in this build. They are the calendar
 * session's, with `clinic_providers`; until they land, 3.2 offers the shared
 * calendar only.
 */
export const PROVIDER_FUNCTIONS_PRESENT = false;

/** Whether setup 3.2 may offer named providers: only with a healthy connected calendar and the provider functions. */
export function providersAvailable(step: CalendarStep): boolean {
  return PROVIDER_FUNCTIONS_PRESENT && step.kind === "connect" && step.connected && step.healthy;
}

/** The "Right now: …" line under Auto-confirm (plan Part E 3.1). */
export function rightNowLine(step: CalendarStep): string {
  return step.kind === "connect"
    ? step.rightNow
    : "Right now: your team confirms each booking AYA takes.";
}

import {
  bookingSyncFor,
  BOOKING_SYSTEMS,
  renderGoogleCalendarDisclosure,
  type CalendarAccount,
  type GoogleCalendarDisclosure,
} from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import {
  effectiveBookingMode,
  type BookingModeReasonCode,
  type EffectiveBookingMode,
} from "@/lib/booking/mode";
import { calendarTermsFor } from "@/lib/booking/terms";
import {
  calendarConnectProblem,
  getCalendarConnection,
  type CalendarConnectionView,
} from "@/lib/connections/google-calendar";
import { GOOGLE_CONNECT_OUTCOMES, GoogleConnectError } from "@/lib/connections/google-oauth";
import { withTenant } from "@/lib/tenant";

import type { SetupScreenId } from "./screen-ids";
import type { SetupSettings } from "./settings";

/**
 * Setup step 3.1, the calendar (plan Part E; contracts §6;
 * docs/design/google-calendar-2026-10-05.md §2), on the calendar session's
 * functions in lib/connections/: whether Sign in with Google can work here,
 * the connection as getCalendarConnection reports it, what the callback's
 * `?calendar=<outcome>` says in words, and the "Right now: …" line under
 * Auto-confirm, from the calendar session's effectiveBookingMode
 * (lib/booking/mode.ts). The button's server action, which calls startGoogleConnect
 * with `returnTo: /c/<slug>/setup`, is app/c/[slug]/setup/calendar-actions.ts;
 * 3.2's named providers are lib/setup/providers.ts.
 *
 * The button is shown only where startGoogleConnect would send the practice
 * to Google: the deployment can ask Google and keep what it grants
 * (calendarConnectProblem: the OAuth client, sealing, the public origin), and
 * the location's calendar terms let healdesk write to a calendar. Everywhere
 * else, which includes a clinic bound to a version before 1.3.0 (none can be
 * provisioned since 1.3.0 became the go-live floor on 12 October 2026), until
 * it records a calendar election (its terms resolve to `needs_election`; the
 * election form is released with 1.3.0), the step says
 * "Bookings arrive as requests your team confirms." with no button: a button
 * that goes nowhere breaks the rule that every link works the day it ships.
 */

/** What step 3.1 can offer the clinic now. */
export type CalendarStep =
  /**
   * Nobody can be sent to Google from here: `unavailable` when this
   * deployment cannot ask Google or keep its grant, `terms` when the
   * location's calendar terms do not let healdesk write to a calendar (none,
   * not used, or an election still to record). Bookings arrive as requests.
   */
  | { kind: "requests_only"; reason: "unavailable" | "terms" }
  /** Sign in with Google works: the connection as it stands, and what the step shows before the button. */
  | {
      kind: "google";
      connection: CalendarConnectionView;
      /** The kind of Google account the location's calendar terms name. */
      account: CalendarAccount;
      /** The data-use notice, for this practice, shown directly above the tick-box and the button. */
      disclosure: GoogleCalendarDisclosure;
    };

export async function calendarStep(
  clinic: { id: string; name: string },
  options: { actor: ActorContext },
): Promise<CalendarStep> {
  if (await calendarConnectProblem()) return { kind: "requests_only", reason: "unavailable" };
  const terms = await withTenant({ clinicId: clinic.id, actor: options.actor }, (tx) =>
    calendarTermsFor(tx),
  );
  if (!terms.allowsWrite) return { kind: "requests_only", reason: "terms" };
  return {
    kind: "google",
    connection: await getCalendarConnection(clinic.id, { actor: options.actor }),
    account: terms.account,
    disclosure: renderGoogleCalendarDisclosure({ clinicName: clinic.name }),
  };
}

/** Where the step's calendar stands, for the lines that depend on it. */
export type CalendarState = "requests_only" | "not_connected" | "connected" | "broken";

export function calendarStateOf(step: CalendarStep): CalendarState {
  if (step.kind === "requests_only") return "requests_only";
  if (step.connection.status === "not_connected") return "not_connected";
  return step.connection.status === "error" ? "broken" : "connected";
}

// -----------------------------------------------------------------------------
// What `?calendar=` says
// -----------------------------------------------------------------------------

/**
 * What `?calendar=` may carry on the setup page: how a sign-in with Google
 * ended (the callback's outcomes, GOOGLE_CONNECT_OUTCOMES), or what one of
 * this step's own buttons did. A closed set, so a crafted URL puts no
 * sentence on the page.
 */
export const CALENDAR_NOTICES = [
  ...GOOGLE_CONNECT_OUTCOMES,
  "disconnected",
  "disconnect_failed",
] as const;
export type CalendarNotice = (typeof CALENDAR_NOTICES)[number];

export function readCalendarNotice(value: unknown): CalendarNotice | null {
  return typeof value === "string" && (CALENDAR_NOTICES as readonly string[]).includes(value)
    ? (value as CalendarNotice)
    : null;
}

/**
 * The screen a setup URL asks for: `?s=` when it names one of the clinic's
 * screens; the calendar screen when Google sent the browser back with only
 * `?calendar=` (the callback returns to exactly `/c/<slug>/setup`); null to
 * resume where the clinic left off.
 */
export function requestedScreen(
  screens: readonly SetupScreenId[],
  s: unknown,
  notice: CalendarNotice | null,
): SetupScreenId | null {
  if (typeof s === "string" && (screens as readonly string[]).includes(s)) {
    return s as SetupScreenId;
  }
  return notice && screens.includes("calendar") ? "calendar" : null;
}

const NOTICE_WORDS: Record<Exclude<CalendarNotice, "mismatch">, string> = {
  connected: "Your Google Calendar is connected.",
  disconnected:
    "Your Google Calendar is disconnected, and healdesk no longer holds access to it. Bookings arrive as requests your team confirms.",
  disconnect_failed: "Something went wrong disconnecting your calendar. Please try again.",
  declined:
    "You didn't allow access in Google, so nothing was connected. Sign in again when you're ready, or skip this for now.",
  admin_blocked:
    "Your Google Workspace administrator has blocked healdesk from your calendar. Ask them to mark healdesk as trusted, then sign in again.",
  failed:
    "Something went wrong connecting your calendar, and nothing was stored. Please try again.",
  scopes:
    "One of the three calendar permissions Google asked about was left unticked, so nothing was stored. Sign in again and leave all three ticked: healdesk needs them to list your calendars, see when they're free or busy, and add its bookings.",
  no_refresh:
    "Google didn't give healdesk lasting access to the calendar, so nothing was stored. Please sign in again.",
  probe:
    "healdesk couldn't check that calendar's free and busy times with Google, or the account isn't the calendar's owner, so nothing was stored. Try again in a few minutes.",
  different_account:
    "You signed in with a different Google account from the one connected, so nothing changed. To move your bookings to that account, confirm it's you with Face ID or your screen lock first (under Reconnect), then sign in with it again.",
  election_needed:
    "That Google account is a different kind of account, or in another Workspace organisation, from the one connected now. Switching to it means updating your calendar terms first, so nothing changed. Write to hello@healdesk.io and we'll help.",
  account_in_use:
    "That Google account is already connected to another healdesk location. Each location connects its own account, so nothing was stored.",
  already_connected: "That sign-in had already been used, so nothing changed.",
  terms:
    "Your calendar terms don't let healdesk use a calendar, so nothing was connected. Bookings arrive as requests your team confirms.",
  disclosure: "Tick the box under the notice before you sign in with Google.",
  unavailable:
    "Connecting a calendar isn't available right now, so nothing was stored. Bookings arrive as requests your team confirms.",
};

/**
 * One notice in plain words. A mismatch says what Google reported about the
 * account (its `hd`): a personal account where the terms name a Workspace
 * one, or the other way round.
 */
export function calendarNoticeWords(
  notice: CalendarNotice,
  account: CalendarAccount | null,
): { tone: "done" | "problem"; text: string } {
  const tone = notice === "connected" || notice === "disconnected" ? "done" : "problem";
  if (notice !== "mismatch") return { tone, text: NOTICE_WORDS[notice] };
  return {
    tone,
    text:
      account === null
        ? "The Google account you signed in with isn't the kind your agreement with healdesk names, so nothing was stored."
        : account === "personal"
          ? "You signed in with a Google Workspace account, but your agreement with healdesk is for a personal Google account, so nothing was stored. Sign in with that personal account."
          : "You signed in with a personal Google account (@gmail.com), but your agreement with healdesk is for a Google Workspace account, so nothing was stored. Sign in with your practice's Workspace account.",
  };
}

/**
 * Whether a notice fits the calendar as it stands, so a stale or crafted
 * address never says "connected" over a step with nothing connected, or
 * "disconnected" over a connected one. A failure fits any state.
 */
export function noticeFits(notice: CalendarNotice, state: CalendarState): boolean {
  if (notice === "connected") return state === "connected";
  if (notice === "disconnected") return state === "not_connected" || state === "requests_only";
  return true;
}

/**
 * The notice for a sign-in refused before anyone reached Google
 * (startGoogleConnect's GoogleConnectError), or `failed` for anything else.
 * `needs_election` cannot reach the button, which is shown only under terms
 * that allow writing, unless the terms changed under the page.
 */
export function noticeForRefusal(error: unknown): CalendarNotice {
  if (!(error instanceof GoogleConnectError)) return "failed";
  switch (error.code) {
    case "unavailable":
      return "unavailable";
    case "terms":
    case "needs_election":
      return "terms";
    case "disclosure":
      return "disclosure";
    case "return_to":
    case "not_member":
      return "failed";
  }
}

// -----------------------------------------------------------------------------
// Auto-confirm's "Right now: …" line
// -----------------------------------------------------------------------------

/**
 * The reasons whose sentence already says that each booking is a request
 * (the catalogue's manual-booking sentence, and Auto-confirm off): the line
 * is that sentence alone. Every other sentence says only what stands in
 * the way, so the line says first what it means for a booking.
 */
const SAYS_REQUESTS: ReadonlySet<BookingModeReasonCode> = new Set([
  "manual_booking_system",
  "auto_confirm_off",
]);

/**
 * The "Right now: …" line under Auto-confirm (plan Part E 3.1): the
 * calendar session's effectiveBookingMode (C9), whose `reason` is the first
 * gate that leaves the location taking requests, in the clinic's words, and
 * null exactly when AYA books straight into the calendar. The mode is
 * derived fresh on every read, so the line is what is true as the page
 * renders, whatever the step above it shows.
 */
export function rightNowLine(mode: EffectiveBookingMode): string {
  if (mode.mode === "direct" || mode.reason === null) {
    return "Right now: AYA books straight into your calendar.";
  }
  if (SAYS_REQUESTS.has(mode.reason.code)) return `Right now: ${mode.reason.sentence}`;
  return `Right now: your team confirms each booking AYA takes. ${mode.reason.sentence}`;
}

/** Auto-confirm as step 3.1 shows it. */
export type AutoConfirmView = {
  /** The clinic's switch, as saved. */
  on: boolean;
  /** effectiveBookingMode's answer now, as the "Right now" line. */
  rightNow: string;
  /**
   * What the switch becomes once the picker's answer is saved, for each
   * booking system it can hold: saveSetupSettings turns it on where a new
   * system reads Google Calendar and off where it does not, and leaves it
   * as it is for the system already saved.
   */
  onceSaved: Record<string, boolean>;
};

export function autoConfirmView(
  settings: Pick<SetupSettings, "bookingSystem" | "autoConfirmBookings">,
  mode: EffectiveBookingMode,
): AutoConfirmView {
  return {
    on: settings.autoConfirmBookings,
    rightNow: rightNowLine(mode),
    onceSaved: Object.fromEntries(
      BOOKING_SYSTEMS.map((system) => [
        system.id,
        system.id === settings.bookingSystem
          ? settings.autoConfirmBookings
          : bookingSyncFor(system.id) === "live",
      ]),
    ),
  };
}

/** Auto-confirm for the step, with the location's booking mode read now. */
export async function autoConfirmFor(
  clinicId: string,
  settings: Pick<SetupSettings, "bookingSystem" | "autoConfirmBookings">,
  options: { actor: ActorContext },
): Promise<AutoConfirmView> {
  return autoConfirmView(settings, await effectiveBookingMode(clinicId, options));
}

import { getBookingSystem, type GoogleCalendarDisclosure } from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import {
  effectiveBookingMode,
  type BookingModeReasonCode,
  type EffectiveBookingMode,
} from "@/lib/booking/mode";
import { renderPracticeCalendarDisclosure } from "@/lib/connections/calendar-disclosure";
import {
  calendarConnectProblem,
  getCalendarConnection,
  type CalendarConnectionView,
} from "@/lib/connections/google-calendar";
import { isGoogleConnectOutcome, type GoogleConnectOutcome } from "@/lib/connections/google-oauth";
import type { SetupSettings } from "@/lib/setup/settings";
import { withTenant } from "@/lib/tenant";

/**
 * Settings → Calendar (plan Part F2's card: "Connected calendar [Change]
 * [Reconnect] [Disconnect] (step-up to change); booking system; Auto-confirm
 * (On) with 'Right now: …'; booking detail (Generic)"), over the calendar
 * session's functions: getCalendarConnection and effectiveBookingMode here,
 * startGoogleConnect, disconnect, setAutoConfirm, listCalendars,
 * chooseCalendar and the provider functions in the card's server actions
 * (app/c/[slug]/settings/calendar-actions.ts).
 *
 * The card offers no button that cannot work: a sign-in with Google is
 * offered only when one could start now (healdesk's Google client is set,
 * a token could be sealed, and the location's calendar terms let healdesk
 * write to a calendar); otherwise the card says why, in the clinic's words.
 * Business data only: the account's address is the clinic's own, shown to
 * it and nowhere else.
 */

export type CalendarHealth = "healthy" | "needs_reconnect" | "unreachable";

export type CalendarCardView = {
  slug: string;
  /** A sign-in with Google could start from this card now. */
  canConnect: boolean;
  /** Why it cannot, in the clinic's words, when it cannot. */
  blockedLine: string | null;
  connection: {
    email: string | null;
    account: string;
    /** The calendar booked into: the account's main one, or another it chose. */
    calendar: string;
    health: CalendarHealth;
    /** What is wrong and what puts it right, when it is not healthy. */
    healthLine: string | null;
    lastCheckedAt: Date | null;
  } | null;
  disclosure: GoogleCalendarDisclosure;
  bookingSystem: string | null;
  autoConfirm: boolean;
  mode: "direct" | "requests";
  rightNow: string;
  bookingDetail: "generic" | "named_provider";
  /** Named providers can be set up: a healthy connection Google can be asked about. */
  providersPossible: boolean;
  /** What the last sign-in with Google came back with (`?calendar=`), or null. */
  outcome: { ok: boolean; text: string } | null;
};

/**
 * The reasons that mean no sign-in can start: what startGoogleConnect would
 * refuse (`unavailable`, `terms`, `needs_election`), and a location leaving
 * healdesk, which the callback refuses.
 */
const CONNECT_BLOCKERS: ReadonlySet<BookingModeReasonCode> = new Set<BookingModeReasonCode>([
  "offboarding",
  "no_agreement",
  "needs_election",
  "manual_booking_system",
  "google_not_configured",
]);

const UNAVAILABLE = "Connecting a calendar isn't available yet.";

export async function readCalendarCard(input: {
  slug: string;
  clinicId: string;
  /** The practice's name, which Google's notice names (renderPracticeCalendarDisclosure). */
  clinicName: string;
  settings: Pick<SetupSettings, "bookingSystem" | "autoConfirmBookings" | "bookingDetail">;
  actor: ActorContext;
  outcome?: unknown;
}): Promise<CalendarCardView> {
  const [mode, connection, problem, disclosure] = await Promise.all([
    effectiveBookingMode(input.clinicId, { actor: input.actor }),
    getCalendarConnection(input.clinicId, { actor: input.actor }),
    calendarConnectProblem(),
    // Rendered with the practice's name, as the wizard and the link page do,
    // in the practice's own wording: the BAA's, or the DPA's for its audience.
    withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
      renderPracticeCalendarDisclosure(tx, input.clinicName),
    ),
  ]);
  const blocker = mode.reasons.find((reason) => CONNECT_BLOCKERS.has(reason.code));
  const blockedLine = blocker
    ? blocker.code === "google_not_configured"
      ? UNAVAILABLE
      : blocker.sentence
    : problem
      ? UNAVAILABLE
      : null;
  const shown = connectionOf(connection, mode);
  return {
    slug: input.slug,
    canConnect: blockedLine === null,
    blockedLine,
    connection: shown,
    disclosure,
    bookingSystem: input.settings.bookingSystem
      ? (getBookingSystem(input.settings.bookingSystem)?.label ?? null)
      : null,
    autoConfirm: input.settings.autoConfirmBookings,
    mode: mode.mode,
    rightNow: rightNowOf(mode),
    bookingDetail: input.settings.bookingDetail,
    providersPossible: blockedLine === null && shown?.health === "healthy",
    outcome: outcomeOf(input.outcome),
  };
}

function connectionOf(
  view: CalendarConnectionView,
  mode: EffectiveBookingMode,
): CalendarCardView["connection"] {
  if (view.status === "not_connected" || view.status === "pending") return null;
  const broken = view.status === "error" || view.brokenAt !== null;
  const health: CalendarHealth = broken
    ? "needs_reconnect"
    : view.status === "degraded"
      ? "unreachable"
      : "healthy";
  const mismatch = mode.reasons.find((r) => r.code === "calendar_account_mismatch");
  const healthLine = broken
    ? "The connection stopped working, so bookings arrive as requests. Reconnect it to put it right."
    : view.status === "degraded"
      ? "healdesk can't reach your Google Calendar right now. We keep trying, and email you if it stays down."
      : !view.disclosureCurrent
        ? "Reconnect to accept healdesk's updated notice; until then bookings arrive as requests."
        : mismatch
          ? mismatch.sentence
          : null;
  return {
    email: view.account.email,
    account:
      view.account.kind === "workspace"
        ? `a Google Workspace account${view.account.domain ? ` (${view.account.domain})` : ""}`
        : view.account.kind === "personal"
          ? "a personal Google account"
          : "a Google account",
    calendar: view.calendar.primary ? "its main calendar" : "another calendar on this account",
    health,
    healthLine,
    lastCheckedAt: view.lastVerifiedAt,
  };
}

/** The "Right now: …" line under Auto-confirm (plan Part E 3.1, F2), from the mode's first reason. */
export function rightNowOf(mode: Pick<EffectiveBookingMode, "mode" | "reason">): string {
  if (mode.mode === "direct" || !mode.reason) {
    return "Right now: AYA books straight into your calendar.";
  }
  if (mode.reason.code === "auto_confirm_off") return `Right now: ${mode.reason.sentence}`;
  return `Right now: bookings arrive as requests your team confirms. ${mode.reason.sentence}`;
}

/**
 * What a sign-in with Google came back with, as the portal says it: the
 * callback's closed set (`?calendar=`), worded for Settings. Anything else
 * says nothing.
 */
const OUTCOMES: Record<GoogleConnectOutcome, { ok: boolean; text: string }> = {
  connected: {
    ok: true,
    text: "Your Google Calendar is connected. AYA books into it as your Auto-confirm switch says.",
  },
  declined: { ok: false, text: "You didn't allow access in Google, so nothing was connected." },
  admin_blocked: {
    ok: false,
    text: "Your Google Workspace administrator has blocked healdesk from your calendar. Ask them to mark healdesk as trusted, then try again.",
  },
  failed: {
    ok: false,
    text: "Something went wrong connecting your calendar. Nothing was stored; please try again.",
  },
  scopes: {
    ok: false,
    text: "Please leave every calendar permission ticked when Google asks: healdesk needs them to read free and busy times and add its bookings. Nothing was stored.",
  },
  no_refresh: {
    ok: false,
    text: "Google didn't give healdesk lasting access to the calendar. Nothing was stored; please try again.",
  },
  probe: {
    ok: false,
    text: "healdesk couldn't read that calendar's free and busy times, or the account isn't the calendar's owner. Nothing was stored.",
  },
  mismatch: {
    ok: false,
    text: "That Google account isn't the kind your calendar terms name, so nothing was stored.",
  },
  different_account: {
    ok: false,
    text: "You signed in with a different Google account from the one connected, so nothing changed. Changing the account needs Face ID or your screen lock first: use Change.",
  },
  election_needed: {
    ok: false,
    text: "That account needs the practice owner to record a calendar election for it first. Nothing changed.",
  },
  account_in_use: {
    ok: false,
    text: "That Google account is already connected to another healdesk account; nothing was stored.",
  },
  already_connected: { ok: true, text: "Your calendar was already connected." },
  terms: { ok: false, text: "This location's calendar terms don't let healdesk use a calendar." },
  disclosure: {
    ok: false,
    text: "Please tick the box under the notice before signing in with Google.",
  },
  unavailable: { ok: false, text: UNAVAILABLE },
};

export function outcomeOf(value: unknown): CalendarCardView["outcome"] {
  return isGoogleConnectOutcome(value) ? OUTCOMES[value] : null;
}

/** Why a sign-in could not start, by the word the callback would have used. */
export function connectRefusalText(outcome: GoogleConnectOutcome): string {
  return OUTCOMES[outcome].text;
}

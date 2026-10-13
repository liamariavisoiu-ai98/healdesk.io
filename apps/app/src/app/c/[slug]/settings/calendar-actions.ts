"use server";

import type { ActorContext } from "@/lib/audit";
import { setAutoConfirm } from "@/lib/booking/mode";
import {
  chooseCalendar,
  disconnect,
  listCalendars,
  listProviderCalendars,
  saveProviders,
  setProviderServices,
  type CalendarTargetRefusal,
} from "@/lib/connections/google-calendar";
import {
  connectOutcomeOf,
  GoogleConnectError,
  startGoogleConnect,
} from "@/lib/connections/google-oauth";
import { describeError, log } from "@/lib/log";
import { requirePortal, type PortalContext } from "@/lib/portal/access";
import { portalActor, type PortalActor } from "@/lib/portal/actor";
import { connectRefusalText, rightNowOf } from "@/lib/portal/settings-calendar";
import { stepUpPath, touchStepUp } from "@/lib/portal/step-up";
import { readKnowledge } from "@/lib/setup/knowledge";
import { saveSetupSettings } from "@/lib/setup/settings";
import { withTenant } from "@/lib/tenant";

/**
 * Settings → Calendar's server actions (plan Part F2), over the calendar
 * session's functions, which are theirs to change (lib/connections/*,
 * lib/booking/mode.ts). Each calls requirePortal(slug) itself and acts as
 * the portal user, labelled as every portal change is.
 *
 * A passkey step-up where the plan says "step-up to change": disconnecting
 * the calendar, changing the Google account or the calendar booked into, and
 * Auto-confirm (the funnel's contract: setAutoConfirm is "behind step-up").
 * A first connect and a reconnect of the same account need none, as the
 * start route says; the callback asks again for a different account.
 * Without one the action answers with the step-up page's address, so the
 * card says why before the browser goes there.
 */

export type CalendarActionResult =
  | { ok: true; toast: string; href?: string; rightNow?: string }
  | { ok: false; message: string; stepUpHref?: string };

const SOMETHING_WRONG = "Something went wrong on our side. Try again in a moment.";

function settingsPath(slug: string): string {
  return `/c/${slug}/settings`;
}

async function portalFor(
  slug: unknown,
): Promise<{ portal: PortalContext; actor: PortalActor; as: ActorContext }> {
  const portal = await requirePortal(String(slug));
  const actor = await portalActor(portal);
  return { portal, actor, as: { type: "user", userId: portal.userId, label: actor.label } };
}

function needsStepUp(portal: PortalContext, why: string): CalendarActionResult {
  return {
    ok: false,
    message: `${why} needs Face ID or your screen lock on a device you've added.`,
    stepUpHref: stepUpPath(portal.clinicSlug, settingsPath(portal.clinicSlug)),
  };
}

// -----------------------------------------------------------------------------
// The connection
// -----------------------------------------------------------------------------

/**
 * Start a sign-in with Google from Settings: Google's consent URL to send
 * the browser to, which comes back to Settings with `?calendar=<outcome>`.
 * `change` is "use a different Google account", behind a step-up.
 */
export async function connectCalendarAction(
  slug: string,
  input: { disclosureVersion: unknown; change?: unknown },
): Promise<CalendarActionResult> {
  const { portal, actor } = await portalFor(slug);
  if (input.change === true) {
    if (!actor.steppedUp) return needsStepUp(portal, "Changing the Google account");
    await touchStepUp(portal);
  }
  try {
    const { authUrl } = await startGoogleConnect({
      clinicId: portal.clinicId,
      returnTo: settingsPath(portal.clinicSlug),
      disclosureVersion: typeof input.disclosureVersion === "string" ? input.disclosureVersion : "",
      userId: portal.userId,
    });
    return { ok: true, toast: "Opening Google…", href: authUrl };
  } catch (error) {
    if (error instanceof GoogleConnectError) {
      return { ok: false, message: connectRefusalText(connectOutcomeOf(error.code)) };
    }
    log.error("calendar sign-in could not start from Settings", {
      clinicId: portal.clinicId,
      error: describeError(error),
    });
    return { ok: false, message: SOMETHING_WRONG };
  }
}

/** Take the location's Google Calendar away, behind a step-up. */
export async function disconnectCalendarAction(slug: string): Promise<CalendarActionResult> {
  const { portal, actor, as } = await portalFor(slug);
  if (!actor.steppedUp) return needsStepUp(portal, "Disconnecting your calendar");
  await touchStepUp(portal);
  const result = await disconnect(portal.clinicId, { actor: as });
  return result.status === "disconnected"
    ? {
        ok: true,
        toast:
          "Your Google Calendar is disconnected. Bookings arrive as requests your team confirms until you connect one again.",
      }
    : { ok: true, toast: "No Google Calendar is connected." };
}

export type CalendarChoice = { id: string; name: string; current: boolean };

/** The calendars the connected account may book into, for "Choose another calendar". */
export async function listCalendarsAction(
  slug: string,
): Promise<{ ok: true; calendars: CalendarChoice[] } | { ok: false; message: string }> {
  const { portal, as } = await portalFor(slug);
  const listed = await listCalendars(portal.clinicId, { actor: as });
  if (listed.status === "refused") return { ok: false, message: targetRefusal(listed.reason) };
  if (listed.status !== "ok") return { ok: false, message: listingProblem(listed.status) };
  return {
    ok: true,
    calendars: listed.calendars.map((calendar) => ({
      id: calendar.primary ? "primary" : calendar.id,
      name: calendar.primary
        ? `${calendar.name ?? "Main calendar"} (main)`
        : (calendar.name ?? "A calendar with no name"),
      current: calendar.current,
    })),
  };
}

/** Book into another of the account's calendars, behind a step-up. */
export async function chooseCalendarAction(
  slug: string,
  calendarId: unknown,
): Promise<CalendarActionResult> {
  const { portal, actor, as } = await portalFor(slug);
  if (!actor.steppedUp) return needsStepUp(portal, "Changing the calendar AYA books into");
  if (typeof calendarId !== "string") return { ok: false, message: "Choose a calendar." };
  await touchStepUp(portal);
  const result = await chooseCalendar(portal.clinicId, calendarId, { actor: as });
  switch (result.status) {
    case "chosen":
      return {
        ok: true,
        toast: result.changed
          ? "Saved. AYA books into that calendar from now on."
          : "That's already the calendar AYA books into.",
      };
    case "refused":
      return { ok: false, message: targetRefusal(result.reason) };
    default:
      return { ok: false, message: listingProblem(result.status) };
  }
}

// -----------------------------------------------------------------------------
// Auto-confirm
// -----------------------------------------------------------------------------

/** Switch Auto-confirm, behind a step-up, and say what the mode is now. */
export async function setAutoConfirmAction(
  slug: string,
  on: unknown,
): Promise<CalendarActionResult> {
  const { portal, actor, as } = await portalFor(slug);
  if (typeof on !== "boolean") return { ok: false, message: "Choose on or off." };
  if (!actor.steppedUp) return needsStepUp(portal, "Changing Auto-confirm");
  await touchStepUp(portal);
  const result = await setAutoConfirm(portal.clinicId, on, as);
  const rightNow = rightNowOf(result);
  return {
    ok: true,
    toast: result.autoConfirm
      ? `Auto-confirm on: a booking AYA takes goes straight into your calendar whenever it can. ${rightNow}`
      : `Auto-confirm off: every booking AYA takes is a request your team confirms. ${rightNow}`,
    rightNow,
  };
}

// -----------------------------------------------------------------------------
// Booking detail: one shared calendar, or named providers
// -----------------------------------------------------------------------------

export type ProviderRow = {
  id: string | null;
  displayName: string;
  calendarId: string;
  services: string[];
};

export type ProvidersLoad =
  | {
      ok: true;
      providers: ProviderRow[];
      calendars: CalendarChoice[];
      /** The clinic's own services, from Knowledge, which a provider can offer. */
      services: string[];
    }
  | { ok: false; message: string };

/** The named providers, the calendars they can be given, and the services they can offer. */
export async function loadProvidersAction(slug: string): Promise<ProvidersLoad> {
  const { portal, as } = await portalFor(slug);
  const listed = await listProviderCalendars(portal.clinicId, { actor: as });
  if (listed.status === "refused") return { ok: false, message: targetRefusal(listed.reason) };
  if (listed.status !== "ok") return { ok: false, message: listingProblem(listed.status) };
  const knowledge = await withTenant({ clinicId: portal.clinicId, actor: as }, (tx) =>
    readKnowledge(tx.db, tx.clinicId),
  );
  const services = knowledge.services.map((service) => service.name);
  const nameOfKey = new Map(services.map((name) => [name.trim().toLowerCase(), name]));
  return {
    ok: true,
    // A provider whose calendar the account can no longer book into (deleted,
    // or no longer shared) is shown with no calendar, so it is chosen again.
    providers: listed.providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      calendarId: provider.calendarAvailable === false ? "" : provider.calendarId,
      services: provider.services
        .map((key) => nameOfKey.get(key))
        .filter((name): name is string => name !== undefined),
    })),
    calendars: listed.calendars.map((calendar) => ({
      id: calendar.primary ? "primary" : calendar.id,
      name: calendar.primary
        ? `${calendar.name ?? "Main calendar"} (main)`
        : (calendar.name ?? "A calendar with no name"),
      current: calendar.current,
    })),
    services,
  };
}

/**
 * Save the named providers, each with their own calendar and the services
 * they offer, and book by provider; an empty list goes back to one shared
 * calendar. No step-up: it changes who a booking is with, not where calls
 * or money go.
 */
export async function saveProvidersAction(
  slug: string,
  rows: unknown,
): Promise<CalendarActionResult> {
  const { portal, as } = await portalFor(slug);
  if (!Array.isArray(rows)) return { ok: false, message: "Add at least one provider." };
  const wanted = rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      id: typeof r.id === "string" && r.id ? r.id : null,
      displayName: typeof r.displayName === "string" ? r.displayName : "",
      calendarId: typeof r.calendarId === "string" ? r.calendarId : "",
      services: Array.isArray(r.services)
        ? r.services.filter((s): s is string => typeof s === "string")
        : [],
    };
  });
  if (wanted.length === 0) return { ok: false, message: "Add at least one provider." };

  const saved = await saveProviders(
    portal.clinicId,
    wanted.map(({ id, displayName, calendarId }) => ({ id, displayName, calendarId })),
    { actor: as },
  );
  if (saved.status === "refused") {
    const which = saved.index === null ? "" : `Provider ${saved.index + 1}: `;
    return { ok: false, message: `${which}${providerRefusal(saved.reason)}` };
  }
  if (saved.status !== "saved") return { ok: false, message: listingProblem(saved.status) };

  for (const [index, provider] of saved.providers.entries()) {
    const mapped = await setProviderServices(
      portal.clinicId,
      provider.id,
      wanted[index]!.services,
      { actor: as },
    );
    if (mapped.status !== "saved") {
      return {
        ok: false,
        message: `Provider ${index + 1}: ${
          mapped.reason === "unknown_service"
            ? "a service isn't on your price list any more. Reload the page and choose again."
            : "their services couldn't be saved. Reload the page and try again."
        }`,
      };
    }
  }
  await setBookingDetail(portal, as, "named_provider");
  return {
    ok: true,
    toast:
      saved.providers.length === 1
        ? "One named provider saved. AYA books each service with them, on their own calendar."
        : `${saved.providers.length} named providers saved. AYA books each service with a provider who offers it, on that provider's own calendar.`,
  };
}

/** Back to one shared calendar: AYA books any free time and the team decides who sees each person. */
export async function sharedCalendarAction(slug: string): Promise<CalendarActionResult> {
  const { portal, as } = await portalFor(slug);
  await setBookingDetail(portal, as, "generic");
  return {
    ok: true,
    toast:
      "AYA books any free time in your calendar, and your team decides who sees each person. Your named providers are kept in case you go back.",
  };
}

async function setBookingDetail(
  portal: PortalContext,
  as: ActorContext,
  detail: "generic" | "named_provider",
): Promise<void> {
  await withTenant({ clinicId: portal.clinicId, actor: as }, (tx) =>
    saveSetupSettings(tx, { bookingDetail: detail }, as.type === "user" ? as.label : "portal"),
  );
}

// -----------------------------------------------------------------------------
// Words
// -----------------------------------------------------------------------------

function listingProblem(status: "not_connected" | "unavailable" | "failed"): string {
  switch (status) {
    case "not_connected":
      return "Your Google Calendar isn't connected.";
    case "unavailable":
      return "Connecting a calendar isn't available yet.";
    case "failed":
      return "healdesk couldn't get your calendars from Google just now. Try again in a minute; if it keeps happening, reconnect your calendar.";
  }
}

function targetRefusal(reason: CalendarTargetRefusal): string {
  switch (reason) {
    case "terms":
      return "This location's calendar terms don't let healdesk use a calendar.";
    case "unmanaged_account":
    case "account_mismatch":
      return "The Google account connected isn't the kind of account your calendar terms name.";
    case "outside_organisation":
      return "Under your calendar terms AYA can only book into your own organisation's calendars. Choose one of those.";
    case "not_owned":
      return "That calendar can't be used: the connected account has to own it. Choose one from the list.";
    case "unverified":
      return "healdesk couldn't check that calendar with Google just now. Try again in a minute.";
    case "offboarding":
      return "Your healdesk service has ended, so healdesk no longer uses your calendar.";
  }
}

function providerRefusal(
  reason: Extract<Awaited<ReturnType<typeof saveProviders>>, { status: "refused" }>["reason"],
): string {
  switch (reason) {
    case "invalid_name":
      return "give them a name, up to 80 characters.";
    case "invalid_calendar":
      return "choose their calendar.";
    case "duplicate_calendar":
      return "each provider needs a calendar of their own.";
    case "unknown_provider":
      return "this provider has changed. Reload the page and try again.";
    case "too_many":
      return "that's more providers than one location can have.";
    default:
      return lowerFirst(targetRefusal(reason));
  }
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

import type { BookingDetail, ClinicProfile } from "@healdesk/catalog";

import type { ActorContext } from "@/lib/audit";
import {
  listProviderCalendars,
  MAX_PROVIDERS,
  saveProviders,
  serviceKeyOf,
  setProviderServices,
  type SaveProvidersOutcome,
} from "@/lib/connections/google-calendar";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { calendarStep } from "./calendar";
import { readKnowledge } from "./knowledge";
import type { SaveContext } from "./save";

/**
 * Setup step 3.2: any available time, or named providers (plan Part E 3.2;
 * the spec's provider-specific booking; calendar contract §2 and §4), on the
 * calendar session's listProviderCalendars, saveProviders and
 * setProviderServices.
 *
 * Named providers are offered only when listProviderCalendars returns
 * calendars to give them, which needs what 3.1's button needs (a deployment
 * that can ask Google, terms that allow writing) and a connected account
 * whose calendar list Google answered: the calendar-list scope is what makes
 * the list. Otherwise the step offers the shared calendar only.
 *
 * Each provider is saved with a name, one calendar of their own on the
 * connected account (checked by saveProviders as the location's own calendar
 * is, HRC-04 included) and the services they offer from the clinic's own
 * list. clinic_settings.booking_detail becomes `named_provider` only once
 * that list is saved; any refusal leaves it as it was.
 */

/** A provider as the 3.2 form holds one: services by the clinic's own names. */
export type ProviderRow = {
  id: string | null;
  displayName: string;
  /** "primary" for the account's main calendar; null when one has to be chosen (again). */
  calendarId: string | null;
  services: string[];
};

export type ProvidersStep =
  | {
      kind: "named";
      /** What a provider's calendar may be, primary first; the main calendar's id is "primary". */
      calendars: { id: string; name: string; primary: boolean }[];
      /** The active providers, or, before any is saved, the people the website read named. */
      providers: ProviderRow[];
    }
  /**
   * The shared calendar only: `no_calendar` with nothing connected, or
   * nothing that could be (3.1 shows requests only); `failed` when Google
   * could not list the connected account's calendars just now.
   */
  | { kind: "generic_only"; reason: "no_calendar" | "failed" };

export async function providersStep(
  clinic: {
    id: string;
    name: string;
    services: readonly string[];
    siteProfile: ClinicProfile | null;
  },
  options: { actor: ActorContext },
): Promise<ProvidersStep> {
  const step = await calendarStep(clinic, options);
  if (step.kind !== "google" || step.connection.status === "not_connected") {
    return { kind: "generic_only", reason: "no_calendar" };
  }
  let listed: Awaited<ReturnType<typeof listProviderCalendars>>;
  try {
    listed = await listProviderCalendars(clinic.id, { actor: options.actor });
  } catch (error) {
    log.error("setup could not list provider calendars", {
      clinicId: clinic.id,
      error: describeError(error),
    });
    return { kind: "generic_only", reason: "failed" };
  }
  if (listed.status === "failed") return { kind: "generic_only", reason: "failed" };
  if (listed.status !== "ok" || listed.calendars.length === 0) {
    return { kind: "generic_only", reason: "no_calendar" };
  }
  // Services are stored as keys; the form shows the clinic's own names, and
  // a key the list no longer holds is dropped (it could not be saved again).
  const byKey = new Map(clinic.services.map((name) => [serviceKeyOf(name), name]));
  const saved: ProviderRow[] = listed.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    // A calendar the account no longer lists is chosen again.
    calendarId: provider.calendarAvailable === false ? null : provider.calendarId,
    services: provider.services.flatMap((key) => byKey.get(key) ?? []),
  }));
  const read: ProviderRow[] = (clinic.siteProfile?.providers ?? [])
    .slice(0, MAX_PROVIDERS)
    .map((person) => ({ id: null, displayName: person.name, calendarId: null, services: [] }));
  return {
    kind: "named",
    calendars: listed.calendars.map((calendar) => ({
      id: calendar.primary ? "primary" : calendar.id,
      name: calendar.name ?? "Untitled calendar",
      primary: calendar.primary,
    })),
    providers: saved.length > 0 ? saved : read,
  };
}

export type NamedProvidersResult =
  /** What booking_detail becomes; null leaves the saved answer as it is. */
  { ok: true; bookingDetail: BookingDetail | null } | { ok: false; field: string; message: string };

/**
 * Before the providers screen's own transaction: for `named_provider`, check
 * the form, then save the providers and each one's services through the
 * calendar functions, each in a transaction of its own (Google is asked
 * about the calendars, and never inside a transaction). `generic` saves
 * nothing here and leaves any providers as they are: the setting decides
 * whether they are used. A form that asks nothing, which is what the screen
 * sends while Google cannot list the calendars of a clinic that already
 * books by provider, changes nothing: an outage never turns named providers
 * off.
 */
export async function saveNamedProviders(
  ctx: SaveContext,
  input: unknown,
): Promise<NamedProvidersResult> {
  const body = (input ?? {}) as Record<string, unknown>;
  if (body.bookingDetail === undefined) return { ok: true, bookingDetail: null };
  if (body.bookingDetail === "generic") return { ok: true, bookingDetail: "generic" };
  if (body.bookingDetail !== "named_provider") {
    return {
      ok: false,
      field: "bookingDetail",
      message: "Choose any available time, or a named provider.",
    };
  }
  const actor: ActorContext = { type: "user", userId: ctx.userId, label: ctx.actorLabel };
  const services = (
    await withTenant({ clinicId: ctx.clinicId, actor }, (tx) => readKnowledge(tx.db, ctx.clinicId))
  ).services.map((service) => service.name);
  const rows = readRows(body.providers, services);
  if (!rows.ok) return rows;

  const saved = await saveProviders(
    ctx.clinicId,
    rows.providers.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      calendarId: row.calendarId,
    })),
    { actor },
  );
  if (saved.status !== "saved") return { ok: false, ...refusalWords(saved, rows.providers) };

  // saveProviders answers in the order it was given.
  for (const [index, provider] of saved.providers.entries()) {
    const mapped = await setProviderServices(
      ctx.clinicId,
      provider.id,
      rows.providers[index]!.services,
      { actor },
    );
    if (mapped.status !== "saved") {
      return {
        ok: false,
        field: `providers[${index}].services`,
        message: `${provider.displayName}'s services changed while you were choosing them. Reload the page and try again.`,
      };
    }
  }
  return { ok: true, bookingDetail: "named_provider" };
}

type CheckedRow = {
  id: string | null;
  displayName: string;
  calendarId: string;
  services: string[];
};

function readRows(
  raw: unknown,
  services: readonly string[],
): { ok: true; providers: CheckedRow[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      field: "providers",
      message: "Add at least one provider, or choose any available time.",
    };
  }
  if (raw.length > MAX_PROVIDERS) {
    return { ok: false, field: "providers", message: `Add up to ${MAX_PROVIDERS} providers.` };
  }
  const offered = new Map(services.map((name) => [serviceKeyOf(name), name]));
  const providers: CheckedRow[] = [];
  for (const [index, entry] of raw.entries()) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    if (!displayName) {
      return {
        ok: false,
        field: `providers[${index}].name`,
        message: "Give each provider a name.",
      };
    }
    if (typeof row.calendarId !== "string" || row.calendarId === "") {
      return {
        ok: false,
        field: `providers[${index}].calendar`,
        message: `Choose ${displayName}'s calendar.`,
      };
    }
    const chosen = Array.isArray(row.services) ? row.services : [];
    const named: string[] = [];
    for (const service of chosen) {
      const name = typeof service === "string" ? offered.get(serviceKeyOf(service)) : undefined;
      if (!name) {
        return {
          ok: false,
          field: `providers[${index}].services`,
          message: `One of ${displayName}'s services isn't on your list any more. Reload the page and try again.`,
        };
      }
      if (!named.includes(name)) named.push(name);
    }
    providers.push({
      id: typeof row.id === "string" && row.id ? row.id : null,
      displayName,
      calendarId: row.calendarId,
      services: named,
    });
  }
  return { ok: true, providers };
}

/** saveProviders' refusals in plain words, naming the provider they are about. */
function refusalWords(
  outcome: Exclude<SaveProvidersOutcome, { status: "saved" }>,
  rows: readonly CheckedRow[],
): { field: string; message: string } {
  switch (outcome.status) {
    case "not_connected":
      return {
        field: "providers",
        message: "Connect your Google Calendar first, in the step before this one.",
      };
    case "unavailable":
      return {
        field: "providers",
        message:
          "Connecting a calendar isn't available right now, so named providers aren't either.",
      };
    case "failed":
      return {
        field: "providers",
        message:
          "We couldn't check your calendars with Google just now. Try again in a few minutes.",
      };
    case "refused": {
      const at = outcome.index;
      const field = at === null ? "providers" : `providers[${at}]`;
      const name = (at === null ? null : rows[at]?.displayName) ?? "A provider";
      switch (outcome.reason) {
        case "invalid_name":
          return { field, message: "Give each provider a name of up to 80 characters." };
        case "invalid_calendar":
        case "not_owned":
          return {
            field,
            message: `${name}'s calendar isn't one your connected Google account owns. Choose another.`,
          };
        case "outside_organisation":
          return {
            field,
            message: `${name}'s calendar isn't in your practice's own Google Workspace. Choose one that is.`,
          };
        case "duplicate_calendar":
          return {
            field,
            message: `${name}'s calendar is already another provider's. Each provider needs a calendar of their own.`,
          };
        case "unknown_provider":
          return {
            field,
            message: "Your providers changed since you opened this page. Reload it and try again.",
          };
        case "too_many":
          return { field: "providers", message: `Add up to ${MAX_PROVIDERS} providers.` };
        case "terms":
          return {
            field: "providers",
            message:
              "Your calendar terms don't let healdesk book into a calendar, so named providers aren't available.",
          };
        case "unmanaged_account":
        case "account_mismatch":
          return {
            field: "providers",
            message:
              "The Google account connected isn't the kind your agreement names. Reconnect your calendar in the step before this one.",
          };
        case "unverified":
          return {
            field,
            message: `Google couldn't be asked about ${name}'s calendar just now. Try again in a few minutes.`,
          };
      }
    }
  }
}

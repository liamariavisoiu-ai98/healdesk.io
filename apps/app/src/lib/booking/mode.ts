import { GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE, manualBookingNotice } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { agentConfigs, clinics } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { getClinicSettings, lockAutoConfirm, updateClinicSettings } from "@/lib/billing/settings";
import { OpeningHoursError, parseOpeningHours } from "@/lib/clinic/opening-hours";
import {
  googleCalendarConnection,
  type GoogleCalendarConnection,
} from "@/lib/connections/google-calendar";
import { env } from "@/lib/env";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { directBookingOpen } from "./direct-switch";
import { calendarTermsFor, type CalendarTerms } from "./terms";

/**
 * The booking mode (plan §8; owner decision 4, 5 October 2026): whether the
 * assistant books a caller straight into the location's Google Calendar
 * ("live", the portal's "direct"), or takes the time as a request for staff
 * to confirm ("manual", the portal's "requests").
 *
 * The mode is derived, never stored (plan §9.3). Every fact it weighs is read
 * fresh, in the caller's transaction, on every call: a kill switch pulled at
 * noon, a calendar Google took away a minute ago or Auto-confirm switched off
 * in the portal changes the very next answer. Only the connection's health
 * is stored, by whatever found it broken (markCalendarBroken), which is the
 * whole of "flip the location to manual booking in the same turn".
 *
 * Every gate is evaluated rather than stopping at the first, so the console
 * and the portal show at once everything that stands between a location and
 * live booking. Two tiers:
 *
 *   - `canOfferTimes`: whether the assistant can offer real free times at
 *     all. The location's calendar terms allow writing (so its booking system
 *     reads Google Calendar), healdesk's Google client is set, a healthy
 *     connection of the account kind the terms name was accepted under a
 *     notice still compatible, its hours parse, its zone is confirmed, and it
 *     is not leaving;
 *   - `mode`: whether it may then book rather than take a request. Auto-confirm
 *     (the clinic's switch), the location live or healdesk's demo clinic (plan
 *     A9), its script approved, and the owner's kill switch.
 *
 * So a location with Auto-confirm off, or still in setup, is offered real free
 * times and the time chosen becomes a request: the spec's "Off makes every AI
 * booking a request".
 *
 * The mode is the location's whatever its booking detail: a named provider's
 * calendar is on the location's one connection, and passes its own check at
 * each write (HRC-04, plan C12 and C13), so the funnel's
 * clinic_settings.booking_detail does not enter it.
 *
 * The database holds the same line from its side: app_calendar_write_permitted
 * (drizzle/0057) refuses a hold's move into `writing` unless the terms, the
 * connection and Auto-confirm allow it, and every gate it checks is checked
 * here too, so "live" is never wider than what the database lets through.
 */

/**
 * Every reason a location takes requests, in the order the portal's "Right
 * now: …" line picks one (`effectiveBookingMode().reason`): first what stops
 * the assistant offering real times, in the order a clinic would put them
 * right, then the clinic's own switch, then going live, and last the owner's
 * kill switch, which holds for every clinic alike.
 */
export const BOOKING_MODE_REASON_CODES = [
  "offboarding",
  "no_agreement",
  "needs_election",
  "manual_booking_system",
  "google_not_configured",
  "calendar_not_connected",
  "calendar_broken",
  "calendar_degraded",
  "calendar_account_mismatch",
  "calendar_disclosure_outdated",
  "timezone_unconfirmed",
  "opening_hours_unknown",
  "auto_confirm_off",
  "not_production",
  "agent_not_approved",
  "kill_switch_off",
] as const;

export type BookingModeReasonCode = (typeof BOOKING_MODE_REASON_CODES)[number];

/** A reason, and the sentence the portal and the console show for it. */
export type BookingModeReason = { code: BookingModeReasonCode; sentence: string };

/** The reasons that leave real free times on offer: they decide only booking or request. */
const BOOK_OR_REQUEST_ONLY: ReadonlySet<BookingModeReasonCode> = new Set([
  "auto_confirm_off",
  "not_production",
  "agent_not_approved",
  "kill_switch_off",
]);

/**
 * In the clinic's words, as the calendar page words the same states, because
 * the portal shows them; the console shows the code beside them. A manual
 * booking system's sentence is the catalogue's own (manualBookingNotice),
 * naming the system.
 */
const SENTENCES: Record<Exclude<BookingModeReasonCode, "manual_booking_system">, string> = {
  offboarding: "This location is leaving healdesk.",
  no_agreement: "This location has no agreement in effect.",
  needs_election: "This location's calendar terms aren't in place yet.",
  google_not_configured: "Calendar connection isn't available yet.",
  calendar_not_connected: "Your Google Calendar isn't connected.",
  calendar_broken: "Your Google Calendar connection stopped working and needs reconnecting.",
  calendar_degraded: "healdesk can't reach your Google Calendar right now.",
  calendar_account_mismatch:
    "The Google account connected isn't the kind of account your calendar terms name.",
  calendar_disclosure_outdated:
    "Your Google Calendar needs reconnecting to accept healdesk's updated notice.",
  timezone_unconfirmed: "Your time zone hasn't been confirmed.",
  opening_hours_unknown: "Your opening hours aren't set.",
  auto_confirm_off:
    "Auto-confirm is off, so your assistant takes each booking as a request for your staff to confirm.",
  not_production: "Your assistant isn't live yet.",
  agent_not_approved: "Your assistant's script hasn't been approved yet.",
  kill_switch_off: "healdesk hasn't switched on live booking yet.",
};

/** What the location's connection brings to the mode: its health, its account kind and its notice. */
export type BookingModeConnection = Pick<
  GoogleCalendarConnection,
  "status" | "managed" | "brokenAt"
> & {
  /** metadata.disclosureVersion: the data-use notice the connection was accepted under. */
  disclosureVersion: string | null;
};

/** Everything the mode weighs, read by bookingModeFor. */
export type BookingModeFacts = {
  /**
   * directBookingOpen(): the owner's HEALDESK_DIRECT_BOOKING_ENABLED AND counsel's
   * released addendum AND a matching HEALDESK_DIRECT_BOOKING_ADDENDUM (DB-1). The
   * env var alone never makes a location live.
   */
  killSwitchOn: boolean;
  /** clinic_settings.auto_confirm_bookings; on for a location with no settings row. */
  autoConfirm: boolean;
  terms: CalendarTerms;
  /** healdesk's Google OAuth client is set on this deployment. */
  googleConfigured: boolean;
  /** The location's Google Calendar row, revoked or not, or null. */
  connection: BookingModeConnection | null;
  openingHoursKnown: boolean;
  timezoneConfirmed: boolean;
  /** Offboarding has started, or the location's data is destroyed. */
  offboarding: boolean;
  /** data_classification is `production`. */
  production: boolean;
  /** healdesk's demo clinic (app_clinic_is_demo), which counts as live here (plan A9). */
  demo: boolean;
  agentApproved: boolean;
};

export type BookingModeDecision = {
  mode: "live" | "manual";
  canOfferTimes: boolean;
  /** Every reason that applies, in BOOKING_MODE_REASON_CODES order; empty exactly when live. */
  reasons: BookingModeReason[];
};

/**
 * The rules over a set of facts, with no I/O, so every gate and the order of
 * the reasons is one table test (tests/booking-mode.test.ts).
 *
 * The connection is weighed only where the terms let healdesk write. Under
 * any other terms the terms sweep takes a connection away (plan §9.2) and
 * the connect flow refuses to make one, so "isn't connected" would ask the
 * clinic for something it cannot do; the terms' own reason says why.
 */
export function decideBookingMode(facts: BookingModeFacts): BookingModeDecision {
  const { terms, connection } = facts;
  const applies = new Set<BookingModeReasonCode>();

  if (facts.offboarding) applies.add("offboarding");
  if (terms.kind === "none") applies.add("no_agreement");
  if (terms.kind === "needs_election") applies.add("needs_election");
  if (terms.kind === "not_used") applies.add("manual_booking_system");
  if (!facts.googleConfigured) applies.add("google_not_configured");

  if (terms.allowsWrite) {
    if (!connection || connection.status === "pending" || connection.status === "revoked") {
      applies.add("calendar_not_connected");
    } else {
      // A broken stamp counts whatever the status says, as it does in
      // app_calendar_write_permitted.
      if (connection.status === "error" || connection.brokenAt !== null) {
        applies.add("calendar_broken");
      } else if (connection.status === "degraded") {
        applies.add("calendar_degraded");
      }
      // Unknown (null) is a mismatch too: nothing proves the account's kind.
      if (connection.managed !== (terms.account !== "personal")) {
        applies.add("calendar_account_mismatch");
      }
      if (
        connection.disclosureVersion === null ||
        !GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE.includes(connection.disclosureVersion)
      ) {
        applies.add("calendar_disclosure_outdated");
      }
    }
  }

  if (!facts.timezoneConfirmed) applies.add("timezone_unconfirmed");
  if (!facts.openingHoursKnown) applies.add("opening_hours_unknown");
  if (!facts.autoConfirm) applies.add("auto_confirm_off");
  if (!facts.production && !facts.demo) applies.add("not_production");
  if (!facts.agentApproved) applies.add("agent_not_approved");
  if (!facts.killSwitchOn) applies.add("kill_switch_off");

  const reasons = BOOKING_MODE_REASON_CODES.filter((code) => applies.has(code)).map((code) => ({
    code,
    sentence:
      code === "manual_booking_system"
        ? manualBookingNotice(terms.kind === "not_used" ? terms.bookingSystem : null)
        : SENTENCES[code],
  }));
  return {
    mode: reasons.length === 0 ? "live" : "manual",
    canOfferTimes: reasons.every((reason) => BOOK_OR_REQUEST_ONLY.has(reason.code)),
    reasons,
  };
}

export type BookingMode = BookingModeDecision & {
  terms: CalendarTerms;
  /**
   * The location's Google Calendar row as stored, revoked or not, or null. Its
   * metadata holds the account's email address, for the clinic only: a
   * caller that projects this anywhere else picks its fields.
   */
  connection: GoogleCalendarConnection | null;
  demo: boolean;
};

/** The tenant location's booking mode now, read in the caller's transaction. */
export async function bookingModeFor(tx: TenantTx): Promise<BookingMode> {
  const terms = await calendarTermsFor(tx);
  const connection = await googleCalendarConnection(tx);
  const [clinic] = await tx.db
    .select({
      openingHours: clinics.openingHours,
      timezoneConfirmedAt: clinics.timezoneConfirmedAt,
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      dataClassification: clinics.dataClassification,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  const [agent] = await tx.db
    .select({ approvedAt: agentConfigs.approvedAt })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const settings = await getClinicSettings(tx);

  const disclosureVersion = connection?.metadata.disclosureVersion;
  const decision = decideBookingMode({
    killSwitchOn: directBookingOpen(),
    autoConfirm: settings.autoConfirmBookings,
    terms,
    googleConfigured: env.googleCalendarConfigured(),
    connection: connection
      ? {
          status: connection.status,
          managed: connection.managed,
          brokenAt: connection.brokenAt,
          disclosureVersion: typeof disclosureVersion === "string" ? disclosureVersion : null,
        }
      : null,
    openingHoursKnown: openingHoursKnown(clinic?.openingHours),
    timezoneConfirmed: Boolean(clinic?.timezoneConfirmedAt),
    offboarding: Boolean(clinic?.offboardingStartedAt ?? clinic?.destroyedAt),
    production: clinic?.dataClassification === "production",
    demo: terms.demo,
    agentApproved: Boolean(agent?.approvedAt),
  });
  return { ...decision, terms, connection, demo: terms.demo };
}

/**
 * Unknown is not closed (lib/clinic/opening-hours.ts): a missing or malformed
 * schedule means the assistant cannot say when the clinic is open, so it
 * offers no times, rather than a 500 or a week of guesses.
 */
function openingHoursKnown(value: unknown): boolean {
  try {
    parseOpeningHours(value);
    return true;
  } catch (error) {
    if (error instanceof OpeningHoursError) return false;
    throw error;
  }
}

// -----------------------------------------------------------------------------
// The portal's contract (the funnel's, 6 October 2026)
// -----------------------------------------------------------------------------

/** The mode as the portal shows it: Settings → Calendar, and setup step 3. */
export type EffectiveBookingMode = {
  /** `live` is "direct"; `manual` is "requests". */
  mode: "direct" | "requests";
  /** The one the "Right now: …" line shows: the first of `reasons`, or null when direct. */
  reason: BookingModeReason | null;
  reasons: BookingModeReason[];
};

export function effectiveOf(
  decision: Pick<BookingModeDecision, "mode" | "reasons">,
): EffectiveBookingMode {
  return {
    mode: decision.mode === "live" ? "direct" : "requests",
    reason: decision.reasons[0] ?? null,
    reasons: decision.reasons,
  };
}

export type BookingModeCallOptions = { actor?: ActorContext; request?: RequestContext };

const MODE_ACTOR: ActorContext = { type: "service", serviceName: "booking-mode" };

/**
 * The location's booking mode in the portal's words. It reads configuration
 * only, so it writes no audit row; the portal passes its user as `actor`, as
 * it does to the calendar functions.
 */
export async function effectiveBookingMode(
  clinicId: string,
  options: BookingModeCallOptions = {},
): Promise<EffectiveBookingMode> {
  const mode = await withTenant(
    { clinicId, actor: options.actor ?? MODE_ACTOR, request: options.request },
    (tx) => bookingModeFor(tx),
  );
  return effectiveOf(mode);
}

export type AutoConfirmOutcome = EffectiveBookingMode & {
  /** False when Auto-confirm already was where it was asked to be: nothing written or audited. */
  changed: boolean;
  autoConfirm: boolean;
  changedAt: Date | null;
  changedByLabel: string | null;
};

/**
 * Switch the location's Auto-confirm, and answer with the mode that leaves,
 * read in the same transaction. The portal calls this behind its step-up,
 * and ops setAutoConfirm calls it too (the funnel's contract).
 *
 * Through updateClinicSettings, which stamps who switched it and when and
 * audits `{ autoConfirm }` in the location's audit trail under `actor`. The
 * stamp names the actor unless `label` names someone else: the console
 * passes its team's name, as it does for a pause, because the portal shows
 * the clinic who switched it.
 *
 * `changed` is this call's own doing. The value it compares with is read
 * under lockAutoConfirm, the lock updateClinicSettings takes for the same
 * switch, so another session's switch is either committed before the read
 * or waits until this one commits; neither can be reported as this one's.
 */
export async function setAutoConfirm(
  clinicId: string,
  on: boolean,
  actor: ActorContext,
  options: { request?: RequestContext; label?: string; now?: Date } = {},
): Promise<AutoConfirmOutcome> {
  return withTenant({ clinicId, actor, request: options.request }, async (tx) => {
    await lockAutoConfirm(tx);
    const before = await getClinicSettings(tx);
    const after = await updateClinicSettings(
      tx,
      { autoConfirmBookings: on },
      options.label ?? labelOf(actor),
      options.now,
    );
    const mode = await bookingModeFor(tx);
    return {
      changed: after.autoConfirmBookings !== before.autoConfirmBookings,
      autoConfirm: after.autoConfirmBookings,
      changedAt: after.autoConfirmChangedAt,
      changedByLabel: after.autoConfirmChangedByLabel,
      ...effectiveOf(mode),
    };
  });
}

function labelOf(actor: ActorContext): string {
  switch (actor.type) {
    case "user":
    case "connector":
      return actor.label;
    case "service":
    case "agent":
      return actor.serviceName;
    case "system":
      return "system";
  }
}

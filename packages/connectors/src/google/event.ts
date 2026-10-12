import { assertNonClinical } from "../guards";

import { HEALDESK_EVENT_MARKER } from "./ids";

/**
 * The body of every event healdesk adds to a clinic's Google Calendar.
 *
 * The calendar clauses of the business associate agreement promise exactly
 * what an event carries: the patient's first name, the service as the
 * practice's own list names it, and the time, and no other information about
 * the patient — never a telephone number, an email address or anything
 * clinical. They also promise the event is private, invites no one and sets
 * no reminders. This file is where those promises are kept, so the body is
 * built field by field from a type with nowhere to put anything else: no
 * attendees (no invitations, no email address), no location, no conference
 * link, no source link, and no booking reference beyond the hashed event id.
 * The content is the same whichever calendar terms the clinic elected; a
 * clinic whose terms do not allow writing gets no event at all, which is the
 * app's decision, not this file's.
 */

/** On the assistant's own bookings. */
export const ASSISTANT_EVENT_DESCRIPTION = "Booked by your healdesk assistant.";
/** On a booking the practice's staff confirmed from a request. */
export const DESK_EVENT_DESCRIPTION = "Added by healdesk after your front desk confirmed it.";

/**
 * What the summary says when the first name cannot be trusted: the
 * practice's own word for the person (catalog `audienceFor`). "Patient"
 * everywhere HIPAA can reach, which is every practice under a business
 * associate agreement.
 */
export const FALLBACK_FIRST_NAME = "Patient";
/** At a veterinary practice the patients are animals and the people are their owners: "Client". */
export const FALLBACK_CLIENT_NAME = "Client";

/**
 * Who the practice's customers are, as the catalogue's `audienceFor` says
 * it. This package does not depend on the catalogue, so the caller passes
 * the answer; omitted means "patients".
 */
export type EventAudience = "patients" | "clients";

/** The fallback word for a person at a practice with this audience. */
export function fallbackNameFor(audience: EventAudience | undefined): string {
  return audience === "clients" ? FALLBACK_CLIENT_NAME : FALLBACK_FIRST_NAME;
}
/** What the summary says when the service cannot be trusted. */
export const FALLBACK_SERVICE = "Appointment";

export type GoogleEventBody = {
  id: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  visibility: "private";
  transparency: "opaque";
  reminders: { useDefault: false };
  guestsCanInviteOthers: false;
  guestsCanSeeOtherGuests: false;
  extendedProperties: { private: { healdesk: string } };
};

export type EventBodyInput = {
  /** googleEventIdFor(the booking key). */
  eventId: string;
  /** Whatever name the caller holds; only a clean first token survives. */
  firstName: string;
  /** The canonical service name from the clinic's own list, or null. */
  service: string | null;
  startsAt: Date;
  endsAt: Date;
  /** The clinic's IANA zone, so the event reads in the clinic's own clock. */
  timeZone: string;
  origin: "assistant" | "desk";
  /** The practice's word for the person when the name cannot be used; default "patients". */
  audience?: EventAudience;
};

const FIRST_NAME = /^\p{L}[\p{L}'-]{0,39}$/u;

/**
 * The first token of a name, if it looks like a name: a letter, then up to 39
 * letters, apostrophes or hyphens, after NFC normalisation. Anything else —
 * digits, an email address, a stray symbol — becomes the practice's word for
 * the person ("Patient", or "Client" at a vet), because a calendar entry that
 * reads "Patient" costs the desk a glance and one that carries a mistyped
 * phone number is a disclosure.
 */
export function sanitizeFirstName(
  raw: string | null | undefined,
  fallback: string = FALLBACK_FIRST_NAME,
): string {
  const first = (raw ?? "").trim().split(/\s+/u)[0]?.normalize("NFC") ?? "";
  return FIRST_NAME.test(first) ? first : fallback;
}

/**
 * Seven digits, allowing the separators a phone number is written with. The
 * plan's rule is "no run of seven digits"; counting through spaces, dots,
 * dashes and brackets is deliberately stricter, since the fallback costs
 * nothing and "555 010 1234" is a run of digits to anyone reading it.
 */
const PHONE_LIKE = /\d(?:[\s().+-]*\d){6}/u;

/**
 * The service as the event's summary shows it, or "Appointment".
 *
 * The name is the canonical one from the clinic's own service list, so it is
 * the clinic's words, not the caller's. It is still checked, because the list
 * is free text a person typed: anything that reads as clinical, carries an
 * `@`, holds a phone-length run of digits, or has control characters in it is
 * replaced rather than sent.
 */
export function eventServiceLabel(service: string | null | undefined): string {
  const name = (service ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!name || name.includes("@") || PHONE_LIKE.test(name) || /\p{Cc}/u.test(name)) {
    return FALLBACK_SERVICE;
  }
  try {
    assertNonClinical(name);
  } catch {
    return FALLBACK_SERVICE;
  }
  return name;
}

/** The whole body, as POSTed to events.insert. */
export function buildEventBody(input: EventBodyInput): GoogleEventBody {
  return {
    id: input.eventId,
    summary: `${sanitizeFirstName(input.firstName, fallbackNameFor(input.audience))} – ${eventServiceLabel(input.service)}`,
    description:
      input.origin === "assistant" ? ASSISTANT_EVENT_DESCRIPTION : DESK_EVENT_DESCRIPTION,
    start: { dateTime: input.startsAt.toISOString(), timeZone: input.timeZone },
    end: { dateTime: input.endsAt.toISOString(), timeZone: input.timeZone },
    visibility: "private",
    transparency: "opaque",
    reminders: { useDefault: false },
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: { private: { ...HEALDESK_EVENT_MARKER } },
  };
}

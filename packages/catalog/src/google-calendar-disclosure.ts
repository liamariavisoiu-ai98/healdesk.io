import { createHash } from "node:crypto";

import type { AgreementKind } from "./agreement-kind";
import type { Audience } from "./audience";

/**
 * What a practice is told, and ticks, immediately before it is sent to
 * Google to connect its calendar.
 *
 * Google's consent screen names the permissions; it does not say who else
 * sees what they return. This does: what healdesk reads, what it adds, where
 * the free times it reads go and on what terms, and how to end it. The
 * connect flow (plan §4.2, C8) is to show it directly above an unticked box
 * and the Google-branded button, with nothing in between; to refuse to start
 * the connection unless the box was ticked on this exact version; and to
 * store on the state row the version, `googleCalendarDisclosureSha256()` and
 * the time it was accepted. Nothing shows it yet.
 *
 * Versioned like a document, because a stored acceptance points at it.
 * Wording changes are a new version. A new RECIPIENT of calendar-derived
 * times (Meta, when Meta booking is built) is a new version that is not
 * added to GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE, so no connection accepted
 * under the old one is used for booking until the clinic accepts the new
 * one: nobody's consent is stretched to cover a recipient they were never
 * told about. The email asking such a clinic to reconnect (plan §9.2 step 5)
 * is deferred, not built (apps/app lib/scheduler/calendar-watch.ts), so
 * until it exists no version may leave GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE:
 * the booking mode would put every such location on requests
 * (`calendar_disclosure_outdated`) and tell no clinic why.
 *
 * `timeRecipients` names the subprocessor-register rows the times reach
 * (apps/web/src/lib/subprocessors.ts). apps/web/src/lib/google-disclosure
 * .test.ts ties the two: every name is a register row that handles PHI, and
 * while any of them has not signed its business associate agreement, the
 * text says the agreements are signed before any patient's information is
 * processed, never that they are signed.
 *
 * Version /1 has never been shown to anyone, so the calendar-list permission
 * (owner, 6 October 2026) changed it in place rather than making a /2, and so
 * did the pre-release audit of the calendar clauses the same day
 * (agreement-changes.md §12.14: a calendar per provider, PT-06; the
 * subscribed-calendar list Google's permission reaches, PT-20; the first name
 * the person booking gave, PT-30; nothing clinical beyond the service's name,
 * ICD-28). It says what the calendar clauses say, and no more.
 *
 * ## One per agreement, and per audience under the DPA
 *
 * The BAA's wording says the times reach Anthropic and Retell "under business
 * associate agreements with healdesk that are signed before any patient's
 * information is processed". A practice under the Data Protection Agreement
 * (a veterinary practice, or one that bills no health insurance) has no
 * business associate agreement with healdesk, and a vet's customers are
 * clients, so on 20 October 2026, the day the DPA was released, it was given
 * its own wording rather than that one: the same paragraphs but the fourth,
 * which names the data protection agreement and says what its Subcontractors
 * clause holds every subcontractor to (dpa.ts), with the person the practice
 * serves called a patient or a client by `audienceFor`. Each is a version of
 * its own, frozen by its own golden hash, so a stored acceptance names the
 * exact words that were ticked. `googleCalendarDisclosureFor` chooses, from
 * the practice's agreement kind (`clinics.agreement_kind`) and its audience;
 * the BAA's wording, its version and its hash did not move.
 */

export type GoogleCalendarDisclosure = {
  version: string;
  heading: string;
  /**
   * In order. The first names the practice through `{clinicName}`, which
   * renderGoogleCalendarDisclosure fills in; the last is the Limited Use
   * statement exactly as privacy §11 makes it.
   */
  paragraphs: readonly string[];
  /** In the last paragraph, these words link to Google's policy. */
  limitedUse: { linkText: string; href: string };
  /** The last paragraph also links here: the privacy page's Google section. */
  privacyHref: string;
  tickLabel: string;
  /** Subprocessor-register names of everyone the free times reach. */
  timeRecipients: readonly string[];
  /**
   * "conditional" while any recipient's BAA is unsigned: the text promises
   * the agreements are signed before any patient's information is processed
   * (the DPA's wordings: that the agreement requires each recipient's written
   * terms before any patient's or client's information reaches it), never
   * that they are signed.
   */
  baaWording: "conditional" | "signed";
  /** The agreement the wording names: shown only to a practice under that kind. */
  agreementKind: AgreementKind;
  /** Who the wording calls the person offered times: "patients", or a vet's "clients". */
  audience: Audience;
};

export const GOOGLE_CALENDAR_DISCLOSURE_VERSION = "google-calendar-disclosure/1";

export const GOOGLE_CALENDAR_DISCLOSURE: GoogleCalendarDisclosure = {
  version: GOOGLE_CALENDAR_DISCLOSURE_VERSION,
  heading: "Connecting your Google Calendar",
  paragraphs: [
    "healdesk, a service of Viixi FZC, is asking for {clinicName} to connect the Google account " +
      "you sign in with next. healdesk books into that account's main calendar, unless you choose " +
      "another calendar it owns or manages, or one for each provider if you book by provider.",
    "What healdesk reads: the names of the calendars that account owns or manages, so you can " +
      "choose where healdesk books; when each calendar it books into is free or busy; and the " +
      "appointments healdesk itself adds. Google's permission also reaches the list of every " +
      "calendar you subscribe to, the other events on your calendars and when your other " +
      "calendars are free or busy; healdesk does not read or store them.",
    "What healdesk adds: each booking your assistant makes, and each booking your staff confirm " +
      "through healdesk, as a private event with the first name the person booking gave, the " +
      "service and the time — never a phone number, an email address, or anything clinical " +
      "beyond the service's name — with no guests and no reminders. healdesk never changes or " +
      "deletes an event it did not add.",
    "Where the information goes: healdesk keeps the connection encrypted on servers in the " +
      "United States. When your assistant offers a patient times, the free times it read are " +
      "processed by healdesk's AI model provider, Anthropic, and, on a call, spoken to the " +
      "caller by healdesk's voice provider, Retell, under business associate agreements with " +
      "healdesk that are signed before any patient's information is processed. healdesk does " +
      "not sell this information, use it for advertising, or use it to train AI models.",
    "You can disconnect at any time: ask us, or remove healdesk's access in your Google " +
      "Account's security settings. healdesk then deletes the stored connection (when you remove " +
      "access in Google, as soon as healdesk next finds it no longer works). Events already " +
      "added stay in your calendar, under your own agreement with Google.",
    "healdesk's use and transfer to any other app of information received from Google APIs will " +
      "adhere to the Google API Services User Data Policy, including the Limited Use " +
      "requirements.",
  ],
  limitedUse: {
    linkText: "Google API Services User Data Policy",
    href: "https://developers.google.com/terms/api-services-user-data-policy",
  },
  privacyHref: "https://healdesk.io/privacy#google",
  tickLabel:
    "I allow healdesk to see when the calendars it books into are free or busy and to add the " +
    "bookings it makes, as described above.",
  timeRecipients: ["Anthropic (the product)", "Retell"],
  baaWording: "conditional",
  agreementKind: "baa",
  audience: "patients",
};

/**
 * The versions of the wording a practice under the Data Protection Agreement
 * ticks: one for a practice whose patients are people and bills no health
 * insurance, and one for a veterinary practice, whose customers are clients.
 */
export const GOOGLE_CALENDAR_DISCLOSURE_DPA_VERSIONS: Readonly<Record<Audience, string>> = {
  patients: "google-calendar-disclosure-dpa-patients/1",
  clients: "google-calendar-disclosure-dpa-clients/1",
};

/**
 * The DPA's fourth paragraph. The recipients and what healdesk does not do
 * with the times are the BAA's wording; the terms they get them on are the
 * DPA's Subcontractors clause, which has healdesk ensure that every
 * subcontractor agrees in writing, before it handles a client's information,
 * to restrictions and conditions at least as protective as those the
 * agreement places on healdesk. A promise about when, like the BAA's, never
 * a statement that those agreements are already signed.
 */
function dpaWhereItGoes(audience: Audience): string {
  const one = audience === "clients" ? "client" : "patient";
  return (
    "Where the information goes: healdesk keeps the connection encrypted on servers in the " +
    `United States. When your assistant offers a ${one} times, the free times it read are ` +
    "processed by healdesk's AI model provider, Anthropic, and, on a call, spoken to the caller " +
    "by healdesk's voice provider, Retell. Your data protection agreement with healdesk requires " +
    `healdesk to have each of them agree in writing, before any ${one}'s information reaches ` +
    "it, to restrictions and conditions at least as protective of that information as those the " +
    "agreement places on healdesk. healdesk does not sell this information, use it for " +
    "advertising, or use it to train AI models."
  );
}

function dpaDisclosure(audience: Audience): GoogleCalendarDisclosure {
  const paragraphs = [...GOOGLE_CALENDAR_DISCLOSURE.paragraphs];
  paragraphs[3] = dpaWhereItGoes(audience);
  return {
    ...GOOGLE_CALENDAR_DISCLOSURE,
    version: GOOGLE_CALENDAR_DISCLOSURE_DPA_VERSIONS[audience],
    paragraphs,
    agreementKind: "dpa",
    audience,
  };
}

/** The DPA's wordings, by audience. */
export const GOOGLE_CALENDAR_DISCLOSURE_DPA: Readonly<Record<Audience, GoogleCalendarDisclosure>> =
  {
    patients: dpaDisclosure("patients"),
    clients: dpaDisclosure("clients"),
  };

/** Every wording a practice can be shown, the BAA's first. */
export const GOOGLE_CALENDAR_DISCLOSURES: readonly GoogleCalendarDisclosure[] = [
  GOOGLE_CALENDAR_DISCLOSURE,
  GOOGLE_CALENDAR_DISCLOSURE_DPA.patients,
  GOOGLE_CALENDAR_DISCLOSURE_DPA.clients,
];

/** What a practice is, for choosing its wording. */
export type GoogleCalendarDisclosurePractice = {
  /**
   * `clinics.agreement_kind`. Null, a clinic created before the column with
   * no bound agreement, is read as the BAA, as the PHI gate reads it.
   */
  agreementKind: AgreementKind | null;
  audience: Audience;
};

/**
 * The wording one practice is shown, ticks and has recorded: the BAA's for a
 * practice under the BAA, whatever its audience, since it names the agreement
 * the practice has; the DPA's for its audience otherwise. Unrendered: its
 * `{clinicName}` is renderGoogleCalendarDisclosure's to fill.
 */
export function googleCalendarDisclosureFor(
  practice: GoogleCalendarDisclosurePractice,
): GoogleCalendarDisclosure {
  if (practice.agreementKind !== "dpa") return GOOGLE_CALENDAR_DISCLOSURE;
  return GOOGLE_CALENDAR_DISCLOSURE_DPA[practice.audience === "clients" ? "clients" : "patients"];
}

/**
 * The versions a stored connection may have been accepted under and still
 * be used. A connection on any other version gets the booking-mode reason
 * `calendar_disclosure_outdated` (plan C9) and books by request. The notice
 * asking that clinic to reconnect (plan C10) is deferred, so no version may
 * be taken out of this list until that notice exists
 * (apps/app lib/scheduler/calendar-watch.ts).
 *
 * Every wording is here, the DPA's two with the BAA's. What the list guards
 * is consent to the recipients, and all three name the same two: the
 * acceptance itself is held to the practice's own wording
 * (`googleCalendarDisclosureFor`, which beginGoogleSignIn asks), so the only
 * way a connection's wording can differ from its practice's today is a later
 * change of the practice, such as a DPA practice re-signing under the BAA.
 * Its times still reach only the two recipients it was told of, and putting
 * it on requests for the change is what the paragraph above forbids, since
 * nothing would tell it why.
 */
export const GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE: readonly string[] = [
  GOOGLE_CALENDAR_DISCLOSURE_VERSION,
  GOOGLE_CALENDAR_DISCLOSURE_DPA_VERSIONS.patients,
  GOOGLE_CALENDAR_DISCLOSURE_DPA_VERSIONS.clients,
];

export class GoogleCalendarDisclosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarDisclosureError";
  }
}

/**
 * The disclosure as one practice sees it: `disclosure` is the practice's own
 * wording (googleCalendarDisclosureFor), the BAA's when none is given.
 * Strict: a disclosure that names no practice is not a consent anyone gave.
 */
export function renderGoogleCalendarDisclosure(
  input: { clinicName: string },
  disclosure: GoogleCalendarDisclosure = GOOGLE_CALENDAR_DISCLOSURE,
): GoogleCalendarDisclosure {
  const clinicName = typeof input.clinicName === "string" ? input.clinicName.trim() : "";
  if (!clinicName) {
    throw new GoogleCalendarDisclosureError("clinicName is required to render the disclosure.");
  }
  // `{clinicName}` is the template's only placeholder (pinned by its test),
  // so nothing else is substituted. split/join rather than replaceAll with a
  // string: replaceAll expands `$&`, `$'`, `` $` `` and `$$` in its
  // replacement, so a practice named "A $& B" would put the placeholder
  // itself back into its consent text, while the stored hash still said the
  // standard wording was shown.
  const paragraphs = disclosure.paragraphs.map((p) => p.split("{clinicName}").join(clinicName));
  return { ...disclosure, paragraphs };
}

/**
 * SHA-256 hex of the wording every practice is shown on this version, before
 * the practice's name is filled in: the heading, the paragraphs, both links
 * and the tick label. Stored with each acceptance so "which words did they
 * tick" survives a later version.
 */
export function googleCalendarDisclosureSha256(
  disclosure: GoogleCalendarDisclosure = GOOGLE_CALENDAR_DISCLOSURE,
): string {
  const shown = JSON.stringify([
    disclosure.version,
    disclosure.heading,
    disclosure.paragraphs,
    disclosure.limitedUse.linkText,
    disclosure.limitedUse.href,
    disclosure.privacyHref,
    disclosure.tickLabel,
  ]);
  return createHash("sha256").update(shown, "utf8").digest("hex");
}

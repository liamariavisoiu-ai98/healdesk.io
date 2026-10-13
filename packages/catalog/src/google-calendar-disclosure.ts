import { createHash } from "node:crypto";

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
   * the agreements are signed before any patient's information is processed.
   */
  baaWording: "conditional" | "signed";
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
};

/**
 * The versions a stored connection may have been accepted under and still
 * be used. A connection on any other version gets the booking-mode reason
 * `calendar_disclosure_outdated` (plan C9) and books by request. The notice
 * asking that clinic to reconnect (plan C10) is deferred, so no version may
 * be taken out of this list until that notice exists
 * (apps/app lib/scheduler/calendar-watch.ts).
 */
export const GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE: readonly string[] = [
  GOOGLE_CALENDAR_DISCLOSURE_VERSION,
];

export class GoogleCalendarDisclosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCalendarDisclosureError";
  }
}

/**
 * The disclosure as one practice sees it. Strict: a disclosure that names
 * no practice is not a consent anyone gave.
 */
export function renderGoogleCalendarDisclosure(input: {
  clinicName: string;
}): GoogleCalendarDisclosure {
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
  const paragraphs = GOOGLE_CALENDAR_DISCLOSURE.paragraphs.map((p) =>
    p.split("{clinicName}").join(clinicName),
  );
  return { ...GOOGLE_CALENDAR_DISCLOSURE, paragraphs };
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

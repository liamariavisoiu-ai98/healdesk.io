import { isAllowedClinicName, isCountKey } from "@/lib/email/lint";

import { anyEventWord, CHANGE_SECTION_WORDS, CLOSED_WORDS, closedWord, EVENT_WORDS } from "./words";

/**
 * What an ops alert may say outside the ops log: the fields its Slack copy
 * carries and the values its wording may print. One list, for both, because
 * the email and Slack print the same sentences (lane N1, 23 October 2026)
 * and Slack signs no business associate agreement.
 *
 * The clinic's id when it is a uuid; the clinic's name (looked up when the
 * alert goes out, never stored) and, for a setup request, the requester's
 * business name, both under isAllowedClinicName's rule; every field with a
 * closed word list in ./words.ts (a meter, a section, the lifecycle watch's
 * decision and recommendation, an email or billing request kind, a vendor,
 * a channel, a Meta provider, a status), and only a value on its list; a
 * handful of day fields, printed as a day and never a time; and every count
 * that is a finite, non-negative number. Never a patient, an address, a
 * phone number, a conversation, a request id, a reason code off its list or
 * free text: a field not on the list is left out whatever it holds.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const METERS: ReadonlySet<string> = new Set(Object.keys(CLOSED_WORDS.meter!));

/** What a clinic changed (clinic_availability_changed's `section`): a closed list, never words. */
export const CHANGE_SECTIONS: ReadonlySet<string> = new Set(Object.keys(CHANGE_SECTION_WORDS));

/**
 * Days an alert may name, printed as "22 Oct": the day a setup request's
 * reply was promised by, the day a usage window opened, and the offboarding
 * and vendor days (destruction, export due, service ended, an agreement's
 * expiry). Never a time, and never an appointment's.
 */
export const DAY_KEYS: ReadonlySet<string> = new Set([
  "promisedOn",
  "windowStart",
  "destroyAt",
  "exportDueAt",
  "serviceEndedAt",
  "expiresOn",
]);
/** A support case's printed ref (lane P7e): "HD-" and five characters of Crockford base32, never a word. */
const SUPPORT_REF = /^HD-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// <business-name-rule>
// Identical in apps/app lib/ops/alert-wording/allow-list.ts and apps/web
// lib/setup-requests.ts; apps/app's tests/alert-wording.test.ts fails when the
// two copies differ. Change both in one commit.
/** The most of a requester's business name an ops alert prints. */
export const MAX_BUSINESS_NAME = 80;

/**
 * A setup requester's business name as an ops alert may print it, or null
 * (owner, 23 October 2026; lane N1 and its review). Typed by a prospect, so
 * it is refused, and the alert goes without it, when it could reach anyone
 * or trip the email link scanner: seven or more digits in all, in any script
 * (a phone number however spaced); an address, spelled out or not; a link or
 * a bare domain; a slash, backslash, `=`, quote, bracket or angle bracket;
 * `href`, `src` or `url`; a control or invisible formatting character.
 * Otherwise it is cut to 80 characters at a word.
 */
export function cleanBusinessName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = value.replace(/\s+/gu, " ").trim();
  if (!name) return null;
  if ((name.match(/\p{Nd}/gu) ?? []).length >= 7) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return null;
  if (/[@/\\=()[\]{}<>"“”`]/u.test(name)) return null;
  if (/\b(?:href|src|url)\b/i.test(name)) return null;
  if (/\w\.\s*[a-z]{2,}/u.test(name)) return null;
  if (/\.\s*(?:com|net|org|io|co|us|ca|uk|ly|me|app|health|clinic|dental|spa|biz|info)\b/i.test(name)) return null;
  if (/\bat\b.*\bdot\b|\bdot\s+(?:com|net|org|io|co|us|ca|uk)\b/i.test(name)) return null;
  if (name.length > MAX_BUSINESS_NAME) {
    const cut = name.slice(0, MAX_BUSINESS_NAME + 1);
    const space = cut.lastIndexOf(" ");
    name = (space > 20 ? cut.slice(0, space) : cut.slice(0, MAX_BUSINESS_NAME)).trim();
  }
  return name || null;
}
// </business-name-rule>

/** cleanBusinessName, then the clinic-name rule every ops alert's names are held to. */
export function printableBusinessName(value: unknown): string | null {
  const name = cleanBusinessName(value);
  return name && isAllowedClinicName(name) ? name : null;
}

function isDay(value: unknown): value is string {
  return typeof value === "string" && ISO_DAY.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The fields Slack may carry, and nothing else. Exported for the test that
 * holds it to that (lib/ops/slack.ts re-exports it as slackFields).
 */
export function allowedAlertFields(fields: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "clinicId") {
      if (typeof value === "string" && UUID.test(value)) out.clinicId = value;
    } else if (key === "business") {
      const name = printableBusinessName(value);
      if (name) out.business = name;
    } else if (key === "supportRef") {
      if (typeof value === "string" && SUPPORT_REF.test(value)) out.supportRef = value;
    } else if (Object.hasOwn(CLOSED_WORDS, key)) {
      if (closedWord(key, value) !== null) out[key] = value as string;
    } else if (Object.hasOwn(EVENT_WORDS, key)) {
      // On some event's list; the event decides whether it prints (words.ts scopeToEvent).
      if (anyEventWord(key, value)) out[key] = value as string;
    } else if (DAY_KEYS.has(key)) {
      if (isDay(value)) out[key] = value;
    } else if (isCountKey(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The values a wording may print: the allow-listed fields, the clinic's name
 * when there is one, and `percent` (used of included, rounded down) when both
 * counts are there.
 */
export function wordingValues(
  fields: Readonly<Record<string, unknown>>,
  clinicName: string | null,
): Record<string, string | number> {
  const values: Record<string, string | number> = allowedAlertFields(fields);
  delete values.clinicId;
  if (clinicName && isAllowedClinicName(clinicName)) values.clinicName = clinicName;
  const used = values.used;
  const included = values.included;
  if (typeof used === "number" && typeof included === "number" && included > 0) {
    values.percent = Math.floor((used / included) * 100);
  }
  return values;
}

/** Every key a wording may name in a `{placeholder}`, besides any count key. */
export const NAMED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "clinicName",
  "business",
  "percent",
  "supportRef",
  ...Object.keys(CLOSED_WORDS),
  ...Object.keys(EVENT_WORDS),
  ...DAY_KEYS,
]);

/** Whether a wording may name this key: on the list above, or a count. */
export function isPlaceholderAllowed(key: string): boolean {
  return NAMED_PLACEHOLDERS.has(key) || isCountKey(key);
}

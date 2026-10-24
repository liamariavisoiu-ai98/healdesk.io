import { LIFECYCLE_DECISIONS } from "@/db/schema";
import { isAllowedClinicName, isCountKey } from "@/lib/email/lint";
import { RECOMMENDATIONS } from "@/lib/lifecycle/recommend";

/**
 * What an ops alert may say outside the ops log: the fields its Slack copy
 * carries and the values its wording may print. One list, for both, because
 * the email and Slack print the same sentences (lane N1, 23 October 2026)
 * and Slack signs no business associate agreement.
 *
 * The clinic's id when it is a uuid; the clinic's name (looked up when the
 * alert goes out, never stored) and, for a setup request, the requester's
 * business name, both under isAllowedClinicName's rule; a usage meter, a
 * changed section and the lifecycle watch's two closed words, each from its
 * own closed list; a handful of day fields, printed as a day and never a
 * time; and every count that is a finite, non-negative number. Never a
 * patient, an address, a phone number, a conversation, a request id, a
 * reason code or free text: a field not on the list is left out whatever it
 * holds.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const METERS: ReadonlySet<string> = new Set(["voice_minutes", "chat_conversations"]);

/** What a clinic changed (clinic_availability_changed's `section`): a closed list, never words. */
export const CHANGE_SECTIONS: ReadonlySet<string> = new Set([
  "hours",
  "closures",
  "location_hours",
  "providers",
  "provider_services",
]);

/** The lifecycle watch's closed words (design E2): a setup's decision and the recommended action. */
const LIFECYCLE_WORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  decision: new Set(LIFECYCLE_DECISIONS),
  recommendation: new Set(RECOMMENDATIONS),
};

/**
 * Days an alert may name, printed as "22 Oct": the day a setup request's
 * reply was promised by, and the day a usage window opened. Never a time,
 * and never an appointment's.
 */
export const DAY_KEYS: ReadonlySet<string> = new Set(["promisedOn", "windowStart"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** The most of a requester's business name an alert prints. */
export const MAX_BUSINESS_NAME = 80;

/**
 * A setup requester's business name as an ops alert may print it, or null.
 * Typed by a prospect on the marketing site, so held to more than a clinic's
 * name: at most 80 characters (longer is cut at a word), and nothing that
 * looks like an address, a link or a number someone could call. A name that
 * fails is left out and the alert goes without it (owner, 23 October 2026).
 * apps/web applies the same rule before sending it (lib/setup-requests.ts).
 */
export function printableBusinessName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = value.replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (/@|:\/\/|\bwww\.|\.(?:com|net|org|io|co|us|ca|uk|health|clinic|biz|info)\b|\d{7,}/i.test(name)) {
    return null;
  }
  if (name.length > MAX_BUSINESS_NAME) {
    const cut = name.slice(0, MAX_BUSINESS_NAME + 1);
    const space = cut.lastIndexOf(" ");
    name = (space > 20 ? cut.slice(0, space) : cut.slice(0, MAX_BUSINESS_NAME)).trim();
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(name)) return null;
  return isAllowedClinicName(name) ? name : null;
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
    } else if (key === "meter") {
      if (typeof value === "string" && METERS.has(value)) out.meter = value;
    } else if (key === "section") {
      if (typeof value === "string" && CHANGE_SECTIONS.has(value)) out.section = value;
    } else if (Object.hasOwn(LIFECYCLE_WORDS, key)) {
      if (typeof value === "string" && LIFECYCLE_WORDS[key]!.has(value)) out[key] = value;
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
  "meter",
  "section",
  "decision",
  "recommendation",
  "percent",
  ...DAY_KEYS,
]);

/** Whether a wording may name this key: on the list above, or a count. */
export function isPlaceholderAllowed(key: string): boolean {
  return NAMED_PLACEHOLDERS.has(key) || isCountKey(key);
}

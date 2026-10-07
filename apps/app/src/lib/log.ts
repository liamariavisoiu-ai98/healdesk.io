/**
 * The only logger the PHI side of the product is allowed to use.
 *
 * docs/hipaa-compliance.md says "Never log PHI. Not to stdout, not to Sentry,
 * not to analytics." Until now that was a sentence; every route and the worker
 * called console.* directly, and nothing stood between a well-meant
 * `console.error("sync failed", job)` and a caller's phone number sitting in
 * CloudWatch with no retention, no encryption key of ours, and no way to
 * enumerate it during a breach notification.
 *
 * This module makes the sentence a type and a runtime check:
 *
 *   1. A log line is a fixed message plus FIELDS. Fields are scalars only and
 *      their KEYS come from an allowlist of identifiers and counters. A key
 *      like `phone`, `name`, `payload` or `transcript` is not on it and throws
 *      — in every environment, because the developer who wrote it is the one
 *      who needs to see the error, and a log line that is wrong in test is
 *      wrong in production.
 *   2. String VALUES are scrubbed anyway. Free-text fields (`reason`,
 *      `error`) exist because a driver error or a bounce message is useful,
 *      and both are exactly where an address or a number leaks in sideways
 *      (see lib/email/agreement-copy.ts for the bounce that carried the
 *      signer's email). Emails, phone-shaped digit runs and URLs with a query
 *      string are replaced before anything is written.
 *   3. The message itself is checked the same way, so template-literal
 *      interpolation into the message cannot smuggle a value past the fields.
 *
 * Output is one line: `[healdesk] <message> <json fields>` on the console
 * stream matching the level, which is what every host we might run on
 * (ECS, Fly, a box) collects. There is no error tracker on purpose — see
 * docs/handover.md "Logs" — so nothing here ships anywhere else.
 */

export type LogField = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogField>;

/**
 * Identifiers, counters, statuses and short free-text reasons. Adding a key
 * is a review question: "can this value ever describe a patient?" If the
 * answer is not an immediate no, re-read what you need inside withTenant()
 * and log the id instead.
 */
export const ALLOWED_LOG_KEYS: ReadonlySet<string> = new Set([
  // Identifiers — opaque, and safe by construction.
  "clinicId",
  "organizationId",
  "connectionId",
  "conversationId",
  "agreementId",
  "requestId",
  "jobId",
  "event",
  "eventId",
  "deliveryId",
  // Categorical.
  "type",
  "kind",
  "provider",
  "resource",
  "status",
  "outcome",
  "op",
  "job",
  "signal",
  "code",
  "source",
  "channel",
  "transport",
  "subject",
  // The Stripe launch (5 October 2026). Each names a category, never a
  // person: `meter` is voice_minutes or chat_conversations, `purpose` a
  // sign-in link's purpose, `decision` an answer-gate or deposit outcome,
  // `phase` a step name, `field` the name of a form field (never its value).
  "meter",
  "purpose",
  "decision",
  "phase",
  "field",
  "noticeId",
  "windowStart",
  // The Stripe build (6 October 2026): `eventType` is a Stripe event's type
  // (invoice.paid, checkout.session.completed), never anything the event
  // carries.
  "eventType",
  // Offboarding's dates (lib/offboarding): when a clinic's service ended,
  // when its export reached it and when its data is destroyed, ISO instants
  // about a customer's contract, never about a patient.
  "serviceEndedAt",
  "exportDeliveredAt",
  "destroyAt",
  // Counters.
  "count",
  "written",
  "matched",
  "exceptions",
  "deleted",
  "attempts",
  "failures",
  "processed",
  "deferred",
  "olderThanDays",
  "months",
  "ms",
  "attempt",
  "units",
  "lateDays",
  // Short free text, scrubbed on the way out.
  "reason",
  "error",
  "hint",
]);

export class LogFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogFieldError";
  }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Seven or more digits with optional separators: every NANP and E.164 shape,
// and long enough not to eat an HTTP status or a port number. Bounded so a
// digit run inside a UUID or a hash (`3fa85f64-5717-4562-…`) is left alone:
// those are the ids we WANT in the log.
const PHONE = /(?<![A-Za-z0-9-])\+?\d(?:[\s().-]*\d){6,}(?![A-Za-z0-9-])/g;
// A URL with a query string or fragment can carry a token or a search term.
const URL_WITH_QUERY = /https?:\/\/[^\s"']+[?#][^\s"']*/g;

/** Replace anything that could identify a person in free text. Exported for tests. */
export function scrub(text: string): string {
  return text
    .replace(EMAIL, "[email redacted]")
    .replace(URL_WITH_QUERY, "[url redacted]")
    .replace(PHONE, "[number redacted]");
}

function checkFields(fields: LogFields | undefined): Record<string, LogField> {
  if (!fields) return {};
  const out: Record<string, LogField> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_LOG_KEYS.has(key)) {
      throw new LogFieldError(
        `Log field "${key}" is not on the allowlist (lib/log.ts). Log an id, not the thing.`,
      );
    }
    if (
      value !== null &&
      value !== undefined &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new LogFieldError(
        `Log field "${key}" must be a scalar; objects and arrays are where payloads hide.`,
      );
    }
    out[key] = typeof value === "string" ? scrub(value).slice(0, 500) : value;
  }
  return out;
}

function write(
  level: "info" | "warn" | "error",
  message: string,
  fields?: LogFields,
): void {
  const safeFields = checkFields(fields);
  const safeMessage = scrub(message);
  const line =
    Object.keys(safeFields).length > 0
      ? `[healdesk] ${safeMessage} ${JSON.stringify(safeFields)}`
      : `[healdesk] ${safeMessage}`;
  // eslint-disable-next-line no-console
  console[level](line);
}

/**
 * Summarise an unknown thrown value for a log line: the error's name and
 * message, scrubbed. Never the stack, never the object — a driver error
 * carries the query and its parameters.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return scrub(`${error.name}: ${error.message}`).slice(0, 300);
  }
  return "unknown error";
}

export const log = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};

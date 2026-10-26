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
  // A voice vendor's call id ("call_..."): which call, before its
  // conversation row exists, so two calls' alerts are never folded into one.
  "callId",
  "agreementId",
  "requestId",
  "jobId",
  "event",
  "eventId",
  "deliveryId",
  // An incident's id (lib/incidents), for the overdue-notice alert.
  "incidentId",
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
  "exportDueAt",
  "destroyAt",
  // A vendor's business associate agreement's recorded expiry (YYYY-MM-DD,
  // UTC; lib/compliance/vendor-coverage.ts): a contract date about
  // healdesk's own vendor, never about a clinic or a patient.
  "expiresOn",
  // A deletion request's id (erasure_requests, lib/patient-rights/erasure.ts):
  // a random uuid naming the request, never the person.
  "erasureId",
  // An amendment's id (record_amendments, lib/patient-rights/amendments.ts)
  // and a corrected contact's id: random uuids, logged so a restore can find
  // the amendments and corrections it lost; never their words.
  "amendmentId",
  "contactId",
  // The practice questions (lib/engine/practice): a run's and a review's
  // random ids, and the closed name of the section a case failed on.
  "runId",
  "reviewId",
  "section",
  // A website re-read's random id (site_rereads, lib/website), never the website.
  "rereadId",
  // Counters.
  "count",
  "written",
  "matched",
  "exceptions",
  "deleted",
  // What a deletion kept because it is someone else's (lib/patient-rights/erasure.ts): a count.
  "kept",
  "attempts",
  "failures",
  "processed",
  "deferred",
  "olderThanDays",
  "months",
  "ms",
  // A call turn's whole answer time beside `ms`, its time to first audio
  // (lib/voice/retell.ts, "retell turn timing"): numbers, never words.
  "totalMs",
  // A call turn: the model's own time to its first words (lib/voice/retell.ts).
  "modelMs",
  "attempt",
  "units",
  "lateDays",
  // The location-quantity check (lib/billing/location-quantity.ts): the
  // locations an account has and the quantity Stripe bills it for. Counts.
  "locationCount",
  "billedCount",
  // An appointment's opaque id, for an ops alert about its calendar write
  // (lib/ops/calendar-write-alerts.ts). An id, never the booking.
  "appointmentId",
  // ...and how many attempts its write has had, which makes a retried
  // write that fails again a new alert. A count.
  "attemptCount",
  // The usage alerts to ops (lib/billing/usage-alerts.ts): a meter's units
  // used in its window and the allowance it includes. Counts.
  "used",
  "included",
  // A Slack member id (U...) pressing a support reply's button, or locking
  // Slack approvals with wrong passcodes (lib/support/slack-actions.ts, lane
  // P7i). An operator's id at Slack, never a clinic's or a patient's.
  "slackUser",
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
// Google's OAuth material, in the shapes Google issues it (plan §12): an
// access token (ya29.…), a refresh token (1//…), an authorization code
// (4/…), any JWT, which is what an ID token is, and the OAuth client's
// secret (GOCSPX-…). A fetch or driver error can echo the request that
// carried one, and a calendar connection's every request carries one. Each
// is a credential to a clinic's calendar, or to all of them; none has an
// email or a phone shape for the patterns above to catch.
const GOOGLE_SECRETS = [
  /ya29\.[\w.-]+/g,
  /1\/\/[\w.-]+/g,
  /\b4\/[\w-]{10,}/g,
  // The same two form- or URL-encoded (1%2F%2F…, 4%2F…), which is how
  // Google's token, revoke and callback traffic carries them.
  /1%2F%2F[\w.%-]+/gi,
  /\b4%2F[\w%-]{10,}/gi,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /GOCSPX-[\w-]+/g,
];
// An Authorization header, whatever scheme's token follows it.
const BEARER = /\bBearer\s+\S+/gi;
// A credential named by its OAuth parameter, whatever shape its value has, in
// a form body, a query string, or a relative URL with no scheme for
// URL_WITH_QUERY to see.
const OAUTH_PARAMS =
  /\b(refresh_token|access_token|id_token|client_secret|code_verifier)=[^&\s"']+/gi;

/** Replace anything that could identify a person, or open an account, in free text. Exported for tests. */
export function scrub(text: string): string {
  // Named parameters first, so a value the shapes below also match is
  // redacted once, as the parameter's.
  const withoutSecrets = GOOGLE_SECRETS.reduce(
    (out, pattern) => out.replace(pattern, "[token redacted]"),
    text.replace(BEARER, "Bearer [token redacted]").replace(OAUTH_PARAMS, "$1=[token redacted]"),
  );
  return withoutSecrets
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
 *
 * Nor drizzle's message. drizzle-orm 0.45 wraps every driver error in a
 * `DrizzleQueryError` whose own message is "Failed query: <the SQL>" and
 * "params: <every bound value>": a booking's time, a request's key and a
 * caller's first name sit beside the ids, and scrub() catches only phone-
 * and address-shaped text. So the wrapper is unwrapped to the database's own
 * error at `.cause` (its message names the constraint or our RAISE text,
 * never a row's values), and a wrapper with nothing under it (a pool
 * timeout, a socket dropped mid-query) says only that the query failed.
 * The same lesson as connect/[token]/actions.ts and lib/agreements.ts,
 * learned once for every caller.
 */
export function describeError(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isQueryWrapper(current); depth += 1) {
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null) {
      return `${(current as Error).name}: query failed before the database answered`;
    }
    current = cause;
  }
  if (isQueryWrapper(current)) return "Error: query failed";
  if (current instanceof Error) {
    return scrub(`${current.name}: ${current.message}`).slice(0, 300);
  }
  return "unknown error";
}

/** drizzle's DrizzleQueryError, by its shape: the failed query and its parameters as own properties. */
function isQueryWrapper(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.prototype.hasOwnProperty.call(error, "query") &&
    Object.prototype.hasOwnProperty.call(error, "params")
  );
}

export const log = {
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields),
};

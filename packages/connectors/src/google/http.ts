import { fail, failure, ok, statusWord, type Result } from "../result";

/**
 * The one door between this package and Google's HTTP endpoints, for the
 * Calendar adapter and the OAuth helpers alike.
 *
 * Three things every Google call gets here rather than at its call site:
 *
 *   - **A bound.** Each kind of call has its own timeout (plan §5.7), because
 *     the voice budget for a booking is eight seconds and a hung Google must
 *     become an answer, not a caller listening to silence.
 *   - **Nothing Google said in words.** A failure carries the HTTP status and
 *     at most one reason word, read from the error body's reason field and
 *     kept only if it matches /^[a-zA-Z_]{1,40}$/. Never a message: an error
 *     body can echo the request, and the request carries a token or a
 *     patient's first name.
 *   - **An injected fetch.** `setGoogleFetch` swaps in the offline fake for
 *     tests. Production never calls it, and every request then goes through
 *     the global fetch, resolved at call time.
 */

/** Every kind of request this package makes to Google. */
export type GoogleCall =
  | "exchange"
  | "refresh"
  | "revoke"
  | "freeBusy"
  | "insert"
  | "get"
  | "list"
  | "delete"
  | "calendarList";

/**
 * Plan §5.7. The voice budget (BOOK_CALENDAR_BUDGET_MS, 8 s) covers an insert
 * and its read-back, so neither may take longer than the two together allow.
 * The calendar list came after §5.7 was written and takes events.list's bound:
 * it is read while a person waits at a picker, never during a call.
 */
export const GOOGLE_TIMEOUTS_MS: Readonly<Record<GoogleCall, number>> = Object.freeze({
  exchange: 5_000,
  refresh: 3_000,
  freeBusy: 3_000,
  insert: 5_000,
  get: 2_000,
  delete: 4_000,
  revoke: 4_000,
  list: 4_000,
  calendarList: 4_000,
});

let fetchOverride: typeof fetch | undefined;
let timeoutOverrides: Partial<Record<GoogleCall, number>> | undefined;
const fetchChangeHooks = new Set<() => void>();

/**
 * Route every Google request through `impl`, or back to the global fetch with
 * `undefined`. Anything built on the previous fetch (the adapter's cache of
 * access tokens) is dropped, so a token one fake minted is never presented to
 * another.
 */
export function setGoogleFetch(impl: typeof fetch | undefined): void {
  fetchOverride = impl;
  for (const hook of fetchChangeHooks) hook();
}

/** Lets module state that depends on which Google it talked to be dropped when that changes. */
export function onGoogleFetchChange(hook: () => void): void {
  fetchChangeHooks.add(hook);
}

/**
 * Test seam: shorten the timeouts so a hang costs milliseconds. Database
 * tests cannot fake the clock instead, because the pool's own timers would
 * stop with it. `undefined` restores §5.7's values.
 */
export function setGoogleTimeouts(
  overrides: Partial<Record<GoogleCall, number>> | undefined,
): void {
  timeoutOverrides = overrides;
}

export function googleTimeoutMs(call: GoogleCall): number {
  return timeoutOverrides?.[call] ?? GOOGLE_TIMEOUTS_MS[call];
}

/**
 * Google's answer, whatever its status. `json` is the parsed body, undefined
 * when the body was empty or could not be read; `readable` is false when a
 * body arrived that was not JSON, which for an insert means "it may have
 * happened, read back before retrying".
 */
export type GoogleReply = {
  status: number;
  ok: boolean;
  headers: Headers;
  json: unknown;
  readable: boolean;
};

/**
 * One bounded request. The body is read under the same timer as the status
 * line, so a body that never finishes is a timeout too. A transport failure
 * is a Result failure (`timeout` or `network`, both meaning "unknown whether
 * it took effect"); any HTTP status, error or not, comes back as a reply for
 * the caller to map, because what a 404 or a 409 means depends on the call.
 */
export async function fetchWithTimeout(
  url: string,
  init: { method: "GET" | "POST" | "DELETE"; headers?: Record<string, string>; body?: string },
  call: GoogleCall,
  context: string,
): Promise<Result<GoogleReply>> {
  const timeoutMs = googleTimeoutMs(call);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await (fetchOverride ?? globalThis.fetch)(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } catch {
      // The thrown error can carry the request, token and all; neither its
      // message nor its shape is looked at.
      return lost(controller.signal.aborted, timeoutMs, context);
    }

    const reply = { status: response.status, ok: response.ok, headers: response.headers };
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (controller.signal.aborted) return lost(true, timeoutMs, context, response.status);
      return ok({ ...reply, json: undefined, readable: false });
    }

    if (text.trim() === "") return ok({ ...reply, json: undefined, readable: true });
    try {
      return ok({ ...reply, json: JSON.parse(text) as unknown, readable: true });
    } catch {
      return ok({ ...reply, json: undefined, readable: false });
    }
  } finally {
    clearTimeout(timer);
  }
}

function lost<T>(aborted: boolean, timeoutMs: number, context: string, status?: number): Result<T> {
  return aborted
    ? failure("unavailable", `${context}: no answer from Google within ${timeoutMs} ms`, {
        reason: "timeout",
        status,
      })
    : failure("unavailable", `${context}: could not reach Google`, { reason: "network", status });
}

const REASON_WORD = /^[a-zA-Z_]{1,40}$/;

/** A word Google wrote, kept only if it is a plain machine word; anything else is dropped unread. */
export function reasonWord(value: unknown): string | undefined {
  return typeof value === "string" && REASON_WORD.test(value) ? value : undefined;
}

/**
 * The reason a Calendar API error body gives, read from the fields Google's
 * two error formats carry one in: `error.errors[].reason` (the Calendar v3
 * format), then `error.details[].reason` (the newer ErrorInfo), then
 * `error.status`. Nothing else in the body is read.
 */
export function googleApiReason(json: unknown): string | undefined {
  if (!isRecord(json) || !isRecord(json.error)) return undefined;
  const error = json.error;
  for (const list of [error.errors, error.details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = isRecord(entry) ? reasonWord(entry.reason) : undefined;
      if (reason) return reason;
    }
  }
  return reasonWord(error.status);
}

/** The `error` word of an OAuth token-endpoint error body (RFC 6749 §5.2). */
export function googleTokenErrorWord(json: unknown): string | undefined {
  return isRecord(json) ? reasonWord(json.error) : undefined;
}

const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

const API_DISABLED_REASONS: ReadonlySet<string> = new Set([
  "accessNotConfigured",
  "SERVICE_DISABLED",
]);

/**
 * A non-2xx Calendar API answer as a Result (plan §5.6).
 *
 * The reason words the rest of the app keys on are ours, so the watch and the
 * booking path can tell the three classes apart without knowing Google's
 * vocabulary:
 *
 *   - definitive, calendar-level: `access_denied` (401; the caller has
 *     already retried once with a fresh token where a retry made sense),
 *     `insufficient_permissions` (every other 403: forbidden,
 *     insufficientPermissions, requiredAccessLevel and any word not listed
 *     here), `calendar_not_found` (404);
 *   - ours: `api_disabled` (403 accessNotConfigured);
 *   - transient: 429 and the 403 rate-limit reasons (`rate_limited`, with
 *     Google's own word as the reason), and 5xx (`unavailable`).
 *
 * Owner decision 5 makes a 403 on the target calendar definitive, apart from
 * the rate limits and a disabled API. So a 403 whose word this table does not
 * know, or cannot read, is `insufficient_permissions` too, and Google's word
 * stays in the message only. That takes the location to manual booking, the
 * safe direction: leaving the word unclassified would keep a calendar that
 * goes on refusing healdesk on live booking, with every write failing.
 */
export function googleApiError<T>(reply: GoogleReply, context: string): Result<T> {
  const { status } = reply;
  const given = googleApiReason(reply.json);
  const said = given ?? statusWord(status, undefined);
  const base = { message: `${context}: Google answered ${status} ${said}`, status };

  if (status === 401) {
    return fail({ ...base, code: "unauthorised", retryable: false, reason: "access_denied" });
  }
  if (status === 429 || (status === 403 && given !== undefined && RATE_LIMIT_REASONS.has(given))) {
    return fail({
      ...base,
      code: "rate_limited",
      retryable: true,
      reason: given ?? "rate_limited",
      retryAfter: retryAfterOf(reply.headers),
    });
  }
  if (status === 403 && given !== undefined && API_DISABLED_REASONS.has(given)) {
    return fail({ ...base, code: "misconfigured", retryable: false, reason: "api_disabled" });
  }
  if (status === 403) {
    return fail({
      ...base,
      code: "unauthorised",
      retryable: false,
      reason: "insufficient_permissions",
    });
  }
  if (status === 404) {
    return fail({ ...base, code: "misconfigured", retryable: false, reason: "calendar_not_found" });
  }
  if (status >= 500) {
    return fail({ ...base, code: "unavailable", retryable: true, reason: said });
  }
  return fail({ ...base, code: "unknown", retryable: false, reason: said });
}

/**
 * A non-2xx answer to an insert, or to the read-back that settles a 409, as a
 * Result. The same as googleApiError, except that a 5xx is `unconfirmed`:
 * Google may have stored the event before it fell over, so the answer is not
 * "no" but "read back before anything is tried again", as for a timeout
 * (result.ts, `reason`). Read as a plain no, a booking Google did take would
 * be recorded as failed, and the desk told to add it by hand a second time.
 */
export function googleWriteError<T>(reply: GoogleReply, context: string): Result<T> {
  const { status } = reply;
  if (status < 500) return googleApiError(reply, context);
  const said = googleApiReason(reply.json) ?? statusWord(status, undefined);
  return fail({
    code: "unavailable",
    message: `${context}: Google answered ${status} ${said}; the event may exist, so read back before retrying`,
    retryable: true,
    status,
    reason: "unconfirmed",
  });
}

const OAUTH_CLIENT_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
  "redirect_uri_mismatch",
]);

/**
 * A non-2xx answer from Google's token endpoint as a Result (plan §5.6).
 *
 * The split that matters is between a grant that is gone and a client that is
 * wrong. `invalid_grant` and `admin_policy_enforced` are about one clinic's
 * grant: definitive, and the app erases that clinic's token. Anything about
 * the client — `invalid_client`, `unauthorized_client`, `deleted_client`, a
 * redirect URI Google does not recognise, or any 401, which at this endpoint
 * is client authentication — is `oauth_client`: ours, the same for every
 * clinic, and never a reason to erase a clinic's token.
 */
export function googleTokenError<T>(reply: GoogleReply, context: string): Result<T> {
  const { status } = reply;
  const given = googleTokenErrorWord(reply.json);
  const said = given ?? statusWord(status, undefined);
  const base = {
    message: `${context}: Google's token endpoint answered ${status} ${said}`,
    status,
  };

  if (given === "invalid_grant" || given === "admin_policy_enforced") {
    return fail({ ...base, code: "unauthorised", retryable: false, reason: given });
  }
  if ((given !== undefined && OAUTH_CLIENT_ERRORS.has(given)) || status === 401) {
    return fail({ ...base, code: "misconfigured", retryable: false, reason: "oauth_client" });
  }
  if (status === 429) {
    return fail({
      ...base,
      code: "rate_limited",
      retryable: true,
      reason: said,
      retryAfter: retryAfterOf(reply.headers),
    });
  }
  if (status >= 500) {
    return fail({ ...base, code: "unavailable", retryable: true, reason: said });
  }
  return fail({ ...base, code: "unknown", retryable: false, reason: said });
}

function retryAfterOf(headers: Headers): number | undefined {
  const seconds = Number.parseInt(headers.get("retry-after") ?? "", 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Results, rather than exceptions, at the adapter boundary.
 *
 * A sync touches many clinics and many pages. One platform being rate-limited
 * or briefly down must not abort the run for everyone else, and a thrown error
 * makes "continue with the rest, record why this one stopped" awkward enough
 * that people write bare catch blocks instead.
 *
 * The failure shape carries a `retryable` flag because the two cases need
 * opposite handling: a 429 should back off and try again, a 401 should mark the
 * connection broken and tell someone. Treating them alike either hammers a
 * dead credential or gives up on a transient blip.
 */

export type ConnectorErrorCode =
  /** Credentials rejected. Needs a human; do not retry. */
  | "unauthorised"
  /** Rate limited. Back off. */
  | "rate_limited"
  /** Platform is down or unreachable. */
  | "unavailable"
  /** We asked for something the platform doesn't offer. Do not retry. */
  | "unsupported"
  /** The platform's response didn't match what we expected. */
  | "malformed_response"
  | "unknown";

export type ConnectorError = {
  code: ConnectorErrorCode;
  /** Safe to log and show an operator. Never contains credentials or PHI. */
  message: string;
  retryable: boolean;
  /** Seconds, when the platform tells us. */
  retryAfter?: number;
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectorError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(error: ConnectorError): Result<T> {
  return { ok: false, error };
}

const NON_RETRYABLE: ReadonlySet<ConnectorErrorCode> = new Set([
  "unauthorised",
  "unsupported",
]);

export function failure<T>(
  code: ConnectorErrorCode,
  message: string,
  options: { retryAfter?: number } = {},
): Result<T> {
  return fail({
    code,
    message,
    retryable: !NON_RETRYABLE.has(code),
    retryAfter: options.retryAfter,
  });
}

/**
 * Turn an unknown thrown value into a Result.
 *
 * Deliberately does NOT include the original error's message by default: a
 * driver or HTTP client error can carry the request body, and the request body
 * can carry the credential that caused it.
 */
export function fromThrown<T>(
  thrown: unknown,
  context: string,
): Result<T> {
  const status = (thrown as { status?: number; statusCode?: number })?.status
    ?? (thrown as { statusCode?: number })?.statusCode;

  if (status === 401 || status === 403) {
    return failure("unauthorised", `${context}: credentials rejected`);
  }
  if (status === 429) {
    return failure("rate_limited", `${context}: rate limited`);
  }
  if (typeof status === "number" && status >= 500) {
    return failure("unavailable", `${context}: platform returned ${status}`);
  }

  return failure("unknown", `${context}: request failed`);
}

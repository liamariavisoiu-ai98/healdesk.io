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
  /**
   * The connection's own configuration is incomplete, or the platform side is
   * set up in a way we refuse to write into. Needs a human; do not retry.
   */
  | "misconfigured"
  | "unknown";

export type ConnectorError = {
  code: ConnectorErrorCode;
  /** Safe to log and show an operator. Never contains credentials or PHI. */
  message: string;
  retryable: boolean;
  /** Seconds, when the platform tells us. */
  retryAfter?: number;
  /**
   * The HTTP status, when the platform answered at all. Absent when it did not
   * — see `reason` — and then the caller cannot know whether the request took
   * effect.
   */
  status?: number;
  /**
   * A short machine word for the console and the audit row: the platform's
   * status word (`unauthorized`, `conflict`), or ours (`timeout`, `network`,
   * `emails_or_workflows_on`). Never a response body, never PHI.
   *
   * For a write, `timeout`, `network` and `unconfirmed` mean "the outcome is
   * unknown": read back before retrying. `unconfirmed` covers a 2xx whose
   * body could not be read, and a 5xx, since a platform can commit a write
   * and then fail before it answers. Everything else means the platform
   * answered, and its answer was no.
   */
  reason?: string;
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
  "misconfigured",
]);

export function failure<T>(
  code: ConnectorErrorCode,
  message: string,
  options: { retryAfter?: number; status?: number; reason?: string } = {},
): Result<T> {
  return fail({
    code,
    message,
    retryable: !NON_RETRYABLE.has(code),
    retryAfter: options.retryAfter,
    status: options.status,
    reason: options.reason,
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

/** Words for the statuses vendors most often return with an empty reason phrase (HTTP/2 has none). */
const STATUS_WORDS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  408: "request_timeout",
  409: "conflict",
  410: "gone",
  422: "unprocessable",
  429: "rate_limited",
  500: "server_error",
  502: "bad_gateway",
  503: "unavailable",
  504: "gateway_timeout",
};

/**
 * A short, log-safe word for an HTTP status: the reason phrase the platform
 * sent, normalised, or a fixed word when it sent none.
 */
export function statusWord(status: number, statusText: string | undefined): string {
  const normalised = (statusText ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalised || STATUS_WORDS[status] || `http_${status}`;
}

/**
 * Map a non-2xx answer from the platform into a Result.
 *
 * Reads nothing but the status line, on purpose. An error body is where a
 * vendor echoes the request back — attendee name, email, the lot — so no
 * adapter reads one to build an error. The word the console sees is the
 * status text or a fixed table entry, never something the vendor composed.
 *
 * Retryable only when the platform said to come back (429) or fell over
 * (5xx). A 4xx is an answer, and asking the same question again gets the same
 * answer.
 */
export function fromHttpStatus<T>(
  status: number,
  statusText: string | undefined,
  context: string,
  options: { retryAfter?: number } = {},
): Result<T> {
  const reason = statusWord(status, statusText);
  const message = `${context}: platform returned ${status} ${reason}`;

  if (status === 401 || status === 403) {
    return fail({ code: "unauthorised", message, retryable: false, status, reason });
  }
  if (status === 429) {
    return fail({
      code: "rate_limited",
      message,
      retryable: true,
      status,
      reason,
      retryAfter: options.retryAfter,
    });
  }
  if (status >= 500) {
    return fail({ code: "unavailable", message, retryable: true, status, reason });
  }

  return fail({ code: "unknown", message, retryable: false, status, reason });
}

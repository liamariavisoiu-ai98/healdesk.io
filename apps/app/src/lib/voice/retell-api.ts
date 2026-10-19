/**
 * The two calls healdesk makes to Retell's own API, for the fall-through
 * (T14 in docs/hipaa-risk-analysis.md): read a phone number's
 * `fallback_number`, and set it.
 *
 * Retell has no setting that sends a call elsewhere when a custom-LLM
 * endpoint cannot be reached: it tries to open the WebSocket three times and
 * then ends the call (`error_llm_websocket_open`). What it does have is a
 * fallback number on each phone number, which takes the call when the
 * number's concurrency is full and when the Retell workspace is put in outage
 * mode (Settings → Reliability, in Retell's dashboard). Our code keeps that
 * fallback equal to the clinic's direct line (retell-fallback-sync.ts), so
 *
 *   - outage mode is the one switch that sends every clinic's forwarded
 *     calls straight to its direct line while our endpoint is down
 *     (docs/on-call.md, "Voice endpoint down"); and
 *   - the voice endpoint can read the direct line back from Retell when it
 *     cannot read our database (fallback-line.ts).
 *
 * A clinic's direct line is business contact data, not PHI: no caller, no
 * call, no words cross here. The key is HEALDESK_RETELL_API_KEY, the BAA
 * workspace's API key (never the marketing site's RETELL_API_KEY, which is a
 * different workspace). Nothing here logs a number.
 */

export const RETELL_API_ORIGIN = "https://api.retellai.com";

/** Short enough that a call waiting on it is still in its first seconds. */
const DEFAULT_TIMEOUT_MS = 2_500;

export type RetellApiOptions = {
  key?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type RetellPhoneNumber = {
  phoneNumber: string;
  fallbackNumber: string | null;
};

/** E.164, as Retell and clinic_settings both keep it. */
export function isE164(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
}

/** The key, or null when unset or still the image's placeholder. */
export function retellApiKey(): string | null {
  const value = process.env.HEALDESK_RETELL_API_KEY?.trim();
  return value && value !== "__unset__" ? value : null;
}

export class RetellApiError extends Error {
  constructor(readonly status: number) {
    super(`Retell API answered ${status}`);
    this.name = "RetellApiError";
  }
}

async function request(path: string, init: RequestInit, options: RetellApiOptions): Promise<Response> {
  const key = options.key === undefined ? retellApiKey() : options.key;
  if (!key) throw new Error("HEALDESK_RETELL_API_KEY is not set");
  return (options.fetch ?? fetch)(`${RETELL_API_ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

function numberPath(prefix: string, number: string): string {
  if (!isE164(number)) throw new Error("not an E.164 number");
  return `/${prefix}/${encodeURIComponent(number)}`;
}

function parse(body: unknown): RetellPhoneNumber | null {
  const b = body as { phone_number?: unknown; fallback_number?: unknown } | null;
  if (!b || !isE164(b.phone_number)) return null;
  return { phoneNumber: b.phone_number, fallbackNumber: isE164(b.fallback_number) ? b.fallback_number : null };
}

/** The number as Retell holds it; null when Retell has no such number. Throws on any other failure. */
export async function getRetellPhoneNumber(number: string, options: RetellApiOptions = {}): Promise<RetellPhoneNumber | null> {
  const response = await request(numberPath("get-phone-number", number), { method: "GET" }, options);
  if (response.status === 404) return null;
  if (!response.ok) throw new RetellApiError(response.status);
  return parse(await response.json());
}

/** Point the number's fallback at `fallback`. Throws unless Retell accepted it. */
export async function setRetellFallbackNumber(number: string, fallback: string, options: RetellApiOptions = {}): Promise<void> {
  if (!isE164(fallback) || fallback === number) throw new Error("not a usable fallback number");
  const response = await request(
    numberPath("update-phone-number", number),
    { method: "PATCH", body: JSON.stringify({ fallback_number: fallback }) },
    options,
  );
  if (!response.ok) throw new RetellApiError(response.status);
}

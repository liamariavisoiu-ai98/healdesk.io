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
  /**
   * `missing`: a 404 that is Retell's own "no such thing" answer
   * (isRetellNotFound), as opposed to a 404 from a wrong route or a proxy.
   */
  constructor(
    readonly status: number,
    readonly missing = false,
  ) {
    super(`Retell API answered ${status}`);
    this.name = "RetellApiError";
  }
}

/**
 * Is this 404 Retell's own answer for a thing that does not exist?
 *
 * Live Retell, 22 October 2026: a call that does not exist, on the right
 * route, answers 404 with a JSON body {"status":"error","message":"Not
 * Found"}. A wrong route answers 404 with an HTML page ("Cannot DELETE
 * /..."). Only the first means "already gone". An HTML, empty or unparseable
 * 404 is a mistake of ours (a wrong path) or a proxy's, and treating it as
 * success would report a delete that never happened. The body is read from a
 * clone and never kept or logged.
 */
export async function isRetellNotFound(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  try {
    const body: unknown = JSON.parse(await response.clone().text());
    return typeof body === "object" && body !== null && (body as { status?: unknown }).status === "error";
  } catch {
    return false;
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
  if (await isRetellNotFound(response)) return null;
  if (!response.ok) throw new RetellApiError(response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A parse error quotes the body; this says only what failed.
    throw new Error("Retell answered with a body that is not JSON");
  }
  return parse(body);
}

/** Point the number's fallback at `fallback`, or clear it with null. Throws unless Retell accepted it. */
export async function setRetellFallbackNumber(number: string, fallback: string | null, options: RetellApiOptions = {}): Promise<void> {
  if (fallback !== null && (!isE164(fallback) || fallback === number)) throw new Error("not a usable fallback number");
  const response = await request(
    numberPath("update-phone-number", number),
    { method: "PATCH", body: JSON.stringify({ fallback_number: fallback }) },
    options,
  );
  if (!response.ok) throw new RetellApiError(response.status);
  // A field Retell renamed or ignores would answer 200 and set nothing, and
  // the sync would report success every hour: the answer must carry it.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Retell answered with a body that is not JSON");
  }
  if (parse(body)?.fallbackNumber !== fallback) throw new Error("Retell did not keep the fallback number");
}

/** Expressive Mode on an agent, as Retell holds it, cached for a while per agent: a call reads it as it starts. */
const expressiveSeen = new Map<string, { at: number; value: boolean }>();
const EXPRESSIVE_FRESH_MS = 10 * 60_000;

/**
 * Whether Retell's Expressive Mode is on for this agent (get-agent's
 * enable_expressive_mode; Retell docs, read 1 November 2026: it reads emotion
 * tags in the text only on platform voices with the mode on). False on any
 * doubt: no key, a failure, a missing agent. A call sends no tag unless this
 * says true, so a tag is never read aloud by an agent that has not got it yet.
 */
export async function retellAgentExpressive(agentId: string, options: RetellApiOptions = {}): Promise<boolean> {
  if (!/^[\w-]{6,80}$/.test(agentId)) return false;
  const seen = expressiveSeen.get(agentId);
  if (seen && Date.now() - seen.at < EXPRESSIVE_FRESH_MS) return seen.value;
  try {
    const response = await request(`/get-agent/${encodeURIComponent(agentId)}`, { method: "GET" }, { timeoutMs: 2_000, ...options });
    if (!response.ok) return false;
    const body = (await response.json()) as { enable_expressive_mode?: unknown } | null;
    const value = body?.enable_expressive_mode === true;
    expressiveSeen.set(agentId, { at: Date.now(), value });
    return value;
  } catch {
    return false;
  }
}

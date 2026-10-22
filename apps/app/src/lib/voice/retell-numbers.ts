import { isE164, isRetellNotFound, RETELL_API_ORIGIN, RetellApiError, retellApiKey, type RetellApiOptions } from "./retell-api";

/**
 * Retell's phone-number calls that automated voice provisioning makes
 * (lib/voice/provision.ts): buy a number, find one we bought by its
 * nickname, read one back in full, bind it to the clinic's agent for inbound
 * calls only, and delete it. The fallback number keeps its own two calls in
 * retell-api.ts, which the hourly fallback sync shares.
 *
 * Only createRetellPhoneNumber spends money, and only provision.ts calls it,
 * behind the owner's switch, the paid-invoice check and the daily cap. Every
 * request goes through an injectable fetch; tests never reach Retell.
 *
 * From Retell's API reference (Context7, 21 October 2026): POST
 * /create-phone-number (area_code, country_code, nickname, inbound_agents),
 * GET /get-phone-number/<n>, PATCH /update-phone-number/<n> (inbound_agents,
 * outbound_agents, nickname), DELETE /delete-phone-number/<n> (204), GET
 * /v2/list-phone-numbers (the paginated `items`, `pagination_key`,
 * `has_more` that replaced GET /list-phone-numbers on 15 June 2026). The
 * single-agent fields (inbound_agent_id) were removed on 31 March 2026 for
 * the weighted lists. Not shown there, and so UNCONFIRMED: the list call's
 * query parameter for the next page (sent as `pagination_key`), and that a
 * missing number answers 404 rather than only the documented 422.
 */

const TIMEOUT_MS = 10_000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** How many pages of numbers a lookup reads before giving up: a guard, not a limit we expect to meet. */
const MAX_PAGES = 50;

/** A number as provisioning reads it: what it is bound to, and nothing about any call. */
export type RetellNumberView = {
  phoneNumber: string;
  nickname: string | null;
  /** Agent ids bound for inbound calls. */
  inboundAgentIds: string[];
  /** How many agents are bound for outbound calls; ours must be none (v1 is inbound only). */
  outboundAgents: number;
  fallbackNumber: string | null;
  inboundWebhookUrl: string | null;
};

/** The nickname every number we buy carries: how a crashed run finds it again. */
export function numberNickname(clinicId: string): string {
  return `healdesk ${clinicId}`;
}

function keyOf(options: RetellApiOptions): string {
  const key = options.key === undefined ? retellApiKey() : options.key;
  if (!key) throw new Error("HEALDESK_RETELL_API_KEY is not set");
  return key;
}

async function call(path: string, init: RequestInit, options: RetellApiOptions): Promise<Response> {
  return (options.fetch ?? fetch)(`${RETELL_API_ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${keyOf(options)}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  });
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // A parse error quotes the body; this says only what failed.
    throw new Error("Retell answered with a body that is not JSON");
  }
}

function numberPath(prefix: string, number: string): string {
  if (!isE164(number)) throw new Error("not an E.164 number");
  return `/${prefix}/${encodeURIComponent(number)}`;
}

function agentIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => (a as { agent_id?: unknown } | null)?.agent_id)
    .filter((id): id is string => typeof id === "string" && AGENT_ID.test(id));
}

/** Pure: a number as Retell describes it. Null when the body is not a number. */
export function readNumber(body: unknown): RetellNumberView | null {
  const b = body as {
    phone_number?: unknown;
    nickname?: unknown;
    inbound_agents?: unknown;
    outbound_agents?: unknown;
    fallback_number?: unknown;
    inbound_webhook_url?: unknown;
  } | null;
  if (!b || !isE164(b.phone_number)) return null;
  return {
    phoneNumber: b.phone_number,
    nickname: typeof b.nickname === "string" ? b.nickname : null,
    inboundAgentIds: agentIds(b.inbound_agents),
    outboundAgents: Array.isArray(b.outbound_agents) ? b.outbound_agents.length : 0,
    fallbackNumber: isE164(b.fallback_number) ? b.fallback_number : null,
    inboundWebhookUrl: typeof b.inbound_webhook_url === "string" ? b.inbound_webhook_url : null,
  };
}

/**
 * Buy a number for the clinic (POST /create-phone-number), bound to its
 * agent for inbound calls only, with our nickname. COSTS MONEY: only
 * provision.ts calls it, after its spend guard. `areaCode` is a US area
 * code, when the clinic's published number gives one.
 */
export async function createRetellPhoneNumber(
  input: { clinicId: string; agentId: string; areaCode: number | null; countryCode: "US" | "CA" },
  options: RetellApiOptions,
): Promise<RetellNumberView> {
  if (!AGENT_ID.test(input.agentId)) throw new Error("not a Retell agent id");
  const response = await call(
    "/create-phone-number",
    {
      method: "POST",
      body: JSON.stringify({
        ...(input.areaCode !== null ? { area_code: input.areaCode } : {}),
        country_code: input.countryCode,
        toll_free: false,
        nickname: numberNickname(input.clinicId),
        inbound_agents: [{ agent_id: input.agentId, weight: 1 }],
        outbound_agents: [],
      }),
    },
    options,
  );
  if (!response.ok) throw new RetellApiError(response.status);
  const number = readNumber(await jsonOf(response));
  if (!number) throw new Error("Retell answered without a phone number");
  return number;
}

/** The number in full; null when Retell has no such number (404, or its documented 422). */
export async function getRetellNumber(number: string, options: RetellApiOptions): Promise<RetellNumberView | null> {
  const response = await call(numberPath("get-phone-number", number), { method: "GET" }, options);
  if (response.status === 422 || (await isRetellNotFound(response))) return null;
  if (!response.ok) throw new RetellApiError(response.status);
  return readNumber(await jsonOf(response));
}

/**
 * The number we bought for this clinic, found by its nickname, or null. For
 * a run that crashed after buying and before recording: it adopts what is
 * there instead of buying again.
 */
export async function findRetellNumberByNickname(clinicId: string, options: RetellApiOptions): Promise<RetellNumberView | null> {
  const wanted = numberNickname(clinicId);
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const query: string = page ? `?pagination_key=${encodeURIComponent(page)}` : "";
    const response = await call(`/v2/list-phone-numbers${query}`, { method: "GET" }, options);
    if (!response.ok) throw new RetellApiError(response.status);
    const body = (await jsonOf(response)) as { items?: unknown; pagination_key?: unknown; has_more?: unknown } | null;
    const items = Array.isArray(body?.items) ? body.items : [];
    for (const item of items) {
      const n = readNumber(item);
      if (n && n.nickname === wanted) return n;
    }
    if (body?.has_more !== true || typeof body.pagination_key !== "string" || !body.pagination_key) return null;
    page = body.pagination_key;
  }
  throw new Error("Retell's number list did not end");
}

/**
 * Bind the number to the clinic's agent for inbound calls, and to nothing
 * outbound (PATCH /update-phone-number/<n>). Throws unless Retell's answer
 * carries the binding.
 */
export async function bindRetellNumber(
  number: string,
  input: { clinicId: string; agentId: string },
  options: RetellApiOptions,
): Promise<RetellNumberView> {
  if (!AGENT_ID.test(input.agentId)) throw new Error("not a Retell agent id");
  const response = await call(
    numberPath("update-phone-number", number),
    {
      method: "PATCH",
      body: JSON.stringify({
        inbound_agents: [{ agent_id: input.agentId, weight: 1 }],
        outbound_agents: [],
        nickname: numberNickname(input.clinicId),
      }),
    },
    options,
  );
  if (!response.ok) throw new RetellApiError(response.status);
  const view = readNumber(await jsonOf(response));
  if (!view || view.inboundAgentIds.length !== 1 || view.inboundAgentIds[0] !== input.agentId || view.outboundAgents !== 0) {
    throw new Error("Retell did not keep the number's agent");
  }
  return view;
}

/** Release the number (DELETE /delete-phone-number/<n>, 204). "absent" when Retell has none. */
export async function deleteRetellNumber(number: string, options: RetellApiOptions): Promise<"deleted" | "absent"> {
  const response = await call(numberPath("delete-phone-number", number), { method: "DELETE" }, options);
  if (response.status === 422 || (await isRetellNotFound(response))) return "absent";
  if (!response.ok) throw new RetellApiError(response.status);
  return "deleted";
}

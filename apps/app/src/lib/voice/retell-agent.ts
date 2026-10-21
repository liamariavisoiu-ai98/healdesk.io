import { RETELL_API_ORIGIN, RetellApiError, retellApiKey, type RetellApiOptions } from "./retell-api";

/**
 * A clinic's Retell agent, written by code with call storage restricted
 * (NOAUDIO-01): CLAUDE.md promises no call audio is kept, and until 21
 * October 2026 that rested on a setting chosen by hand in Retell's console,
 * whose default (`everything`) keeps transcripts, recordings and logs.
 *
 * Every agent this writes carries:
 *
 *   - `data_storage_setting: "basic_attributes_only"`, the most restrictive
 *     of Retell's three (`everything`, `everything_except_pii`, which still
 *     keeps a scrubbed recording, and this one, which keeps "only basic
 *     attributes; no transcripts/recordings/logs"; Retell's create-agent and
 *     get-call references). The product does not need Retell's copy: every
 *     word of a call reaches us live over the custom-LLM WebSocket
 *     (src/voice/server.ts, lib/voice/retell.ts) and the transcript the clinic
 *     gets is our own, sealed in the outbox. The one reader of Retell's copy
 *     is the crash backstop (lib/voice/backstop.ts), which then records
 *     nothing of a call whose voice task died: an owner question, in the
 *     NOAUDIO-01 report.
 *   - the custom-LLM response engine at
 *     `wss://<public host>/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>`
 *     (Retell appends the call id; src/voice/server.ts), on the public origin
 *     BETTER_AUTH_URL names;
 *   - its webhooks at `https://<public host>/api/webhooks/retell/<clinic id>`,
 *     which the backstop and the recording alerts read
 *     (app/api/webhooks/retell/[clinicId]/route.ts).
 *
 * The secret is in the URL Retell holds, so nothing here logs, returns or
 * throws a URL: verifyRetellAgent compares inside and answers yes or no.
 * Every request goes through an injectable fetch (RetellApiOptions); nothing
 * calls these yet, and no switch is set by them. Where a clinic's agent id is
 * kept is data, not configuration: the caller holds it.
 */

/** The only storage setting this code writes. */
export const RETELL_DATA_STORAGE_SETTING = "basic_attributes_only" as const;

/** Retell's three, as its API names them. */
export const RETELL_DATA_STORAGE_SETTINGS = ["everything", "everything_except_pii", "basic_attributes_only"] as const;
export type RetellDataStorageSetting = (typeof RETELL_DATA_STORAGE_SETTINGS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The voice server's own rule for the secret (src/voice/server.ts, PATH). */
const SECRET = /^[^/\s]{16,200}$/;

export type RetellAgentOptions = RetellApiOptions & {
  /** HEALDESK_RETELL_LLM_SECRET; read from the environment when absent. */
  llmSecret?: string | null;
  /** The public origin (BETTER_AUTH_URL); read from the environment when absent. */
  publicOrigin?: string | null;
};

export class RetellAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetellAgentConfigError";
  }
}

function present(value: string | undefined | null): string | null {
  const v = value?.trim();
  return v && v !== "__unset__" ? v : null;
}

function origin(options: RetellAgentOptions): URL {
  const raw = options.publicOrigin === undefined ? present(process.env.BETTER_AUTH_URL) : present(options.publicOrigin);
  if (!raw) throw new RetellAgentConfigError("BETTER_AUTH_URL is not set: there is no public host for the agent");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RetellAgentConfigError("BETTER_AUTH_URL is not a URL");
  }
  if (url.protocol !== "https:") throw new RetellAgentConfigError("BETTER_AUTH_URL must be https for Retell to reach it");
  return url;
}

function llmSecret(options: RetellAgentOptions): string {
  const secret = options.llmSecret === undefined ? present(process.env.HEALDESK_RETELL_LLM_SECRET) : present(options.llmSecret);
  if (!secret || !SECRET.test(secret)) throw new RetellAgentConfigError("HEALDESK_RETELL_LLM_SECRET is not set to a usable value");
  return secret;
}

function clinicPath(clinicId: string): string {
  if (!UUID.test(clinicId)) throw new RetellAgentConfigError("not a clinic id");
  return clinicId;
}

function agentPath(agentId: string): string {
  if (!AGENT_ID.test(agentId)) throw new RetellAgentConfigError("not a Retell agent id");
  return encodeURIComponent(agentId);
}

/** The settings every agent of ours carries, for one clinic. Holds the secret: never log it. */
export function retellAgentSettings(clinicId: string, options: RetellAgentOptions = {}) {
  const id = clinicPath(clinicId);
  const host = origin(options).host;
  return {
    response_engine: {
      type: "custom-llm" as const,
      llm_websocket_url: `wss://${host}/llm-websocket/${llmSecret(options)}/${id}`,
    },
    webhook_url: `https://${host}/api/webhooks/retell/${id}`,
    data_storage_setting: RETELL_DATA_STORAGE_SETTING,
  };
}

async function send(path: string, init: RequestInit, options: RetellApiOptions): Promise<unknown> {
  const key = options.key === undefined ? retellApiKey() : options.key;
  if (!key) throw new RetellAgentConfigError("HEALDESK_RETELL_API_KEY is not set");
  const response = await (options.fetch ?? fetch)(`${RETELL_API_ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new RetellApiError(response.status);
  try {
    return await response.json();
  } catch {
    // A parse error quotes the body; this says only what failed.
    throw new Error("Retell answered with a body that is not JSON");
  }
}

export type RetellAgentCheck = {
  /** Retell's answer names data_storage_setting basic_attributes_only. */
  storageRestricted: boolean;
  /** What Retell says the setting is, or null when it said none (Retell's default is everything). */
  storageSetting: RetellDataStorageSetting | null;
  /** The response engine is our custom-LLM endpoint for this clinic, with the current secret. */
  engineIsOurs: boolean;
  /** The webhooks come to this clinic's route. */
  webhookIsOurs: boolean;
};

/** Pure: an agent as Retell describes it, checked against what it should be. Never returns a URL. */
export function checkRetellAgent(body: unknown, clinicId: string, options: RetellAgentOptions = {}): RetellAgentCheck {
  const expected = retellAgentSettings(clinicId, options);
  const b = (body && typeof body === "object" ? body : {}) as {
    data_storage_setting?: unknown;
    response_engine?: { type?: unknown; llm_websocket_url?: unknown } | null;
    webhook_url?: unknown;
  };
  const setting = (RETELL_DATA_STORAGE_SETTINGS as readonly unknown[]).includes(b.data_storage_setting)
    ? (b.data_storage_setting as RetellDataStorageSetting)
    : null;
  return {
    storageRestricted: setting === RETELL_DATA_STORAGE_SETTING,
    storageSetting: setting,
    engineIsOurs:
      b.response_engine?.type === "custom-llm" && b.response_engine.llm_websocket_url === expected.response_engine.llm_websocket_url,
    webhookIsOurs: b.webhook_url === expected.webhook_url,
  };
}

function agentIdOf(body: unknown): string {
  const id = (body as { agent_id?: unknown } | null)?.agent_id;
  if (typeof id !== "string" || !AGENT_ID.test(id)) throw new Error("Retell answered without an agent id");
  return id;
}

function mustHold(check: RetellAgentCheck): void {
  // A field Retell renamed or ignores would answer 200 and set nothing: the
  // answer must carry what was written, as setRetellFallbackNumber checks.
  if (!check.storageRestricted) throw new Error("Retell did not keep the agent's storage restricted");
  if (!check.engineIsOurs) throw new Error("Retell did not keep the agent's response engine");
  if (!check.webhookIsOurs) throw new Error("Retell did not keep the agent's webhook");
}

/**
 * Create a clinic's agent with storage restricted (POST /create-agent).
 * `voiceId` is Retell's voice, the one thing about the agent we do not
 * decide here. Returns the agent id and the check of Retell's answer; throws
 * unless Retell kept all three settings.
 */
export async function createRetellAgent(
  clinicId: string,
  input: { voiceId: string; agentName?: string },
  options: RetellAgentOptions = {},
): Promise<{ agentId: string; check: RetellAgentCheck }> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.voiceId)) throw new RetellAgentConfigError("not a Retell voice id");
  const body = await send(
    "/create-agent",
    {
      method: "POST",
      body: JSON.stringify({
        ...retellAgentSettings(clinicId, options),
        voice_id: input.voiceId,
        // The clinic id, never its name: the agent list is Retell's dashboard.
        agent_name: (input.agentName ?? `healdesk ${clinicId}`).slice(0, 120),
      }),
    },
    options,
  );
  const agentId = agentIdOf(body);
  const check = checkRetellAgent(body, clinicId, options);
  mustHold(check);
  return { agentId, check };
}

/**
 * Bring an existing agent to our settings (PATCH /update-agent/<id>): storage
 * restricted, our engine, our webhook. Throws unless Retell kept all three.
 */
export async function updateRetellAgent(
  agentId: string,
  clinicId: string,
  options: RetellAgentOptions = {},
): Promise<RetellAgentCheck> {
  const body = await send(
    `/update-agent/${agentPath(agentId)}`,
    { method: "PATCH", body: JSON.stringify(retellAgentSettings(clinicId, options)) },
    options,
  );
  const check = checkRetellAgent(body, clinicId, options);
  mustHold(check);
  return check;
}

/**
 * Read the agent back (GET /get-agent/<id>) and say whether its storage is
 * restricted and it is wired to us. A report, never a gate: nothing refuses a
 * call on it (the owner's design of 21 October 2026); a recording Retell
 * keeps anyway is caught per call (lib/voice/recording-alerts.ts). Throws on
 * any failure to read, so a caller never mistakes "unknown" for "restricted".
 */
export async function verifyRetellAgent(
  agentId: string,
  clinicId: string,
  options: RetellAgentOptions = {},
): Promise<RetellAgentCheck> {
  const body = await send(`/get-agent/${agentPath(agentId)}`, { method: "GET" }, options);
  return checkRetellAgent(body, clinicId, options);
}

import { RETELL_API_ORIGIN, RetellApiError, retellApiKey, type RetellApiOptions } from "./retell-api";

/**
 * A clinic's Retell agent, written by code so its storage does not rest on a
 * setting chosen by hand in Retell's console.
 *
 * Every agent this writes carries:
 *
 *   - `data_storage_setting: "everything"`, Retell's default: it keeps the
 *     call's transcript, and with it the recording and logs. The owner chose
 *     on 21 October 2026 to keep Retell's transcript until the call is over,
 *     reversing NOAUDIO-01's `basic_attributes_only`, so the crash backstop
 *     (lib/voice/backstop.ts) can read the words of a call whose voice task
 *     died. Retell has no setting that keeps the transcript without the
 *     audio (its create-agent and privacy references name only three:
 *     `everything`; `everything_except_pii`, which scrubs PII from the
 *     transcript itself as well as the recording, so the clinic's
 *     transcript email would lose the caller's name and number; and
 *     `basic_attributes_only`, which keeps no transcript). Once the call is
 *     recorded here the backstop job deletes it at Retell
 *     (lib/voice/recording-alerts.ts).
 *   - `data_storage_retention_days: 1`, the least Retell takes (1 to 730):
 *     Retell's own deletion, a day later, of anything ours did not delete.
 *   - the response engine the caller names (`engine`, a RetellEngine). The
 *     owner is assessing Retell's own LLM against our custom-LLM socket (21
 *     October 2026, nothing decided), so the engine is an input, not a
 *     choice made here:
 *       - `{ type: "custom-llm" }`: our endpoint at
 *         `wss://<public host>/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>`
 *         (Retell appends the call id; src/voice/server.ts), on the public
 *         origin BETTER_AUTH_URL names;
 *       - `{ type: "retell-llm", llmId, version? }`: a Retell LLM that
 *         already exists (Retell's create-agent reference: `llm_id`,
 *         `version`). Creating one is not built here.
 *   - its webhooks at `https://<public host>/api/webhooks/retell/<clinic id>`,
 *     which queue the backstop that records and deletes each call
 *     (app/api/webhooks/retell/[clinicId]/route.ts).
 *
 * The secret is in the URL Retell holds, so nothing here logs, returns or
 * throws a URL: verifyRetellAgent compares inside and answers yes or no.
 * Every request goes through an injectable fetch (RetellApiOptions); nothing
 * calls these yet, and no switch is set by them. Where a clinic's agent id is
 * kept is data, not configuration: the caller holds it.
 */

/** The only storage setting this code writes: the transcript is kept until we delete the call. */
export const RETELL_DATA_STORAGE_SETTING = "everything" as const;

/** Retell deletes a call's data this many days after it, whatever we did: its minimum. */
export const RETELL_DATA_RETENTION_DAYS = 1 as const;

/** Retell's three, as its API names them. */
export const RETELL_DATA_STORAGE_SETTINGS = ["everything", "everything_except_pii", "basic_attributes_only"] as const;
export type RetellDataStorageSetting = (typeof RETELL_DATA_STORAGE_SETTINGS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The voice server's own rule for the secret (src/voice/server.ts, PATH). */
const SECRET = /^[^/\s]{16,200}$/;

/** The response engine an agent is written with: ours over the socket, or a Retell LLM that already exists. */
export type RetellEngine = { type: "custom-llm" } | { type: "retell-llm"; llmId: string; version?: number };

export type RetellAgentOptions = RetellApiOptions & {
  /** The response engine; required, so no caller gets one by default. */
  engine: RetellEngine;
  /** HEALDESK_RETELL_LLM_SECRET, used only by the custom-llm engine; read from the environment when absent. */
  llmSecret?: string | null;
  /** The public origin (BETTER_AUTH_URL); read from the environment when absent. */
  publicOrigin?: string | null;
};

const LLM_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

type ResponseEngineBody =
  | { type: "custom-llm"; llm_websocket_url: string }
  | { type: "retell-llm"; llm_id: string; version?: number };

function responseEngine(engine: RetellEngine, host: string, clinicId: string, options: RetellAgentOptions): ResponseEngineBody {
  if (engine.type === "custom-llm") {
    return { type: "custom-llm", llm_websocket_url: `wss://${host}/llm-websocket/${llmSecret(options)}/${clinicId}` };
  }
  if (engine.type === "retell-llm") {
    if (!LLM_ID.test(engine.llmId)) throw new RetellAgentConfigError("not a Retell LLM id");
    if (engine.version !== undefined && !(Number.isInteger(engine.version) && engine.version >= 0)) {
      throw new RetellAgentConfigError("not a Retell LLM version");
    }
    return { type: "retell-llm", llm_id: engine.llmId, ...(engine.version !== undefined ? { version: engine.version } : {}) };
  }
  throw new RetellAgentConfigError("not a response engine");
}

/** The settings every agent of ours carries, for one clinic. A custom-llm engine's holds the secret: never log it. */
export function retellAgentSettings(clinicId: string, options: RetellAgentOptions) {
  const id = clinicPath(clinicId);
  const host = origin(options).host;
  return {
    response_engine: responseEngine(options.engine, host, id, options),
    webhook_url: `https://${host}/api/webhooks/retell/${id}`,
    data_storage_setting: RETELL_DATA_STORAGE_SETTING,
    data_storage_retention_days: RETELL_DATA_RETENTION_DAYS,
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
  /** Retell's answer names data_storage_setting `everything` and a retention of one day. */
  storageAsWritten: boolean;
  /** What Retell says the setting is, or null when it said none (Retell's default is everything). */
  storageSetting: RetellDataStorageSetting | null;
  /**
   * The response engine is the one asked for: our custom-LLM endpoint for
   * this clinic with the current secret, or the named Retell LLM (and
   * version, when one was named).
   */
  engineIsOurs: boolean;
  /** The webhooks come to this clinic's route. */
  webhookIsOurs: boolean;
};

/** Pure: an agent as Retell describes it, checked against what it should be. Never returns a URL. */
export function checkRetellAgent(body: unknown, clinicId: string, options: RetellAgentOptions): RetellAgentCheck {
  const expected = retellAgentSettings(clinicId, options);
  const b = (body && typeof body === "object" ? body : {}) as {
    data_storage_setting?: unknown;
    data_storage_retention_days?: unknown;
    response_engine?: { type?: unknown; llm_websocket_url?: unknown; llm_id?: unknown; version?: unknown } | null;
    webhook_url?: unknown;
  };
  const setting = (RETELL_DATA_STORAGE_SETTINGS as readonly unknown[]).includes(b.data_storage_setting)
    ? (b.data_storage_setting as RetellDataStorageSetting)
    : null;
  return {
    // Retell says a missing setting is `everything`, but a missing retention
    // is "kept forever": both must be read back as written.
    storageAsWritten: setting === RETELL_DATA_STORAGE_SETTING && b.data_storage_retention_days === RETELL_DATA_RETENTION_DAYS,
    storageSetting: setting,
    engineIsOurs: sameEngine(b.response_engine, expected.response_engine),
    webhookIsOurs: b.webhook_url === expected.webhook_url,
  };
}

function sameEngine(
  actual: { type?: unknown; llm_websocket_url?: unknown; llm_id?: unknown; version?: unknown } | null | undefined,
  expected: ResponseEngineBody,
): boolean {
  if (!actual || actual.type !== expected.type) return false;
  if (expected.type === "custom-llm") return actual.llm_websocket_url === expected.llm_websocket_url;
  return actual.llm_id === expected.llm_id && (expected.version === undefined || actual.version === expected.version);
}

function agentIdOf(body: unknown): string {
  const id = (body as { agent_id?: unknown } | null)?.agent_id;
  if (typeof id !== "string" || !AGENT_ID.test(id)) throw new Error("Retell answered without an agent id");
  return id;
}

function mustHold(check: RetellAgentCheck): void {
  // A field Retell renamed or ignores would answer 200 and set nothing: the
  // answer must carry what was written, as setRetellFallbackNumber checks.
  if (!check.storageAsWritten) throw new Error("Retell did not keep the agent's storage setting and one-day retention");
  if (!check.engineIsOurs) throw new Error("Retell did not keep the agent's response engine");
  if (!check.webhookIsOurs) throw new Error("Retell did not keep the agent's webhook");
}

/**
 * Create a clinic's agent with our storage and retention (POST /create-agent).
 * `voiceId` is Retell's voice, the one thing about the agent we do not
 * decide here. Returns the agent id and the check of Retell's answer; throws
 * unless Retell kept all three settings.
 */
export async function createRetellAgent(
  clinicId: string,
  input: { voiceId: string; agentName?: string },
  options: RetellAgentOptions,
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
 * Bring an existing agent to our settings (PATCH /update-agent/<id>): our
 * storage and one-day retention, our engine, our webhook. Throws unless Retell kept all three.
 */
export async function updateRetellAgent(
  agentId: string,
  clinicId: string,
  options: RetellAgentOptions,
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
 * Read the agent back (GET /get-agent/<id>) and say whether its storage and
 * retention are ours and it is wired to us. A report, never a gate: nothing
 * refuses a call on it; a call Retell still holds past the deletion window
 * is caught per call (lib/voice/recording-alerts.ts). Throws on any failure
 * to read, so a caller never mistakes "unknown" for "as written".
 */
export async function verifyRetellAgent(
  agentId: string,
  clinicId: string,
  options: RetellAgentOptions,
): Promise<RetellAgentCheck> {
  const body = await send(`/get-agent/${agentPath(agentId)}`, { method: "GET" }, options);
  return checkRetellAgent(body, clinicId, options);
}

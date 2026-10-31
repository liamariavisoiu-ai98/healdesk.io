/**
 * Create or update the demo engine agent in Retell from the repo: the agent
 * every personalised demo call runs on once AYA's own engine answers it.
 *
 *   npm run retell:demo-engine -w @healdesk/web -- --dry-run   # print, no calls
 *   npm run retell:demo-engine -w @healdesk/web                # create, or update
 *
 * Needs RETELL_API_KEY and HEALDESK_RETELL_LLM_SECRET in the environment (or
 * apps/web/.env.local): the secret is the same one the engine's voice
 * endpoint checks in every Retell line address, put in AWS with
 * put-external-secrets.sh. It is read here, put in the agent's socket address
 * and sent to Retell, and never printed: a dry run and every error show
 * `<secret>` where it would be.
 *
 * With RETELL_DEMO_ENGINE_AGENT_ID unset it creates the agent and prints the
 * id to set. With it set it updates that agent in place, so a change to the
 * shared call settings (packages/catalog/src/retell-call-settings.ts) reaches
 * it by re-running this, not by editing the agent in Retell's dashboard.
 *
 * ## One assistant, a different start (owner, 24 October 2026)
 *
 * "The demo AYAs and the client AYA should be THE SAME, only difference should
 * be the start." So this agent has no prompt of its own and no Retell LLM:
 * its response engine is the custom-LLM socket of apps/app's voice endpoint
 * (src/voice/server.ts), at `/llm-websocket/<secret>/demo`, where `demo` is
 * the path segment a clinic's id would be (DEMO_CALL_PATH). The engine reads
 * the sealed `demo_context` variable each demo call starts with
 * (lib/demo/engine.ts, packages/catalog/src/demo-call.ts), answers from the
 * clinic's public website with the same turn pipeline a clinic's patients
 * get, and keeps nothing. Everything about how a call feels (backchannel,
 * pace, reminders, the pronunciation dictionary) is the shared
 * RETELL_CALL_SETTINGS, the same object apps/app writes into every clinic's
 * agent, and the voice is Sloane's, the clinic demo agent's.
 *
 * ## Settings that are decisions, not defaults
 *
 *   - data_storage_setting `basic_attributes_only` and a retention of one
 *     day: as the clinic demo agent, Retell keeps neither the audio nor the
 *     transcript, and what it does keep goes after the day apps/app's own
 *     agents keep a transcript for at most (RETELL_DATA_RETENTION_DAYS, the
 *     least Retell takes). The demo talks to a clinic owner and has no clinic
 *     whose outbox needs the words, so there is nothing to back up. If a
 *     test call shows the engine cannot read `demo_context` under this
 *     setting, `everything` with the same one-day retention is apps/app's
 *     choice for its agents: change it here, not in the dashboard.
 *   - no webhook: apps/app's backstop is a clinic's (a transcript emailed to
 *     it); the demo has none.
 *   - voicemail: hang up, and DNC detection on, for the call-me demo, as the
 *     clinic demo agent (the call is placed with `honor_internal_dnc`).
 *   - language en-US, as the clinic demo agent.
 *   - boosted_keywords: the treatment words owners use when they play a
 *     patient, and the demo's own words (DEMO_KEYWORDS). One agent answers
 *     every demo, so a clinic's own menu cannot be listed the way a clinic's
 *     agent lists it (apps/app lib/voice/provision.ts, voiceKeywords); demo
 *     call c4093be6 heard "filler" as "failure", "lips" as "Deeps" and
 *     "centimeter" as "sentiment". The role-play also asks her to check a
 *     treatment she does not recognise before answering it.
 *
 * Both demo agents talk to clinic owners, never patients.
 */

import { DEMO_CALL_PATH, RETELL_CALL_SETTINGS } from "@healdesk/catalog";

import { SLOANE_VOICE_ID } from "../src/lib/demo/sloane-voice";

const API = "https://api.retellai.com";
const AGENT_NAME = "healdesk AYA demo engine";
/** Where apps/app's voice endpoint is (the public host, BETTER_AUTH_URL). */
const SOCKET_HOST = "app.healdesk.io";
/** The voice server's own rule for the secret (apps/app src/voice/server.ts). */
const SECRET = /^[^/\s]{16,200}$/;

const dryRun = process.argv.includes("--dry-run");

/** Words the transcriber is biased towards on every demo call (Retell takes at most 100, each 1 to 80 characters). */
const DEMO_KEYWORDS: readonly string[] = [
  "Aya", "healdesk", "role play", "consultation", "appointment", "units", "per unit", "centimeter",
  "Botox", "Dysport", "Xeomin", "Jeuveau", "Daxxify", "filler", "lip filler", "lips", "cheek filler", "Juvederm", "Restylane", "Kybella",
  "semaglutide", "tirzepatide", "Ozempic", "Wegovy", "weight loss",
  "HydraFacial", "microneedling", "chemical peel", "laser hair removal", "IPL", "Morpheus8", "PRP", "facial",
  "sclerotherapy", "varicose veins", "spider veins", "vein",
  "Invisalign", "veneers", "teeth whitening", "implants", "cleaning", "crown",
  "WhatsApp", "Instagram", "Messenger", "after hours", "voicemail",
];

function agentConfig(secret: string) {
  return {
    agent_name: AGENT_NAME,
    response_engine: {
      type: "custom-llm",
      llm_websocket_url: `wss://${SOCKET_HOST}/llm-websocket/${secret}/${DEMO_CALL_PATH}`,
    },
    voice_id: SLOANE_VOICE_ID,
    language: "en-US",
    ...RETELL_CALL_SETTINGS,
    // The owner's call-me demo can be answered by a machine, or by someone who asks us to stop.
    voicemail_option: { action: { type: "hangup" } },
    enable_dnc_detection: true,
    // One agent answers the browser call, the dialled-in call and the call we place,
    // so it waits a beat in case the callee is lifting the phone.
    begin_message_delay_ms: 600,
    // A backstop behind the engine's own wrap-up, as the clinic demo agent has.
    max_call_duration_ms: 10 * 60_000,
    end_call_after_silence_ms: 20_000,
    data_storage_setting: "basic_attributes_only",
    data_storage_retention_days: 1,
    boosted_keywords: [...DEMO_KEYWORDS],
  };
}

/** Anything Retell says back, with the secret taken out: it may echo the address it was sent. */
function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("<secret>") : text;
}

async function retell<T>(path: string, method: "GET" | "POST" | "PATCH", secret: string | undefined, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(redact(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 600)}`, secret));
  return JSON.parse(text) as T;
}

type AgentAnswer = {
  agent_id?: string;
  response_engine?: { type?: string };
  data_storage_setting?: string;
  data_storage_retention_days?: number;
};

/** A field Retell renamed or ignores would answer 200 and set nothing: the answer must carry what was written. */
function mustHold(answer: AgentAnswer): void {
  if (answer.response_engine?.type !== "custom-llm") throw new Error("Retell did not keep the agent's custom-LLM response engine.");
  if (answer.data_storage_setting !== "basic_attributes_only" || answer.data_storage_retention_days !== 1) {
    throw new Error("Retell did not keep the agent's storage setting and one-day retention.");
  }
}

async function main(): Promise<void> {
  const secret = process.env.HEALDESK_RETELL_LLM_SECRET;
  if (dryRun) {
    // The secret's place, never its value.
    console.log(JSON.stringify(agentConfig("<secret>"), null, 2));
    console.log(secret ? "HEALDESK_RETELL_LLM_SECRET is set here." : "HEALDESK_RETELL_LLM_SECRET is not set here: a real run needs it.");
    console.log("Nothing was sent.");
    return;
  }
  if (!process.env.RETELL_API_KEY) throw new Error("RETELL_API_KEY is not set.");
  if (!secret || !SECRET.test(secret)) {
    throw new Error("HEALDESK_RETELL_LLM_SECRET is not set to a usable value (16 to 200 characters, no slash or space). It is the same one the engine holds in AWS.");
  }

  const agentId = process.env.RETELL_DEMO_ENGINE_AGENT_ID;
  if (!agentId) {
    const agent = await retell<AgentAnswer>("/create-agent", "POST", secret, agentConfig(secret));
    if (!agent.agent_id) throw new Error("Retell answered without an agent id.");
    mustHold(agent);
    console.log(`Created agent ${agent.agent_id}.`);
    console.log(`Set RETELL_DEMO_ENGINE_AGENT_ID=${agent.agent_id} in the Vercel project (Production), then redeploy; and here to update it in place next time.`);
    return;
  }

  const existing = await retell<AgentAnswer>(`/get-agent/${encodeURIComponent(agentId)}`, "GET", secret);
  if (existing.response_engine?.type !== "custom-llm") {
    throw new Error(`Agent ${agentId} does not run on a custom-LLM socket; refusing to overwrite it.`);
  }
  const updated = await retell<AgentAnswer>(`/update-agent/${encodeURIComponent(agentId)}`, "PATCH", secret, agentConfig(secret));
  mustHold(updated);
  console.log(`Updated agent ${agentId} (draft). RETELL_DEMO_ENGINE_AGENT_ID is already set to it in the Vercel project.`);
}

main().catch((error: unknown) => {
  console.error(redact(error instanceof Error ? error.message : String(error), process.env.HEALDESK_RETELL_LLM_SECRET));
  process.exit(1);
});

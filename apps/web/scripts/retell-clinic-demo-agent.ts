/**
 * Create or update the personalised clinic-demo agent in Retell from the repo.
 *
 *   npm run retell:clinic-demo -w @healdesk/web -- --dry-run   # print, no calls
 *   npm run retell:clinic-demo -w @healdesk/web                # create, then update
 *
 * With RETELL_CLINIC_DEMO_AGENT_ID unset it creates a Retell LLM and an agent
 * and prints the id to set. With it set it updates that agent's draft and its
 * LLM in place, so a prompt fix ships by re-running this, not by editing the
 * prompt in Retell's dashboard (the prompt lives in
 * src/lib/demo/clinic-prompts.ts).
 *
 * ## One agent, every clinic
 *
 * The doc behind this feature sketched one Retell agent per demo. This is one
 * agent for all of them, with the clinic supplied per call as dynamic
 * variables (`{{clinic_name}}`, `{{clinic_knowledge}}`, `{{opening_line}}`):
 * the clinic still hears its own name, services and hours, but a demo is
 * ready the moment its profile is, there is no agent to delete when it
 * expires, and a prompt fix reaches every live demo at once instead of only
 * the ones built after it.
 *
 * ## Same decisions as AYA's demo agent (scripts/retell-demo-agent.ts)
 *
 *   - data_storage_setting `basic_attributes_only`: Retell keeps neither audio
 *     nor transcript, so "this call is transcribed" stays the whole truth.
 *   - voicemail: hang up. DNC detection on, paired with `honor_internal_dnc`
 *     on the one call /api/callback places.
 *   - Retell's call-centre personality and filler words off.
 *
 * Both demo agents talk to clinic owners, never patients. The product's voice
 * agent is a different Retell agent pointed at our own Claude endpoint in
 * apps/app, and it is not configured here.
 */

import { CLINIC_VOICE_DEFAULTS, CLINIC_VOICE_GENERAL_PROMPT } from "../src/lib/demo/clinic-prompts";

const API = "https://api.retellai.com";
const AGENT_NAME = "healdesk personalised clinic demo";

/** As AYA's agent: Sonnet, because a phone turn has to start within about a second. */
const MODEL = "claude-5.5-sonnet";
const VOICE_ID = "11labs-Grace";
const FALLBACK_VOICE_IDS = ["cartesia-Grace"];

const dryRun = process.argv.includes("--dry-run");

const llmConfig = {
  model: MODEL,
  model_temperature: 0.2,
  start_speaker: "agent",
  // Per call: the browser call and the call to the owner's phone open differently.
  begin_message: "{{opening_line}}",
  general_prompt: CLINIC_VOICE_GENERAL_PROMPT,
  general_tools: [
    {
      type: "end_call",
      name: "end_call",
      description: "Hang up. Call it straight after your goodbye line.",
    },
  ],
  default_dynamic_variables: CLINIC_VOICE_DEFAULTS,
};

function agentConfig(llmId: string) {
  return {
    agent_name: AGENT_NAME,
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: VOICE_ID,
    fallback_voice_ids: FALLBACK_VOICE_IDS,
    language: "en-US",
    voice_speed: 1,
    volume: 0.9,
    voice_temperature: 0.6,
    responsiveness: 0.9,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_frequency: 0.3,
    begin_message_delay_ms: 600,
    reminder_trigger_ms: 8_000,
    reminder_max_count: 1,
    end_call_after_silence_ms: 20_000,
    // A backstop behind the prompt's eight-minute wrap-up.
    max_call_duration_ms: 10 * 60_000,
    voicemail_option: { action: { type: "hangup" } },
    enable_dnc_detection: true,
    data_storage_setting: "basic_attributes_only",
    data_storage_retention_days: 30,
    opt_in_signed_url: true,
    boosted_keywords: ["healdesk", "Botox", "filler", "consultation", "Invisalign", "Mindbody", "Boulevard"],
    handbook_config: {
      default_personality: false,
      conversational_personality: false,
      natural_filler_words: false,
      high_empathy: false,
      echo_verification: false,
      nato_phonetic_alphabet: false,
      speech_normalization: true,
      smart_matching: true,
      ai_disclosure: true,
      scope_boundaries: true,
    },
  };
}

async function retell<T>(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 600)}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  if (dryRun) {
    console.log(JSON.stringify({ llm: llmConfig, agent: agentConfig("<llm_id>") }, null, 2));
    console.log(`General prompt: about ${CLINIC_VOICE_GENERAL_PROMPT.split(/\s+/).length} words before the clinic's own.`);
    console.log("Nothing was sent.");
    return;
  }
  if (!process.env.RETELL_API_KEY) throw new Error("RETELL_API_KEY is not set.");

  const agentId = process.env.RETELL_CLINIC_DEMO_AGENT_ID;
  if (!agentId) {
    const llm = await retell<{ llm_id: string }>("/create-retell-llm", "POST", llmConfig);
    const agent = await retell<{ agent_id: string }>("/create-agent", "POST", agentConfig(llm.llm_id));
    console.log(`Created LLM ${llm.llm_id} and agent ${agent.agent_id}.`);
    console.log(`Set RETELL_CLINIC_DEMO_AGENT_ID=${agent.agent_id} in the web project, and here to update it in place next time.`);
    return;
  }

  const existing = await retell<{ response_engine?: { type?: string; llm_id?: string } }>(`/get-agent/${agentId}`, "GET");
  const llmId = existing.response_engine?.llm_id;
  if (existing.response_engine?.type !== "retell-llm" || !llmId) {
    throw new Error(`Agent ${agentId} does not run on a Retell LLM; refusing to overwrite it.`);
  }
  await retell(`/update-retell-llm/${llmId}`, "PATCH", llmConfig);
  await retell(`/update-agent/${agentId}`, "PATCH", agentConfig(llmId));
  console.log(`Updated LLM ${llmId} and agent ${agentId} (draft).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

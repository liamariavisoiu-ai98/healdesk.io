/**
 * Create or update AYA's two demo agents in Retell from the repo, and bind
 * the demo number to them.
 *
 *   npm run retell:demo -w @healdesk/web -- --dry-run   # print, no calls
 *   npm run retell:demo -w @healdesk/web                # create, then update
 *
 * Two agents from one prompt module (lib/voice-demo-prompt.ts):
 *
 *   - outbound, RETELL_DEMO_AGENT_ID: the call an owner asks for on the site.
 *   - inbound, RETELL_DEMO_INBOUND_AGENT_ID: the demo line printed on the
 *     site (site.demoLine), which owners dial themselves.
 *
 * An unset id creates that agent and prints the id to set; a set one updates
 * the agent's draft and its LLM in place, so a catalog price change reaches
 * both calls by re-running this, not by editing a prompt in the dashboard.
 * With RETELL_DEMO_FROM_NUMBER set it also binds the number: answered by the
 * inbound agent, dialling out as the outbound one, US and Canada only.
 *
 * ## This is the marketing demo, not the product
 *
 * The agent calls a clinic owner who asked for one call, on a Retell-hosted
 * prompt. The product's voice agent is Retell pointed at our own Claude
 * endpoint in apps/app, and it is not configured here.
 *
 * ## Settings that are decisions, not defaults
 *
 *   - data_storage_setting `basic_attributes_only`: Retell keeps neither the
 *     audio nor the transcript. It has no "transcript but no recording"
 *     setting, and the call says it is transcribed, never recorded, so keeping
 *     audio would make the opening line untrue in a two-party-consent state.
 *   - voicemail: hang up. The brief allows no voicemail until counsel rules.
 *   - DNC detection on, paired with `honor_internal_dnc` on every call
 *     /api/callback places, so "stop calling me" outlives this call.
 *   - Retell's "professional call center rep" preset off: it fights the
 *     peer register the prompt asks for. Natural filler words on: owners
 *     heard the call without them as robotic, and the opening line has
 *     already said it is an AI, so sounding human misleads nobody.
 */

import { type VoiceDemoDirection, voiceDemoLlm } from "../src/lib/voice-demo-prompt";

const API = "https://api.retellai.com";
const AGENT_NAME: Record<VoiceDemoDirection, string> = {
  outbound: "healdesk demo call (AYA)",
  inbound: "healdesk demo line (AYA, inbound)",
};
const AGENT_ID_VAR: Record<VoiceDemoDirection, string> = {
  outbound: "RETELL_DEMO_AGENT_ID",
  inbound: "RETELL_DEMO_INBOUND_AGENT_ID",
};

/**
 * Claude, as the chat demo is. Sonnet rather than Opus because a phone turn
 * has to start within about a second; the chat demo can afford to think.
 */
const MODEL = "claude-5.5-sonnet";

/**
 * A Retell platform voice: tuned for phone audio (pacing, fillers, clarity at
 * telephone bitrates) and the only kind that supports Expressive Mode. The
 * ElevenLabs voice before it was judged robotic on test calls. Platform
 * voices fail over to another provider on their own, so there is no fallback
 * list. Change by ear in the dashboard's voice picker, then here.
 */
const VOICE_ID = "retell-Grace";

/**
 * Expressive Mode's palette: the agent may add one of these where it fits,
 * most lines have none, and it never tags a price or a number. No "excited":
 * owners heard the earlier voice as loud, and a consultant is not excited.
 */
const EXPRESSIVE_TAGS = ["curious", "empathetic", "pause", "emphasis"];

/**
 * Where Retell posts request_follow_up. The deployed site, never
 * NEXT_PUBLIC_SITE_URL: a local .env points that at localhost, which Retell's
 * servers cannot reach, and a tool that silently fails would leave AYA giving
 * out the inbox address on every call.
 */
const TOOL_ORIGIN = process.env.RETELL_DEMO_TOOL_ORIGIN ?? "https://healdesk.io";

const dryRun = process.argv.includes("--dry-run");

const END_CALL = {
  type: "end_call",
  name: "end_call",
  description: "Hang up. Call it straight after your last line, whenever the prompt says to end the call.",
};

const REQUEST_FOLLOW_UP = {
  type: "custom",
  name: "request_follow_up",
  description:
    "Pass a prospect's request to the healdesk team by email: a pricing or discount question, " +
    "terms, a second location, or a session with the team. Only after they agreed to be contacted " +
    "and you confirmed their details. The reply says whether it was sent; follow it.",
  url: `${TOOL_ORIGIN}/api/voice-demo/follow-up`,
  method: "POST",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["start", "pricing", "discount", "terms", "sales_session", "other"],
        description:
          "start: they said yes in the close, and are emailed the setup link for the package. " +
          "Anything else goes to the team, who reply by email.",
      },
      name: { type: "string", description: "Their name, as they gave it." },
      clinic: { type: "string", description: "Their clinic's name, if they gave it." },
      email: {
        type: "string",
        description: "Their email, lowercase, exactly as spelled and confirmed.",
      },
      preferred_time: {
        type: "string",
        description: "For a session with the team: the day and rough time in their words, with their time zone.",
      },
      recommended_package: {
        type: "string",
        description: "The package you recommended, by its name from the price list.",
      },
      summary: {
        type: "string",
        description:
          "Two or three plain sentences of what they told you: practice type, locations, who answers now, " +
          "when calls slip through, what a new patient is worth, booking system, why now. Never anything about a patient.",
      },
      notes: {
        type: "string",
        description: "What they want from the team, in one plain line.",
      },
    },
    required: ["topic", "email"],
  },
  speak_during_execution: true,
  execution_message_type: "static_text",
  execution_message_description: "One sec, passing that on.",
  speak_after_execution: true,
  timeout_ms: 10_000,
  // A retry after a slow success would mail the team twice.
  max_retry: 0,
};

function llmConfig(direction: VoiceDemoDirection) {
  const llm = voiceDemoLlm(direction);
  return {
    model: MODEL,
    // Retell's guidance for sales calls is 0.5 to 0.7; lower here because
    // the prices, the refunds and the disclosure must come out exactly.
    model_temperature: 0.3,
    // Retell's fast tier: dedicated capacity, 1.5x the model's rate. The
    // measured cost of the standard pool was the variance, turns of 2.5 to
    // 3.7 seconds, and a demo call is the one place that cannot afford it.
    model_high_priority: true,
    start_speaker: "agent",
    begin_message: llm.beginMessage,
    // One prompt, no states: a state change is a second model call on the
    // turn that crosses it (see the module header).
    general_prompt: llm.prompt,
    general_tools: [END_CALL, REQUEST_FOLLOW_UP],
    states: [],
    starting_state: null,
    default_dynamic_variables: llm.defaults,
  };
}

function agentConfig(llmId: string, direction: VoiceDemoDirection) {
  const outbound = direction === "outbound";
  return {
    agent_name: AGENT_NAME[direction],
    response_engine: { type: "retell-llm", llm_id: llmId },
    voice_id: VOICE_ID,
    fallback_voice_ids: null,
    enable_expressive_mode: true,
    expressive_emotion_tags: EXPRESSIVE_TAGS,
    language: "en-US",
    // Natural speed and variation. The slower, steadier settings tried for
    // "calm" (0.95 speed, 0.6 temperature) made the voice flatter, which
    // owners heard as robotic; calm now comes from the wording. Dynamic speed
    // matches the caller's own pace.
    voice_speed: 1,
    volume: 0.9,
    voice_temperature: 1,
    enable_dynamic_voice_speed: true,
    // 1 is Retell's fastest: reply as soon as the turn is judged over. 0.8
    // added a wait that measured calls showed as about 0.4s of every pause.
    responsiveness: 1,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    backchannel_frequency: 0.3,
    // Outbound waits for the callee to get the phone to their ear; the demo
    // line answers as a front desk would, at once.
    begin_message_delay_ms: outbound ? 800 : 0,
    reminder_trigger_ms: 8_000,
    reminder_max_count: 1,
    end_call_after_silence_ms: 20_000,
    // A backstop, not the target. The prompt reads {{session_duration}} and
    // wraps up from about nine minutes, so the cap never cuts a sentence on a
    // call that is going well; it only ends one that has gone wrong.
    max_call_duration_ms: 12 * 60_000,
    // Only an outbound call can reach a voicemail or a "stop calling me".
    voicemail_option: outbound ? { action: { type: "hangup" } } : null,
    enable_dnc_detection: outbound,
    data_storage_setting: "basic_attributes_only",
    data_storage_retention_days: 30,
    opt_in_signed_url: true,
    // None: Retell lists boosted keywords as a cost to transcription latency.
    boosted_keywords: null,
    // Every preset adds tokens to every turn. Only the one the prompt cannot
    // do itself stays on: light, natural fillers. The disclosure, numbers
    // read aloud and staying in scope are all in the prompt already.
    handbook_config: {
      default_personality: false,
      conversational_personality: false,
      natural_filler_words: true,
      high_empathy: false,
      echo_verification: false,
      nato_phonetic_alphabet: false,
      speech_normalization: false,
      smart_matching: false,
      ai_disclosure: false,
      scope_boundaries: false,
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

const DIRECTIONS: readonly VoiceDemoDirection[] = ["outbound", "inbound"];

/** Create or update one direction's LLM and agent. Returns the agent id. */
async function upsert(direction: VoiceDemoDirection): Promise<string> {
  const llm = llmConfig(direction);
  const agentId = process.env[AGENT_ID_VAR[direction]];
  if (!agentId) {
    const created = await retell<{ llm_id: string }>("/create-retell-llm", "POST", llm);
    const agent = await retell<{ agent_id: string }>("/create-agent", "POST", agentConfig(created.llm_id, direction));
    console.log(`Created ${direction} LLM ${created.llm_id} and agent ${agent.agent_id}.`);
    console.log(`Set ${AGENT_ID_VAR[direction]}=${agent.agent_id} to update it in place next time.`);
    return agent.agent_id;
  }

  const existing = await retell<{ response_engine?: { type?: string; llm_id?: string } }>(
    `/get-agent/${agentId}`,
    "GET",
  );
  const llmId = existing.response_engine?.llm_id;
  if (existing.response_engine?.type !== "retell-llm" || !llmId) {
    throw new Error(`Agent ${agentId} does not run on a Retell LLM; refusing to overwrite it.`);
  }
  await retell(`/update-retell-llm/${llmId}`, "PATCH", llm);
  await retell(`/update-agent/${agentId}`, "PATCH", agentConfig(llmId, direction));
  console.log(`Updated ${direction} LLM ${llmId} and agent ${agentId} (draft).`);
  return agentId;
}

async function main(): Promise<void> {
  if (dryRun) {
    for (const direction of DIRECTIONS) {
      const llm = llmConfig(direction);
      console.log(`\n== ${direction}: ${llm.begin_message}`);
      console.log(`Prompt: about ${llm.general_prompt.split(/\s+/).length} words a turn.`);
    }
    console.log("\nNothing was sent.");
    return;
  }
  if (!process.env.RETELL_API_KEY) throw new Error("RETELL_API_KEY is not set.");
  if (!TOOL_ORIGIN.startsWith("https://")) throw new Error(`RETELL_DEMO_TOOL_ORIGIN must be https: ${TOOL_ORIGIN}`);

  const outbound = await upsert("outbound");
  const inbound = await upsert("inbound");

  const number = process.env.RETELL_DEMO_FROM_NUMBER;
  if (!number) {
    console.log("RETELL_DEMO_FROM_NUMBER is unset; no number bound.");
    return;
  }
  await retell(`/update-phone-number/${encodeURIComponent(number)}`, "PATCH", {
    nickname: "healdesk demo line (AYA)",
    inbound_agents: [{ agent_id: inbound, weight: 1 }],
    outbound_agents: [{ agent_id: outbound, weight: 1 }],
    // A toll-free demo line answered by an AI is a target for pumped
    // international traffic; owners who would buy are in the US and Canada.
    allowed_inbound_country_list: ["US", "CA"],
    allowed_outbound_country_list: ["US"],
  });
  console.log(`Bound ${number}: answered by ${inbound}, dialling as ${outbound}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

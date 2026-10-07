/**
 * Sloane: the voice, model and delivery settings of AYA's demo agents, shared
 * with the personalised clinic demo so a prospect hears exactly the voice the
 * owner chose by ear.
 *
 * Every value here is transcribed from scripts/retell-demo-agent.ts on the
 * claude/aya-retell-demo-call branch (commits 702cbc3 to 025a312, 6 October
 * 2026), where the reasons are written out: Sloane as a Retell platform voice
 * for a serious, friendly, luxury register; Claude Haiku on Retell's priority
 * tier because it measured fastest while keeping the rules; Expressive Mode
 * with only the smile and the sympathy, because sighs and fillers were heard
 * as "drunk" and flat settings as "sleepy". When that branch lands, its
 * script should import these instead of keeping its own copy, so the two
 * agents cannot drift apart.
 */

/** Claude Haiku on Retell: still Claude, and the fastest model that kept the rules. */
export const SLOANE_MODEL = "claude-4.5-haiku";

export const SLOANE_LLM = {
  model: SLOANE_MODEL,
  // Low, because prices and the disclosure must come out exactly.
  model_temperature: 0.3,
  // Retell's fast tier: steady turn times instead of 2.5 to 3.7 s outliers.
  model_high_priority: true,
} as const;

/** A Retell platform voice: phone-tuned, fails over by itself, supports Expressive Mode. */
export const SLOANE_VOICE_ID = "retell-Sloane";

export const SLOANE_EXPRESSIVE_TAGS = ["happy", "empathetic", "emphasis"];

export const SLOANE_EXPRESSIVE_GUIDANCE =
  "Speak with a gentle, warm smile throughout, calm and bright, with natural rise and fall, never monotone. " +
  "Use [emphasis] on the one word that carries the point, at most once a turn. Use [happy] only on a greeting, " +
  "a thank-you or good news, and [empathetic] only when they describe something hard, each at most once every " +
  "few turns. Never sigh, never pause for effect, never whisper, never sound excited, and never tag a price, a " +
  "number or a name.";

/** The opening is spoken with that smile; the tag itself is never read aloud. */
export const SLOANE_SMILE = "[happy] ";

/** The agent settings that make the voice sound like Sloane, for any agent that uses her. */
export const SLOANE_AGENT = {
  voice_id: SLOANE_VOICE_ID,
  fallback_voice_ids: null,
  enable_expressive_mode: true,
  expressive_emotion_tags: SLOANE_EXPRESSIVE_TAGS,
  expressive_mode_prompt: SLOANE_EXPRESSIVE_GUIDANCE,
  language: "en-US",
  voice_speed: 1,
  volume: 1,
  voice_temperature: 0.95,
  enable_dynamic_voice_speed: false,
  responsiveness: 1,
  interruption_sensitivity: 0.8,
  enable_backchannel: true,
  backchannel_frequency: 0.2,
  reminder_trigger_ms: 8_000,
  reminder_max_count: 1,
  end_call_after_silence_ms: 20_000,
  data_storage_setting: "basic_attributes_only",
  data_storage_retention_days: 30,
  opt_in_signed_url: true,
  // Boosted keywords cost transcription latency; every handbook preset adds
  // tokens to every turn, and the prompt covers what they would.
  boosted_keywords: null,
  handbook_config: {
    default_personality: false,
    conversational_personality: false,
    natural_filler_words: false,
    high_empathy: false,
    echo_verification: false,
    nato_phonetic_alphabet: false,
    speech_normalization: false,
    smart_matching: false,
    ai_disclosure: false,
    scope_boundaries: false,
  },
} as const;

/**
 * How AYA talks on the phone, from her prompt on the same branch: the rules
 * that made her sound like a person rather than a script. Shared, word for
 * word where it applies, so the clinic demo is trained the same way.
 */
export const SLOANE_PHONE_STYLE = `HOW YOU SOUND
  · Warm, calm, sure of yourself, with a smile in your voice: a hostess at a
    high-end clinic, not a call centre.
  · Every turn is one or two short sentences and ends with at most ONE
    question. Never two questions. Never a question with more after it.
  · Short sentences, one idea each, never more than about fifteen words.
    Plain words anyone understands at once.
  · Put the weight on the word that matters, usually near the end.
  · Respond to the person, not the data. No stock phrases, no flattery, and
    never repeat their words back to them.
  · Polished and natural, with contractions. No slang or fillers: never
    "yeah", "huh", "honestly", "um" or "you know".
  · Never read out a list or a menu. Offer two or three options and ask
    which they'd like.
  · Say numbers the way people speak them; read a phone number back in
    groups, once.`;

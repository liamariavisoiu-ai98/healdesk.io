/**
 * How a call feels, in Retell's own agent settings (owner's briefs, 24
 * October 2026). Shared so every agent that runs AYA's engine gets the same
 * ones: each clinic's agent, written by apps/app (lib/voice/retell-agent.ts,
 * where each value's reason is), and the demo engine agent, written by
 * apps/web's script (scripts/retell-demo-engine-agent.ts). The demo AYA and
 * the client AYA are one assistant (owner, 24 October 2026).
 *
 * `stt_mode: "fast"` is Retell's own default; it is written here, not left
 * to default, so a dashboard switched to "accurate" for one test call (which
 * adds real seconds to every reply, the owner's repeated "still too slow")
 * is put back the moment that agent is next synced, and the drift check
 * catches it meanwhile, rather than a setting only a person remembers to undo.
 */
export const RETELL_CALL_SETTINGS = {
  stt_mode: "fast",
  enable_backchannel: true,
  // Gentle (owner, 1 November 2026: "an occasional mm-hmm during a long caller turn only"): was 0.7, so Retell's
  // listening sounds came on most turns; the marketing agents run 0.2.
  backchannel_frequency: 0.3,
  backchannel_words: ["mm-hmm", "uh-huh", "yeah", "I see"],
  // No background sound (owner, 1 November 2026, after a test call: "Remove the background noise altogether";
  // under the office murmur her words sounded mechanical and cut off). null clears it on Retell.
  ambient_sound: null,
  // Her mood word reaches her voice (owner, 1 November 2026, realism item 1): the call sends [happy] or
  // [empathetic] before her words, at most every few turns, only once it has read this setting off the
  // call's own agent (apps/app retell.ts, retellAgentExpressive). Platform voices only, as Sloane is.
  enable_expressive_mode: true,
  expressive_emotion_tags: ["happy", "empathetic"],
  expressive_mode_prompt:
    "Speak with a gentle, warm smile throughout, calm and bright, with natural rise and fall, never monotone. A [happy] tag marks a greeting, a thank-you or good news; an [empathetic] tag marks something hard they described. Never sigh, never whisper, never sound excited, and never tag a price, a number or a name.",
  interruption_sensitivity: 0.8,
  responsiveness: 1,
  enable_dynamic_responsiveness: false,
  voice_temperature: 1.2,
  voice_speed: 1.05,
  enable_dynamic_voice_speed: true,
  reminder_trigger_ms: 8_000,
  reminder_max_count: 3,
  pronunciation_dictionary: [
    // Her name, "Eye-uh" (owner, 24 and 25 October 2026), never spelled out
    // letter by letter. Everything spoken writes it "Aya" since 25 October
    // (disclosure.ts, demo-facts.ts), because a voice provider that ignores
    // this dictionary still spells capitals out; "AYA" stays listed for any
    // reply that writes it so anyway. Listen on the demo agent and correct
    // the phoneme if a voice reads it wrong.
    { word: "Aya", alphabet: "ipa", phoneme: "ˈaɪə" },
    { word: "AYA", alphabet: "ipa", phoneme: "ˈaɪə" },
    { word: "Juvederm", alphabet: "ipa", phoneme: "ˈdʒuvədɝm" },
    { word: "Restylane", alphabet: "ipa", phoneme: "ˈrɛstəleɪn" },
    { word: "Dysport", alphabet: "ipa", phoneme: "ˈdɪspɔɹt" },
    { word: "Xeomin", alphabet: "ipa", phoneme: "ˈzioʊmɪn" },
    { word: "Kybella", alphabet: "ipa", phoneme: "kaɪˈbɛlə" },
    { word: "HydraFacial", alphabet: "ipa", phoneme: "ˈhaɪdɹəˌfeɪʃəl" },
  ],
} as const;

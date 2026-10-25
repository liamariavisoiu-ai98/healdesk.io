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
  backchannel_frequency: 0.7,
  backchannel_words: ["mm-hmm", "uh-huh", "yeah", "I see"],
  interruption_sensitivity: 0.8,
  responsiveness: 1,
  enable_dynamic_responsiveness: true,
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

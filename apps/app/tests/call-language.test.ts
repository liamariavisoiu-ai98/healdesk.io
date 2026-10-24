import { describe, expect, test } from "vitest";

import { FAILURE_LINE, FAILURE_LINE_ES, failureLine, refusalLine, urgentReply } from "@/lib/assistant/turn";
import { assistantTurnContext } from "@/lib/assistant/prompt";
import { nextCallLanguage, START_LANGUAGE, utteranceVote, type CallLanguageState } from "@/lib/voice/call-language";
import { CLOSED_LINE, CLOSED_LINE_ES, REMINDER_LINE_ES, TRANSFER_LINE_ES, TROUBLE_TRANSFER_LINE_ES } from "@/lib/voice/retell";
import { spokenPhone, spokenSlotEs } from "@/lib/voice/spoken";

import { SAFETY_FACTS } from "./setup/safety-cases";

/**
 * A call's language (lib/voice/call-language.ts) and the Spanish fixed lines
 * it picks: pure, no database. The end-to-end call is in
 * tests/safety-suite-voice.test.ts, section 7.
 */

const ES = { spanishAllowed: true } as const;

function run(utterances: readonly string[], options: { spanishAllowed: boolean } = ES): CallLanguageState[] {
  const out: CallLanguageState[] = [];
  let state = START_LANGUAGE;
  for (const u of utterances) {
    state = nextCallLanguage(state, u, options);
    out.push(state);
  }
  return out;
}

describe("the call's language", () => {
  test("starts in English; two short Spanish utterances in a row turn it, one does not", () => {
    expect(START_LANGUAGE.language).toBe("en");
    const states = run(["Hola, buenos días", "¿Tienen citas mañana?"]);
    expect(states.map((s) => s.language)).toEqual(["en", "es"]);
  });

  test("one long, confident Spanish utterance turns it at once", () => {
    const [state] = run(["Hola, quisiera saber si tienen citas disponibles para la próxima semana por favor"]);
    expect(state!.language).toBe("es");
  });

  test("it never flaps: utterances that alternate, one each way, leave it where it was", () => {
    const states = run(["Hola, buenos días", "Hi there, thanks", "Gracias, muy bien", "Okay, sounds good"]);
    expect(states.every((s) => s.language === "en")).toBe(true);
  });

  test("words with no evidence (a name, a time, ok, sí) neither turn it nor break a streak", () => {
    expect(utteranceVote("Maria")).toBeNull();
    expect(utteranceVote("3pm")).toBeNull();
    expect(utteranceVote("ok")).toBeNull();
    expect(utteranceVote("sí")).toBeNull();
    const states = run(["Hola, buenos días", "Maria", "¿Tienen citas mañana?"]);
    expect(states.map((s) => s.language)).toEqual(["en", "en", "es"]);
  });

  test("a caller who goes back to English turns it back by the same rule", () => {
    const states = run([
      "Hola, quisiera saber si tienen citas disponibles para la próxima semana por favor",
      "Actually, can we speak English?",
      "I would like to book a consultation please",
    ]);
    expect(states.map((s) => s.language)).toEqual(["es", "es", "en"]);
  });

  test("a clinic that does not answer in Spanish stays English whatever is said", () => {
    const states = run(["Hola, quisiera saber si tienen citas disponibles para la próxima semana por favor", "¿Tienen citas mañana?"], { spanishAllowed: false });
    expect(states.every((s) => s.language === "en")).toBe(true);
  });

  test("a language no screen reads is no vote", () => {
    expect(utteranceVote("Mwen pa ka respire, tanpri ede mwen")).toBeNull();
  });
});

describe("the Spanish fixed lines", () => {
  test("numbers are spoken with Spanish digits; English stays as it was", () => {
    expect(spokenPhone("+14155550190")).toBe("four one five — five five five — oh one nine oh");
    expect(spokenPhone("+14155550190", "es")).toBe("cuatro uno cinco — cinco cinco cinco — cero uno nueve cero");
  });

  test("a booking time as a Spanish speaker says it", () => {
    const tz = "America/New_York";
    expect(spokenSlotEs(new Date("2026-11-03T20:00:00Z"), tz)).toBe("martes 3 de noviembre a las tres de la tarde");
    expect(spokenSlotEs(new Date("2026-11-03T18:30:00Z"), tz)).toBe("martes 3 de noviembre a la una y media de la tarde");
    expect(spokenSlotEs(new Date("2026-11-04T14:15:00Z"), tz)).toBe("miércoles 4 de noviembre a las nueve y cuarto de la mañana");
    expect(spokenSlotEs(new Date("2026-11-04T17:00:00Z"), tz)).toBe("miércoles 4 de noviembre a las doce del mediodía");
    expect(spokenSlotEs(new Date("2026-11-04T01:45:00Z"), tz)).toBe("martes 3 de noviembre a las ocho y 45 de la noche");
  });

  test("failure, refusal and the call's own lines exist in Spanish, and English is unchanged", () => {
    expect(failureLine()).toBe(FAILURE_LINE);
    expect(failureLine("en")).toBe(FAILURE_LINE);
    expect(failureLine("es")).toBe(FAILURE_LINE_ES);
    const facts = { ...SAFETY_FACTS, urgentPhone: null, directLine: "+14155550124" };
    expect(refusalLine(facts, "voice")).toMatch(/^Sorry, that's not something I can help with\. .*four one five/);
    const es = refusalLine(facts, "voice", "es");
    expect(es).toMatch(/^Lo siento, eso no es algo con lo que pueda ayudarle\./);
    expect(es).toContain(spokenPhone("+14155550124", "es"));
    // The website chat writes the number, whatever the language.
    expect(refusalLine(facts, "web_chat", "es")).not.toMatch(/cuatro/);
    for (const line of [CLOSED_LINE_ES, TRANSFER_LINE_ES, TROUBLE_TRANSFER_LINE_ES, REMINDER_LINE_ES]) expect(line).not.toBe(CLOSED_LINE);
  });

  test("the Spanish urgent reply on a call speaks its numbers in Spanish; the English one in English", () => {
    const facts = { ...SAFETY_FACTS, urgentPhone: null, directLine: "+14155550124", urgentAlertsReady: true };
    const now = new Date("2026-11-03T15:00:00Z");
    const es = urgentReply(facts, "voice", { emergency: "911", language: "es" }, now);
    expect(es).toMatch(/cuelgue y llame al 9-1-1/);
    expect(es).toContain(spokenPhone("+14155550124", "es"));
    expect(es).toContain("Ya avisé al equipo.");
    const en = urgentReply(facts, "voice", { emergency: "911", language: "en" }, now);
    expect(en).toContain(spokenPhone("+14155550124"));
  });

  test("the turn context carries the Spanish note only when given, so an English turn is byte for byte as before", () => {
    const now = new Date("2026-11-03T15:00:00Z");
    expect(assistantTurnContext(SAFETY_FACTS, now, "Hi", null, null)).toBe(assistantTurnContext(SAFETY_FACTS, now, "Hi", null));
    expect(assistantTurnContext(SAFETY_FACTS, now, "Hi", null, "SPANISH")).toMatch(/\nSPANISH$/);
  });
});

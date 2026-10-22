import { describe, expect, it } from "vitest";

import { PERSONA } from "../knowledge/persona";
import { CLINIC_VOICE_GENERAL_PROMPT } from "./clinic-prompts";

/**
 * The demo contacts nobody, and a clinic's public website names no on-call
 * contact. A demo that says an urgent symptom is "going straight to the
 * clinic's on-call contact" claims a flag that does not exist (the review of
 * the Lumen Clinic demo, 22 October 2026). The live assistant is designed to
 * alert the clinic's named urgent contact; the demo must say that only as
 * design, and must point to 911.
 */
describe("the demo's answer to an urgent symptom", () => {
  const prompts = { "voice prompt": CLINIC_VOICE_GENERAL_PROMPT, persona: PERSONA };

  for (const [name, text] of Object.entries(prompts)) {
    const flat = text.replace(/\s+/g, " ");

    it(`${name} never says the symptom is going to an on-call contact`, () => {
      expect(flat).not.toMatch(/straight to the clinic's on-call contact/i);
      expect(flat).not.toMatch(/goes straight to the clinic's on-call/i);
    });

    it(`${name} says the demo contacts nobody and points to 911`, () => {
      expect(flat).toMatch(/contacts nobody/i);
      expect(flat).toMatch(/call 911/i);
    });

    it(`${name} describes the live alert only as design`, () => {
      expect(flat).toMatch(/designed to alert the clinic's named urgent contact/i);
    });
  }
});

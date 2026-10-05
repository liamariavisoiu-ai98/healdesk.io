import { plans } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { GUARANTEE_TEXT, POLICY } from "./legal";
import {
  VOICE_DEMO_INBOUND_OPENING,
  VOICE_DEMO_OPENING,
  VOICE_DEMO_PRICES,
  VOICE_DEMO_RISK_REVERSAL,
  VOICE_DEMO_VARIABLES,
  type VoiceDemoDirection,
  voiceDemoLlm,
  voiceDemoPromptText,
  voiceDemoVariables,
} from "./voice-demo-prompt";

/**
 * The demo agents' prompt is pushed to Retell by scripts/retell-demo-agent.ts,
 * so a wrong sentence here is spoken to a real person on the next call. These
 * pin the lines the call cannot lose. Whitespace is collapsed before matching,
 * so re-wrapping a paragraph does not break a test.
 */

const flat = (text: string) => text.replace(/\s+/g, " ");
const DIRECTIONS: readonly VoiceDemoDirection[] = ["outbound", "inbound"];
const text = (direction: VoiceDemoDirection) => flat(voiceDemoPromptText(direction));

/** Retell's own variables, filled on every call without being declared. */
const SYSTEM_VARIABLES = new Set(["session_duration", "current_time"]);

/** Every line the prompt quotes for AYA to say, as written. */
function quotedLines(direction: VoiceDemoDirection): string[] {
  return [...voiceDemoLlm(direction).prompt.matchAll(/"([^"]{12,})"/g)].map((m) => flat(m[1]!));
}

describe("the openings say what the product must, and nothing more", () => {
  test.each([
    ["outbound", VOICE_DEMO_OPENING],
    ["inbound", VOICE_DEMO_INBOUND_OPENING],
  ])("%s: AI assistant, healdesk, transcribed, in five seconds", (_direction, opening) => {
    expect(opening).toMatch(/AI assistant/);
    expect(opening).toMatch(/healdesk/);
    expect(opening).toMatch(/This call is transcribed/);
    expect(opening.split(/\s+/).length).toBeLessThanOrEqual(20);
    // No audio is kept, so a call never says it is recorded.
    expect(opening).not.toMatch(/record|AYA|healdesk\.io|!/);
    // One question, at the end.
    expect(opening.match(/\?/g)).toHaveLength(1);
    expect(opening).toMatch(/\?$/);
  });

  test("the outbound call asks who answered rather than asserting they asked", () => {
    expect(VOICE_DEMO_OPENING).not.toMatch(/you asked/i);
  });

  test("each agent opens with its own line", () => {
    expect(voiceDemoLlm("outbound").beginMessage).toBe(VOICE_DEMO_OPENING);
    expect(voiceDemoLlm("inbound").beginMessage).toBe(VOICE_DEMO_INBOUND_OPENING);
    expect(text("inbound")).not.toContain("Did you ask for a demo?");
    expect(text("inbound")).toContain("A patient trying to reach their own clinic");
  });
});

describe("one question at a time", () => {
  test.each(DIRECTIONS)("%s: the rule is stated before the selling, as the one that matters most", (direction) => {
    const prompt = flat(voiceDemoLlm(direction).prompt);
    expect(prompt).toContain("THE RULE THAT MATTERS MOST: ONE QUESTION A TURN");
    expect(prompt).toContain("ends with at most ONE question. Never two questions.");
    expect(prompt.indexOf("ONE QUESTION A TURN")).toBeLessThan(prompt.indexOf("HOW YOU SELL"));
  });

  test.each(DIRECTIONS)("%s: no example line the prompt gives her breaks it", (direction) => {
    for (const line of quotedLines(direction)) {
      const questions = line.match(/\?/g)?.length ?? 0;
      expect(questions, line).toBeLessThanOrEqual(1);
      // A question is the end of a turn: nothing said after it.
      if (questions === 1) expect(line.trim().endsWith("?"), line).toBe(true);
    }
  });
});

describe("her register: a gracious hostess", () => {
  test.each(DIRECTIONS)("%s: no line she is given to say is slang or a filler", (direction) => {
    // Casual wording and filler words, with Expressive Mode, were heard as
    // "drunk". The quoted lines are what she imitates.
    for (const line of quotedLines(direction)) {
      expect(line, line).not.toMatch(/\b(yeah|huh|okay|gonna|um|nice|honestly|no problem)\b/i);
    }
  });

  test("both openings are courteous and complete", () => {
    expect(VOICE_DEMO_OPENING).toMatch(/^Hello \{\{prospect_name\}\}, this is \w+, healdesk's AI assistant\./);
    expect(VOICE_DEMO_INBOUND_OPENING).toMatch(/^Thank you for calling healdesk\. This is \w+, an AI assistant\./);
  });
});

describe("how she sells", () => {
  test.each(DIRECTIONS)("%s: CLOSER, in order, and the close asks for the decision", (direction) => {
    const prompt = text(direction);
    const steps = [
      "C · Clarify why",
      "L · Label the problem",
      "O · Overview what",
      "S · Sell the outcome",
      "E · Explain away",
      "R · Reinforce",
    ];
    const at = steps.map((step) => prompt.indexOf(step));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(prompt).toContain('"What made you look at this now?"');
    expect(prompt).toContain("Want me to email you the link to set it up?");
  });

  test("the risk reversal is the contract's words, not a paraphrase", () => {
    expect(flat(VOICE_DEMO_RISK_REVERSAL)).toContain(GUARANTEE_TEXT.paragraphs[0]!.body);
    expect(flat(VOICE_DEMO_RISK_REVERSAL)).toContain(`Within ${POLICY.refundWindowDays} days of paying`);
    expect(flat(VOICE_DEMO_RISK_REVERSAL)).toContain(`${POLICY.setupFeeRefundNotLiveDays} days after they`);
    expect(flat(VOICE_DEMO_RISK_REVERSAL)).toContain("Never add to it.");
  });

  test.each(DIRECTIONS)("%s: no discount, no invented urgency, no invented proof", (direction) => {
    const prompt = text(direction);
    expect(prompt).toContain("Never discount and never hint at one.");
    expect(prompt).toContain("Don't invent urgency");
    expect(prompt).toContain("Never invent a statistic, a customer, a result or a testimonial");
    // She once opened with "Many clinics find that...": proof nobody measured.
    expect(prompt).toContain('never say what "many clinics" or "most owners" find');
  });
});

describe("price, precisely", () => {
  test("every package is on the list at the catalog's figures", () => {
    for (const plan of plans) {
      const line = VOICE_DEMO_PRICES.split("\n").find((l) => l.includes(`${plan.name}:`));
      expect(line, plan.name).toBeDefined();
      expect(line).toContain(`$${plan.monthlyUsd.toLocaleString("en-US")} a month`);
      expect(line).toContain(`$${plan.annualMonthlyUsd.toLocaleString("en-US")} a month billed yearly`);
      expect(line).toContain(`$${plan.setupFeeUsd.toLocaleString("en-US")} one-time setup`);
    }
  });

  test("it never multiplies by locations, and sends a second location to the team", () => {
    expect(flat(VOICE_DEMO_PRICES)).toContain("Never multiply a price by their locations and never guess.");
    expect(flat(VOICE_DEMO_PRICES)).toContain("each extra location is quoted by the team");
  });

  test.each(DIRECTIONS)("%s: no real price appears as an example figure, where she would anchor on it", (direction) => {
    // Real figures live only in THE PRICE LIST, as dollars. Spoken-form
    // examples ("eight ninety-seven") once surfaced as the wrong package's
    // price mid-sentence.
    const outsideList = text(direction).replace(flat(VOICE_DEMO_PRICES), "");
    const spoken = /\b(three|four|five|six|seven|eight|nine|eleven) (ninety-seven|seventeen|thirty-seven|fifty-seven|seventy-seven)\b/i;
    expect(outsideList).not.toMatch(spoken);
  });

  test("overage is called provisional, as copy must", () => {
    expect(flat(VOICE_DEMO_PRICES)).toContain("Provisional: only if asked, and say so.");
  });

  test.each(DIRECTIONS)("%s: the price list and the risk reversal are both in the prompt", (direction) => {
    expect(text(direction)).toContain(flat(VOICE_DEMO_PRICES));
    expect(text(direction)).toContain(flat(VOICE_DEMO_RISK_REVERSAL));
  });
});

describe("the rules every call keeps", () => {
  test.each(DIRECTIONS)("%s: every variable has a value, including on dashboard tests", (direction) => {
    const used = [...voiceDemoPromptText(direction).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      if (SYSTEM_VARIABLES.has(name)) continue;
      expect(Object.keys(voiceDemoLlm(direction).defaults)).toContain(name);
    }
  });

  test.each(DIRECTIONS)("%s: stops, ends, and promises only what was sent", (direction) => {
    const prompt = text(direction);
    expect(prompt).toContain("I'll take you off. Sorry to have bothered you.");
    expect(prompt).toContain("end_call");
    expect(prompt).toContain("unless request_follow_up said it was sent.");
    expect(prompt).toContain("don't claim anything was sent");
    expect(prompt).toContain("Never offer to have anyone phone them. Email only.");
    expect(prompt).not.toMatch(/someone (from healdesk )?will (call|ring|text)/i);
  });

  test.each(DIRECTIONS)("%s: a BAA, never a certification, never revenue, never a '!'", (direction) => {
    const prompt = text(direction);
    expect(prompt).toContain("we sign a business associate agreement with every clinic");
    expect(prompt).toContain('Never say healdesk is "HIPAA compliant"');
    expect(prompt).toContain("Never call anything revenue.");
    expect(prompt).not.toContain("!");
    expect(prompt).not.toMatch(/healdesk\.io/);
  });

  test.each(DIRECTIONS)("%s: it knows the time, and wraps up before the cut", (direction) => {
    expect(text(direction)).toContain("{{session_duration}}");
    expect(text(direction)).toContain("From about nine minutes, wrap up within two turns.");
  });

  test("on the call, 'it'll sound robotic' is answered by the call, not by placing one", () => {
    expect(text("outbound")).not.toContain("phone panel");
    expect(text("outbound")).toContain("let this call answer it");
  });

  test.each(DIRECTIONS)("%s: short enough to answer fast", (direction) => {
    // The model reads all of it before every reply. At about 3,400 words
    // its median was 1.3 seconds of a 1.5-second budget; see the header.
    const words = voiceDemoLlm(direction).prompt.split(/\s+/).length;
    const notes = voiceDemoVariables({ specialtyId: "med-spa" }).practice_notes.split(/\s+/).length;
    expect(words + notes).toBeLessThan(2_400);
  });

  test.each(DIRECTIONS)("%s: the facts that must not drift are there", (direction) => {
    const prompt = text(direction);
    for (const fact of [
      "checks live availability in their Google Calendar and books during the conversation",
      "Auto-confirm is on by default",
      "It sends no texts and never contacts a patient first",
      "booked value at their own prices",
      "It never answers clinical questions",
    ]) {
      expect(prompt).toContain(fact);
    }
  });
});

describe("per-call variables", () => {
  test("a known specialty brings its practice knowledge and economics", () => {
    const vars = voiceDemoVariables({ name: "Sam Rivera", specialtyId: "med-spa" });
    expect(vars.prospect_name).toBe("Sam");
    expect(vars.practice_type).toMatch(/Med Spa/);
    expect(vars.practice_notes).toContain("Who calls:");
    expect(vars.practice_notes).toContain("One booking is worth about $550");
  });

  test("nothing known falls back to defaults rather than an empty prompt", () => {
    expect(voiceDemoVariables({})).toEqual(VOICE_DEMO_VARIABLES);
    expect(voiceDemoVariables({ name: "  ", specialtyId: "nope" }).prospect_name).toBe("there");
  });
});

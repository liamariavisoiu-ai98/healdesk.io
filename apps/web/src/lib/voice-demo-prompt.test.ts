import { plans } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  VOICE_DEMO_GENERAL_PROMPT,
  VOICE_DEMO_OPENING,
  VOICE_DEMO_PRICES,
  VOICE_DEMO_STATES,
  VOICE_DEMO_VARIABLES,
  voiceDemoPromptText,
  voiceDemoVariables,
} from "./voice-demo-prompt";

/**
 * The demo call's prompt is pushed to Retell by scripts/retell-demo-agent.ts,
 * so a wrong sentence here is spoken to a real person on the next call. These
 * pin the lines the call cannot lose. Whitespace is collapsed before matching,
 * so re-wrapping a paragraph does not break a test.
 */

const flat = (text: string) => text.replace(/\s+/g, " ");
const all = flat(voiceDemoPromptText());
const stage = (name: string) => flat(VOICE_DEMO_STATES.find((s) => s.name === name)!.prompt);

/** Retell's own variables, filled on every call without being declared. */
const SYSTEM_VARIABLES = new Set(["session_duration", "current_time"]);

describe("the demo call opens the way the product must", () => {
  test("the fixed opening says AI assistant, healdesk and transcribed, and nothing more", () => {
    expect(VOICE_DEMO_OPENING).toMatch(/healdesk's AI assistant/);
    expect(VOICE_DEMO_OPENING).toMatch(/This call is transcribed/);
    // About five seconds spoken. Anything longer is an AI talking at someone
    // who just picked up.
    expect(VOICE_DEMO_OPENING.split(/\s+/).length).toBeLessThanOrEqual(20);
    // No audio is kept, so the call never says it is recorded.
    expect(VOICE_DEMO_OPENING).not.toMatch(/record/i);
  });

  test("the opening asks who answered rather than asserting they asked", () => {
    expect(VOICE_DEMO_OPENING).toMatch(/\?$/);
    expect(VOICE_DEMO_OPENING).not.toMatch(/you asked/i);
  });

  test("names and the site are written the way they are said", () => {
    expect(VOICE_DEMO_OPENING).not.toMatch(/AYA|healdesk\.io/);
    expect(all).not.toMatch(/healdesk\.io/);
  });
});

describe("the stages", () => {
  test("every variable has a value on every call, including dashboard tests", () => {
    const used = [...voiceDemoPromptText().matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      if (SYSTEM_VARIABLES.has(name)) continue;
      expect(Object.keys(VOICE_DEMO_VARIABLES)).toContain(name);
    }
  });

  test("the close receives what discovery found", () => {
    const into = VOICE_DEMO_STATES.find((s) => s.name === "discovery")!.edges.find((e) => e.to === "close")!;
    expect(Object.keys(into.carry ?? {})).toEqual(["discovery_summary", "recommended_package"]);
    expect(stage("close")).toContain("{{discovery_summary}}");
  });

  test("the price list is read only in the close, keeping every other turn short", () => {
    expect(stage("close")).toContain(flat(VOICE_DEMO_PRICES));
    expect(flat(VOICE_DEMO_GENERAL_PROMPT)).not.toContain("THE PRICE LIST");
    expect(stage("discovery")).not.toContain("THE PRICE LIST");
    for (const state of VOICE_DEMO_STATES) {
      const words = (VOICE_DEMO_GENERAL_PROMPT + state.prompt).split(/\s+/).length;
      expect(words, state.name).toBeLessThan(2_800);
    }
  });

  test("on the call, 'it'll sound robotic' is answered by the call, not by placing one", () => {
    expect(stage("discovery")).not.toContain("phone panel");
    expect(stage("discovery")).toContain("let this call answer it");
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

  test("overage is called provisional, as copy must", () => {
    expect(flat(VOICE_DEMO_PRICES)).toContain("These overage rates are provisional");
  });

  test("it never invents a discount, and asks before passing details on", () => {
    expect(all).toContain("Never invent or hint at a discount, credit, guarantee or contract term.");
    expect(all).toContain("it's fine for the team to get in touch about this?");
  });
});

describe("the conversation", () => {
  test("it asks about their clinic before it pitches, and checks it understood", () => {
    expect(all).toContain("can I ask you a couple of quick questions first?");
    expect(all).toContain('"What made you look at this now?"');
    expect(all).toContain("Have I got that right?");
    expect(all).toContain("follow them at once");
  });

  test("it knows how long the call has run, and wraps up before the cut", () => {
    expect(all).toContain("{{session_duration}}");
    expect(all).toContain("From about nine minutes, wrap up within two turns");
  });

  test("its register is calm: nothing in it is exclaimed", () => {
    expect(all).not.toContain("!");
    expect(VOICE_DEMO_OPENING).not.toContain("!");
  });

  test("it ends calls itself, and handles a request to stop", () => {
    expect(all).toContain("end_call");
    expect(all).toContain("I'll take you off. Sorry to have bothered you.");
    expect(all).toContain("Never leave a message");
  });

  test("it promises a follow-up only when the tool says it was sent", () => {
    expect(all).not.toMatch(/someone (from healdesk )?will (call|ring|email|text)/i);
    expect(all).not.toMatch(/I'll (text|email|send) you/i);
    expect(all).toContain("unless request_follow_up said it was sent.");
    expect(all).toContain("do not claim anything was passed on");
  });

  test("it claims a BAA, never a certification, and never revenue", () => {
    expect(all).toContain("we sign a business associate agreement with every clinic");
    expect(all).toContain('Never say healdesk is "HIPAA compliant"');
    expect(all).toContain("Never call anything revenue.");
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
    expect(voiceDemoVariables({})).toEqual({
      prospect_name: VOICE_DEMO_VARIABLES.prospect_name,
      practice_type: VOICE_DEMO_VARIABLES.practice_type,
      practice_notes: VOICE_DEMO_VARIABLES.practice_notes,
    });
    expect(voiceDemoVariables({ name: "  ", specialtyId: "nope" }).prospect_name).toBe("there");
  });
});

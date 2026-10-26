import { describe, expect, test } from "vitest";

import {
  afterDemoReply,
  DEMO_START_PROGRESS,
  demoStateFrom,
  LOVE_THAT,
  quirkRules,
  quirksIn,
  talkSoonLine,
  type DemoProgress,
} from "@/lib/voice/demo-facts";

/**
 * Aya's signature touches (owner, 26 October 2026, 6h: "I want to proceed
 * only with C and a revised D (only "Talk soon, [name]!")";
 * docs/design/aya-personality-2026-10-26.md). The regression cases in
 * lib/voice/demo-cases.ts walk them through a call; these pin the rules.
 */
describe("Aya's signature touches", () => {
  test("are read from her words, so one said without being declared still counts", () => {
    expect(quirksIn(`${LOVE_THAT} How many calls a day?`)).toEqual(["loveThat"]);
    expect(quirksIn("Thanks so much. Talk soon, Josh!")).toEqual(["talkSoon"]);
    expect(quirksIn("Glad to hear it.")).toEqual([]);
    expect(demoStateFrom({ asked: null, beats: [] }, "Oh, love that!")?.quirks).toEqual(["loveThat"]);
    expect(talkSoonLine("Josh")).toBe("Talk soon, Josh!");
    expect(talkSoonLine(null)).toBe("Talk soon!");
  });

  test("each is kept once, and never from inside a role-play, where she is the clinic's front desk", () => {
    const said = afterDemoReply(DEMO_START_PROGRESS, "pitch", "pitch", demoStateFrom({ asked: null, beats: [] }, LOVE_THAT));
    expect(said.quirks).toEqual(["loveThat"]);
    const again = afterDemoReply(said, "pitch", "pitch", demoStateFrom({ asked: null, beats: [] }, LOVE_THAT));
    expect(again.quirks).toEqual(["loveThat"]);
    const inRoleplay = afterDemoReply(DEMO_START_PROGRESS, "roleplay", "roleplay", demoStateFrom({ asked: null, beats: [] }, "Oh, love that, congratulations!"));
    expect(inRoleplay.quirks).toEqual([]);
  });

  test("leave the note once said, and no sign-off is offered after a call back that failed", () => {
    const fresh = quirkRules(DEMO_START_PROGRESS, "Josh").join("\n");
    expect(fresh).toContain(`your reaction may be exactly "${LOVE_THAT}"`);
    expect(fresh).toContain('your last words are exactly "Talk soon, Josh!"');
    expect(fresh).toMatch(/Never after a firm refusal/);

    const both: DemoProgress = { ...DEMO_START_PROGRESS, quirks: ["loveThat", "talkSoon"] };
    const done = quirkRules(both, "Josh").join("\n");
    expect(done).not.toContain("your reaction may be exactly");
    expect(done).not.toContain("your last words are exactly");
    expect(done).toContain("never again");

    const failed = quirkRules({ ...DEMO_START_PROGRESS, callback: "failed" }, "Josh").join("\n");
    expect(failed).not.toContain("Talk soon");
  });
});

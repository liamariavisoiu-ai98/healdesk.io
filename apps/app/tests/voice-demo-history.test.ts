import { describe, expect, test } from "vitest";

import { demoHistory, type DemoTrail } from "@/lib/voice/retell";

/**
 * Each part of a demo call shows the model only its own conversation (owner,
 * 30 October 2026: Aya mixed the healdesk pitch into the front desk, and the
 * front desk into the pitch).
 */
const t = (speaker: "person" | "assistant", text: string) => ({ speaker, text });
const TURNS = [
  t("assistant", "Hi, this is Aya from healdesk. Am I speaking with Sam?"),
  t("person", "Yes, let's do the role-play."),
  t("assistant", "Let's do it, you be the patient. Ring ring! Hi, thanks for calling Lumen."),
  t("person", "How much is Botox?"),
  t("assistant", "Botox is $12 a unit. Want me to put a consultation in for you?"),
  t("person", "Yes, Thursday at 2, thanks, bye."),
  t("assistant", "Perfect, the team will confirm Thursday at 2. And that's the role-play! So, how was that?"),
  t("person", "Pretty good."),
];

describe("what the model is shown on a demo call", () => {
  test("in the role-play, only the role-play, from its opener", () => {
    const trail: DemoTrail = { open: 2, spans: [] };
    const seen = demoHistory(TURNS.slice(0, 4), "roleplay", trail);
    expect(seen.map((x) => x.text)).toEqual([TURNS[2]!.text, TURNS[3]!.text]);
    expect(seen.some((x) => /healdesk/i.test(x.text))).toBe(false);
  });

  test("after it, everything but the role-play", () => {
    const trail: DemoTrail = { open: null, spans: [[2, 7]] };
    const seen = demoHistory(TURNS, "pitch", trail);
    expect(seen.map((x) => x.text)).toEqual([TURNS[0]!.text, TURNS[1]!.text, TURNS[7]!.text]);
  });

  test("with no role-play yet, the whole call", () => {
    expect(demoHistory(TURNS.slice(0, 2), "intro", { open: null, spans: [] })).toHaveLength(2);
  });
});

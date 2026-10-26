import { describe, expect, test } from "vitest";

import {
  keepsSupportTone,
  lintSupportTone,
  SUPPORT_BANNED_PHRASES,
  SUPPORT_SIGN_OFF,
  SUPPORT_TONE_RULES,
} from "./support-copy";

/**
 * The support tone lint (design E5 §7): the one check the chat's tests, the
 * email drafter and the send path share. Pure, so these are its whole
 * contract.
 */

describe("lintSupportTone", () => {
  test("a calm, short reply in the guide's own shape passes", () => {
    const reply =
      "Hi Dana, calls aren't reaching AYA because forwarding on your main line isn't set yet, so callers get your line as before and nobody is lost. The codes are in Settings, Channels. If they don't take, reply here and we'll call you today.\n\nThe Healdesk Team";
    expect(lintSupportTone(reply)).toEqual([]);
    expect(keepsSupportTone(reply)).toBe(true);
  });

  test("any exclamation mark fails, the full-width one included", () => {
    expect(lintSupportTone("All set!")).toEqual([{ rule: "exclamation" }]);
    expect(lintSupportTone("All set！")).toEqual([{ rule: "exclamation" }]);
  });

  test("an emoji fails", () => {
    expect(lintSupportTone("All set 🙂")).toEqual([{ rule: "emoji" }]);
    expect(lintSupportTone("Done ✅")).toEqual([{ rule: "emoji" }]);
  });

  test("every banned phrase fails on its own, whatever its case", () => {
    for (const phrase of SUPPORT_BANNED_PHRASES) {
      const sentence = `Thanks for writing. ${phrase.toUpperCase()} and the rest is fine.`;
      const problems = lintSupportTone(sentence);
      expect(problems, phrase).toContainEqual({ rule: "banned_phrase", phrase });
      expect(lintSupportTone(sentence.toLowerCase()), phrase).toContainEqual({ rule: "banned_phrase", phrase });
    }
  });

  test("a scripted reply with 'unfortunately' and '!' names both rules, in order, without echoing the text", () => {
    const problems = lintSupportTone("Unfortunately the calendar disconnected! We'll fix it shortly.");
    expect(problems).toEqual([
      { rule: "exclamation" },
      { rule: "banned_phrase", phrase: "unfortunately" },
      { rule: "banned_phrase", phrase: "shortly" },
    ]);
    expect(JSON.stringify(problems)).not.toContain("calendar");
  });

  test("phrases match on word boundaries: a word that only contains one passes", () => {
    expect(lintSupportTone("She has perhaps seen it.")).toEqual([]);
    expect(lintSupportTone("Paid tickets are elsewhere.")).toEqual([]);
    expect(lintSupportTone("The aim is Tuesday.")).toEqual([]);
    expect(lintSupportTone("We sent the AIM report.")).toEqual([]);
    expect(lintSupportTone("Reach the outbox.")).toEqual([]);
  });

  test("spacing and apostrophes do not hide a phrase", () => {
    expect(lintSupportTone("Please   feel\nfree to call.")).toContainEqual({ rule: "banned_phrase", phrase: "feel free to" });
    expect(lintSupportTone("Don’t hesitate to call.")).toContainEqual({ rule: "banned_phrase", phrase: "don't hesitate" });
  });

  test("'the AI' fails: the assistant is AYA", () => {
    expect(lintSupportTone("The AI answered the call.")).toContainEqual({ rule: "banned_phrase", phrase: "the AI" });
    expect(lintSupportTone("AYA answered the call.")).toEqual([]);
  });
});

describe("the rules", () => {
  test("eight rules, the sign-off is the team's and never a first name", () => {
    expect(SUPPORT_TONE_RULES).toHaveLength(8);
    expect(SUPPORT_SIGN_OFF).toBe("The Healdesk Team");
    const rules = SUPPORT_TONE_RULES.join("\n");
    expect(rules).toContain(`signed "The Healdesk Team"`);
    expect(rules).toContain("never with a first name");
    expect(rules).not.toMatch(/Liam/);
  });

  test("the sign-off itself keeps the tone", () => {
    expect(lintSupportTone(SUPPORT_SIGN_OFF)).toEqual([]);
  });
});

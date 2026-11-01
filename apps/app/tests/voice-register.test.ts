import { describe, expect, test } from "vitest";

import { shapeVoiceReply, withoutLeadingFiller } from "@/lib/assistant/turn";
import { DEMO_START_PROGRESS, isConfused, listedIn, pickedFrom, withDemoAnswer, type DemoProgress } from "@/lib/voice/demo-facts";

/**
 * What test call 72dc66b7 (Thomas, Lumen, 26 October 2026) showed a reminder
 * in the prompt could not hold, now held in code. The demo's regression case
 * these pin each rule.
 */
const shape = (text: string, over: Partial<Parameters<typeof shapeVoiceReply>[1]> = {}) =>
  shapeVoiceReply(text, { name: "Thomas", nameUses: 0, apologised: false, first: true, noSignOff: false, ...over });

describe("a call's register, enforced", () => {
  test("the caller's name as a form of address goes after two uses; the sign-off keeps it", () => {
    expect(shape("Sure, Thomas, I can help.", { nameUses: 1 })).toBe("Sure, Thomas, I can help.");
    expect(shape("Sure, Thomas, I can help.", { nameUses: 2 })).toBe("Sure, I can help.");
    expect(shape("Thomas, the address is 200 Congress Ave.", { nameUses: 3 })).toBe("The address is 200 Congress Ave.");
    expect(shape("Got it, Thomas. Anything else?", { nameUses: 2 })).toBe("Got it. Anything else?");
    expect(shape("Thanks for your time. Talk soon, Thomas!", { nameUses: 5 })).toBe("Thanks for your time. Talk soon, Thomas!");
    // A name that is the subject of the sentence is not a form of address.
    expect(shape("Thomas asked a great question.", { nameUses: 5 })).toBe("Thomas asked a great question.");
  });

  test("once the call has had an apology, a reply's opening sorry goes; the first one stays", () => {
    expect(shape("I'm sorry, the address is 200 Congress Ave.")).toBe("I'm sorry, the address is 200 Congress Ave.");
    expect(shape("I'm sorry, the address is 200 Congress Ave.", { apologised: true })).toBe("The address is 200 Congress Ave.");
    expect(shape("Sorry, Thomas, you're right, you already told me.", { apologised: true })).toBe("You're right, you already told me.");
    // Only at the start of the reply, and never a reply that is nothing else.
    expect(shape("I'm sorry, the address is 200 Congress Ave.", { apologised: true, first: false })).toBe("I'm sorry, the address is 200 Congress Ave.");
    expect(shape("Sorry!", { apologised: true })).toBe("Sorry!");
  });

  test("a frustrated caller never hears Talk soon", () => {
    expect(shape("Thanks for your time. Talk soon, Thomas!", { noSignOff: true })).toBe("Thanks for your time.");
    expect(shape("Talk soon!", { noSignOff: true })).toBe("");
  });

  test("filler openers go, the ones the model writes included", () => {
    expect(withoutLeadingFiller("Mm. Hi, great to hear from you!")).toBe("Hi, great to hear from you!");
    expect(withoutLeadingFiller("Let me see. Our facials start at $199.")).toBe("Our facials start at $199.");
    expect(withoutLeadingFiller("Let's see, which day suits you?")).toBe("Which day suits you?");
  });
});

describe("what the caller's words mean, read in code", () => {
  test("I don't understand is no answer, and the count goes up until they follow", () => {
    for (const words of ["I don't understand.", "I don't understand what you're asking", "What do you mean?", "I'm confused", "What does it mean?"]) {
      expect(isConfused(words), words).toBe(true);
    }
    expect(isConfused("I don't understand why that costs so much, can you explain the price?")).toBe(false);
    let p: DemoProgress = DEMO_START_PROGRESS;
    p = withDemoAnswer(p, "roleplay", "I don't understand.");
    expect(p.confused).toBe(1);
    p = withDemoAnswer(p, "roleplay", "What do you mean?");
    expect(p.confused).toBe(2);
    p = withDemoAnswer(p, "roleplay", "Friday, please.");
    expect(p.confused).toBe(0);
  });

  test("the second one is the second item she listed, never her guess", () => {
    const menu = ["Signature Facial", "VIP Facial", "Prestige Facial", "Facial"];
    const listed = listedIn("Our Signature Facial is $249, the VIP Facial is $349 and the Prestige Facial is $599.", menu);
    expect(listed).toEqual(["Signature Facial", "VIP Facial", "Prestige Facial"]);
    expect(pickedFrom("The second one.", listed)).toEqual({ said: "second", item: "VIP Facial", index: 1 });
    expect(pickedFrom("the last one please", listed)?.item).toBe("Prestige Facial");
    expect(pickedFrom("The middle one", listed)?.item).toBe("VIP Facial");
    expect(pickedFrom("The first.", listed)?.item).toBe("Signature Facial");
    // No list, or no position: nothing is read into their words.
    expect(pickedFrom("The second one.", [])).toBeNull();
    expect(pickedFrom("I'd like the facial", listed)).toBeNull();
  });
});

describe("the call's details are never spoken (transcript 0a45870b)", () => {
  test("a brace ends the spoken words, as the delimiter does, while streaming and at the end", async () => {
    const { SpokenStream } = await import("@/lib/assistant/turn");
    const said: string[] = [];
    const stream = new SpokenStream((sentence) => said.push(sentence));
    for (const piece of ["Lovely, what day ", "suits you? ", '{"handoff": false, "state": ', '{"asked": null}}']) stream.push(piece);
    expect(said.join(" ")).toBe("Lovely, what day suits you?");
    expect(stream.remainder()).toBe("");
  });

  test("anything from a brace, a state field or the delimiter on is kept out of speech and the record", async () => {
    const { spokenOnly } = await import("@/lib/assistant/turn");
    expect(spokenOnly('Great, Friday it is. {"state": {"booking": {"day": "Friday"}}}')).toBe("Great, Friday it is.");
    expect(spokenOnly('Great. "state": {"asked": null}')).toBe("Great.");
    expect(spokenOnly("Great. ### {}")).toBe("Great.");
    expect(spokenOnly(" Lovely, which day suits you?")).toBe(" Lovely, which day suits you?");
  });

  test("a bare no is a no; a no that closes warmly is not", async () => {
    const { SAID_NO } = await import("@/lib/voice/demo-facts");
    for (const words of ["No.", "No. No.", "I told you no. No.", "Nope", "I said no"]) expect(SAID_NO.test(words), words).toBe(true);
    for (const words of ["No, that's all, thanks.", "Nothing else", "Not now, maybe later", "Yes"]) expect(SAID_NO.test(words), words).toBe(false);
  });
});

import { describe, expect, test } from "vitest";

import { shapeVoiceReply, withoutLeadingFiller } from "@/lib/assistant/turn";
import {
  afterDemoReply,
  DEMO_ROLEPLAY_EXIT,
  DEMO_START_PROGRESS,
  demoRoleplayOpener,
  isBareYes,
  isConfused,
  listedIn,
  offeredRoleplayChoice,
  pickedFrom,
  SKIPPED_ANSWER,
  withDemoAnswer,
  withRoleplayExit,
  withRoleplayOpener,
} from "@/lib/voice/demo-facts";

/**
 * What test call 72dc66b7 (Thomas, Lumen, 26 October 2026) showed a reminder
 * in the prompt could not hold, now held in code. The demo's regression case
 * thomas-lumen-72dc66b7 walks them through a call; these pin each rule.
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

describe("the role-play's scripted lines, said by the call", () => {
  const opener = demoRoleplayOpener("Lumen Aesthetics");

  test("the opener follows her handover word for word, whatever she wrote of it", () => {
    expect(withRoleplayOpener("Let's do it, you be the patient.", opener)).toBe(`Let's do it, you be the patient. ${opener}`);
    expect(withRoleplayOpener("Let's do it, you be the patient. Ring ring!", opener)).toBe(`Let's do it, you be the patient. ${opener}`);
    expect(withRoleplayOpener(`Sure. ${opener}`, opener)).toBe(`Sure. ${opener}`);
    // What already went out stands, and the rest of the opener follows it.
    expect(withRoleplayOpener("Let's do it. Ring ring!", opener, "Let's do it. Ring ring!")).toBe(`Let's do it. ${opener}`);
    expect(withRoleplayOpener("Okay! Quick heads-up: I'll play the front desk.", opener, "Okay!")).toBe(`Okay! Quick heads-up: I'll play the front desk. ${opener}`);
  });

  test("the exit line follows her in-character goodbye, once", () => {
    expect(withRoleplayExit("Take care!")).toBe(`Take care! ${DEMO_ROLEPLAY_EXIT}`);
    expect(withRoleplayExit(`Take care! ${DEMO_ROLEPLAY_EXIT}`)).toBe(`Take care! ${DEMO_ROLEPLAY_EXIT}`);
    expect(withRoleplayExit("Take care! And that's the role-play!")).toBe(`Take care! ${DEMO_ROLEPLAY_EXIT}`);
  });

  test("a bare yes chooses nothing between two offers", () => {
    for (const yes of ["Yes, please.", "Yeah", "Sure!", "Okay, sure", "yes please"]) expect(isBareYes(yes), yes).toBe(true);
    for (const words of ["Yes, the role-play", "Tell me more first", "let's do the role play"]) expect(isBareYes(words), words).toBe(false);
    expect(offeredRoleplayChoice("Want me to walk through each channel, or switch into the role-play?")).toBe(true);
    expect(offeredRoleplayChoice("Ready for the role-play?")).toBe(false);
  });
});

describe("what the caller's words mean, read in code", () => {
  test("I don't understand is no answer, and the count goes up until they follow", () => {
    for (const words of ["I don't understand.", "I don't understand what you're asking", "What do you mean?", "I'm confused", "What does it mean?"]) {
      expect(isConfused(words), words).toBe(true);
    }
    expect(isConfused("I don't understand why that costs so much, can you explain the price?")).toBe(false);
    let p = { ...DEMO_START_PROGRESS, asked: "volume" as const };
    p = withDemoAnswer(p, "pitch", "I don't understand.");
    expect(p.answers.volume).toBeUndefined();
    expect(p.confused).toBe(1);
    p = withDemoAnswer(p, "pitch", "What do you mean?");
    expect(p.confused).toBe(2);
    p = withDemoAnswer(p, "pitch", "About five.");
    expect(p).toMatchObject({ confused: 0, answers: { volume: "About five." } });
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

  test("a rich answer counts for every question it answered, and impatience skips the rest", () => {
    const words = "Answer the phone, book clients, and handle WhatsApp and Instagram.";
    let p = withDemoAnswer({ ...DEMO_START_PROGRESS, asked: "goal" }, "pitch", words);
    p = afterDemoReply(p, "pitch", "pitch", { asked: "volume", beats: [], callback: null, answered: ["goal", "coverage"] }, words);
    expect(p.answers).toEqual({ goal: words, coverage: words });
    const tired = "You tired me, honestly.";
    p = withDemoAnswer(p, "pitch", tired);
    p = afterDemoReply(p, "pitch", "pitch", { asked: null, beats: [], callback: null, impatient: true }, tired);
    expect(p.impatient).toBe(true);
    expect(p.answers).toEqual({ goal: words, coverage: words, volume: SKIPPED_ANSWER, volumeCheck: SKIPPED_ANSWER, missed: SKIPPED_ANSWER });
  });
});

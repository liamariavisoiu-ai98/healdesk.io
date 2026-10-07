import { describe, expect, test } from "vitest";

import { findClinicalContent } from "./clinical-content";
import { findUrgentContent } from "./urgent-content";

describe("findUrgentContent", () => {
  // What someone writes when something is happening to them now: each of
  // these gets the urgent reply, never the model.
  test.each([
    ["My lips are swelling after yesterday's treatment, what should I do?", "swelling"],
    ["my face is swollen", "swelling"],
    ["I can’t breathe properly since the injection", "breathing, the throat or the chest"],
    ["cant breathe", "breathing, the throat or the chest"],
    ["my throat feels tight", "breathing, the throat or the chest"],
    ["chest pain since this morning", "breathing, the throat or the chest"],
    ["I think I'm having an allergic reaction", "an allergic reaction"],
    ["it's bleeding and won't stop", "bleeding"],
    ["there's pus coming out", "an infection or a burn"],
    ["I have a fever after the procedure", "an infection or a burn"],
    ["blisters after the laser", "an infection or a burn"],
    ["I got burned by the laser", "an infection or a burn"],
    ["the skin around the filler has turned white", "a change in the skin or in sight"],
    ["the area looks mottled", "a change in the skin or in sight"],
    ["blurry vision since this morning", "a change in the skin or in sight"],
    ["I'm in severe pain", "severe pain"],
    ["I'm in so much pain", "severe pain"],
    ["I fainted after the appointment", "consciousness or the nerves"],
    ["she lost consciousness for a minute", "consciousness or the nerves"],
    ["feeling dizzy and lightheaded", "consciousness or the nerves"],
    ["I can't feel my lip", "consciousness or the nerves"],
    ["the stitches came out", "a wound or an injury"],
    ["my wound has opened", "a wound or an injury"],
    ["I knocked out my front tooth", "a wound or an injury"],
    ["I broke a tooth, can someone see me today?", "a wound or an injury"],
    ["I want to kill myself", "a crisis"],
    ["I had a bad reaction to the peel", "a reaction or a complication"],
    ["is this an emergency?", "an emergency"],
    ["should I call 911", "an emergency"],
    ["it's urgent, please", "an emergency"],
    ["should I go to the hospital?", "an emergency"],
  ])("%j is urgent (%s)", (text, label) => {
    expect(findUrgentContent(text)).toEqual({ label });
  });

  // The ordinary business of a front desk, and the messages the Meta tests
  // send: none of them is urgent. Some are clinical, which is the other
  // screen's business.
  test.each([
    "What are your opening hours?",
    "where do I park?",
    "Is the consultation free?",
    "how much are lip fillers?",
    "How much is it per unit?",
    "Do you take Blue Cross? What's my copay for a consult?",
    "Can you book me in for Botox on Tuesday at 2pm with Dr Chen?",
    "I'd like to book. I'm Maria, 415-555-0134, any weekday morning works.",
    "415-555-0134 — it's for my acne",
    "my number is 415-911-2345",
    "any weekday morning works, or Thursday after 4",
    "Mornings are best, or Thursday after 4 — oh and my rosacea is flaring",
    "I have terrible acne, can you fix it?",
    "I'm pregnant, is it safe to get filler?",
    "Do you treat back pain?",
    "Do you use numbing cream?",
    "Do you fix droopy eyelids?",
    "my hair is going grey, do you do PRP?",
    "do you do fat burning injections?",
    "How much are brush stroke brows?",
    "I want a dusky pink lip blush",
    "I can't see a booking link on your website",
    "That sounds swell, thanks",
    "nothing urgent, just wondering about prices",
    "please stop calling me",
    "Are you a real person?",
  ])("%j is not urgent", (text) => {
    expect(findUrgentContent(text)).toBeNull();
  });

  test("empty or missing text is not urgent", () => {
    expect(findUrgentContent("")).toBeNull();
    expect(findUrgentContent(null)).toBeNull();
    expect(findUrgentContent(undefined)).toBeNull();
  });

  test("it names the family that matched, never the words", () => {
    const finding = findUrgentContent("My lips are swelling after the filler");
    expect(Object.keys(finding ?? {})).toEqual(["label"]);
    expect(JSON.stringify(finding)).not.toMatch(/lips|filler/);
  });

  test("an urgent message is often clinical as well, which is why callers screen for urgency first", () => {
    const text = "I think I'm having an allergic reaction to the filler";
    expect(findUrgentContent(text)).not.toBeNull();
    expect(findClinicalContent({ message: text })).not.toEqual([]);
  });
});

import { describe, expect, test } from "vitest";

import { findClinicalContent } from "./clinical-content";
import { findUrgentContent, urgentSetFor } from "./urgent-content";

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
    // In the present tense too, and with no verb at all: the past tense alone
    // let "I have a reaction" through to the model.
    ["I have a bad reaction to the filler you did yesterday", "a reaction or a complication"],
    ["she has a reaction to the botox", "a reaction or a complication"],
    ["I think I have a complication from the botox", "a reaction or a complication"],
    ["I've got a reaction to the peel", "a reaction or a complication"],
    ["I get a weird reaction every time", "a reaction or a complication"],
    ["she developed a complication after the lift", "a reaction or a complication"],
    ["Bad reaction to the filler, what do I do??", "a reaction or a complication"],
    ["my skin is reacting badly to the peel", "a reaction or a complication"],
    // Trouble swallowing after a toxin: its boxed warning's spread of effect.
    ["trouble swallowing since my botox", "breathing, the throat or the chest"],
    ["difficulty swallowing after the injections", "breathing, the throat or the chest"],
    ["it hurts to swallow", "breathing, the throat or the chest"],
    ["I can't swallow properly", "breathing, the throat or the chest"],
    ["is this an emergency?", "an emergency"],
    ["should I call 911", "an emergency"],
    ["it's urgent, please", "an emergency"],
    ["should I go to the hospital?", "an emergency"],
  ])("%j is urgent (%s)", (text, label) => {
    expect(findUrgentContent(text)).toEqual({ label, emergency: "911" });
    // The set for people is the same for every specialty HIPAA can reach.
    for (const specialty of ["med-spa", "dental", "plastic-surgery", "massage-chiro", null]) {
      expect(findUrgentContent(text, specialty), String(specialty)).toEqual({ label, emergency: "911" });
    }
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
    // "have" and "get" are the words of a front desk as well.
    "Do you have a cancellation policy?",
    "I have a question about prices",
    "Can I get a consultation first?",
    "How do I get to your office?",
    "Are there any complications?",
    "Do I need to swallow anything before the procedure?",
    "That's a hard pill to swallow",
  ])("%j is not urgent", (text) => {
    expect(findUrgentContent(text)).toBeNull();
  });

  test("empty or missing text is not urgent", () => {
    expect(findUrgentContent("")).toBeNull();
    expect(findUrgentContent(null)).toBeNull();
    expect(findUrgentContent(undefined)).toBeNull();
  });

  test("it names the family that matched and the emergency service, never the words", () => {
    const finding = findUrgentContent("My lips are swelling after the filler");
    expect(Object.keys(finding ?? {}).sort()).toEqual(["emergency", "label"]);
    expect(JSON.stringify(finding)).not.toMatch(/lips|filler/);
  });

  test("a complication someone has is urgent; complications asked about in general are the clinical screen's", () => {
    expect(findUrgentContent("I think I have a complication from the botox")).toEqual({
      label: "a reaction or a complication",
      emergency: "911",
    });
    expect(findUrgentContent("Are there any complications?")).toBeNull();
    expect(findClinicalContent({ message: "Are there any complications?" })).not.toEqual([]);
  });

  test("an urgent message is often clinical as well, which is why callers screen for urgency first", () => {
    const text = "I think I'm having an allergic reaction to the filler";
    expect(findUrgentContent(text)).not.toBeNull();
    expect(findClinicalContent({ message: text })).not.toEqual([]);
  });

  test("an everyday condition is clinical on a Meta channel and never urgent: the hand-off line, not 911", () => {
    for (const text of [
      "415-555-0134 — it's for my acne",
      "Mornings are best, or Thursday after 4 — oh and my rosacea is flaring",
      "I have terrible acne, can you fix it?",
    ]) {
      expect(findUrgentContent(text), text).toBeNull();
      expect(findClinicalContent({ message: text }, { conditions: true }), text).not.toEqual([]);
      expect(findClinicalContent({ message: text }), text).toEqual([]);
    }
  });
});

describe("findUrgentContent for a veterinary practice", () => {
  test("the specialty chooses the set: animals for a vet, people for everyone else", () => {
    expect(urgentSetFor("veterinary")).toBe("veterinary");
    for (const specialty of ["med-spa", "plastic-surgery", "fertility", "dental", "glp1", "hair-restoration", "massage-chiro"]) {
      expect(urgentSetFor(specialty), specialty).toBe("human");
    }
    expect(urgentSetFor(null)).toBe("human");
    expect(urgentSetFor(undefined)).toBe("human");
    expect(urgentSetFor("not-a-specialty")).toBe("human");
  });

  // What a client writes when their animal needs emergency care now: each of
  // these gets the emergency vet, never the model and never 911.
  test.each([
    ["My dog ate a whole bar of chocolate", "a poisoning or something swallowed"],
    ["he got into my ibuprofen", "a poisoning or something swallowed"],
    ["I think the cat licked antifreeze in the garage", "a poisoning or something swallowed"],
    ["she ate some grapes off the counter", "a poisoning or something swallowed"],
    ["our puppy chewed up a pack of gum with xylitol", "a poisoning or something swallowed"],
    ["I think he's been poisoned", "a poisoning or something swallowed"],
    ["she ate something toxic on our walk", "a poisoning or something swallowed"],
    ["my dog swallowed a sock", "a poisoning or something swallowed"],
    ["he ate a corn cob from the trash", "a poisoning or something swallowed"],
    ["my lab's stomach is swollen and hard", "bloat"],
    ["he keeps retching but nothing comes up", "bloat"],
    ["I think it's bloat", "bloat"],
    ["my dog is trying to vomit but can't", "bloat"],
    ["she can't breathe properly", "breathing"],
    ["he's breathing really fast and his gums are pale", "breathing"],
    ["my cat is gasping", "breathing"],
    ["her gums look blue", "breathing"],
    ["my dog just collapsed in the yard", "a collapse or a seizure"],
    ["he's having a seizure right now", "a collapse or a seizure"],
    ["she can't stand up and is dragging her back legs", "a collapse or a seizure"],
    ["I think my cat is dying", "a collapse or a seizure"],
    ["his paw is bleeding everywhere", "bleeding"],
    ["there's blood in her urine", "bleeding"],
    ["he's vomiting blood", "bleeding"],
    ["my dog was hit by a car", "an accident or an injury"],
    ["she was attacked by another dog", "an accident or an injury"],
    ["I think his leg is broken", "an accident or an injury"],
    ["my cat can't pee", "not passing urine"],
    ["my male cat keeps straining in the litter box", "not passing urine"],
    ["he hasn't peed all day", "not passing urine"],
    ["I think she has heatstroke", "heatstroke"],
    ["he's overheating after the walk", "heatstroke"],
    ["his eye is bulging out of its socket", "an eye injury"],
    ["she scratched her eye on a bush", "an eye injury"],
    ["she's been in labour for three hours and nothing", "a difficult birth"],
    ["there's a puppy stuck", "a difficult birth"],
    ["his face is swelling after a bee sting", "an allergic reaction"],
    ["my dog keeps vomiting", "vomiting that will not stop"],
    ["she's been throwing up all night", "vomiting that will not stop"],
    ["he's yelping in pain when I touch him", "severe pain"],
    ["it's an emergency", "an emergency"],
    ["should I take him to the animal hospital?", "an emergency"],
  ])("%j is urgent (%s) and points to the emergency vet", (text, label) => {
    expect(findUrgentContent(text, "veterinary")).toEqual({ label, emergency: "veterinary" });
  });

  test("a client in crisis themselves is a person: 911, whatever the practice treats", () => {
    for (const text of ["I want to kill myself", "I just want to die", "I've been thinking about suicide"]) {
      expect(findUrgentContent(text, "veterinary"), text).toEqual({ label: "a crisis", emergency: "911" });
    }
  });

  // The business of a veterinary front desk, and a pet spa's: none of it is urgent.
  test.each([
    "What are your opening hours?",
    "How much is a dental cleaning for my dog?",
    "Do you do vaccinations for kittens?",
    "Can I book a nail trim for Saturday?",
    "How much is it to neuter a cat?",
    "Is the spay price including the pain meds?",
    "My cat needs her annual checkup",
    "Do you board cats over the holidays?",
    "Do you sell flea and tick treatment?",
    "We have a new puppy, when should we start his shots?",
    "Can you microchip my dog?",
    "I need a grooming appointment for my poodle",
    "My dog is due for her rabies booster",
    "Do you see rabbits and guinea pigs?",
    "nothing urgent, just a booking please",
    "My dog hates car rides, any tips?",
    "Is there parking for my car?",
    "My dog's breath smells, do you do dental cleaning?",
    "We're expecting a litter in the spring",
    "My cat had kittens last month, when can she be spayed?",
    "Can dogs eat grapes?",
    "My dog is eating well, he loves his ball",
    "Are your shampoos non-toxic?",
    "Do you offer fur dyeing at the spa?",
    "my number is 415-911-2345",
    "Our dog died last week, do you arrange cremation?",
    "I can't see a booking link on your website",
  ])("%j is not urgent at a veterinary practice", (text) => {
    expect(findUrgentContent(text, "veterinary")).toBeNull();
  });
});

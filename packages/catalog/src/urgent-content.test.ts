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
    expect(findUrgentContent(text)).toEqual({ label, emergency: "911", language: "en" });
    // The set for people is the same for every specialty HIPAA can reach.
    for (const specialty of ["med-spa", "dental", "plastic-surgery", "massage-chiro", null]) {
      expect(findUrgentContent(text, specialty), String(specialty)).toEqual({ label, emergency: "911", language: "en" });
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
    expect(Object.keys(finding ?? {}).sort()).toEqual(["emergency", "label", "language"]);
    expect(JSON.stringify(finding)).not.toMatch(/lips|filler/);
  });

  test("a complication someone has is urgent; complications asked about in general are the clinical screen's", () => {
    expect(findUrgentContent("I think I have a complication from the botox")).toEqual({
      label: "a reaction or a complication",
      emergency: "911",
      language: "en",
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

describe("findUrgentContent: a crisis, in every way it is said", () => {
  // The review of 14 October: the crisis family missed these, at every practice.
  test.each([
    "I'm thinking of ending my life",
    "I'm going to end it all",
    "I took too many pills",
    "I don't want to live anymore",
    "she wants to die",
    "my wife wants to hurt herself",
    "I overdosed",
    "I took an overdose",
    "I wanna die",
    "I swallowed a bottle of pills",
  ])("%j is a crisis, and 911's", (text) => {
    expect(findUrgentContent(text)).toEqual({ label: "a crisis", emergency: "911", language: "en" });
  });

  test.each([
    "Is it OK to take my pills before the appointment?",
    "I'd die for clear skin lol",
    "I took the day off for my appointment",
    "Do I need to stop my medication before Botox?",
  ])("%j is not a crisis", (text) => {
    expect(findUrgentContent(text)).toBeNull();
  });
});

describe("findUrgentContent: a question about the practice's emergency service is read past, an emergency never", () => {
  test.each([
    "Do you offer emergency appointments?",
    "Do you have emergency hours on the weekend?",
    "Is there an emergency line I can call after hours?",
    "How much is an emergency visit?",
    "Is it urgent to book a consultation before my trip?",
  ])("%j is a question for the desk", (text) => {
    expect(findUrgentContent(text)).toBeNull();
  });

  test.each([
    ["Do you take urgent appointments? I'm in severe pain", "severe pain"],
    ["Do you have emergency hours? My lips are swelling", "swelling"],
    ["it's an emergency, are you open?", "an emergency"],
    ["Help! Do you have emergency appointments?", "an emergency"],
    ["I need an emergency appointment", "an emergency"],
    ["is this an emergency?", "an emergency"],
  ])("%j is still urgent (%s)", (text, label) => {
    expect(findUrgentContent(text)).toMatchObject({ label, emergency: "911" });
  });

  test("the practice's own name is read past, and only its name", () => {
    expect(findUrgentContent("Is Urgent Smiles Dental open on Saturday?", "dental", { clinicName: "Urgent Smiles Dental" })).toBeNull();
    expect(findUrgentContent("Is Urgent Smiles Dental open on Saturday?", "dental")).not.toBeNull();
    expect(
      findUrgentContent("Urgent Smiles Dental, I knocked out my front tooth", "dental", { clinicName: "Urgent Smiles Dental" }),
    ).toMatchObject({ label: "a wound or an injury" });
  });
});

describe("findUrgentContent in Spanish", () => {
  // Spanish is the second language the assistant answers in, so the screen reads it at every practice.
  test.each([
    ["No puedo respirar", "breathing, the throat or the chest"],
    ["Me cuesta respirar desde la inyección", "breathing, the throat or the chest"],
    ["Siento dolor en el pecho", "breathing, the throat or the chest"],
    ["Tengo una reacción alérgica después del relleno", "an allergic reaction"],
    ["Es una emergencia, mi labio se está poniendo blanco", "an emergency"],
    ["Tengo los labios hinchados", "swelling"],
    ["Está sangrando y no para de sangrar", "bleeding"],
    ["Tengo fiebre después del procedimiento", "an infection or a burn"],
    ["Tengo visión borrosa", "a change in the skin or in sight"],
    ["Tengo un dolor insoportable", "severe pain"],
    ["Me desmayé después de la cita", "consciousness or the nerves"],
    ["Se me rompió un diente", "a wound or an injury"],
    ["Quiero suicidarme", "a crisis"],
    ["Me quiero morir", "a crisis"],
    ["Me tomé demasiadas pastillas", "a crisis"],
    ["Tuve una mala reacción al peeling", "a reaction or a complication"],
  ])("%j is urgent (%s), and its reply is Spanish", (text, label) => {
    expect(findUrgentContent(text, "med-spa")).toEqual({ label, emergency: "911", language: "es" });
  });

  test.each([
    "¿Cuánto cuesta el botox?",
    "Quisiera una cita para el martes por la mañana",
    "¿Dónde puedo estacionar?",
    "nada urgente, solo una pregunta sobre precios",
    "¿Tienen citas de urgencia?",
    "¿Aceptan seguro?",
    "Mi número es 415-911-2345",
    "¿Usan crema anestésica?",
  ])("%j is not urgent", (text) => {
    expect(findUrgentContent(text, "med-spa")).toBeNull();
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
    expect(findUrgentContent(text, "veterinary")).toEqual({ label, emergency: "veterinary", language: "en" });
  });

  // The review of 14 October: these reached the model.
  test.each([
    ["my dog isn't moving", "a collapse or a seizure"],
    ["he won't wake up", "a collapse or a seizure"],
    ["my dog was attacked by a pit bull", "an accident or an injury"],
    ["she ate something and is now shaking", "a poisoning or something swallowed"],
    ["my dog overdosed on my pills", "a poisoning or something swallowed"],
    ["should I call 911 for my dog?", "an emergency"],
  ])("%j is an animal's emergency (%s)", (text, label) => {
    expect(findUrgentContent(text, "veterinary")).toEqual({ label, emergency: "veterinary", language: "en" });
  });

  test("a client in crisis themselves is a person: 911, by the very family the set for people uses", () => {
    for (const text of [
      "I want to kill myself",
      "I just want to die",
      "I've been thinking about suicide",
      "she wants to die",
      "my wife wants to hurt herself",
      "I overdosed",
      "I took an overdose",
      "I'm thinking of ending my life",
      "I'm going to end it all",
      "I took too many pills",
      "I don't want to live anymore",
      "my dog died and I want to kill myself",
    ]) {
      expect(findUrgentContent(text, "veterinary"), text).toEqual({ label: "a crisis", emergency: "911", language: "en" });
      expect(findUrgentContent(text, "med-spa"), text).toEqual({ label: "a crisis", emergency: "911", language: "en" });
    }
  });

  // The review of 14 October: a person's own emergency at a veterinary
  // practice went to the emergency vet.
  test.each([
    "I swallowed a bottle of pills",
    "call 911, my husband collapsed",
    "I need an ambulance",
    "I can't breathe",
    "my son swallowed a battery",
    "I'm having an allergic reaction",
    "my baby isn't breathing",
    "I'm having chest pains",
    "my husband is having a heart attack",
    "I was bitten by a dog and it won't stop bleeding",
    "my face is swelling and my throat feels tight",
    "call 911",
  ])("%j is a person's emergency at a vet: 911", (text) => {
    expect(findUrgentContent(text, "veterinary")).toMatchObject({ emergency: "911" });
  });

  test("an animal's emergency still goes to the emergency vet when the client says I", () => {
    for (const text of [
      "I think my dog ate a whole bar of chocolate",
      "I just found my cat collapsed",
      "I can't get my dog to stand up, he collapsed",
      "I'm worried, my dog is vomiting blood",
    ]) {
      expect(findUrgentContent(text, "veterinary"), text).toMatchObject({ emergency: "veterinary" });
    }
  });

  test("in Spanish too: an animal's emergency, and a person's", () => {
    expect(findUrgentContent("mi perro comió chocolate", "veterinary")).toEqual({
      label: "a poisoning or something swallowed",
      emergency: "veterinary",
      language: "es",
    });
    expect(findUrgentContent("mi gato no puede orinar", "veterinary")).toMatchObject({ emergency: "veterinary", language: "es" });
    expect(findUrgentContent("mi perro no se mueve", "veterinary")).toMatchObject({ emergency: "veterinary", language: "es" });
    expect(findUrgentContent("lo atropelló un carro", "veterinary")).toMatchObject({ emergency: "veterinary", language: "es" });
    expect(findUrgentContent("mi esposo no puede respirar", "veterinary")).toMatchObject({ emergency: "911", language: "es" });
    expect(findUrgentContent("me quiero morir", "veterinary")).toMatchObject({ label: "a crisis", emergency: "911", language: "es" });
    expect(findUrgentContent("¿Cuánto cuesta vacunar a mi perro?", "veterinary")).toBeNull();
    expect(findUrgentContent("¿Tienen citas de urgencia para gatos?", "veterinary")).toBeNull();
  });

  // The review of 14 October: a hospital's name and a question about its
  // emergency service fired the urgent reply.
  test("the practice's name and a question about its service are read past; an emergency never", () => {
    const named = { clinicName: "Oakwood Animal Hospital" };
    for (const text of [
      "Hi, is Oakwood Animal Hospital open on Saturday?",
      "Thanks Oakwood Animal Hospital, see you tomorrow",
      "Do you offer emergency appointments?",
      "Is it urgent to get my puppy vaccinated?",
      "is the vet hospital open Sunday",
    ]) {
      expect(findUrgentContent(text, "veterinary", named), text).toBeNull();
    }
    for (const [text, label] of [
      ["Hi Oakwood Animal Hospital, my dog was hit by a car", "an accident or an injury"],
      ["Do you take emergency appointments? he was hit by a car", "an accident or an injury"],
      ["it's an emergency, are you open?", "an emergency"],
      ["should I take him to the animal hospital?", "an emergency"],
    ] as const) {
      expect(findUrgentContent(text, "veterinary", named), text).toMatchObject({ label, emergency: "veterinary" });
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
    // The review of 14 October.
    "I'd like to book a spay",
    "Do you do dental cleaning?",
    "how much for vaccinations",
    "my dog loves eating bones, what treats do you sell?",
    "my dog is due for her heartworm pills",
    "Do you board dogs over the holidays?",
    "My dog needs his nails trimmed, he hates it and yelps",
    "Can I bring in the bloodwork from the other vet?",
    "My dog chews his toy ball all day",
    "we just had a litter of puppies, when can they get shots",
    "how long does a dental take? she will be under anaesthesia",
    "do you sell flea and tick medication?",
    "My dog ate his food too fast",
    "I'm not breathing easy about the cost lol",
  ])("%j is not urgent at a veterinary practice", (text) => {
    expect(findUrgentContent(text, "veterinary")).toBeNull();
  });
});

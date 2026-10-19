import {
  NEVER_SAY_DEFAULTS,
  PATIENT_MODEL_IDS,
  URGENT_LEAVE_NUMBER_LINE,
  URGENT_TEAM_TOLD_LINE,
} from "@healdesk/catalog";
import { describe, expect, test, vi } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import {
  amountsIn,
  cardNumberIn,
  clinicOwnWords,
  cutCardNumbersAcrossTurns,
  guardAssistantReply,
  guardedLine,
  NEVER_SAY_PROTECTED,
  neverSayBlocksDisclosure,
  neverSayIn,
} from "@/lib/assistant/guard";
import { assistantTurnContext, buildAssistantPrompt, priceText } from "@/lib/assistant/prompt";
import { assistantModel, MODEL_CONFIG, modelRequest, readModelResponse } from "@/lib/assistant/responder";
import {
  answerTurn,
  EMPTY_CAPTURE,
  FAILURE_LINE,
  mergeCapture,
  messagesFor,
  parseModelAnswer,
  languageTerms,
  refusalLine,
  type AssistantResponder,
} from "@/lib/assistant/turn";
import { requestReceivedLine } from "@/lib/meta/booking-requests";
import { guardContextFor, guardReply } from "@/lib/meta/front-door";
import { URGENT_ALERT_DELIVERED } from "@/lib/notices/booking-alerts";
import { neverSayWithDefaults } from "@/lib/setup/knowledge";
import { spokenPhone } from "@/lib/voice/spoken";

/**
 * The brain calls and web chats share (lib/assistant): the urgent screen
 * before the model, the guard after it, card numbers cut, and the model's
 * answer read without trusting it. No database, no network.
 */

const WEEKDAYS = [["09:00", "17:00"]] as [string, string][];
const FACTS: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-000000000001",
  clinicName: "Radiance Med Spa",
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  vetReferralPhone: null,
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Monday: 09:00-17:00"],
  openingHours: { sun: [], mon: WEEKDAYS, tue: WEEKDAYS, wed: WEEKDAYS, thu: WEEKDAYS, fri: WEEKDAYS, sat: [] },
  services: [
    { name: "Botox", priceFromUsd: 12, priceToUsd: 12, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: 50 },
    { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, priceKind: "exact", unit: null, durationMinutes: 30, depositUsd: null },
    { name: "Lip filler", priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null, durationMinutes: 45, depositUsd: null },
  ],
  policies: ["24 hours' notice to cancel."],
  quickAnswers: [{ question: "Parking?", answer: "Free parking behind the building." }],
  promotions: null,
  notes: null,
  escalationHours: "Weekdays 9 to 5",
  neverSay: ["guaranteed results", "painless", "Dr. Smith is the best"],
  requirements: [],
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: ["Dr. Ngozi Okafor"],
};

/** A veterinary practice: its urgent set is an animal's, and its urgent line gives the emergency vet. */
const VET: AssistantFacts = {
  ...FACTS,
  clinicName: "Paws Animal Clinic",
  specialty: "veterinary",
  vetReferralPhone: "+14155550911",
  services: [{ name: "Senior diagnostics", priceFromUsd: 180, priceToUsd: 180, priceKind: "exact", unit: null, durationMinutes: 45, depositUsd: null }],
};

/** A Tuesday at 11:00 and a Sunday at 11:00 in New York. */
const OPEN = new Date("2026-10-13T15:00:00Z");
const CLOSED = new Date("2026-10-11T15:00:00Z");

const GLOW_LIKE: AssistantFacts = { ...FACTS, clinicName: "Glow Med Spa", neverSay: [] };

const reply = (text: string, extra: object = {}): AssistantResponder => async () => JSON.stringify({ reply: text, ...extra });

describe("the guard", () => {
  test("only configured prices and deposits may be named", () => {
    expect(guardAssistantReply("A consultation is $150.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("Botox is $12 a unit with a $50 deposit.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("Lip filler is $650.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(guardAssistantReply("About 600 dollars.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(guardAssistantReply("It's $1.5k.", FACTS)).toEqual({ ok: false, reason: "price" });
    expect(amountsIn("$1,200.50 and 99 dollars")).toEqual([120050, 9900]);
  });

  test("the never-say list, whatever the case, quotes or dashes", () => {
    expect(guardAssistantReply("You'll get Guaranteed   Results!", FACTS)).toEqual({ ok: false, reason: "never_say" });
    expect(guardAssistantReply("It's practically painless.", FACTS)).toEqual({ ok: false, reason: "never_say" });
    expect(guardAssistantReply("Dr. Smith is the best", FACTS)).toEqual({ ok: false, reason: "never_say" });
  });

  test("never asks for card details, never claims HIPAA compliance", () => {
    expect(guardAssistantReply("Could you read me your card number?", FACTS)).toEqual({ ok: false, reason: "payment_details" });
    expect(guardAssistantReply("We're fully HIPAA-compliant.", FACTS)).toEqual({ ok: false, reason: "hipaa_claim" });
    expect(guardAssistantReply("The practice takes payment at the visit.", FACTS)).toEqual({ ok: true });
  });

  test("a clinical reply is refused after the model, and becomes the offer of a consultation", () => {
    for (const text of [
      "It's completely fine and very safe during pregnancy.",
      "Most people have little downtime and the side effects are mild.",
      "You'd need about 20 units for your forehead.",
      "You sound like a good candidate for it.",
      "That's a common symptom, nothing to worry about.",
      "Stop taking blood thinners a week before.",
    ]) {
      expect(guardAssistantReply(text, FACTS), text).toEqual({ ok: false, reason: "clinical" });
    }
    expect(guardedLine("clinical", FACTS.clinicName)).toMatch(/consultation/);
    expect(guardedLine("clinical", FACTS.clinicName)).toContain(FACTS.clinicName);
  });

  test("the clinical screen is the default one: no everyday condition, a price by the unit, the clinic's own service names", () => {
    // The Meta channels count everyday skin conditions; a call and a web chat do not.
    expect(guardAssistantReply("Yes, the practice treats acne and rosacea. Would you like a consultation?", FACTS)).toEqual({ ok: true });
    // A price by the unit, however it is said, is a price and not a dose.
    expect(guardAssistantReply("Botox is $12 per unit.", FACTS)).toEqual({ ok: true });
    expect(guardAssistantReply("It's 12 dollars each unit.", FACTS)).toEqual({ ok: true });
    // A veterinary menu's own names were screened for its specialty when saved.
    expect(guardAssistantReply("Senior diagnostics is $180 and takes about 45 minutes.", VET)).toEqual({ ok: true });
    expect(guardAssistantReply("His symptoms sound like a diagnosis for the vet.", VET)).toEqual({ ok: false, reason: "clinical" });
  });

  // The review of 14 October, ported from its probe: ordinary answers pass...
  const GLOW = {
    ...FACTS,
    clinicName: "Glow Med Spa",
    address: "12 Main Street, Unit 4, Austin",
    neverSay: [],
    services: [
      { name: "Botox", priceFromUsd: 12, priceToUsd: 12, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: null },
      { name: "Lip Filler", priceFromUsd: 650, priceToUsd: 650, priceKind: "exact", unit: null, durationMinutes: 45, depositUsd: 100 },
      { name: "Laser Hair Removal", priceFromUsd: 150, priceToUsd: 400, priceKind: "range", unit: null, durationMinutes: 30, depositUsd: null },
      { name: "Acne Facial", priceFromUsd: 199, priceToUsd: 199, priceKind: "exact", unit: null, durationMinutes: 60, depositUsd: null },
    ],
  } as AssistantFacts;

  test.each([
    "We're open Monday to Friday, 9am to 5pm, and Saturday 10 to 2.",
    "Botox is $12 per unit.",
    "Botox is $12 a unit.",
    "Botox is 12 dollars a unit.",
    "Lip Filler is $650, with a $100 deposit.",
    "Laser Hair Removal is $150 to $400 depending on the area.",
    "Yes, we offer the Acne Facial for $199.",
    "We're at 12 Main Street, Unit 4, Austin.",
    "We're at 400 Oak Ave, Suite 2.",
    "Parking is free and safe behind the building.",
    "Please bring a list of any medications you take to your consultation.",
    "We have a 24-hour cancellation policy, and the deposit is non-refundable within 24 hours.",
    "I can pass on a request for Tuesday at 3pm. The team will confirm it within a day.",
    "Do you have any allergies we should note for the team?",
    "The team will be in touch within a day. Is there anything else?",
    "Sorry, I didn't catch that. Could you say it again?",
    "Lip Filler takes about 45 minutes.",
    "We're closed on Sundays.",
    "We open around 9 on Saturdays.",
    "It's about 10 minutes from downtown.",
    "El botox cuesta $12 por unidad.",
    "Abrimos de lunes a viernes de 9 a 5.",
  ])("an ordinary answer passes: %j", (text) => {
    expect(guardAssistantReply(text, GLOW)).toEqual({ ok: true });
  });

  // ...and clinical content in plain words, or in Spanish, is refused.
  test.each([
    "Botox is $12 a unit, and most foreheads need about 20.",
    "It's $12 a unit; a typical forehead is 10 to 20, so around 20 is common.",
    "Bruising is common and goes away in about a week.",
    "Some swelling and redness for a day or two is normal.",
    "If it's sore, ice it and take Tylenol, not ibuprofen.",
    "Avoid alcohol and don't lie down for 4 hours after Botox.",
    "Results last 3 to 4 months, and you'll see them in about two weeks.",
    "It's painless and most people go straight back to work.",
    "Lip Filler works really well for thin lips and lasts about a year.",
    "Botox is approved for frown lines and it's very effective.",
    "Arnica cream helps with bruising.",
    "You'll need 2 syringes for fuller lips.",
    "Most people need 6 sessions of Laser Hair Removal.",
    "Laser Hair Removal works best on dark hair and light skin.",
    "Botox is $12 a unit, 20U for the forehead.",
    "That's normal after filler and should settle on its own.",
    "Es seguro durante el embarazo y no tiene efectos secundarios.",
    "La dosis habitual es de 20 unidades.",
  ])("a clinical reply is refused: %j", (text) => {
    expect(guardAssistantReply(text, GLOW)).toEqual({ ok: false, reason: "clinical" });
  });

  // The third review of 14 October: plain-worded clinical content, all of it sent before.
  test.each([
    "A little puffiness after lip filler usually settles within a couple of days.",
    "Most clients are back to normal the next day.",
    "You can wear makeup again after 24 hours.",
    "Sleep on your back the first night after filler.",
    "Drink plenty of water and stay upright for four hours.",
    "Botox kicks in after 3 to 5 days and wears off around month four.",
    "It sounds like a mild bruise, which is fine.",
    "That sounds fine, no need to come in.",
    "Hold off on ibuprofen for a week before your appointment.",
    "Stop taking fish oil a week before filler.",
    "Don't exercise for 24 hours after Botox.",
    "Don't drink alcohol the night before.",
    "It won't hurt much, we use numbing cream.",
    "You'll look ten years younger.",
    "The redness should be gone by tomorrow.",
    "Wait two weeks before your next Botox touch-up.",
    "Lip Filler usually takes 1 syringe for most people.",
    "Most people need one syringe.",
    "You'd probably want 20 to 25 units for your forehead.",
    "Pregnant women shouldn't get Botox.",
    "Bruising is totally normal.",
    "Need about 20 for the forehead.",
    "Usually 20 to 30 units.",
    "Puede tomar Tylenol si le duele.",
    "La hinchazón es normal después del relleno.",
    "Es normal que se hinche un poco.",
    "Póngase hielo y no haga ejercicio.",
    "Los moretones desaparecen en una semana.",
    "Los resultados duran unos cuatro meses.",
  ])("third review: a clinical reply is refused: %j", (text) => {
    expect(guardAssistantReply(text, GLOW)).toEqual({ ok: false, reason: "clinical" });
  });

  // ...and the ordinary replies around them, including LOW 8's, pass.
  test.each([
    "We have about 3 openings left on Saturday.",
    "Our gift cards last 12 months from purchase.",
    "Have a safe drive!",
    "Drive safe!",
    "We'll see you at 3 — stay safe in the rain!",
    "We're at 88 Pine St, Unit 4B.",
    "We're on the 2nd floor, room 210.",
    "Parking is free and safe in the garage.",
    "Please bring a list of any medications you take.",
    "Is there anything else I can help with?",
    "The appointment takes about 45 minutes.",
    "The team usually replies within about 2 hours.",
    "Our opening hours are Monday to Friday, 9 to 5.",
    "I'll pass that to the team and they'll call you back today.",
    "Your appointment is at 2pm; please arrive 10 minutes early.",
    "The deposit is $100 and Lip Filler is $650.",
    "We have parking for about 20 cars.",
    "We close at about 6 on Fridays.",
    "Sí, tenemos citas el sábado a las 10.",
    "Claro, ¿le viene bien el martes a las 3?",
    "Merci for the message! We're open until 6.",
    "Your booking is confirmed for Mon 3pm.",
    "The consultation is free and lasts about 30 minutes.",
    "Bring your ID and arrive about 10 min early.",
    "You can park on level 2, it's free for 2 hours.",
    "Booking takes about 2 minutes online.",
    "Our team has about 15 years of experience.",
    "Room 4 is on your left.",
    "We serve about 200 clients a month.",
    "I'm sorry, I don't have that information, but the team will get back to you.",
    "Our new hours take effect next week.",
    "No need to come in early, five minutes before is plenty.",
    "It won't hurt to ask the team!",
  ])("third review: an ordinary reply passes: %j", (text) => {
    expect(guardAssistantReply(text, GLOW)).toEqual({ ok: true });
  });

  test("third review: a reply in a language no list knows is never sent", () => {
    expect(guardAssistantReply("Mwen pa ka ede w ak sa, rele klinik la.", GLOW)).toEqual({ ok: false, reason: "language" });
    expect(guardAssistantReply("Nie mogę pomóc, proszę zadzwonić do kliniki.", GLOW)).toEqual({ ok: false, reason: "language" });
  });

  test("a reply in a language the screens do not read is never sent", () => {
    expect(guardAssistantReply("C'est sans danger pendant la grossesse.", GLOW)).toEqual({ ok: false, reason: "language" });
    expect(guardAssistantReply("Não tem efeitos colaterais, pode fazer.", GLOW)).toEqual({ ok: false, reason: "language" });
  });

  test("the never-say list is English words matched as written, in a Spanish reply too: that is its limit", () => {
    const facts = { ...GLOW, neverSay: ["guaranteed results"] };
    expect(guardAssistantReply("Ofrecemos guaranteed results.", facts)).toEqual({ ok: false, reason: "never_say" });
    // The same promise in Spanish is the clinical screen's to catch.
    expect(guardAssistantReply("Resultados garantizados.", facts)).toEqual({ ok: false, reason: "clinical" });
  });

  test("the never-say matcher: case, curly quotes, dashes and line breaks normalised, an empty entry never matching", () => {
    const list = ["guaranteed results", "you're a good candidate", "risk-free", "cheapest in town", "  "];
    for (const reply of [
      "GUARANTEED Results, every time.",
      "You’re a good candidate.",
      "It’s risk–free.",
      "It's risk—free.",
      "We're the cheapest\nin   town.",
    ]) {
      expect(neverSayIn(reply, list), reply).toBe(true);
    }
    expect(neverSayIn("We open at 9.", list)).toBe(false);
    expect(neverSayIn("We open at 9.", [])).toBe(false);
    expect(neverSayIn("We open at 9.", ["", "   "])).toBe(false);
  });

  test("the never-say matcher reads a hyphen as a space, either way round", () => {
    expect(neverSayIn("We're the cheapest-in-town option.", ["cheapest in town"])).toBe(true);
    expect(neverSayIn("It's risk free.", ["risk-free"])).toBe(true);
    expect(neverSayIn("It's risk – free.", ["risk-free"])).toBe(true);
  });

  test("the never-say matcher matches where a word starts: not inside another word, still in a longer form of it", () => {
    // Inside a word is not the entry: the Meta prompt sends people to a
    // "secure" channel in nearly every reply.
    expect(neverSayIn("This channel isn't secure, so please call the practice.", ["cure"])).toBe(false);
    for (const reply of ["We're available weekdays.", "She said so.", "Email us again."]) {
      expect(neverSayIn(reply, ["AI"]), reply).toBe(false);
    }
    // A longer form of the entry, which the prompt's "in any form" means.
    expect(neverSayIn("It's done painlessly.", ["painless"])).toBe(true);
    expect(neverSayIn("Results are guaranteed.", ["guarantee"])).toBe(true);
    expect(neverSayIn("We're the cheapest around.", ["cheap"])).toBe(true);
    expect(neverSayIn("That would cure it.", ["cure"])).toBe(true);
  });

  test("the never-say matcher excuses an entry inside the clinic's own name and address, and nowhere else", () => {
    const own = clinicOwnWords({ clinicName: "Painless Laser Studio", address: "12 Painless Way, Suite 4\nSpringfield" });
    expect(own).toEqual(["Painless Laser Studio", "12 Painless Way", "Painless Way", "Suite 4", "Springfield"]);
    expect(neverSayIn("Painless Laser Studio is on Painless Way.", ["painless"], own)).toBe(false);
    expect(neverSayIn("Painless Laser Studio’s team can help.", ["painless"], own)).toBe(false);
    expect(neverSayIn("At Painless Laser Studio it's painless.", ["painless"], own)).toBe(true);
    // An occurrence outside the name is found however many sit inside it.
    expect(neverSayIn("Painless Laser Studio: painless, at Painless Way.", ["painless"], own)).toBe(true);
    expect(neverSayIn("Painless Laser Studio is on Painless Way.", ["painless"])).toBe(true);
    // An entry that runs past the name is not inside it, so the reply is never cut before the list is read.
    expect(neverSayIn("Painless Laser Studio is the best.", ["Laser Studio is the best"], own)).toBe(true);
    expect(clinicOwnWords({})).toEqual([]);
  });

  test("a never-say entry naming the clinic, its city or its street is refused on a call, a web chat and the Meta front door", () => {
    // The verifier's case of 19 October: deleting the clinic's own words
    // before matching let every one of these through on every channel.
    const clinicName = "Glow Med Spa";
    const address = "500 Congress Ave, Austin, TX 78701";
    const meta = (neverSay: string[]) =>
      guardContextFor({ clinicName, address, services: [], publishedTimes: [540, 1020], neverSay: neverSayWithDefaults(neverSay) });
    const call = (neverSay: string[]) => ({ ...FACTS, clinicName, address, neverSay: neverSayWithDefaults(neverSay) });
    const cases: Array<[string, string]> = [
      ["cheapest in Austin", "We're the cheapest in Austin."],
      ["best med spa in Austin", "We're the best med spa in Austin."],
      ["Glow Med Spa is the best", "Glow Med Spa is the best."],
      ["Congress Ave", "We're on Congress Ave."],
      ["Congress Ave", "We're at 500 Congress Ave."],
    ];
    for (const [entry, said] of cases) {
      expect(neverSayIn(said, [entry], clinicOwnWords({ clinicName, address })), entry).toBe(true);
      expect(guardAssistantReply(said, call([entry])), entry).toEqual({ ok: false, reason: "never_say" });
      expect(guardReply(`${said} Call the practice to book.`, meta([entry])), entry).toEqual({ ok: false, reason: "a never-say phrase" });
    }
    // A competitor named after the clinic's own town.
    const springfield = { clinicName: "Radiance Med Spa", address: "1 Main St, Springfield" };
    const rival = ["better than Springfield Skin"];
    expect(guardAssistantReply("We're better than Springfield Skin.", { ...FACTS, ...springfield, neverSay: rival })).toEqual({
      ok: false,
      reason: "never_say",
    });
    expect(
      guardReply(
        "We're better than Springfield Skin. Call the practice to book.",
        guardContextFor({ ...springfield, services: [], publishedTimes: [540, 1020], neverSay: rival }),
      ),
    ).toEqual({ ok: false, reason: "a never-say phrase" });
    // And with those entries on the list, the clinic still says who and where it is.
    const all = cases.map(([entry]) => entry).filter((e) => e !== "Congress Ave");
    expect(guardAssistantReply("Glow Med Spa is in Austin, with free parking.", call(all))).toEqual({ ok: true });
    expect(guardReply("Glow Med Spa is in Austin, with free parking. Call the practice to book.", meta(all))).toEqual({ ok: true });
  });

  test("no never-say entry may stop the assistant saying it is an AI assistant when asked, or pointing to 911", () => {
    for (const entry of ["automated assistant", "assistant", "AI assistant", "AI", "Automated", "not a person", "human", "911", "call 911", "I'm an AI"]) {
      expect(neverSayBlocksDisclosure(entry), entry).toBe(true);
    }
    for (const entry of ["cheapest in town", "best-kept secret", "virtual receptionist", "emergency appointments", "humane"]) {
      expect(neverSayBlocksDisclosure(entry), entry).toBe(false);
    }
    // None of the built-in defaults is one of them, so no clinic loses a default.
    expect(NEVER_SAY_DEFAULTS.filter(neverSayBlocksDisclosure)).toEqual([]);
    // And each protected sentence passes both channels' guards with the list read as a conversation reads it.
    const list = neverSayWithDefaults(["automated assistant", "AI", "911", "cheapest in town"]);
    expect(list).toEqual([...NEVER_SAY_DEFAULTS, "cheapest in town"]);
    for (const sentence of NEVER_SAY_PROTECTED) {
      expect(neverSayIn(sentence, list), sentence).toBe(false);
    }
  });

  test("one never-say matcher on every channel: a reply a call or a web chat refuses for the list, the Meta front door refuses too", () => {
    // CLAUDE.md, "Guardrails": the list goes into every conversation on
    // every channel, so the channels cannot disagree about what is on it.
    const list = ["cheapest in town", "best-kept secret"];
    const meta = guardContextFor({ clinicName: FACTS.clinicName, services: [], publishedTimes: [540, 1020], neverSay: list });
    for (const reply of ["We're the CHEAPEST in town.", "We're the best–kept secret: call the practice.", "We're the cheapest\nin town, call the practice."]) {
      expect(guardAssistantReply(reply, { ...FACTS, neverSay: list }), reply).toEqual({ ok: false, reason: "never_say" });
      expect(guardReply(reply, meta), reply).toEqual({ ok: false, reason: "a never-say phrase" });
    }
    // And what neither list holds, neither refuses for it.
    expect(guardAssistantReply("We're open weekdays 9 to 5.", { ...FACTS, neverSay: list })).toEqual({ ok: true });
    expect(guardReply("We're open weekdays 9 to 5; call the practice to book.", meta)).toEqual({ ok: true });

    // The same matcher's edges, on both: an entry inside another word is not
    // the entry, a hyphen is a space, and the clinic's own name is read past.
    const cure = guardContextFor({ clinicName: FACTS.clinicName, services: [], publishedTimes: [540, 1020], neverSay: ["cure"] });
    expect(guardAssistantReply("This chat is secure.", { ...FACTS, neverSay: ["cure"] })).toEqual({ ok: true });
    expect(guardReply("This channel isn't secure, so please call the practice.", cure)).toEqual({ ok: true });
    const hyphen = guardContextFor({ clinicName: FACTS.clinicName, services: [], publishedTimes: [540, 1020], neverSay: list });
    expect(guardAssistantReply("We're the cheapest-in-town option.", { ...FACTS, neverSay: list })).toEqual({ ok: false, reason: "never_say" });
    expect(guardReply("We're the cheapest-in-town option. Call the practice.", hyphen)).toEqual({ ok: false, reason: "a never-say phrase" });
    const painless = { clinicName: "Painless Laser Studio", address: "12 Main Street", neverSay: neverSayWithDefaults() };
    const painlessMeta = guardContextFor({ ...painless, services: [], publishedTimes: [540, 1020] });
    expect(guardAssistantReply("Painless Laser Studio is at 12 Main Street, with free parking.", { ...FACTS, ...painless })).toEqual({ ok: true });
    expect(guardReply("Painless Laser Studio is at 12 Main Street, with free parking. Call the practice for anything else.", painlessMeta)).toEqual({ ok: true });
    // The request-received line keeps the person's name.
    expect(guardReply(requestReceivedLine("Painless Laser Studio", "Maria"), painlessMeta)).toEqual({ ok: true });
    // The entry itself is still refused, on both.
    expect(guardAssistantReply("At Painless Laser Studio, it's painless.", { ...FACTS, ...painless })).toEqual({ ok: false, reason: "never_say" });
    expect(guardReply("Painless Laser Studio says it's painless; call the practice.", painlessMeta)).toEqual({ ok: false, reason: "a never-say phrase" });
  });

  test("a card number is cut; a phone number is not", () => {
    expect(cardNumberIn("card 4242-4242-4242-4242 thanks")).toEqual({ text: "card [card number removed] thanks", found: true });
    expect(cardNumberIn("call me on 415 555 0192")).toEqual({ text: "call me on 415 555 0192", found: false });
  });

  test("a card number is cut however the recogniser or the person punctuates it", () => {
    for (const [said, left] of [
      // Retell's recogniser puts commas and full stops between the groups a caller reads.
      ["Yeah it's 4242, 4242, 4242, 4242.", "Yeah it's [card number removed]."],
      ["4242. 4242. 4242. 4242.", "[card number removed]."],
      ["it's 4242  4242  4242  4242 ok", "it's [card number removed] ok"],
      ["4,242 4,242 4,242 4,242", "[card number removed]"],
      ["5555 5555 5555 4444", "[card number removed]"],
      // Amex, as printed: 4-6-5.
      ["amex 3782 822463 10005", "amex [card number removed]"],
      ["6011111111111117 please", "[card number removed] please"],
    ] as const) {
      expect(cardNumberIn(said), said).toEqual({ text: left, found: true });
    }
  });

  test("a card number followed by its expiry or security code is cut, and they go with it", () => {
    for (const said of [
      "4242 4242 4242 4242 123",
      "4242 4242 4242 4242 12/28",
      "4242 4242 4242 4242 12 28",
      "4242 4242 4242 4242, 12/28, 123",
      "4111111111111111 123",
      "4111 1111 1111 1111 1 2 3",
      "41111111111111111228123",
    ]) {
      expect(cardNumberIn(`card ${said} thanks`), said).toEqual({ text: "card [card number removed] thanks", found: true });
    }
    // Said straight after a phone number, the number alone goes.
    expect(cardNumberIn("Call 415 555 0192 4242 4242 4242 4242")).toEqual({ text: "Call 415 555 0192 [card number removed]", found: true });
  });

  test("phone numbers, dates, prices and times are never cut, alone or side by side", () => {
    for (const said of [
      "call me on 415 555 0192",
      "+1 (415) 555-0192",
      "1 415 555 0192",
      "415.555.0192",
      // Each of the next two holds a stretch of digits that passes the Luhn
      // check with an issuer's first digit: only the shapes keep them whole.
      "my cell is 415-555-0100, 415-555-0106 is the house",
      "Jo Smith, 415-555-0100, 03-14-1957, Thursday 10:30",
      "My number is 415 555 0192, 12/03/2026 at 10:30 please",
      "born 03/14/1990, phone 415-555-0192",
      // 415555019294117 passes the Luhn check whole; the comma and the
      // phone number's shape keep it a number and a ZIP code.
      "My number is 415-555-0192, 94117",
      "415 555 0192. 94117 is my zip",
      "2026-12-03 or 12.03.2026",
      "It's $1,250.00, or 1,250.50 dollars, or $12,500",
      "at 2.30pm, or 10 30 tomorrow, or 10:30",
      "Is the $450 package 3 sessions of 60 minutes?",
    ]) {
      expect(cardNumberIn(said), said).toEqual({ text: said, found: false });
    }
  });

  test("a card number read out across turns is cut from each turn that holds part of it, past the assistant's turns between", () => {
    expect(
      cutCardNumbersAcrossTurns([
        { speaker: "assistant", text: "How can I help?" },
        { speaker: "person", text: "My card is 4242 4242." },
        { speaker: "assistant", text: "Please don't read me card numbers." },
        { speaker: "person", text: "4242 4242, expiry 12/28" },
      ]),
    ).toEqual([
      { speaker: "assistant", text: "How can I help?" },
      { speaker: "person", text: "My card is [card number removed]." },
      { speaker: "assistant", text: "Please don't read me card numbers." },
      { speaker: "person", text: "[card number removed], expiry 12/28" },
    ]);
    // A group a turn, and a number whole in one turn, all go.
    expect(
      cutCardNumbersAcrossTurns([
        { speaker: "person", text: "4242" },
        { speaker: "assistant", text: "Mm-hm." },
        { speaker: "person", text: " 4242 4242 " },
        { speaker: "assistant", text: "Mm-hm." },
        { speaker: "person", text: "4242 and my other card is 5555 5555 5555 4444" },
      ]).map((t) => t.text),
    ).toEqual(["[card number removed]", "Mm-hm.", " [card number removed] ", "Mm-hm.", "[card number removed] and my other card is [card number removed]"]);
    // A phone number ending one turn and a date or another number starting
    // the next are not a card, though "555 0100 03 14 1957" passes the Luhn check.
    const kept = [
      { speaker: "person" as const, text: "My number is 415 555 0100" },
      { speaker: "assistant" as const, text: "And your date of birth?" },
      { speaker: "person" as const, text: "03 14 1957" },
      { speaker: "assistant" as const, text: "And a second number?" },
      { speaker: "person" as const, text: "415 555 0193" },
    ];
    expect(cutCardNumbersAcrossTurns(kept)).toEqual(kept);
  });
});

describe("the prompt", () => {
  test("states the menu's prices as written and the never-say list, and nothing to edit", () => {
    const prompt = buildAssistantPrompt(FACTS, "web_chat");
    expect(prompt).toContain("Botox: $12 per unit");
    expect(prompt).toContain("Lip filler: no price is quoted: offer a consultation");
    expect(prompt).toContain("- painless");
    expect(prompt).toContain("you do not book appointments yourself");
    expect(prompt).toContain("(415) 555-0199");
    expect(buildAssistantPrompt(FACTS, "voice").toLowerCase()).toContain("this is a phone call");
    expect(priceText({ name: "x", priceFromUsd: 100, priceToUsd: null, priceKind: "from", unit: null, durationMinutes: null, depositUsd: null })).toBe("from $100");
  });

  test("the stable prefix carries no clock: the same bytes at any minute, so the prompt cache can hold it", () => {
    const morning = buildAssistantPrompt(FACTS, "web_chat");
    expect(buildAssistantPrompt(FACTS, "web_chat")).toBe(morning);
    expect(morning).not.toMatch(/Now it is/);
    expect(morning).not.toMatch(/October|Tuesday|\d{1,2}:\d{2} (AM|PM)/);
    // The time, and how the conversation opened, come after it, per turn.
    const turn = assistantTurnContext(FACTS, OPEN, "Hi, I'm an AI assistant.");
    expect(turn).toBe(`Now it is Tuesday, October 13 at 11:00 AM in the practice's time zone.\nYou opened the conversation with: "Hi, I'm an AI assistant."`);
    expect(assistantTurnContext(FACTS, CLOSED)).not.toBe(assistantTurnContext(FACTS, OPEN));
  });

  test("the clinic's tone changes how it speaks", () => {
    expect(buildAssistantPrompt(FACTS, "voice")).toMatch(/Be warm, welcoming and unhurried/);
    const clinical = buildAssistantPrompt({ ...FACTS, tone: "clinical" }, "voice");
    expect(clinical).toMatch(/Be calm, brief and precise/);
    expect(clinical).not.toMatch(/Be warm/);
  });

  test("its languages: the caller's, if it is one of them, and it stays in it", () => {
    expect(buildAssistantPrompt(FACTS, "web_chat")).toMatch(/Language: answer in English\./);
    const several = buildAssistantPrompt({ ...FACTS, languages: ["en", "es"] }, "web_chat");
    expect(several).toContain("Languages: you answer in English and Spanish.");
    expect(several).toMatch(/stay in it/);
    // The never-say list is the clinic's English words, matched as written: the prompt claims nothing more.
    expect(several).not.toMatch(/every language/i);
  });

  test("Suggest add-on treatments: off keeps it to what was asked, on allows one", () => {
    expect(buildAssistantPrompt(FACTS, "voice")).toMatch(/Do not suggest other services or products/);
    const on = buildAssistantPrompt({ ...FACTS, suggestAddOns: true }, "voice");
    expect(on).toMatch(/you may suggest one complementary service/);
    expect(on).not.toMatch(/Do not suggest other services/);
  });

  test("Mention promotions: the box is said only while it is on (facts.ts leaves it out when off)", () => {
    const on = buildAssistantPrompt({ ...FACTS, promotions: "20% off peels in October" }, "web_chat");
    expect(on).toContain("Current offer you may mention: 20% off peels in October");
    const off = buildAssistantPrompt({ ...FACTS, promotions: null }, "web_chat");
    expect(off).not.toContain("20% off");
    expect(off).toMatch(/Do not mention discounts, deals or promotions/);
  });
});

describe("the model request", () => {
  const system = { stable: buildAssistantPrompt(FACTS, "web_chat"), turn: assistantTurnContext(FACTS, OPEN) };

  test("the cache breakpoint sits on the stable prefix, and the turn's own context follows it uncached", () => {
    const request = modelRequest({ channel: "web_chat", system, messages: [{ role: "user", content: "hi" }] });
    expect(request.system).toEqual([
      { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: system.turn },
    ]);
    // An empty turn context adds no block of its own.
    expect(modelRequest({ channel: "meta", system: { stable: "x", turn: "" }, messages: [] }).system).toEqual([
      { type: "text", text: "x", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("each channel keeps its own settings, on one client", () => {
    const at = (channel: "web_chat" | "voice" | "meta") => modelRequest({ channel, system, messages: [{ role: "user", content: "x".repeat(5_000) }] });
    expect(at("web_chat")).toMatchObject({ model: "claude-opus-5-5", max_tokens: 800, output_config: { effort: "low" } });
    expect(at("web_chat")).not.toHaveProperty("thinking");
    expect(at("voice")).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 400, output_config: { effort: "low" } });
    // The Meta front door moved onto this client from its own, on claude-opus-5.
    expect(at("meta")).toMatchObject({ model: "claude-opus-5-5", max_tokens: 800, thinking: { type: "adaptive" }, output_config: { effort: "low" } });
    expect(at("meta").messages[0]!.content).toHaveLength(2_000);
    expect(at("voice").messages[0]!.content).toHaveLength(4_000);
    expect(MODEL_CONFIG.voice).toMatchObject({ timeoutMs: 8_000, maxRetries: 0 });
    expect(MODEL_CONFIG.web_chat).toMatchObject({ timeoutMs: 30_000, maxRetries: 1 });
  });

  test("a refusal is read as its own outcome, never as empty text", () => {
    const base = { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_sequence: null, usage: {} } as const;
    const refused = readModelResponse("web_chat", { ...base, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: null } } as never);
    expect(refused).toEqual({ refused: true, category: "bio" });
    const answered = readModelResponse("web_chat", { ...base, content: [{ type: "text", text: " Hello ", citations: null }], stop_reason: "end_turn", stop_details: null } as never);
    expect(answered).toBe("Hello");
  });

  /**
   * The terms, BAA 1.6.0 and the DPA state Anthropic's retention for the
   * models in PATIENT_MODEL_IDS only (packages/catalog model-retention.ts).
   * A Covered Model keeps content at least 30 days, so an override naming one
   * must not move a patient channel onto it unnoticed.
   */
  describe("the models it may run on", () => {
    const withEnv = (name: string, value: string | undefined, run: () => void) => {
      const before = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      try {
        run();
      } finally {
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
      }
    };

    test("every channel's default is a patient model", () => {
      for (const [channel, config] of Object.entries(MODEL_CONFIG)) {
        expect(PATIENT_MODEL_IDS, channel).toContain(config.model);
      }
    });

    test("an override that names a patient model is used", () => {
      withEnv("HEALDESK_VOICE_MODEL", " claude-opus-5-5 ", () => {
        expect(assistantModel("voice")).toBe("claude-opus-5-5");
        expect(modelRequest({ channel: "voice", system, messages: [] }).model).toBe("claude-opus-5-5");
      });
      withEnv("HEALDESK_CHAT_MODEL", "claude-sonnet-5-5", () => {
        expect(assistantModel("web_chat")).toBe("claude-sonnet-5-5");
      });
    });

    test("an override outside the list, a Covered Model above all, falls back to the default and is warned about once, without the conversation", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        withEnv("HEALDESK_VOICE_MODEL", "claude-fable-5", () => {
          const request = modelRequest({
            channel: "voice",
            system,
            messages: [{ role: "user", content: "My name is Jane and I had filler on Monday" }],
          });
          expect(request.model).toBe("claude-sonnet-5-5");
          expect(assistantModel("voice")).toBe("claude-sonnet-5-5");
        });
        withEnv("HEALDESK_CHAT_MODEL", "claude-mythos-5-1", () => {
          expect(assistantModel("web_chat")).toBe("claude-opus-5-5");
        });
        const lines = warn.mock.calls.map((call) => String(call[0]));
        expect(lines.filter((line) => line.includes("HEALDESK_VOICE_MODEL"))).toHaveLength(1);
        expect(lines.filter((line) => line.includes("HEALDESK_CHAT_MODEL"))).toHaveLength(1);
        for (const line of lines) {
          expect(line).toContain("outside PATIENT_MODEL_IDS");
          expect(line).not.toMatch(/Jane|filler/);
        }
      } finally {
        warn.mockRestore();
      }
    });

    test("an empty override is no override", () => {
      withEnv("HEALDESK_CHAT_MODEL", "  ", () => {
        expect(assistantModel("web_chat")).toBe("claude-opus-5-5");
      });
      // The Meta front door reads no variable at all.
      expect(MODEL_CONFIG.meta.modelEnv).toBeNull();
    });
  });
});

describe("answerTurn", () => {
  test("urgent content gets 911 and the urgent number, and the model is never asked", async () => {
    let asked = false;
    const result = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [],
      text: "I think I'm having an allergic reaction to the filler",
      responder: async () => {
        asked = true;
        return "{}";
      },
    });
    expect(asked).toBe(false);
    expect(result).toMatchObject({ source: "urgent", urgent: true });
    expect(result.reply).toMatch(/^I'm an AI assistant/);
    expect(result.reply).toMatch(/hang up and call 911 now/);
    expect(result.reply).toContain("four one five"); // spoken digits on a call
    expect(result.reply).not.toContain(URGENT_LEAVE_NUMBER_LINE);
  });

  test("on the website chat the urgent line gives the number written out and asks for one to call back", async () => {
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "my lips are swelling", responder: null });
    expect(result.reply).toContain("If this is an emergency, call 911 now.");
    expect(result.reply).toContain("Otherwise, please call Radiance Med Spa on (415) 555-0123.");
    expect(result.reply).toContain(URGENT_LEAVE_NUMBER_LINE);
  });

  test("the urgent line says the team was told, now that the urgent alert reaches it", async () => {
    // Package F sends L12 through the outbox, in-process after commit, from
    // voice, web chat and Meta (tests/live-alerts.test.ts).
    expect(URGENT_ALERT_DELIVERED).toBe(true);
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "it won't stop bleeding", responder: null });
    expect(result.reply).toContain(URGENT_TEAM_TOLD_LINE);
  });

  test("a veterinary practice: an animal's emergency gets the emergency vet, never 911, and its own number only while open", async () => {
    let asked = false;
    const responder: AssistantResponder = async () => {
      asked = true;
      return "{}";
    };
    const open = await answerTurn({ facts: VET, channel: "web_chat", history: [], text: "my cat can't pee and keeps straining", responder, now: OPEN });
    expect(asked).toBe(false);
    expect(open).toMatchObject({ source: "urgent", urgent: true });
    expect(open.reply).toContain("call the emergency vet now on (415) 555-0911");
    expect(open.reply).toContain("Otherwise, please call Paws Animal Clinic on (415) 555-0123.");
    // 911 only for a person, after the emergency vet.
    expect(open.reply).toContain("If a person is hurt or in danger, call 911 now.");
    expect(open.reply.indexOf("emergency vet")).toBeLessThan(open.reply.indexOf("911"));
    const closed = await answerTurn({ facts: VET, channel: "voice", history: [], text: "my dog ate a whole bar of chocolate", responder, now: CLOSED });
    expect(closed.reply).toMatch(/hang up and call the emergency vet on/);
    expect(closed.reply).not.toContain("Otherwise, please call");
    // The same words at a med spa are not urgent: the set is the practice's own.
    const medSpa = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "my cat can't pee and keeps straining", responder: reply("Please call the practice."), now: OPEN });
    expect(medSpa.source).toBe("model");
  });

  test("a person's own emergency at a veterinary practice leads with 911, and the emergency vet is still given", async () => {
    // The reviews of 14 October: first 911 was lost, then the emergency vet.
    const voice = await answerTurn({ facts: VET, channel: "voice", history: [], text: "I swallowed a bottle of pills", responder: null, now: OPEN });
    expect(voice).toMatchObject({ source: "urgent", urgent: true });
    expect(voice.reply).toContain("hang up and call 911 now");
    expect(voice.reply.indexOf("911")).toBeLessThan(voice.reply.indexOf("emergency vet"));
    const chat = await answerTurn({ facts: VET, channel: "web_chat", history: [], text: "call 911, my husband collapsed", responder: null, now: OPEN });
    expect(chat.reply).toContain("If this is an emergency, call 911 now.");
    expect(chat.reply).toContain("If an animal needs emergency care, call the emergency vet on (415) 555-0911.");
    for (const text of ["she wants to die", "I took an overdose", "he stopped breathing", "someone collapsed in the waiting room"]) {
      const person = await answerTurn({ facts: VET, channel: "voice", history: [], text, responder: null, now: OPEN });
      expect(person.reply, text).toContain("hang up and call 911 now");
      expect(person.reply, text).toContain("emergency vet");
    }
    // Closed: the practice's own number is left out in the 911 branch too.
    const closed = await answerTurn({ facts: VET, channel: "web_chat", history: [], text: "he's not breathing", responder: null, now: CLOSED });
    expect(closed.reply).toContain("(415) 555-0911");
    expect(closed.reply).not.toContain("(415) 555-0123");
  });

  test("an animal's emergency read through an owner's words keeps the emergency vet in the lead", async () => {
    for (const text of ["my daughter's dog was hit by a car", "my heart is pounding, my dog just collapsed", "Bella swallowed a bottle of pills"]) {
      const result = await answerTurn({ facts: VET, channel: "web_chat", history: [], text, responder: null, now: OPEN });
      expect(result.reply.indexOf("emergency vet"), text).toBeLessThan(result.reply.indexOf("911"));
    }
  });

  test("a Spanish urgent message gets the Spanish reply, and never the model", async () => {
    let asked = false;
    const result = await answerTurn({
      facts: { ...FACTS, languages: ["en", "es"] },
      channel: "web_chat",
      history: [],
      text: "No puedo respirar",
      responder: async () => {
        asked = true;
        return "{}";
      },
    });
    expect(asked).toBe(false);
    expect(result).toMatchObject({ source: "urgent", urgent: true });
    expect(result.reply).toBe(
      "Soy un asistente de IA, así que no puedo ayudar con nada urgente aquí. Si es una emergencia, llame al 911 ahora. Si no, llame a Radiance Med Spa al (415) 555-0123. Ya avisé al equipo. Deje un número para que la clínica le llame.",
    );
  });

  test("a message in another language never reaches the model: a fixed line in English and Spanish, with 911", async () => {
    // The review of 14 October: these skipped the urgent screen.
    for (const text of ["Je n'arrive pas à respirer", "Não consigo respirar", "我不能呼吸"]) {
      let asked = false;
      const result = await answerTurn({
        facts: FACTS,
        channel: "web_chat",
        history: [],
        text,
        responder: async () => {
          asked = true;
          return "{}";
        },
      });
      expect(asked, text).toBe(false);
      expect(result.source, text).toBe("language");
      expect(result.reply).toContain("I can only help in English or Spanish.");
      expect(result.reply).toContain("If this is an emergency, call 911 now.");
      expect(result.reply).toContain("Si es una emergencia, llame al 911 ahora.");
      expect(result.reply).toContain("(415) 555-0123");
    }
  });

  test("the practice's own words are no language: its providers and its services reach the model", async () => {
    const facts = {
      ...FACTS,
      services: [...FACTS.services, { name: "Zelora Glow Facial", priceFromUsd: 180, priceToUsd: 180, priceKind: "exact" as const, unit: null, durationMinutes: 60, depositUsd: null }],
      address: "75-5660 Palani Rd, Kailua-Kona, HI",
    };
    for (const text of ["ngozi okafor?", "zelora glow?", "kailua kona?"]) {
      let asked = false;
      const result = await answerTurn({
        facts,
        channel: "web_chat",
        history: [],
        text,
        responder: async () => {
          asked = true;
          return JSON.stringify({ reply: "Happy to help with that." });
        },
      });
      expect(asked, text).toBe(true);
      expect(result.source, text).toBe("model");
    }
    // Without the practice's terms the same words would be turned away.
    expect(languageTerms(FACTS)).toContain("Dr. Ngozi Okafor");
  });

  test("the reply guard reads the practice's own words as no language too", () => {
    const facts = { ...GLOW_LIKE, services: [{ name: "Zelora Glow Facial", priceFromUsd: 180, priceToUsd: 180, priceKind: "exact" as const, unit: null, durationMinutes: 60, depositUsd: null }], providerNames: ["Ngozi Okafor"] };
    expect(guardAssistantReply("Ngozi Okafor does the Zelora Glow Facial.", facts)).toEqual({ ok: true });
  });

  test("on a call, the urgent and refusal lines never give the published number, which forwards back to us", async () => {
    // Urgent-help number set to the main line: the direct line instead.
    const forwarded = { ...FACTS, urgentPhone: FACTS.phone, directLine: "+14155550177" };
    const urgent = await answerTurn({ facts: forwarded, channel: "voice", history: [], text: "my lips are swelling", responder: null });
    expect(urgent.reply).toContain(spokenPhone("+14155550177"));
    expect(urgent.reply).not.toContain(spokenPhone("+14155550199"));
    // Neither apart from the main line: no number at all.
    const none = { ...FACTS, urgentPhone: FACTS.phone, directLine: null };
    const noNumber = await answerTurn({ facts: none, channel: "voice", history: [], text: "my lips are swelling", responder: null });
    expect(noNumber.reply).not.toContain(spokenPhone("+14155550199"));
    expect(noNumber.reply).toContain("Otherwise, please call Radiance Med Spa.");
    expect(refusalLine(none, "voice")).not.toContain(spokenPhone("+14155550199"));
    expect(refusalLine(none, "voice")).toContain("they get back to people within a day");
    // In writing, the published number is the one to call.
    expect(refusalLine(none, "web_chat")).toContain("(415) 555-0199");
  });

  test("a model that declines is its own outcome: a fixed, honest line and the clinic's number, never the guard's", async () => {
    const refusing: AssistantResponder = async () => ({ refused: true, category: "bio" });
    const chat = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "hi", responder: refusing });
    expect(chat).toMatchObject({ source: "refusal", urgent: false, handoff: false });
    expect(chat.guard).toBeUndefined();
    expect(chat.reply).toBe(refusalLine(FACTS, "web_chat"));
    expect(chat.reply).toBe("Sorry, that's not something I can help with. The team at Radiance Med Spa can: please call them on (415) 555-0199.");
    expect(chat.reply).not.toBe(FAILURE_LINE);
    expect(refusalLine({ ...FACTS, phone: null, urgentPhone: null }, "web_chat")).toBe(
      "Sorry, that's not something I can help with. The team at Radiance Med Spa can help, and they get back to people within a day.",
    );
    // On a call, which came in on the main number, the number that reaches a person.
    const call = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "hi", responder: refusing });
    expect(call.source).toBe("refusal");
    expect(call.reply).toContain(spokenPhone("+14155550123"));
    expect(call.reply).not.toContain(spokenPhone("+14155550199"));
  });

  test("a clinical reply from the model is replaced by the consultation offer", async () => {
    const result = await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "Is filler OK while pregnant?", responder: reply("Yes, it's safe during pregnancy.") });
    expect(result).toMatchObject({ source: "guard", guard: "clinical" });
    expect(result.reply).toBe(guardedLine("clinical", FACTS.clinicName));
  });

  test("the model is sent the stable prefix and the turn's own context apart", async () => {
    const seen: Parameters<AssistantResponder>[0][] = [];
    await answerTurn({
      facts: FACTS,
      channel: "web_chat",
      history: [{ speaker: "assistant", text: "Hi, I'm an AI assistant." }],
      text: "When are you open?",
      responder: async (request) => {
        seen.push(request);
        return JSON.stringify({ reply: "Weekdays 9 to 5." });
      },
      now: OPEN,
    });
    expect(seen[0]!.system.stable).toBe(buildAssistantPrompt(FACTS, "web_chat"));
    expect(seen[0]!.system.turn).toBe(assistantTurnContext(FACTS, OPEN, "Hi, I'm an AI assistant."));
  });

  test("a refused reply becomes a fixed line, and the capture still counts", async () => {
    const result = await answerTurn({
      facts: FACTS,
      channel: "web_chat",
      history: [],
      text: "How much is filler?",
      responder: reply("It's $650 and guaranteed results.", { booking: { wants: true, first_name: "Dana" } }),
    });
    expect(result.source).toBe("guard");
    expect(result.reply).not.toContain("$650");
    expect(result.capture.firstName).toBe("Dana");
  });

  test("no model, or a model that throws, gives the failure line", async () => {
    expect((await answerTurn({ facts: FACTS, channel: "web_chat", history: [], text: "hi", responder: null })).reply).toBe(FAILURE_LINE);
    const throwing: AssistantResponder = async () => {
      throw new Error("timeout");
    };
    expect((await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "hi", responder: throwing })).source).toBe("fallback");
  });

  test("the model's answer is read leniently and cleaned", () => {
    expect(parseModelAnswer('Sure! {"reply": "Hi\\u0007 there", "end": true}')).toMatchObject({ reply: "Hi there", end: true });
    expect(parseModelAnswer("just text")).toMatchObject({ reply: "just text", handoff: false });
    const answer = parseModelAnswer(JSON.stringify({ reply: "ok", booking: { wants: true, fields: { last_name: "Okonkwo", "bad key!": "x" } } }));
    expect(answer.booking.fields).toEqual({ last_name: "Okonkwo" });
  });

  test("captures merge, and an empty value never erases one", () => {
    const first = mergeCapture(EMPTY_CAPTURE, { wants: true, firstName: "Dana", window: "Thursday" });
    const second = mergeCapture(first, { firstName: null, phone: "415 555 0192" });
    expect(second).toMatchObject({ wants: true, firstName: "Dana", window: "Thursday", phone: "415 555 0192" });
  });

  test("the model sees alternating turns, starting with the person", () => {
    const messages = messagesFor(
      [
        { speaker: "assistant", text: "Hi, I'm an AI assistant." },
        { speaker: "person", text: "a" },
        { speaker: "person", text: "b" },
        { speaker: "assistant", text: "c" },
      ],
      "d",
    );
    expect(messages).toEqual([
      { role: "user", content: "a\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
  });
});

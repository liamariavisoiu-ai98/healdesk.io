import { describe, expect, test } from "vitest";

import { leansSpanish, messageLanguage } from "./message-language";

/**
 * The closed language check (./message-language.ts): English and Spanish
 * pass, another language is turned away before the model, and when it is not
 * sure it says English, so no English or Spanish message is ever turned away.
 */

describe("messageLanguage", () => {
  // The review of 14 October: these skipped the urgent screen and reached the model.
  test.each([
    "Je n'arrive pas à respirer",
    "Não consigo respirar",
    "Bonjour, je voudrais un rendez-vous pour mardi",
    "Olá, quanto custa o botox?",
    "Ich kann nicht atmen, bitte helfen Sie mir",
    "Ciao, vorrei un appuntamento per domani",
    "Hallo, ik wil een afspraak maken",
    "Magkano po ang botox? Salamat",
    "Tôi không thở được",
    "我不能呼吸",
    "Я не могу дышать",
    "숨을 쉴 수 없어요",
    "لا أستطيع التنفس",
  ])("%j is another language", (text) => {
    expect(messageLanguage(text)).toBe("other");
  });

  test.each([
    "¿Cuánto cuesta el botox?",
    "Hola, quisiera una cita para el martes",
    "Tengo una pregunta sobre los precios",
    "Buenas tardes, ¿está abierto el sábado?",
  ])("%j is Spanish", (text) => {
    expect(messageLanguage(text)).toBe("es");
  });

  // English, including the English a front desk gets that borrows a word or a name.
  test.each([
    "What are your opening hours?",
    "Hi, do you have availability on Saturday?",
    "Can you call me back? I'm free after 4",
    "My name is Nguyễn Thị Hương and I'd like to book",
    "My name is 王伟, can I book a facial?",
    "Is the clinic open Mon?",
    "Do you speak Hindi?",
    "Can I send it to a PO box?",
    "I'd like to book a rendez-vous with Dr Chen",
    "hi",
    "yes",
    "415-555-0134",
    "Thursday at 2",
    "",
  ])("%j is not turned away", (text) => {
    expect(messageLanguage(text)).not.toBe("other");
  });

  test("short Spanish urgent messages lean Spanish, so their fixed reply is Spanish", () => {
    expect(leansSpanish("Quiero suicidarme")).toBe(true);
    expect(leansSpanish("Me desmayé después de la cita")).toBe(true);
    expect(leansSpanish("I want to kill myself")).toBe(false);
    expect(leansSpanish("Can you help me?")).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The third review of 14 October: the check is closed.
// -----------------------------------------------------------------------------

describe("messageLanguage is closed: English or Spanish only on positive evidence", () => {
  // MEDIUM 4: each of these returned English, so the urgent screen was blind and the model answered.
  test.each([
    "Mwen pa ka respire",
    "Pitit mwen an pa ka respire, tanpri ede m",
    "Mwen bezwen yon randevou demen",
    "Nie mogę oddychać",
    "Non riesco a respirare",
    "Ya ne mogu dyshat",
    "ana mish ader atnafas",
    "mesh 2ader atnafes, sa3dooni",
    "Ana ayez maw3ed bokra",
    "Wo bu neng huxi",
    "toi khong tho duoc",
    "Ndapota ndibatsireiwo",
    "Hindi ako makahinga",
    "Hilfe! Mein Hund atmet nicht",
    "Mon chien ne respire plus",
    "Meu cachorro não está respirando",
  ])("%j is another language", (text) => {
    expect(messageLanguage(text)).toBe("other");
  });

  // MEDIUM 6: days and times, US places and postal forms, greetings and
  // thanks, and a name inside an English frame are neutral: they pass.
  test.each([
    "Mon 3pm?",
    "Mon 10am works",
    "Mon-Fri hours?",
    "Sa 10am?",
    "9am EST",
    "6pm est?",
    "Boston MA",
    "PO box?",
    "merci",
    "Merci beaucoup",
    "Ok merci, à demain",
    "Bonjour",
    "Obrigado",
    "Ciao!",
    "Danke",
    "Oi",
    "Chez Nous Aesthetics hours?",
    "Is Chez Nous Aesthetics open today?",
    "Belle et Beauté Med Spa hours?",
    "Sono Bello prices",
    "my name is Мария",
    "I'm Kim 김민지",
    "Do you do 双眼皮 surgery?",
    "Hi this is Jean-Pierre Dubois",
    "Merci! Can I book a facial tomorrow?",
    "Mi amor said you do lip filler",
    "Can I see Dr. Thị Ngọc Ánh?",
    "Book me with Nguyễn Thị Hằng please",
    "La Jolla location?",
    "Do Mo 2pm",
  ])("%j is not turned away", (text) => {
    expect(messageLanguage(text)).not.toBe("other");
  });

  test.each([
    "Hola, quisiera una cita para mañana",
    "Cuánto cuesta el botox?",
    "Tu tienes cita el sábado?",
    "Je veux una cita",
  ])("%j is Spanish", (text) => {
    expect(messageLanguage(text)).toBe("es");
  });

  // The precision side: the ordinary English a front desk gets, none turned away.
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
    "Do you have a cancellation policy?",
    "I have a question about prices",
    "Can I get a consultation first?",
    "How do I get to your office?",
    "Are there any complications?",
    "Do I need to swallow anything before the procedure?",
    "That's a hard pill to swallow",
    "My lips are swelling after yesterday's treatment, what should I do?",
    "my face is swollen",
    "I can’t breathe properly since the injection",
    "cant breathe",
    "my throat feels tight",
    "chest pain since this morning",
    "it's bleeding and won't stop",
    "there's pus coming out",
    "blisters after the laser",
    "the skin around the filler has turned white",
    "the area looks mottled",
    "blurry vision since this morning",
    "feeling dizzy and lightheaded",
    "the stitches came out",
    "my wound has opened",
    "I knocked out my front tooth",
    "Bad reaction to the filler, what do I do??",
    "my skin is reacting badly to the peel",
    "trouble swallowing since my botox",
    "it hurts to swallow",
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
    "My dog hates car rides, any tips?",
    "Is there parking for my car?",
    "My dog's breath smells, do you do dental cleaning?",
    "We're expecting a litter in the spring",
    "My cat had kittens last month, when can she be spayed?",
    "my dog ate a whole bar of chocolate",
    "he got into my ibuprofen",
    "I think the cat licked antifreeze in the garage",
    "my lab's stomach is swollen and hard",
    "he keeps retching but nothing comes up",
    "her gums look blue",
    "my male cat keeps straining in the litter box",
    "he's overheating after the walk",
    "his eye is bulging out of its socket",
    "she's been in labour for three hours and nothing",
    "there's a puppy stuck",
    "he's yelping in pain when I touch him",
    "Hi! Do you have anything open next Wednesday afternoon for a HydraFacial?",
    "Thx, see you then",
    "Gotta reschedule, something came up at work",
    "Is microneedling good for acne scars?",
    "What's the difference between Dysport and Botox?",
    "Do y'all take walk-ins?",
    "Can my husband come with me to the consult?",
    "I'm running late, stuck in traffic",
    "Can I pay with Venmo or Zelle?",
    "Do you offer financing through CareCredit?",
    "How long does a tummy tuck consult take?",
    "When can I get my teeth whitened?",
    "My daughter needs braces, do you take Delta Dental?",
    "Need to cancel my appt tmrw",
    "Ugh my lips look uneven",
    "Are your injectors nurses or doctors?",
    "Is there an age minimum for lip filler?",
    "I lost my retainer, can you make a new one?",
    "Kindly advise on availability for laser hair removal",
    "Pls call me back",
    "Hello??",
    "Anyone there?",
    "Following up on my previous message",
  ])("%j is English", (text) => {
    expect(messageLanguage(text)).not.toBe("other");
  });
});

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
    "Bonjour",
    "Obrigado",
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

import { NEVER_SAY_DEFAULTS, messageLanguage } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  cardNumberIn,
  guardAssistantReply,
  guardedLine,
  neverSayIn,
  SPOKEN_CARD_DIGITS,
  type GuardRefusal,
} from "@/lib/assistant/guard";
import { answerTurn, type AssistantResponder } from "@/lib/assistant/turn";
import { neverSayWithDefaults } from "@/lib/setup/knowledge";

import { SAFETY_FACTS } from "./setup/safety-cases";

/**
 * The guard in Spanish (21 October 2026). A clinic can have the assistant
 * answer in Spanish, and a read-only review ran Spanish replies through the
 * guard: none of the ones below was refused, though each breaks a rule the
 * owner has enforced in code since September for English. Each rule now has
 * Spanish patterns beside its English ones, and each is pinned here both
 * ways: the measured sentence and variants of it (usted and tú, with and
 * without accents) refused for the rule's own reason, never by accident
 * through the language check, and honest Spanish sentences beside them that
 * must still be sent. No database, no network.
 */

const refused = (reply: string, facts: Parameters<typeof guardAssistantReply>[1] = SAFETY_FACTS, turn = {}): GuardRefusal | null => {
  const verdict = guardAssistantReply(reply, facts, turn);
  return verdict.ok ? null : verdict.reason;
};

/** A clinic that added the stock entries clinics most often add, beside the defaults. */
const STOCK = { ...SAFETY_FACTS, neverSay: neverSayWithDefaults(["best in town", "cheapest"]) };

const rules: { rule: string; reason: GuardRefusal; facts?: Parameters<typeof guardAssistantReply>[1]; blocked: string[]; passes: string[] }[] = [
  {
    rule: "a guaranteed outcome",
    reason: "clinical",
    blocked: [
      "Con este tratamiento va a quedar perfecta, se lo aseguro.",
      "Quedará como nueva, se lo garantizo.",
      "Quedara como nueva, se lo garantizo.",
      "Vas a quedar perfecta, te lo garantizo.",
      "Le garantizamos que le van a encantar los resultados.",
      "Se verá diez años más joven.",
    ],
    passes: [
      "No podemos garantizar resultados; el especialista le explicará qué esperar en la consulta.",
      "Nadie puede garantizar un resultado, por eso la consulta es importante.",
      "Le aseguro que el equipo revisará su solicitud hoy.",
      "Su cita va a quedar para la semana que viene si el equipo la confirma.",
    ],
  },
  {
    rule: "a stock never-say entry said in Spanish",
    reason: "never_say",
    facts: STOCK,
    blocked: [
      "Es un tratamiento sin dolor.",
      "Es practicamente indoloro.",
      "No te va a doler nada, es rapidísimo.",
      "Somos la mejor clínica de la ciudad.",
      "Somos la mejor clinica de la zona.",
      "Es el más barato.",
      "Somos los mas baratos de la zona.",
      "El tratamiento no tiene efectos secundarios.",
    ],
    passes: [
      "La clínica está en la calle principal.",
      "Tenemos horarios por la mañana y por la tarde.",
      "La consulta cuesta ciento cincuenta dólares.",
      "Le recomiendo reservar una consulta para que el especialista evalúe su caso.",
    ],
  },
  {
    rule: "a price off the menu, or in another currency",
    reason: "price",
    blocked: [
      "El relleno cuesta 350 pesos.",
      "El relleno cuesta trescientos cincuenta pesos.",
      "Son seiscientos euros por sesión.",
      "El relleno vale 600 euros.",
      "Cuesta doscientas libras esterlinas.",
      "La consulta no tiene ningún costo.",
      "La consulta no tiene ningun costo.",
      "Tu consulta no te cuesta nada.",
      "La consulta es gratis.",
      "La valoración inicial es de cortesía.",
    ],
    passes: [
      "La consulta cuesta ciento cincuenta dólares.",
      "La consulta cuesta $150.",
      "El estacionamiento es gratis.",
      "Aceptamos dólares y pesos en efectivo.",
      "Su perro pesa cuarenta libras, así que el equipo le pedirá su historial.",
      "No ofrecemos consultas gratis en este momento.",
      "La consulta no es gratis.",
    ],
  },
  {
    rule: "card or bank details asked for",
    reason: "payment_details",
    blocked: [
      "Por favor dígame el número de su tarjeta para apartar la cita.",
      "Por favor digame el numero de su tarjeta.",
      "Dime el número de tu tarjeta y te aparto la hora.",
      "Necesito su número de cuenta bancaria.",
      "Necesitamos los datos de su tarjeta de crédito.",
      "¿Me puede dar los dieciséis dígitos de su tarjeta y la fecha de vencimiento?",
      "¿Me puedes dar los 16 digitos de tu tarjeta?",
      "Mándeme una foto de su tarjeta.",
      "¿Cuándo vence su tarjeta?",
    ],
    passes: [
      "Aceptamos tarjeta de crédito, débito y efectivo.",
      "La clínica le envía un enlace de pago seguro para el depósito.",
      "Aceptamos Visa y Mastercard.",
    ],
  },
  {
    rule: "a booking said to be made, with no booking written",
    reason: "booking_confirmation",
    blocked: [
      "Listo, su cita queda para el martes a las tres de la tarde.",
      "Listo, tu cita quedo para el lunes.",
      "Ya le reservé el martes a las tres.",
      "Ya te reserve el jueves a las diez.",
      "Le confirmo la cita del lunes.",
      "Su cita para el martes está lista.",
      "Su cita para el martes esta lista.",
      "Ya quedó agendada su cita.",
      "Le voy a reservar el martes a las tres.",
    ],
    passes: [
      "¿Le gustaría que le busque un horario el martes?",
      "Cuando su cita esté confirmada, el equipo le avisará.",
      "Su cita todavía no está confirmada; el equipo se la confirmará en un día.",
      "Le confirmo que estamos abiertos el sábado.",
      "Si su cita queda para el martes, llegue diez minutos antes.",
      "Tenemos disponibilidad el martes por la mañana o el jueves por la tarde. ¿Cuál le queda mejor?",
    ],
  },
  {
    rule: "contact promised after the conversation",
    reason: "outbound_promise",
    blocked: [
      "Mañana la llamamos para confirmar.",
      "Manana la llamamos para confirmar.",
      "Le mando un mensaje de texto mañana con los detalles.",
      "Te llamo mañana para confirmar.",
      "Le enviaremos un recordatorio por mensaje de texto.",
      "Recibirá un recordatorio antes de su cita.",
      "Voy a llamarle más tarde.",
    ],
    passes: [
      "Le responderemos en el día.",
      "El equipo le responderá en un día.",
      "El equipo se pondrá en contacto con usted en un día.",
      "No enviamos recordatorios por mensaje de texto.",
      "Le recuerdo que debe llegar diez minutos antes.",
      "Puede llamarnos al número de la clínica.",
    ],
  },
  {
    rule: "the team said to be told, with no alert queued",
    reason: "alert_claim",
    blocked: [
      "Ya notifiqué a la clínica.",
      "Ya notifique a la clinica.",
      "Ya le avisé al equipo y le llamarán.",
      "He informado a la doctora.",
      "Ya pasé su mensaje al equipo.",
      "El equipo ya fue notificado.",
      "No se preocupe ya avisé al equipo.",
    ],
    passes: [
      "Le avisaré al equipo para que le contacten.",
      "Puedo pasar sus datos al equipo, que responde en un día.",
      "Si quiere, le paso su solicitud al equipo.",
    ],
  },
  {
    rule: "a claim to be a person",
    reason: "human_claim",
    blocked: [
      "Soy María, de la recepción.",
      "Soy Maria, de recepcion.",
      "Me llamo Ana y soy la recepcionista.",
      "Le habla Carmen, de la clínica.",
      "Soy una persona real.",
      "Soy de la recepción, ¿en qué le ayudo?",
    ],
    passes: [
      "Soy AYA, la asistente de IA de la clínica.",
      "Soy un asistente de IA, no una persona.",
      "Si prefiere hablar con una persona, el equipo le responde en un día.",
    ],
  },
  {
    rule: "HIPAA compliance claimed",
    reason: "hipaa_claim",
    blocked: ["Somos totalmente compatibles con HIPAA.", "Cumplimos con HIPAA.", "Estamos certificados por HIPAA.", "Somos compatibles con la ley HIPAA."],
    passes: ["Firmamos un acuerdo de socio comercial y tratamos los datos de pacientes conforme a él."],
  },
  {
    rule: "another patient, or another practice",
    reason: "other_party",
    blocked: [
      "Otra paciente se hizo lo mismo y quedó feliz.",
      "Otra paciente se hizo lo mismo y quedo feliz.",
      "Uno de nuestros clientes tuvo lo mismo.",
      "Una antigua clienta vino por eso.",
      "Somos mejores que la clínica de al lado.",
      "Somos más baratos que otras clínicas.",
      "Somos mejores que Glow Med Spa.",
    ],
    passes: [
      "No puedo compartir información sobre otros pacientes.",
      "Otros pacientes suelen preguntar por el estacionamiento.",
      "¿El lunes es mejor que el martes para usted?",
      "Es mejor que lo hable directamente con el equipo.",
      "Es mejor que la clínica le explique los detalles en la consulta.",
    ],
  },
  {
    rule: "a dose, by its count",
    reason: "clinical",
    blocked: [
      "Normalmente son cuatro jeringas.",
      "Normalmente se usan 20 unidades.",
      "Te pondrían unas veinte unidades en la frente.",
      "Lo usual son 2 viales.",
      "Para los labios suelen ser dos jeringas.",
    ],
    passes: ["Tenemos dos horarios disponibles el jueves.", "La consulta dura unos treinta minutos."],
  },
];

describe("the guard in Spanish", () => {
  for (const r of rules) {
    test(`${r.rule}: refused for that reason`, () => {
      for (const reply of r.blocked) {
        // Read as Spanish, so the reason is the rule's own and never the language check's.
        expect(messageLanguage(reply, { knownTerms: ["Glow Med Spa", "HIPAA"] }), reply).not.toBe("other");
        expect(refused(reply, r.facts), reply).toBe(r.reason);
      }
    });
    test(`${r.rule}: an honest Spanish sentence passes`, () => {
      for (const reply of r.passes) expect(refused(reply, r.facts), reply).toBeNull();
    });
  }

  test("ordinary Spanish replies, which the language check used to turn away, are sent", () => {
    for (const reply of [
      "El equipo le responderá en un día.",
      "Le responderemos en el día.",
      "Su solicitud fue recibida. El equipo la revisará y le escribirá de vuelta.",
      "Nuestra dirección es 1 Main St. Puede llegar en coche o en transporte público.",
      "Hola, gracias por comunicarse con nosotros. ¿En qué le puedo ayudar hoy?",
      "Para cancelar o cambiar su cita, le pedimos que avise con veinticuatro horas de anticipación.",
      "Estamos abiertos de lunes a viernes, de nueve de la mañana a cinco de la tarde.",
      "Disculpe, no entendí bien. ¿Me lo podría repetir?",
      "Muchas gracias por su paciencia. Que tenga un buen día.",
    ]) {
      expect(refused(reply), reply).toBeNull();
    }
    // A booking said in Spanish is refused as a booking claim, not as another language, and passes once the tool layer wrote it.
    expect(refused("Ya quedó agendada su cita.")).toBe("booking_confirmation");
    expect(refused("Ya quedó agendada su cita.", SAFETY_FACTS, { bookingWritten: true })).toBeNull();
    expect(refused("Su cita para el martes está lista.", SAFETY_FACTS, { bookingWritten: true })).toBeNull();
  });

  test("a claimed alert in Spanish passes only when one is queued at a clinic whose alerts reach it, as in English", () => {
    const said = "Ya notifiqué a la clínica.";
    expect(refused(said, { ...SAFETY_FACTS, urgentAlertsReady: false }, { alertQueued: true })).toBe("alert_claim");
    expect(refused(said, { ...SAFETY_FACTS, urgentAlertsReady: true }, {})).toBe("alert_claim");
    expect(refused(said, { ...SAFETY_FACTS, urgentAlertsReady: true }, { alertQueued: true })).toBeNull();
  });

  test("free in Spanish passes only where the clinic lists that service at $0, as in English", () => {
    const facts = {
      ...SAFETY_FACTS,
      services: SAFETY_FACTS.services.map((s) => (s.name === "Consultation" ? { ...s, priceFromUsd: 0, priceToUsd: 0 } : s)),
    };
    expect(refused("La consulta es gratis.", facts)).toBeNull();
    expect(refused("La consulta no tiene ningún costo.", facts)).toBeNull();
    // A $0 service elsewhere on the list does not make the consultation free.
    const other = { ...SAFETY_FACTS, services: [...SAFETY_FACTS.services, { name: "Skin check", priceFromUsd: 0, priceToUsd: 0, priceKind: "exact" as const, unit: null, durationMinutes: 15, depositUsd: null }] };
    expect(refused("La consulta es gratis.", other)).toBe("price");
    expect(refused("La consulta no tiene ningún costo.", other)).toBe("price");
  });
});

describe("the never-say list in Spanish: a fixed map for the stock entries, the clinic's own as written", () => {
  test("every default entry has its Spanish, matched with or without accents", () => {
    const spanish: Record<string, string> = {
      "guaranteed results": "Le ofrecemos resultados garantizados.",
      "risk-free": "Es un procedimiento sin riesgo.",
      "completely safe": "Es completamente seguro.",
      "no side effects": "No hay efectos secundarios.",
      painless: "Es indoloro.",
      "permanent results": "Los resultados permanentes son lo nuestro.",
      "you're a good candidate": "Usted es una buena candidata.",
      "you don't need to see a doctor": "No necesita ver a un médico.",
    };
    for (const entry of NEVER_SAY_DEFAULTS) {
      const reply = spanish[entry];
      expect(reply, `a Spanish line for ${entry}`).toBeDefined();
      expect(neverSayIn(reply!, [entry]), reply).toBe(true);
      expect(neverSayIn(reply!.normalize("NFD").replace(/\p{M}+/gu, ""), [entry]), reply).toBe(true);
      // Only the entry's own Spanish: an empty list finds nothing.
      expect(neverSayIn(reply!, []), reply).toBe(false);
    }
  });

  test("a stock entry's Spanish applies only when the entry is on the list", () => {
    expect(refused("Es el más barato.", SAFETY_FACTS)).toBeNull();
    expect(refused("Es el más barato.", STOCK)).toBe("never_say");
  });

  test("a clinic's own entry with no mapping is matched as written only: that is its limit", () => {
    const facts = { ...SAFETY_FACTS, neverSay: ["Dr. Smith is the best"] };
    expect(refused("Dr. Smith is the best.", facts)).toBe("never_say");
    expect(refused("El Dr. Smith es el mejor.", facts)).not.toBe("never_say");
    // An entry the clinic wrote in Spanish is matched as written, accents aside.
    expect(neverSayIn("Le damos garantia total.", ["garantía total"])).toBe(true);
    expect(neverSayIn("Le damos garantía total.", ["garantia total"])).toBe(true);
  });
});

describe("the replacement line in Spanish", () => {
  test("each refusal has a Spanish line, naming the clinic, that the guard itself would send", () => {
    const reasons: GuardRefusal[] = ["never_say", "price", "payment_details", "hipaa_claim", "clinical", "language", "booking_confirmation", "human_claim", "outbound_promise", "alert_claim", "other_party", "empty"];
    for (const reason of reasons) {
      const line = guardedLine(reason, SAFETY_FACTS.clinicName, "es");
      expect(messageLanguage(line, { knownTerms: [SAFETY_FACTS.clinicName] }), line).toBe("es");
      expect(guardAssistantReply(line, SAFETY_FACTS), line).toEqual({ ok: true });
      // English stays the default, and unchanged.
      expect(guardedLine(reason, SAFETY_FACTS.clinicName)).toBe(guardedLine(reason, SAFETY_FACTS.clinicName, "en"));
      expect(guardedLine(reason, SAFETY_FACTS.clinicName)).not.toBe(line);
    }
    expect(guardedLine("price", "Radiance Med Spa")).toBe(
      "I can't give a price for that one, but the team at Radiance Med Spa can go through it with you at a consultation. Would you like me to pass on a request for one?",
    );
  });

  test("a refused Spanish reply is replaced by the Spanish line; a refused English one by the English line", async () => {
    const reply = (text: string): AssistantResponder => async () => JSON.stringify({ reply: text });
    const spanish = await answerTurn({ facts: SAFETY_FACTS, channel: "web_chat", history: [], text: "¿Cuánto cuesta el relleno?", responder: reply("El relleno cuesta 350 pesos.") });
    expect(spanish).toMatchObject({ source: "guard", guard: "price" });
    expect(spanish.reply).toBe(guardedLine("price", SAFETY_FACTS.clinicName, "es"));
    const english = await answerTurn({ facts: SAFETY_FACTS, channel: "web_chat", history: [], text: "How much is lip filler?", responder: reply("Lip filler is €650.") });
    expect(english.reply).toBe(guardedLine("price", SAFETY_FACTS.clinicName));
  });
});

describe("a card number said in words is cut before the model", () => {
  test("in English and in Spanish, digit by digit or in pairs, with the commas a recogniser adds", () => {
    for (const said of [
      "My card is four two four two four two four two four two four two four two four two.",
      "It's four two four two, four two four two, four two four two, four two four two",
      "forty-two forty-two forty-two forty-two forty-two forty-two forty-two forty-two",
      "Mi tarjeta es cuatro dos cuatro dos cuatro dos cuatro dos cuatro dos cuatro dos cuatro dos cuatro dos.",
      "cuarenta y dos cuarenta y dos cuarenta y dos cuarenta y dos cuarenta y dos cuarenta y dos cuarenta y dos cuarenta y dos",
      "the number is 4242 four two four two four two four two 4242",
      "tres siete ocho dos, ocho dos dos cuatro, seis tres uno, cero cero cinco",
    ]) {
      const cut = cardNumberIn(said);
      expect(cut.found, said).toBe(true);
      expect(cut.text, said).toContain("[card number removed]");
      expect(cut.text, said).not.toMatch(/\b(?:two|dos|forty-two|cuarenta y dos)\b.*\b(?:two|dos|forty-two|cuarenta y dos)\b.*\b(?:two|dos|forty-two|cuarenta y dos)\b/i);
    }
  });

  test("a phone number said in words, a time, a year or a price is no card", () => {
    expect(SPOKEN_CARD_DIGITS).toBeGreaterThan(11);
    for (const said of [
      "My number is four one five, five five five, zero one nine two.",
      "one four one five five five five zero one nine two",
      "four fifteen, five fifty-five, oh one nine two",
      "Mi número es cuatro uno cinco cinco cinco cinco cero uno nueve dos.",
      "Can I come at three thirty on the twenty first?",
      "It was back in twenty twenty-five, about two hundred dollars.",
      "Tengo cuarenta y dos años y vivo en el código postal nueve cuatro uno uno cero.",
      "My zip is nine four one one zero and my number is four one five five five five zero one nine two.",
    ]) {
      const cut = cardNumberIn(said);
      expect(cut.found, said).toBe(false);
      expect(cut.text).toBe(said);
    }
  });
});

describe("the Spanish patterns are safe from catastrophic backtracking", () => {
  test("a long reply made of the words the patterns look for is read in time", () => {
    const pieces = [
      "su cita para el martes ",
      "cuarenta y dos cuatro dos ",
      "le la lo te les ",
      "no le ",
      "mejor que ",
      "otra ",
      "va a quedar ",
      "doscientos trescientos ",
      "número de su tarjeta ",
      "four two forty ",
    ];
    for (const piece of pieces) {
      const long = piece.repeat(Math.ceil(6000 / piece.length));
      const started = performance.now();
      guardAssistantReply(long, SAFETY_FACTS);
      guardAssistantReply(`${long}.`, SAFETY_FACTS);
      cardNumberIn(`${long}x`);
      // Generous for a loaded machine: a catastrophic pattern takes minutes, not seconds.
      expect(performance.now() - started, piece).toBeLessThan(5000);
    }
  });
});

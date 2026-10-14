import { describe, expect, test } from "vitest";

import { findClinicalContent, serviceNameScreen } from "./clinical-content";

describe("findClinicalContent and per-unit prices", () => {
  // The spec wants a menu price quoted exactly, and injectables are priced by
  // the unit or the ml. Those phrases must be storable.
  test.each([
    "Botox (per unit)",
    "$14 per unit",
    "Filler $650/ml",
    "Promotion: $2 off per unit this month",
  ])("lets the price notation %j through", (text) => {
    expect(findClinicalContent({ price: text })).toEqual([]);
  });

  // Only the "per" and "/" forms are exempt. A count of units is still dosing.
  test.each([
    "Dysport - 50 units",
    "20 units per area",
    "Lip filler 1 ml",
    "$14 per unit, typical dose 20 units",
  ])("still refuses dosing in %j", (text) => {
    const findings = findClinicalContent({ price: text });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ field: "price", label: "dosing" });
  });

  test("the exemption is for dosing only: a safety claim next to a unit price is caught", () => {
    const findings = findClinicalContent({ price: "$14 per unit, safe for everyone" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.label).toBe("a safety claim");
  });

  test("the excerpt quotes the original text, not the blanked copy", () => {
    const findings = findClinicalContent({ price: "$14 per unit, typical dose 20 units" });
    expect(findings[0]!.excerpt).toContain("dose");
    expect(findings[0]!.excerpt).toContain("per unit");
  });
});

describe("the claims screen, for a veterinary practice's service names", () => {
  // A vet's menu is written in the vocabulary of medicine, so the full screen
  // would refuse the menu itself.
  test.each([
    "Allergy testing",
    "Senior diagnostics",
    "Post-op check",
    "Heartworm medication",
    "Ear infection treatment",
    "Pregnancy ultrasound",
    "Vaccines, per dose",
  ])("lets %j through", (name) => {
    expect(findClinicalContent({ name }, "claims")).toEqual([]);
    expect(findClinicalContent({ name })).not.toEqual([]);
  });

  // A promise is the same promise whoever the patient is.
  test.each([
    ["Safe sedation dentistry", "a safety claim"],
    ["Guaranteed results flea program", "a results guarantee"],
    ["FDA-approved dental sealant", "an efficacy claim"],
  ])("still catches the claim in %j", (name, label) => {
    expect(findClinicalContent({ name }, "claims")).toEqual([expect.objectContaining({ field: "name", label })]);
  });

  test("the full screen is still the default", () => {
    expect(findClinicalContent({ name: "Allergy testing" })).toHaveLength(1);
    expect(findClinicalContent({ name: "Allergy testing" }, "clinical")).toHaveLength(1);
  });

  test("only a veterinary specialty gets the claims screen for its service names", () => {
    expect(serviceNameScreen("veterinary")).toBe("claims");
    for (const specialty of ["med-spa", "dental", "plastic-surgery", "fertility", "glp1", "hair-restoration", "massage-chiro"] as const) {
      expect(serviceNameScreen(specialty), specialty).toBe("clinical");
    }
    expect(serviceNameScreen(null)).toBe("clinical");
    expect(serviceNameScreen(undefined)).toBe("clinical");
    // A value that is not a specialty, from a browser or a model, is screened in full.
    expect(serviceNameScreen("vet" as never)).toBe("clinical");
  });
});

describe("the everyday skin and hair conditions, which only the Meta channels count", () => {
  // What a person writes about their own skin or hair (owner, 7 October 2026).
  test.each([
    "I have bad acne, can you help?",
    "do you treat rosacea?",
    "my acne is so bad",
    "acne scars",
    "cystic acne for years",
    "acne-prone skin",
    "breakouts on my chin",
    "I keep breaking out",
    "I broke out after my last facial",
    "pimples",
    "zits",
    "blackheads on my nose",
    "whiteheads",
    "a rosacea flare",
    "ROSACEA",
    "my rosacia is back",
    "a flare-up",
    "my skin flares up in winter",
    "my eczema",
    "my excema",
    "exzema on my hands",
    "contact dermatitis",
    "psoriasis on my elbows",
    "psorasis",
    "psoriatic plaques",
    "keratosis pilaris",
    "folliculitis",
    "melasma",
    "chloasma",
    "hyperpigmentation",
    "hypopigmentation",
    "pigmentation on my cheeks",
    "vitiligo",
    "a scar on my lip",
    "scarring from surgery",
    "I'm scarred from it",
    "a keloid",
    "pockmarks",
    "hair loss",
    "hairloss",
    "alopecia",
    "I'm going bald",
    "balding at the crown",
    "thinning hair",
    "my hair is thinning",
    "hair fall",
    "my hair is falling out",
    "losing my hair",
    "a receding hairline",
    "hirsutism",
    "dandruff",
    "hyperhidrosis",
    "excessive sweating",
    "cold sores",
    "herpes",
    "warts",
    "a verruca",
    "ingrown hairs",
    "toenail fungus",
  ])("%j names one, and only the conditions option reads it", (message) => {
    expect(findClinicalContent({ message }, { conditions: true })).toEqual([
      expect.objectContaining({ field: "message", label: "a skin or hair condition" }),
    ]);
    expect(findClinicalContent({ message })).toEqual([]);
    expect(findClinicalContent({ message }, "clinical")).toEqual([]);
    expect(findClinicalContent({ message }, { conditions: false })).toEqual([]);
  });

  // A front desk's questions, and the words that look like a condition and are
  // not one: none of them is handed off on Meta.
  test.each([
    "What are your opening hours?",
    "where do I park?",
    "Is the consultation free?",
    "how much are lip fillers?",
    "How much is it per unit?",
    "Filler $650/ml",
    "Can you book me in for Botox on Tuesday at 2pm with Dr Chen?",
    "I'd like to book. I'm Maria, 415-555-0134, any weekday morning works.",
    "any weekday morning works, or Thursday after 4",
    "Do you have a cancellation policy?",
    "Do you use numbing cream?",
    "Are you a real person?",
    "please stop calling me",
    // Whole words only.
    "Any spots left on Saturday?",
    "I'm scared of needles",
    "Is Oscar in today?",
    "Do you do scarless mole removal?",
    "Does Stewart work Saturdays?",
    "Do you do scalp micropigmentation?",
    "What pigment do you use for lip blush?",
    "Can I see the price breakdown?",
    "Do I need a break between sessions?",
    "No sweat, thanks!",
    "I have a cold, should I move my appointment?",
    // A surname, which is why only the plural is a condition.
    "Can I book with Dr Whitehead?",
    // Looks and treatments, not conditions: what a med spa's price questions are made of.
    "Do you do laser hair removal?",
    "How much is Botox for crow's feet?",
    "How much for forehead wrinkles?",
    "Do you do IPL for sun spots?",
    "Do you do stretch mark treatments?",
    "How much is skin tag removal?",
    "Is the facial good for oily skin?",
    "Do you do anything for redness?",
    "Do you fix droopy eyelids?",
    "my hair is going grey, do you do PRP?",
  ])("%j does not", (message) => {
    expect(findClinicalContent({ message }, { conditions: true })).toEqual([]);
  });

  test("a clinic's own service named for a condition passes every screen but Meta's", () => {
    for (const name of ["Acne Facial", "Rosacea Laser", "Scar revision", "Hair loss PRP", "Melasma peel"]) {
      expect(findClinicalContent({ name }), name).toEqual([]);
      expect(findClinicalContent({ name }, "claims"), name).toEqual([]);
      expect(findClinicalContent({ name }, { conditions: true }), name).toEqual([
        expect.objectContaining({ label: "a skin or hair condition" }),
      ]);
    }
  });

  test("they come after the other patterns, so a field that trips one of those keeps its label", () => {
    expect(findClinicalContent({ message: "Is it safe for my acne?" }, { conditions: true })).toEqual([
      expect.objectContaining({ label: "a safety claim" }),
    ]);
    expect(findClinicalContent({ message: "My skin condition is rosacea" }, { conditions: true })).toEqual([
      expect.objectContaining({ label: "a medical condition" }),
    ]);
    const [finding] = findClinicalContent({ message: "Hi there, I've had rosacea for years" }, { conditions: true });
    expect(finding!.excerpt).toContain("rosacea");
  });

  test("the long form takes the screen as well, and the conditions count whatever it is", () => {
    expect(findClinicalContent({ name: "Allergy testing" }, {})).toHaveLength(1);
    expect(findClinicalContent({ name: "Allergy testing" }, { screen: "claims" })).toEqual([]);
    expect(findClinicalContent({ name: "Allergy testing" }, { screen: "claims", conditions: true })).toEqual([]);
    expect(findClinicalContent({ name: "Mange and dandruff bath" }, { screen: "claims", conditions: true })).toEqual([
      expect.objectContaining({ label: "a skin or hair condition" }),
    ]);
  });
});

describe("findClinicalContent in Spanish", () => {
  // The review of 14 October: with Spanish on, the reply guard passed these.
  test.each([
    ["Es seguro durante el embarazo y no tiene efectos secundarios.", "a safety claim"],
    ["La dosis habitual es de 20 unidades.", "dosing"],
    ["No tiene riesgos ni complicaciones.", "side effects or risks"],
    ["Usted es una candidata ideal para el relleno.", "candidacy"],
    ["Esos síntomas son normales.", "diagnosis, symptoms or triage"],
    ["La recuperación toma dos días.", "recovery or aftercare"],
    ["Deje de tomar anticoagulantes una semana antes.", "medication or interactions"],
    ["Si tiene una infección, espere.", "a medical condition"],
    ["Resultados garantizados.", "a results guarantee"],
    ["Está clínicamente probado.", "an efficacy claim"],
  ])("%j is clinical (%s)", (text, label) => {
    expect(findClinicalContent({ reply: text })[0]?.label).toBe(label);
  });

  test.each([
    "El botox cuesta $12 por unidad.",
    "Abrimos de lunes a viernes, de 9 a 5.",
    "¿Aceptan seguro? Sí, el equipo le puede explicar.",
    "Quisiera una cita para el martes.",
    "El estacionamiento es gratis.",
  ])("%j is not clinical", (text) => {
    expect(findClinicalContent({ reply: text })).toEqual([]);
  });

  test("an everyday condition in Spanish counts only where conditions do, on Meta", () => {
    expect(findClinicalContent({ message: "Tengo mucho acné" }, { conditions: true })).not.toEqual([]);
    expect(findClinicalContent({ message: "Tengo mucho acné" })).toEqual([]);
  });
});

describe("third review: the inbound screen reads conditions, medicines and triage questions", () => {
  // The Meta screen that runs before anything is stored, and the default one.
  test.each([
    ["estoy dando pecho", "pregnancy or breastfeeding"],
    ["¿El relleno es peligroso?", "a safety claim"],
    ["¿Es normal tener un bulto después del relleno?", "diagnosis, symptoms or triage"],
    ["Tomo warfarina", "medication or interactions"],
    ["Tengo diabetes", "a medical condition"],
    ["Tengo lupus", "a medical condition"],
    ["Tengo VIH", "a medical condition"],
    ["I have diabetes", "a medical condition"],
    ["I'm HIV positive", "a medical condition"],
    ["Is it normal to have a lump after filler?", "diagnosis, symptoms or triage"],
    ["my lip has a lump after filler", "a medical condition"],
  ])("%j is clinical (%s)", (text, label) => {
    expect(findClinicalContent({ message: text }, { conditions: true })[0]?.label).toBe(label);
    expect(findClinicalContent({ message: text })[0]?.label).toBe(label);
  });

  test.each(["Hi, how much is Botox?", "Hola, ¿cuánto cuesta el botox?", "Can I book a lip filler consult?"])(
    "%j is not clinical",
    (text) => {
      expect(findClinicalContent({ message: text }, { conditions: true })).toEqual([]);
    },
  );
});

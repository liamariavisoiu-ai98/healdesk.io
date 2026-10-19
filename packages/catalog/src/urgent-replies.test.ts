import { describe, expect, test } from "vitest";

import {
  fixedUrgentReply,
  otherLanguageReply,
  URGENT_AI_LINE,
  URGENT_PERSON_LINE,
  URGENT_LEAVE_NUMBER_LINE,
  URGENT_TEAM_TOLD_LINE,
  type UrgentReplyInput,
} from "./urgent-replies";

/**
 * The fixed urgent replies (plan Part G): the AI line first, then 911 (or,
 * for an animal, the emergency vet), then the practice's own number, then
 * "I've told the team" only when that is true, and the web chat's request
 * for a number. Fixed text, word for word.
 */

const HUMAN: UrgentReplyInput = {
  channel: "web_chat",
  emergency: "911",
  clinicName: "Radiance",
  clinicNumber: "(415) 555-0123",
  teamAlerted: true,
};

describe("the urgent reply for a person", () => {
  test("website chat: the AI line, 911, the urgent-help number, the team told, and a number to leave", () => {
    expect(fixedUrgentReply(HUMAN)).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. " +
        "If this is an emergency, call 911 now. " +
        "Otherwise, please call Radiance on (415) 555-0123. " +
        "I've told the team. " +
        "Leave a number for the clinic to call you.",
    );
  });

  test("on a call: hang up and call 911, and no number to leave", () => {
    const reply = fixedUrgentReply({
      ...HUMAN,
      channel: "voice",
      clinicNumber: "four one five, five five five",
    });
    expect(reply).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. " +
        "If this is an emergency, hang up and call 911 now. " +
        "Otherwise, please call Radiance on four one five, five five five. " +
        "I've told the team.",
    );
  });

  test("on a Meta channel: no number to leave, ever", () => {
    expect(fixedUrgentReply({ ...HUMAN, channel: "meta" })).not.toContain(URGENT_LEAVE_NUMBER_LINE);
  });

  test("it says the team was told only when the alert reaches the team", () => {
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      const untold = fixedUrgentReply({ ...HUMAN, channel, teamAlerted: false });
      expect(untold, channel).not.toContain(URGENT_TEAM_TOLD_LINE);
      expect(untold, channel).not.toMatch(/told|let .* know|alerted|someone will/i);
      expect(fixedUrgentReply({ ...HUMAN, channel }), channel).toContain(URGENT_TEAM_TOLD_LINE);
    }
  });

  test("the Meta line, untold, is the line the Meta channels have always sent", () => {
    expect(
      fixedUrgentReply({
        ...HUMAN,
        channel: "meta",
        clinicNumber: "+14155550123",
        teamAlerted: false,
      }),
    ).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. If this is an emergency, call 911 now. Otherwise, please call Radiance on +14155550123.",
    );
  });

  test("without a number it still sends them to 911 and to the practice", () => {
    expect(fixedUrgentReply({ ...HUMAN, clinicNumber: null })).toContain(
      "Otherwise, please call Radiance.",
    );
  });

  test("every reply opens with the AI line", () => {
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      for (const emergency of ["911", "veterinary"] as const) {
        expect(fixedUrgentReply({ ...HUMAN, channel, emergency }).startsWith(URGENT_AI_LINE)).toBe(
          true,
        );
      }
    }
  });
});

describe("the urgent reply for an animal", () => {
  const VET: UrgentReplyInput = {
    channel: "web_chat",
    emergency: "veterinary",
    clinicName: "Paws",
    clinicNumber: "(415) 555-0123",
    referralNumber: "(415) 555-0199",
    clinicOpen: true,
    teamAlerted: true,
  };

  test("the emergency vet's number first, then 911 for a person, then the practice's own while it is open", () => {
    expect(fixedUrgentReply(VET)).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. " +
        "If this is an emergency, call the emergency vet now on (415) 555-0199. " +
        "If a person is hurt or in danger, call 911 now. " +
        "Otherwise, please call Paws on (415) 555-0123. " +
        "I've told the team. " +
        "Leave a number for the clinic to call you.",
    );
  });

  test("closed, the practice's own number is left out: it cannot see an emergency", () => {
    const reply = fixedUrgentReply({ ...VET, clinicOpen: false });
    expect(reply).toContain("(415) 555-0199");
    expect(reply).not.toContain("(415) 555-0123");
  });

  test("hours unknown count as open", () => {
    expect(fixedUrgentReply({ ...VET, clinicOpen: null })).toContain(
      "Otherwise, please call Paws on (415) 555-0123.",
    );
  });

  test("on a call: hang up and call the emergency vet", () => {
    expect(
      fixedUrgentReply({ ...VET, channel: "voice", referralNumber: "four one five" }),
    ).toContain("If this is an emergency, hang up and call the emergency vet on four one five.");
  });

  test("with no referral clinic: the nearest emergency vet, and the practice's own number whatever the hour", () => {
    const reply = fixedUrgentReply({ ...VET, referralNumber: null, clinicOpen: false });
    expect(reply).toContain("If this is an emergency, call your nearest emergency vet now.");
    expect(reply).toContain("Otherwise, please call Paws on (415) 555-0123.");
  });

  test("every veterinary reply says to call 911 for a person, after the emergency vet, on every channel", () => {
    // The review of 14 October: whoever wrote may be the one hurt.
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      for (const referralNumber of ["(415) 555-0199", null]) {
        const reply = fixedUrgentReply({ ...VET, channel, referralNumber });
        expect(reply, channel).toMatch(
          /If a person is hurt or in danger, (hang up and )?call 911 now\./,
        );
        expect(reply.indexOf("emergency vet"), channel).toBeLessThan(reply.indexOf("911"));
        expect(reply.match(/\b911\b/g), channel).toHaveLength(1);
      }
    }
    expect(fixedUrgentReply({ ...VET, channel: "voice" })).toContain(
      "If a person is hurt or in danger, hang up and call 911 now.",
    );
    expect(fixedUrgentReply(VET)).toContain(URGENT_PERSON_LINE);
  });
});

describe("the urgent reply in Spanish", () => {
  test("for a person: the same lines, in Spanish", () => {
    expect(fixedUrgentReply({ ...HUMAN, language: "es" })).toBe(
      "Soy un asistente de IA, así que no puedo ayudar con nada urgente aquí. " +
        "Si es una emergencia, llame al 911 ahora. " +
        "Si no, llame a Radiance al (415) 555-0123. " +
        "Ya avisé al equipo. " +
        "Deje un número para que la clínica le llame.",
    );
    expect(
      fixedUrgentReply({ ...HUMAN, language: "es", channel: "voice", teamAlerted: false }),
    ).toBe(
      "Soy un asistente de IA, así que no puedo ayudar con nada urgente aquí. " +
        "Si es una emergencia, cuelgue y llame al 911 ahora. " +
        "Si no, llame a Radiance al (415) 555-0123.",
    );
  });

  test("for an animal: the emergency vet, then 911 for a person, in Spanish", () => {
    const reply = fixedUrgentReply({
      channel: "meta",
      emergency: "veterinary",
      language: "es",
      clinicName: "Paws",
      clinicNumber: "+14155550123",
      referralNumber: "+14155550199",
      clinicOpen: false,
      teamAlerted: false,
    });
    expect(reply).toBe(
      "Soy un asistente de IA, así que no puedo ayudar con nada urgente aquí. " +
        "Si es una emergencia, llame ahora al veterinario de urgencias al +14155550199. " +
        "Si una persona está herida o en peligro, llame al 911 ahora.",
    );
  });

  test("the Spanish reply promises nothing that is not built either", () => {
    expect(fixedUrgentReply({ ...HUMAN, language: "es", teamAlerted: false })).not.toMatch(
      /avis|equipo/i,
    );
  });
});

describe("the reply to a message no screen can read", () => {
  test("in English and in Spanish: the languages it answers in, 911, and the practice's number", () => {
    expect(
      otherLanguageReply({
        channel: "web_chat",
        clinicName: "Radiance",
        clinicNumber: "(415) 555-0123",
      }),
    ).toBe(
      "I'm an AI assistant, and I can only help in English or Spanish. " +
        "If this is an emergency, call 911 now. " +
        "Otherwise, please call Radiance on (415) 555-0123. " +
        "Soy un asistente de IA y solo puedo ayudar en inglés o en español. " +
        "Si es una emergencia, llame al 911 ahora. " +
        "Si no, llame a Radiance al (415) 555-0123.",
    );
  });

  test("on a call it says hang up; at a vet it gives the emergency vet as well", () => {
    const reply = otherLanguageReply({
      channel: "voice",
      clinicName: "Paws",
      clinicNumber: null,
      referralNumber: "four one five",
      veterinary: true,
    });
    expect(reply).toContain("If this is an emergency, hang up and call 911 now.");
    expect(reply).toContain("For an animal's emergency, call the emergency vet on four one five.");
    expect(reply).toContain(
      "Si un animal tiene una emergencia, llame al veterinario de urgencias al four one five.",
    );
    expect(reply).toContain("Otherwise, please call Paws.");
  });
});

describe("third review: at a vet, every urgent reply carries the emergency vet", () => {
  const VET_911: UrgentReplyInput = {
    channel: "web_chat",
    emergency: "911",
    veterinary: true,
    clinicName: "Oakwood Animal Hospital",
    clinicNumber: "(555) 111-2222",
    referralNumber: "(555) 999-0000",
    clinicOpen: false,
    teamAlerted: false,
  };

  test("a person's emergency at a vet leads with 911, then gives the emergency vet", () => {
    expect(fixedUrgentReply(VET_911)).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. " +
        "If this is an emergency, call 911 now. " +
        "If an animal needs emergency care, call the emergency vet on (555) 999-0000. " +
        "Leave a number for the clinic to call you.",
    );
  });

  test("the practice's own number only while it is open, in the 911 branch too", () => {
    expect(fixedUrgentReply(VET_911)).not.toContain("(555) 111-2222");
    expect(fixedUrgentReply({ ...VET_911, clinicOpen: true })).toContain(
      "Otherwise, please call Oakwood Animal Hospital on (555) 111-2222.",
    );
    expect(fixedUrgentReply({ ...VET_911, clinicOpen: null })).toContain("(555) 111-2222");
    // With no referral clinic, the practice's own number whatever the hour.
    expect(fixedUrgentReply({ ...VET_911, referralNumber: null })).toContain("(555) 111-2222");
    expect(fixedUrgentReply({ ...VET_911, referralNumber: null })).toContain(
      "If an animal needs emergency care, call your nearest emergency vet.",
    );
  });

  test("a practice for people keeps its urgent-help number at any hour: it is the one that reaches a person", () => {
    expect(
      fixedUrgentReply({
        ...VET_911,
        veterinary: false,
        referralNumber: null,
        clinicName: "Glow",
        clinicOpen: false,
      }),
    ).toContain("Otherwise, please call Glow on (555) 111-2222.");
  });

  test("whichever emergency led, both numbers are there, on every channel and in both languages", () => {
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      for (const emergency of ["911", "veterinary"] as const) {
        for (const language of ["en", "es"] as const) {
          const reply = fixedUrgentReply({ ...VET_911, channel, emergency, language });
          expect(reply, `${channel} ${emergency} ${language}`).toMatch(/\b911\b/);
          expect(reply, `${channel} ${emergency} ${language}`).toContain("(555) 999-0000");
        }
      }
    }
    expect(fixedUrgentReply({ ...VET_911, language: "es" })).toContain(
      "Si un animal necesita atención de urgencia, llame al veterinario de urgencias al (555) 999-0000.",
    );
  });
});

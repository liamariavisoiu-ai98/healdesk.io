import { describe, expect, test } from "vitest";

import {
  fixedUrgentReply,
  URGENT_AI_LINE,
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

  test("the emergency vet's number, never 911, then the practice's own while it is open", () => {
    expect(fixedUrgentReply(VET)).toBe(
      "I'm an AI assistant, so I can't help with anything urgent here. " +
        "If this is an emergency, call the emergency vet now on (415) 555-0199. " +
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

  test("never 911 for an animal, on any channel", () => {
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      for (const referralNumber of ["(415) 555-0199", null]) {
        expect(fixedUrgentReply({ ...VET, channel, referralNumber }), channel).not.toMatch(
          /\b911\b/,
        );
      }
    }
  });
});

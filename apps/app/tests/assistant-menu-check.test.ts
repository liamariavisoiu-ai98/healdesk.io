import { beforeEach, describe, expect, test, vi } from "vitest";

const notified = vi.hoisted(() => [] as { event: string; fields: Record<string, unknown> }[]);
vi.mock("@/lib/ops/notify", () => ({
  notifyOps: async (event: string, fields: Record<string, unknown>) => {
    notified.push({ event, fields });
  },
}));

import { checkMenu } from "@/lib/assistant/menu-check";
import { guardAssistantReply, movingOnLine } from "@/lib/assistant/guard";
import { answerTurn, type AssistantResponder } from "@/lib/assistant/turn";

import type { AssistantFacts } from "@/lib/assistant/facts";

const CLINIC = "0c1d2e3f-0000-4000-8000-00000000a123";

beforeEach(() => {
  notified.length = 0;
});

describe("the empty-menu alert (test calls of 23 October 2026)", () => {
  test("a conversation answered while AYA knows no service tells ops, saying why", () => {
    checkMenu({ clinicId: CLINIC, services: [], menu: "none" }, "voice");
    checkMenu({ clinicId: CLINIC, services: [], menu: "awaiting_approval" }, "web_chat");
    expect(notified).toEqual([
      { event: "assistant_knows_no_services", fields: { clinicId: CLINIC, channel: "voice", code: "none" } },
      { event: "assistant_knows_no_services", fields: { clinicId: CLINIC, channel: "web_chat", code: "awaiting_approval" } },
    ]);
  });

  test("a clinic whose menu AYA can say raises nothing", () => {
    checkMenu(
      {
        clinicId: CLINIC,
        services: [{ name: "Botox", priceFromUsd: 12, priceToUsd: 12, priceKind: "per_unit", unit: "unit", durationMinutes: 30, depositUsd: null }],
        menu: "said",
      },
      "voice",
    );
    expect(notified).toEqual([]);
  });
});

const FACTS = {
  clinicId: CLINIC,
  clinicName: "Lumen Aesthetics",
  specialty: "med-spa",
  timeZone: "America/New_York",
  phone: "+15125550100",
  urgentPhone: null,
  vetReferralPhone: null,
  directLine: null,
  address: null,
  hours: [],
  openingHours: null,
  services: [],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: [],
  requirements: [],
  greeting: { phone: "Are you looking to book an appointment, or do you have a question?", chat: "How can I help?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
} satisfies AssistantFacts;

describe("the booking loop of the 23 October test call", () => {
  test("the most ordinary booking question is not refused as an outcome claim", () => {
    for (const reply of [
      "Thanks, Jose. I'll pass on a consultation request. What day and time works best for you?",
      "Which afternoon works well for you?",
      "What time works best for your schedule?",
    ]) {
      expect(guardAssistantReply(reply, FACTS), reply).toEqual({ ok: true });
    }
    // A claim about a treatment is still read.
    for (const reply of ["Microneedling works best for acne scars.", "It works best for you if you come in twice."]) {
      expect(guardAssistantReply(reply, FACTS), reply).toEqual({ ok: false, reason: "clinical" });
    }
  });

  test("a refusal the person has just heard is never said again: the turn hands over instead", async () => {
    // A model that keeps saying something the guard refuses.
    const refused: AssistantResponder = async () => JSON.stringify({ reply: "Results last about six months.", handoff: false, end: false });
    const first = await answerTurn({ facts: FACTS, channel: "voice", history: [], text: "I want to book", responder: refused });
    expect(first.source).toBe("guard");
    const second = await answerTurn({
      facts: FACTS,
      channel: "voice",
      history: [
        { speaker: "person", text: "I want to book" },
        { speaker: "assistant", text: first.reply },
      ],
      text: "Yes, please.",
      responder: refused,
    });
    expect(second.source).toBe("guard");
    expect(second.reply).toBe(movingOnLine("Lumen Aesthetics"));
    expect(second.reply).not.toBe(first.reply);
    expect(second.handoff).toBe(true);
    expect(guardAssistantReply(second.reply, FACTS)).toEqual({ ok: true });
  });
});

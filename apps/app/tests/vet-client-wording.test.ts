import { metaEligible, resolveBookingRequirements } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { buildAssistantPrompt } from "@/lib/assistant/prompt";
import { buildFrontDoorPrompt } from "@/lib/meta/front-door";

/**
 * A veterinary practice's people are its clients, the owners of the animals
 * it cares for, and the assistant is told so in their words (plan Part L,
 * "Copy"; `audienceFor`): on a call, in the website chat and on the Meta
 * front door, the prompt says clients and never patients. Everyone else's
 * prompt keeps saying patients. Pure: no database, no model.
 */

const WEEKDAYS = [["09:00", "17:00"]] as [string, string][];

const PEOPLE: AssistantFacts = {
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
  openingHours: {
    sun: [],
    mon: WEEKDAYS,
    tue: WEEKDAYS,
    wed: WEEKDAYS,
    thu: WEEKDAYS,
    fri: WEEKDAYS,
    sat: [],
  },
  services: [
    {
      name: "Consultation",
      priceFromUsd: 150,
      priceToUsd: 150,
      priceKind: "exact",
      unit: null,
      durationMinutes: 30,
      depositUsd: null,
    },
  ],
  policies: ["24 hours' notice to cancel."],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: "Weekdays 9 to 5",
  neverSay: ["guaranteed results"],
  requirements: resolveBookingRequirements("med-spa", null),
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};

const VET: AssistantFacts = {
  ...PEOPLE,
  clinicName: "Paws Animal Clinic",
  specialty: "veterinary",
  vetReferralPhone: "+14155550911",
  services: [
    {
      name: "Wellness exam",
      priceFromUsd: 80,
      priceToUsd: 80,
      priceKind: "exact",
      unit: null,
      durationMinutes: 30,
      depositUsd: null,
    },
  ],
  requirements: resolveBookingRequirements("veterinary", null),
};

const PATIENT = /\bpatients?\b/i;

function frontDoor(specialty: string) {
  const resolved = resolveBookingRequirements(specialty, null);
  return buildFrontDoorPrompt({
    clinicName: specialty === "veterinary" ? "Golden Paws Vets" : "Radiance",
    phone: "+1 415 555 0199",
    specialty,
    websiteHint: null,
    services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0 }],
    notes: null,
    escalationHours: null,
    requirements: metaEligible(resolved),
    deferredRequirements: resolved.filter((f) => !f.metaEligible),
  });
}

describe("the assistant's prompt, by audienceFor", () => {
  test("a veterinary practice's prompt calls its people clients, on a call and in the chat, and never patients", () => {
    for (const channel of ["voice", "web_chat"] as const) {
      const prompt = buildAssistantPrompt(VET, channel);
      expect(prompt, channel).toContain("Paws Animal Clinic, a veterinary practice.");
      expect(prompt, channel).toContain(
        "The people who contact the practice are its clients: the owners of the animals it cares for. Call them clients, and the animals by their names.",
      );
      expect(prompt, channel).toContain(
        "Anything medical about the animal goes to the practice's vets: offer to pass the client's details on.",
      );
      expect(prompt, channel).not.toMatch(PATIENT);
    }
  });

  test("everyone else's says patients, as it always has", () => {
    const prompt = buildAssistantPrompt(PEOPLE, "voice");
    expect(prompt).toContain("Radiance Med Spa, a practice.");
    expect(prompt).toContain(
      "The people who contact the practice are its patients, or people thinking of becoming one.",
    );
    expect(prompt).toContain(
      "Anything medical about the person goes to the practice's clinicians: offer to pass their details on.",
    );
    expect(prompt).not.toMatch(/\bclients?\b/i);
  });
});

describe("the Meta front door, by audienceFor", () => {
  test("a veterinary practice's: a veterinary practice whose people are clients, never patients", () => {
    const prompt = frontDoor("veterinary");
    expect(prompt).toContain(
      "You are the messaging assistant for Golden Paws Vets, a veterinary practice.",
    );
    expect(prompt).toContain("say whether someone is a client.");
    expect(prompt).toContain(
      "The people who message the practice are its clients. Call them clients.",
    );
    expect(prompt).toContain("Confirming the person is, was, or will be a client");
    expect(prompt).not.toMatch(PATIENT);
    // Nothing about the animal on a Meta thread (package V's rule).
    expect(prompt).not.toMatch(/animal|species/i);
  });

  test("everyone else's: a healthcare practice whose people are patients", () => {
    const prompt = frontDoor("med-spa");
    expect(prompt).toContain(
      "You are the messaging assistant for Radiance, a healthcare practice.",
    );
    expect(prompt).toContain("say whether someone is a patient.");
    expect(prompt).toContain("Confirming the person is, was, or will be a patient");
    expect(prompt).not.toMatch(/\bclients?\b/i);
  });
});

import { describe, expect, test } from "vitest";

import { LEGAL_VERSION } from "@/lib/legal";

import { intentFields, signRequestRefusal, validateOrder } from "./order";

/**
 * The order /api/checkout validates, read directly: the plan is a package at
 * its usage steps (the pricing sheet of 13 October 2026), parsed by the
 * catalog, and only a package with Web Chat needs a website.
 */

const ORDER = {
  plan: "voice-metachat-500-300",
  clinicName: "Glow Med Spa LLC",
  specialty: "med-spa",
  website: null,
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  contactName: "Laura Owner",
  contactEmail: "info@glowmedspa.com",
  agreementId: "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a",
  covered: "no",
  profile: null,
  profileStatus: "none",
  termsAccepted: true,
  termsVersion: LEGAL_VERSION,
};

describe("the plan", () => {
  test("is a package at its steps, and travels to apps/app under `plan`", () => {
    const result = validateOrder(ORDER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.plan.id).toBe("voice-metachat-500-300");
    expect(result.order.plan.monthlyUsd).toBe(580);
    expect(intentFields(result.order)).toMatchObject({
      plan: "voice-metachat-500-300",
      billingInterval: "month",
    });
  });

  test("a step off the grid, a package without its steps or a retired package is no plan", () => {
    for (const plan of ["voice-150", "voice-1600", "voice-metachat-500", "voice-metachat", "complete", "chat-web", ""]) {
      expect(validateOrder({ ...ORDER, plan }), plan).toEqual({
        ok: false,
        refusal: { field: "plan", error: "Unknown plan." },
      });
    }
  });

  test("the steps are the buyer's, any on the grid", () => {
    for (const plan of ["voice-100", "metachat-1500", "voice-metachat-1500-100"]) {
      expect(validateOrder({ ...ORDER, plan }).ok, plan).toBe(true);
    }
  });
});

describe("a practice with no website", () => {
  test("is sold Voice and Meta Chat, which include no website it needs", () => {
    for (const plan of ["voice-500", "metachat-300", "voice-metachat-500-300"]) {
      expect(validateOrder({ ...ORDER, plan }).ok, plan).toBe(true);
    }
  });

  test("is refused Web Chat under the package's field", () => {
    for (const plan of ["webchat-300", "voice-webchat-500-300"]) {
      expect(validateOrder({ ...ORDER, plan }), plan).toEqual({
        ok: false,
        refusal: {
          field: "plan",
          error:
            "AYA Web Chat needs a website. Choose AYA Voice or AYA Meta Chat, or give us your website.",
        },
      });
    }
  });

  test("with a website, Web Chat is sold", () => {
    expect(
      validateOrder({ ...ORDER, plan: "voice-webchat-500-300", website: "glowmedspa.com", profileStatus: "failed" }).ok,
    ).toBe(true);
  });
});

/**
 * What /api/agreement checks before it forwards a signature to apps/app: the
 * calendar answers, the platform they imply, and a practice `agreementKindFor`
 * gives an agreement to. The Data Protection Agreement is one of them since
 * the owner released it on 20 October 2026; with a release stood in as
 * false, the decision never names it and a veterinary practice is refused.
 */
describe("a signature request", () => {
  const REQUEST = {
    specialty: "med-spa",
    isCoveredEntity: true,
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    platform: "none",
  };

  test("a practice signing the BAA goes through, released DPA or not", () => {
    expect(signRequestRefusal(REQUEST)).toBeNull();
    expect(signRequestRefusal(REQUEST, { dpaReleased: true })).toBeNull();
  });

  test("a veterinary practice signs the DPA now that it is released, and would be refused without it", () => {
    const vet = { ...REQUEST, specialty: "veterinary", isCoveredEntity: false };
    expect(signRequestRefusal(vet)).toBeNull();
    expect(signRequestRefusal(vet, { dpaReleased: true })).toBeNull();
    expect(signRequestRefusal(vet, { dpaReleased: false })).toEqual({
      field: "specialty",
      error: "We can't offer an agreement for this practice here.",
    });
  });

  test("a med spa that answered No is forwarded either way: to the DPA since its release, to the BAA without it", () => {
    const no = { ...REQUEST, isCoveredEntity: false };
    expect(signRequestRefusal(no)).toBeNull();
    expect(signRequestRefusal(no, { dpaReleased: false })).toBeNull();
  });

  test("the calendar answers are still checked first, whichever agreement it is", () => {
    const vet = { ...REQUEST, specialty: "veterinary", isCoveredEntity: false };
    expect(
      signRequestRefusal({ ...vet, calendarAccount: "gmail" }, { dpaReleased: true }),
    ).toMatchObject({
      field: "calendarAccount",
    });
    expect(
      signRequestRefusal({ ...vet, platform: "mindbody" }, { dpaReleased: true }),
    ).toMatchObject({
      field: "platform",
    });
  });
});

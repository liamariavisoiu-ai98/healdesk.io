import { describe, expect, test } from "vitest";

import { assertNoTreatmentName, TreatmentNameError } from "../src/guards";

/**
 * Stripe and Meta sign no business associate agreement, so a payment
 * description, a statement descriptor, payment metadata and a Meta message
 * never name the treatment (docs/v1-product-spec.md, "Guardrails").
 */
describe("assertNoTreatmentName", () => {
  const services = ["Botox", "Lip filler", "CoolSculpting", "Laser hair removal"];

  test("refuses a payment description that names a service, and says which", () => {
    expect(() => assertNoTreatmentName("Botox, 3 areas", services)).toThrow(TreatmentNameError);
    try {
      assertNoTreatmentName("Deposit for botox", services);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TreatmentNameError);
      expect((error as TreatmentNameError).serviceName).toBe("Botox");
    }
  });

  test("ignores case, punctuation and spacing in multi-word names", () => {
    expect(() => assertNoTreatmentName("LIP-FILLER deposit", services)).toThrow(TreatmentNameError);
    expect(() => assertNoTreatmentName("laser  hair\nremoval on Tuesday", services)).toThrow(TreatmentNameError);
    expect(() => assertNoTreatmentName("Your coolsculpting time is held", services)).toThrow(TreatmentNameError);
  });

  test("matches whole words only", () => {
    expect(() => assertNoTreatmentName("Lipstick and filler shop", ["Lip"])).not.toThrow();
    expect(() => assertNoTreatmentName("Laser hair", services)).not.toThrow();
  });

  test("lets the generic descriptor and an opaque reference through", () => {
    expect(() => assertNoTreatmentName("Appointment deposit, ref HD-7Q2K9", services)).not.toThrow();
    expect(() => assertNoTreatmentName("Your appointment is booked for Tuesday at 3pm.", services)).not.toThrow();
  });

  test("ignores blank service names rather than matching everything", () => {
    expect(() => assertNoTreatmentName("Appointment deposit", ["", "   ", "--"])).not.toThrow();
    expect(() => assertNoTreatmentName("Appointment deposit", [])).not.toThrow();
  });
});

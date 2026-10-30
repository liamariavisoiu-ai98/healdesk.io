import { describe, expect, it } from "vitest";

import { demoUrgentReply } from "./chat-model";
import { normalizeProfile } from "./profile";

const PROFILE = normalizeProfile(
  { clinic_name: "Miami Skin & Vein", phone: "(305) 555-0100", specialty: "med_spa", services: [{ name: "Botox", price: "$12 per unit" }] },
  "Miami Skin & Vein",
);

describe("the demo chat's urgent answer, in code before the model", () => {
  it("answers a reaction with 911 and the clinic's number, and claims no one was told", () => {
    const reply = demoUrgentReply(PROFILE, "I had a treatment with you yesterday and now my face is swelling and it's getting hard to breathe. What should I do?");
    expect(reply).toBe("I'm an AI assistant, so I can't help with this one here. If this is an emergency, call 911 now. Otherwise, please call Miami Skin & Vein directly on (305) 555-0100.");
    expect(reply).not.toMatch(/flag|notif|told|alert|team/i);
  });

  it("leaves the front desk's ordinary questions, and a clinical one, to the model", () => {
    for (const text of ["What are your opening hours?", "How much is Botox?", "Can I book a consultation for Thursday afternoon?", "I'm pregnant. Is it safe for me to have treatment here?"]) {
      expect(demoUrgentReply(PROFILE, text), text).toBeNull();
    }
  });
});

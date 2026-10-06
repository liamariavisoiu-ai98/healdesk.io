import { describe, expect, test } from "vitest";

import { SENDER_IDENTITY } from "./sender-identity";
import { TREATMENT_NAMES } from "./treatment-names";

describe("the treatment names email may never print", () => {
  test("are lower case, trimmed and listed once", () => {
    expect(TREATMENT_NAMES.length).toBeGreaterThan(20);
    for (const name of TREATMENT_NAMES) {
      expect(name, name).toBe(name.trim().toLowerCase());
      expect(name.length, name).toBeGreaterThan(1);
    }
    expect(new Set(TREATMENT_NAMES).size).toBe(TREATMENT_NAMES.length);
  });

  test("include the vocabulary the specialty copy already names", () => {
    for (const name of ["botox", "lip filler", "semaglutide", "ivf", "invisalign", "rhinoplasty"]) {
      expect(TREATMENT_NAMES).toContain(name);
    }
  });
});

describe("the sender identity", () => {
  test("names the entity and a mailbox, and sends replies to the one inbox", () => {
    expect(SENDER_IDENTITY.entityLine.startsWith("healdesk is a service of Viixi FZC")).toBe(true);
    expect(SENDER_IDENTITY.postalAddress).toMatch(/\d{5}, United States$/);
    expect(SENDER_IDENTITY.replyTo).toBe("hello@healdesk.io");
  });
});

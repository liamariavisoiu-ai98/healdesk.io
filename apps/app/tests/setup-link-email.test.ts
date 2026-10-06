import { beforeEach, describe, expect, test, vi } from "vitest";

import { clinicAiNotice } from "@/lib/compliance/disclosure";
import { renderSetupLink, sendSetupLink, type SetupLinkEmail } from "@/lib/email/setup-link";
import type { DeliveryTarget, OutgoingEmail, PhiClass } from "@/lib/reporting/deliver";

/**
 * The setup email (lib/email/setup-link.ts): §H.2's one ask, and below it the
 * written AI notice of docs/counsel/state-disclosure.md decision 8, which
 * travels here until the portal or the wizard exists.
 *
 * The transport is replaced so the test can see which class of wire the
 * message asked for, not just what it says.
 */

const wire = vi.hoisted(() => ({ classes: [] as string[], messages: [] as unknown[] }));
vi.mock("@/lib/reporting/deliver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reporting/deliver")>();
  return {
    ...actual,
    getTransport: (phiClass: PhiClass) => {
      wire.classes.push(phiClass);
      return {
        name: "capture",
        async send(_target: DeliveryTarget, message: OutgoingEmail) {
          wire.messages.push(message);
          return { status: "sent" as const, messageId: "m-1" };
        },
      };
    },
  };
});

const EMAIL: SetupLinkEmail = {
  to: "frontdesk@radiance.example",
  clinicId: "00000000-0000-0000-0000-000000000001",
  clinicName: "Radiance",
  specialty: "med-spa",
  url: `https://app.healdesk.test/setup/${"A".repeat(43)}`,
  expiresAt: new Date("2026-10-10T12:00:00Z"),
};

describe("the setup email", () => {
  beforeEach(() => {
    wire.classes.length = 0;
    wire.messages.length = 0;
  });

  test("carries the written AI notice word for word, after the link, labelled a convenience and not a warranty", () => {
    const { subject, text, html } = renderSetupLink(EMAIL);
    const notice = clinicAiNotice({ clinicName: "Radiance" });
    // §H.2 is untouched: the one ask is still the subject and still comes first.
    expect(subject).toBe("One thing to set up for Radiance");
    expect(text.indexOf(EMAIL.url)).toBeGreaterThan(-1);
    expect(text.indexOf(EMAIL.url)).toBeLessThan(text.indexOf(notice));
    expect(html).toContain(`<blockquote>${notice}</blockquote>`);
    for (const body of [text, html]) {
      expect(body).toContain(notice);
      expect(body).toMatch(/a convenience, not a warranty that it meets any state's requirements/);
      expect(body).toMatch(/Replace \[your direct line\] with a number that reaches a person at the practice and is not forwarded to the assistant/);
    }
  });

  test("goes out on the no-PHI wire: phiClass \"none\", notice included", async () => {
    expect(await sendSetupLink(EMAIL)).toEqual({ status: "sent", messageId: "m-1" });
    expect(wire.classes).toEqual(["none"]);
    expect(wire.messages).toHaveLength(1);
    const message = wire.messages[0] as OutgoingEmail;
    expect(message.phiClass).toBe("none");
    expect(message.text).toContain(clinicAiNotice({ clinicName: "Radiance" }));
  });
});

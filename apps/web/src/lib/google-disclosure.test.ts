import { GOOGLE_CALENDAR_DISCLOSURE } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { SUBPROCESSORS } from "@/lib/subprocessors";

/**
 * The Google Calendar disclosure names who the free times it reads reach
 * (packages/catalog/src/google-calendar-disclosure.ts), and the subprocessor
 * register is the internal list of who handles patient information, the one
 * a clinic is given on request (it stopped being published on 9 October
 * 2026). The two describe the same vendors to the same practice, so they are
 * tied here: a recipient the register does not list as handling patient
 * information would be a disclosure to a vendor the practice was never told
 * about, and a business associate agreement the register still
 * shows as unsigned cannot be described as signed.
 */
describe("the Google Calendar disclosure and the subprocessor register", () => {
  const recipients = GOOGLE_CALENDAR_DISCLOSURE.timeRecipients.map((name) => ({
    name,
    row: SUBPROCESSORS.find((s) => s.name === name),
  }));

  test.each(recipients.map((r) => [r.name, r] as const))(
    "%s is a register row that handles patient information",
    (_name, { row }) => {
      expect(row).toBeDefined();
      expect(row!.handlesPhi).toBe(true);
      expect(row!.scope).not.toBe("marketing-site");
    },
  );

  test("while any recipient's agreement is unsigned, the disclosure says only that it is signed before any patient's information is processed", () => {
    const unsigned = recipients.filter((r) => r.row?.baa.state !== "signed");
    if (unsigned.length === 0) return;
    expect(GOOGLE_CALENDAR_DISCLOSURE.baaWording).toBe("conditional");
    expect(GOOGLE_CALENDAR_DISCLOSURE.paragraphs.join(" ")).toContain(
      "signed before any patient's information is processed",
    );
  });
});

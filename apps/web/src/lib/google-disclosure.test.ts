import { GOOGLE_CALENDAR_DISCLOSURE, GOOGLE_CALENDAR_DISCLOSURES } from "@healdesk/catalog";
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
 *
 * Every wording is held to it: the BAA's and, since 20 October 2026, the
 * Data Protection Agreement's two, which name the same recipients.
 */
describe("the Google Calendar disclosure and the subprocessor register", () => {
  const recipientsOf = (names: readonly string[]) =>
    names.map((name) => ({ name, row: SUBPROCESSORS.find((s) => s.name === name) }));
  const recipients = recipientsOf(GOOGLE_CALENDAR_DISCLOSURE.timeRecipients);

  test.each(
    GOOGLE_CALENDAR_DISCLOSURES.flatMap((d) =>
      recipientsOf(d.timeRecipients).map((r) => [d.version, r.name, r] as const),
    ),
  )("%s: %s is a register row that handles patient information", (_version, _name, { row }) => {
    expect(row).toBeDefined();
    expect(row!.handlesPhi).toBe(true);
    expect(row!.scope).not.toBe("marketing-site");
  });

  test("while any recipient's agreement is unsigned, the disclosure says only that it is signed before any patient's information is processed", () => {
    const unsigned = recipients.filter((r) => r.row?.baa.state !== "signed");
    if (unsigned.length === 0) return;
    expect(GOOGLE_CALENDAR_DISCLOSURE.baaWording).toBe("conditional");
    expect(GOOGLE_CALENDAR_DISCLOSURE.paragraphs.join(" ")).toContain(
      "signed before any patient's information is processed",
    );
  });

  test("the DPA's wordings promise the recipients' terms before any information reaches them, never that they are signed", () => {
    for (const disclosure of GOOGLE_CALENDAR_DISCLOSURES.filter((d) => d.agreementKind === "dpa")) {
      const one = disclosure.audience === "clients" ? "client" : "patient";
      const words = disclosure.paragraphs.join(" ");
      expect(disclosure.baaWording, disclosure.version).toBe("conditional");
      expect(words, disclosure.version).toContain(`agree in writing, before any ${one}'s information reaches it`);
      expect(words, disclosure.version).not.toMatch(/\b(have|has) signed\b|\bare signed\b/);
    }
  });
});

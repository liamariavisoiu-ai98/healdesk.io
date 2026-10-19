import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY_SUBJECT_MAX, renderAgreementCopy } from "./agreement-copy-email";

/**
 * P6, the signer's copy of the agreement, as both apps send it: the footer
 * every healdesk email carries (Annex X1.9), a subject of at most 70
 * characters however long the practice's legal name (X4), and HTML with no
 * link in it (X1.6).
 */

const COPY = {
  signatoryName: "Alex Chen",
  clinicName: "Radiance Med Spa",
  version: "1.6.0",
  documentHash: "a".repeat(64),
  acceptedAt: new Date("2026-08-18T14:32:00Z"),
};

const LONG = `Radiance ${"Aesthetic and Wellness ".repeat(8)}Med Spa LLC`.slice(0, 200);

describe("renderAgreementCopy", () => {
  test("ends with the footer: why it came, who reads a reply, and who sent it", () => {
    const copy = renderAgreementCopy(COPY);
    for (const body of [copy.text, copy.html]) {
      expect(body).toContain(
        "You're getting this because this address was given for the signatory when an agreement with healdesk was signed.",
      );
      expect(body).toContain("Replies reach the healdesk team. Please leave out patient details.");
      expect(body).toContain("healdesk is a service of Viixi FZC");
      expect(body).toContain(
        "US mailing address (correspondence only): 800 N King Street, Suite 304-1426, Wilmington, DE 19801, United States",
      );
    }
    // A transactional copy of a contract: nothing to unsubscribe from.
    expect(copy.text).not.toMatch(/unsubscribe|Stop these emails/i);
  });

  test.each([
    ["a business associate agreement", "1.6.0"],
    ["a data protection agreement", "dpa/1.0.0"],
  ])("the subject of %s stays within 70 characters, the name cut to fit", (_kind, version) => {
    const short = renderAgreementCopy({ ...COPY, version });
    expect(short.subject).toMatch(/for Radiance Med Spa$/);
    const long = renderAgreementCopy({ ...COPY, version, clinicName: LONG });
    expect([...long.subject].length).toBeLessThanOrEqual(AGREEMENT_COPY_SUBJECT_MAX);
    expect(long.subject.endsWith("…")).toBe(true);
    // The body still names the practice in full.
    expect(long.text.replace(/\n/g, " ")).toContain(LONG);
  });

  test("the HTML is one column in system fonts, with no link and nothing fetched", () => {
    const { html } = renderAgreementCopy(COPY);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("-apple-system");
    expect(html).not.toMatch(/href=|src=|<img|url\(/i);
    expect(html).toContain("hello@healdesk.io");
  });

  test("without a name it can carry, it says when, not who", () => {
    const copy = renderAgreementCopy({ ...COPY, signatoryName: null });
    expect(copy.text).toContain("Signed on 18 August 2026 at 14:32 UTC.");
    expect(copy.text).not.toContain("Signed by");
  });
});

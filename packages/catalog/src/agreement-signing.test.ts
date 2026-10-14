import { describe, expect, test } from "vitest";

import { AGREEMENT_COPY } from "./agreement-copy";
import {
  AgreementError,
  effectiveDateOf,
  MAX_SIGNATORY_CHARS,
  prepareSigning,
  renderSignedDocument,
  storedVariables,
  validateSignRequest,
} from "./agreement-signing";
import { asciiRecipient, isSendableAddress, recipientProblem } from "./mail-address";

/**
 * What a signature must be, now that apps/web takes it and apps/app imports
 * it (docs/design/checkout-records-on-vercel-2026-10-14.md). apps/app's
 * tests/agreements.test.ts holds the full rule set through its wrapper; these
 * pin what moved or was added with the move: the title's cap, phase two's
 * switch as an option rather than an environment read, and that a prepared
 * signature re-renders from its own variables.
 */

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clinicLegalName: "Glow Med Spa LLC",
    specialty: "med-spa",
    attributionMode: "estimated",
    platform: "none",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    signatoryName: "Laura Owner",
    signatoryEmail: "laura@glowspa.test",
    isCoveredEntity: false,
    assentLabel: AGREEMENT_COPY.baa.assentLabel,
    templateVersion: AGREEMENT_COPY.baa.currentVersion,
    ...overrides,
  };
}

function refusal(body: Record<string, unknown>, options = {}): string | undefined {
  try {
    validateSignRequest(body, options);
    return undefined;
  } catch (error) {
    if (error instanceof AgreementError) return error.field;
    throw error;
  }
}

describe("validateSignRequest", () => {
  test("holds the title to the name's limit", () => {
    expect(refusal(request({ signatoryTitle: "T".repeat(MAX_SIGNATORY_CHARS) }))).toBeUndefined();
    expect(refusal(request({ signatoryTitle: "T".repeat(MAX_SIGNATORY_CHARS + 1) }))).toBe("signatoryTitle");
    expect(refusal(request({ signatoryTitle: 42 }))).toBe("signatoryTitle");
  });

  test("never signs phase two's verified reporting unless the caller says it may", () => {
    expect(refusal(request({ attributionMode: "verified", bookingSystem: "mindbody", platform: "mindbody" }))).toBe(
      "attributionMode",
    );
  });

  test("asks the mail layer's own question of the address", () => {
    expect(refusal(request({ signatoryEmail: "günter@klinik.test" }))).toBe("signatoryEmail");
    expect(refusal(request({ signatoryEmail: "gunter@klinik-münchen.test" }))).toBeUndefined();
  });
});

describe("prepareSigning", () => {
  test("renders a document its own recorded variables render again, byte for byte", () => {
    const body = request({ signatoryTitle: "Owner" });
    validateSignRequest(body);
    const prepared = prepareSigning(body, effectiveDateOf(new Date("2026-10-14T23:59:59.999Z")), {});
    expect(prepared.effectiveDate).toBe("2026-10-14");
    const again = renderSignedDocument(prepared.version, prepared.documentVariables as Record<string, unknown>);
    expect(again).toEqual({ text: prepared.text, hash: prepared.hash, clauseIds: prepared.clauseIds });
    expect(storedVariables(prepared.documentVariables, prepared.answers, prepared.clauseIds, false)).toEqual(
      prepared.stored,
    );
  });
});

describe("mail-address", () => {
  test("converts a domain, refuses a mailbox name it cannot write, and says why", () => {
    expect(asciiRecipient("a@münchen.test")).toBe("a@xn--mnchen-3ya.test");
    expect(isSendableAddress("ä@example.test")).toBe(false);
    expect(recipientProblem("ä@example.test")).toBe("local_part");
    expect(recipientProblem("not-an-address")).toBe("not_single_address");
    expect(recipientProblem("a@-bad.test")).toBe("domain");
    expect(recipientProblem("a@example.test\r\nBcc: x@y.test")).toBe("header_break");
    expect(recipientProblem("  a@example.test ")).toBeNull();
  });
});

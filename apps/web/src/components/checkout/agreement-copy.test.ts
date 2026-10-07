import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { AgreementResult } from "./AgreementStep";
import { AgreementCopyLink } from "./CheckoutFlow";

/**
 * The buyer leaves with their contract, including on the day the PDF does not.
 *
 * This block sits on the last screen before payment, and every branch in it
 * except the happy one is a branch nobody sees until something upstream is
 * already broken: apps/app down, a render refused because the stored record
 * failed its own integrity check, a cookie that went stale while the buyer read
 * the plans, a request this browser gave up on. The requirement is the same in
 * all of them, and it is not "show an error": it is that the agreement is still
 * one click away, that the click still goes to a real link a keyboard can
 * reach, and that the swap is admitted rather than performed quietly.
 *
 * Rendered to static markup and read as text, the way the admin honesty rules
 * are: there is no DOM here and no testing library, because the question is
 * never "did a div appear", it is "is what this offers the buyer true".
 */

const SIGNED: AgreementResult = {
  agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
  version: "1.0.0",
  hash: "a".repeat(64),
  text: "HEALDESK BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions...",
  acceptedAt: "2026-09-08T10:00:00.000Z",
  approvedByCounsel: true,
};

function markup(
  props: Partial<Parameters<typeof AgreementCopyLink>[0]> = {},
): string {
  return renderToStaticMarkup(
    h(AgreementCopyLink, {
      agreement: SIGNED,
      unavailable: false,
      pending: false,
      onPdfClick: () => undefined,
      ...props,
    }),
  );
}

describe("the PDF, while there is one to be had", () => {
  test("the link points at the route, which answers only the signing session", () => {
    const html = markup();
    expect(html).toContain(`href="/api/agreement/pdf?id=${SIGNED.agreementId}"`);
    expect(html).toContain('download="healdesk-baa-1.0.0.pdf"');
    expect(html).toContain("Download the copy you signed");
  });

  test("nothing is claimed about a fallback that has not happened", () => {
    expect(markup()).not.toContain("plain text version");
  });

  test("waiting says so on the link rather than on a spinner elsewhere", () => {
    const html = markup({ pending: true });
    expect(html).toContain("Preparing your copy…");
    expect(html).toContain('aria-busy="true"');
    // Still the same anchor, still with somewhere to go, so a second Enter
    // cannot leave a keyboard user on a dead control.
    expect(html).toContain('href="/api/agreement/pdf?');
  });
});

describe("and the text copy, on every day the PDF fails", () => {
  test("the href becomes the stored text the server hashed", () => {
    const html = markup({ unavailable: true });
    expect(html).toContain('href="data:text/plain;charset=utf-8,');
    expect(html).toContain(encodeURIComponent("HEALDESK BUSINESS ASSOCIATE"));
    expect(html).toContain('download="healdesk-baa-1.0.0.txt"');
    // Never a PDF link once we know a PDF is not coming.
    expect(html).not.toContain("/api/agreement/pdf");
  });

  test("it is still an anchor with an href, so the keyboard still reaches it", () => {
    const html = markup({ unavailable: true });
    expect(html).toMatch(/<a [^>]*href="data:text\/plain/);
    // No handler is attached in the fallback, so Enter is the browser's own
    // download and cannot be intercepted into a second failure.
    expect(html).toContain("Download the copy you signed");
  });

  test("the swap is admitted, and not dressed up as an error", () => {
    const html = markup({ unavailable: true });
    // This only ever renders after a click that produced nothing, so it says
    // so. A buyer who reads a swap notice as "the download happened, just in
    // another format" walks on to the payment step holding no copy at all.
    expect(html).toContain("nothing was downloaded");
    expect(html).toContain("Use the link again for the plain text version.");
    expect(html).toContain("It is word for word what you signed");
    // Not an error, and never blames the buyer.
    expect(html).not.toMatch(/error|failed|sorry/i);
    // The house forbids an em dash in anything the buyer reads.
    expect(html).not.toContain("—");
  });

  test("a Data Protection Agreement downloads under its own name, without its version's namespace", () => {
    const dpa = { ...SIGNED, version: "dpa/1.0.0" };
    const pdf = markup({ agreement: dpa, fileStem: "healdesk-dpa" });
    expect(pdf).toContain('download="healdesk-dpa-1.0.0.pdf"');
    const text = markup({ agreement: dpa, fileStem: "healdesk-dpa", unavailable: true });
    expect(text).toContain('download="healdesk-dpa-1.0.0.txt"');
    // A path separator never reaches a file name.
    expect(pdf + text).not.toMatch(/download="[^"]*\//);
  });

  test("an agreement with no id is offered as text from the start", () => {
    // Nothing to ask the server for, so a PDF link here would be a link that
    // is certain to 401 the moment it is pressed.
    const html = markup({
      agreement: { ...SIGNED, agreementId: "" },
      unavailable: false,
    });
    expect(html).toContain('href="data:text/plain;charset=utf-8,');
    expect(html).not.toContain("/api/agreement/pdf");
  });
});

describe("the announcement", () => {
  test("the live region is in the document before it has anything to say", () => {
    // A role="status" element created in the same commit as its first sentence
    // is, on most screen readers, a sentence nobody hears. So it is rendered
    // empty and filled later, and this is the assertion that keeps it that way.
    const html = markup();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<p role="status" aria-live="polite"><\/p>/);
  });

  test("and it is the thing that carries the sentence when there is one", () => {
    expect(markup({ unavailable: true })).toMatch(
      /<p role="status" aria-live="polite"[^>]*>We couldn(&#x27;|')t produce the PDF/,
    );
  });
});

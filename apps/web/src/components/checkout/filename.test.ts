import { describe, expect, test } from "vitest";

import { filenameFrom } from "./CheckoutFlow";

/**
 * The name on the file the buyer keeps.
 *
 * Two slices of this feature each had an opinion about it. The download route
 * echoes the renderer's own `healdesk-baa-<version>-<date>.pdf` in
 * `Content-Disposition`; the checkout intercepts the click, which is precisely
 * what makes the anchor's `download` attribute win instead. So on the one path
 * that matters the client had the last word on a name the server had already
 * chosen, and the two were free to drift with nothing to catch it.
 *
 * `filenameFrom` settles that by asking. What is defended here is that it asks
 * safely: the header is same-origin and already sanitised once, and this is the
 * second pass, because the value becomes a name on somebody's disk.
 */
const FALLBACK = "healdesk-baa-1.0.0.pdf";

describe("the server's name wins", () => {
  test("the renderer's filename is taken verbatim", () => {
    expect(
      filenameFrom(
        'attachment; filename="healdesk-baa-1.0.0-2026-09-08.pdf"',
        FALLBACK,
      ),
    ).toBe("healdesk-baa-1.0.0-2026-09-08.pdf");
  });

  test("an unquoted filename is read too", () => {
    expect(
      filenameFrom("attachment; filename=healdesk-baa-2.0.0-2027-01-01.pdf", FALLBACK),
    ).toBe("healdesk-baa-2.0.0-2027-01-01.pdf");
  });
});

describe("and it is never trusted", () => {
  test("no header at all falls back", () => {
    expect(filenameFrom(null, FALLBACK)).toBe(FALLBACK);
    expect(filenameFrom("attachment", FALLBACK)).toBe(FALLBACK);
    expect(filenameFrom('attachment; filename=""', FALLBACK)).toBe(FALLBACK);
  });

  test("a path cannot survive as one", () => {
    expect(filenameFrom('attachment; filename="../../etc/passwd.pdf"', FALLBACK)).toBe(
      "passwd.pdf",
    );
    expect(
      filenameFrom('attachment; filename="C:\\\\Windows\\\\evil.pdf"', FALLBACK),
    ).toBe("evil.pdf");
  });

  test("a leading dot or dash is stripped, so the file is neither hidden nor a flag", () => {
    expect(filenameFrom('attachment; filename=".hidden.pdf"', FALLBACK)).toBe(
      "hidden.pdf",
    );
    expect(filenameFrom('attachment; filename="--rf.pdf"', FALLBACK)).toBe("rf.pdf");
  });

  test("anything that is not a .pdf falls back rather than being renamed into one", () => {
    // The bytes were checked as a PDF upstream; a name claiming otherwise means
    // the header and the body disagree, and the header is the one we discard.
    expect(filenameFrom('attachment; filename="agreement.html"', FALLBACK)).toBe(
      FALLBACK,
    );
    expect(filenameFrom('attachment; filename="....."', FALLBACK)).toBe(FALLBACK);
  });

  test("the name is bounded", () => {
    const long = `attachment; filename="${"a".repeat(400)}.pdf"`;
    expect(filenameFrom(long, FALLBACK).length).toBeLessThanOrEqual(120);
  });

  test("a name that survives sanitising is still only ever a plain name", () => {
    const out = filenameFrom(
      'attachment; filename="he ll\r\no; drop.pdf"',
      FALLBACK,
    );
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

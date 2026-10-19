import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * The two pages a clinic signs WhatsApp up from: the mailed link's
 * (/channels/whatsapp/[token]) and the portal's (/c/[slug]/whatsapp). Set-up
 * copy describes the step, never how long it takes (CLAUDE.md, "Claims and
 * copy"), and the two say the same thing about the same sign-up.
 */

const PAGES = ["src/app/channels/whatsapp/[token]/page.tsx", "src/app/c/[slug]/whatsapp/page.tsx"];

describe("the WhatsApp sign-up pages", () => {
  test.each(PAGES)("%s says what to have to hand, and no time", (path) => {
    const source = readFileSync(join(process.cwd(), path), "utf8");
    expect(source).toContain("WhatsApp is set up in a window from Meta. Have these to hand:");
    expect(source).not.toMatch(/\b(?:a|one|two|three|four|five|ten|fifteen|\d+)(?:\s+to\s+\w+)?[\s-]+minutes?\b/i);
  });
});

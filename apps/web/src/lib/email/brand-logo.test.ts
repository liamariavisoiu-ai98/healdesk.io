import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EMAIL_LOGO } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

/**
 * Every healdesk email, from both apps, shows the logo from this site
 * (EMAIL_LOGO in @healdesk/catalog's email-brand.ts, owner, 1 November 2026).
 * The file lives in public/, so renaming, deleting or re-exporting it at
 * another size breaks every email already sitting in an inbox: these pin it.
 */

const PUBLIC = join(process.cwd(), "public");

describe("the email logo this site serves", () => {
  const url = new URL(EMAIL_LOGO.url);
  const file = readFileSync(join(PUBLIC, decodeURIComponent(url.pathname)));

  test("is served from public/ at the path every email names", () => {
    expect(url.origin).toBe("https://healdesk.io");
    expect(file.length).toBeGreaterThan(0);
  });

  test("is a PNG, which every mail client shows (none shows WebP)", () => {
    expect([...file.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("is twice the size the emails show it at, for sharp type on retina screens", () => {
    // The IHDR chunk: width and height, big-endian, at bytes 16 and 20.
    expect(file.readUInt32BE(16)).toBe(EMAIL_LOGO.width * 2);
    expect(file.readUInt32BE(20)).toBe(EMAIL_LOGO.height * 2);
  });

  test("stays small: fetched each time an email opens", () => {
    expect(file.length).toBeLessThan(40 * 1024);
  });
});

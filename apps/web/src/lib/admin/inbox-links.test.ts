import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { CARD_ANCHORS, ISSUE_TABS, SYSTEM_ANCHORS } from "./issue-link";

/**
 * Every console address apps/app's inbox sources carry (lib/ops/inbox/*.ts:
 * the Home rows' buttons and the constants they are built from) opens a page
 * that exists in this app and, where it names an anchor, a section that some
 * component on that route renders with that id. Read out of apps/app's
 * source text rather than imported (the PHI boundary: apps/web imports
 * nothing from apps/app), the way lane A4's tests read its constants. A row
 * that opens a page this app does not have, or an anchor nothing renders, is
 * a dead click from the one list the operator works from; this fails first.
 *
 * A template's clinic id becomes a uuid; any other `${...}` segment (the
 * health flags' tab) is tried as every tab, a superset of what apps/app sends.
 */

const APP = join(__dirname, "..", "..", "app");
const INBOX = join(__dirname, "..", "..", "..", "..", "app", "src", "lib", "ops", "inbox");
const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}

/** Every `/admin/...` address in apps/app's inbox sources, templates expanded. */
function inboxHrefs(): string[] {
  const hrefs = new Set<string>();
  for (const name of readdirSync(INBOX)) {
    if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
    const source = readFileSync(join(INBOX, name), "utf8");
    for (const m of source.matchAll(/"(\/admin\/[^"\s]*)"/g)) hrefs.add(m[1]!);
    for (const m of source.matchAll(/`(\/admin\/[^`]*)`/g)) {
      const template = m[1]!.replace(/\/admin\/clinics\/\$\{[^}]*\}/, `/admin/clinics/${CLINIC}`);
      if (!template.includes("${")) {
        hrefs.add(template);
        continue;
      }
      for (const tab of ISSUE_TABS) hrefs.add(template.replace(/\$\{[^}]*\}/g, tab));
    }
  }
  return [...hrefs].sort();
}

/** The href is a console page: under /admin/, a page.tsx that is not a redirect, and an anchor some component on the route renders. */
function expectConsolePage(href: string): void {
  expect(href.startsWith("/admin/"), href).toBe(true);
  const [path, anchor] = href.split("#") as [string, string | undefined];
  const segments = path.split("/").filter(Boolean).map((seg) => (UUID_SEGMENT.test(seg) ? "[clinicId]" : seg));
  const dir = join(APP, ...segments);
  const page = join(dir, "page.tsx");
  expect(existsSync(page), `${href}: no page at ${page}`).toBe(true);
  expect(readFileSync(page, "utf8"), `${href} is a retired address`).not.toMatch(/permanentRedirect\(/);
  if (anchor) {
    expect(
      sourcesUnder(dir).some((text) => text.includes(`id="${anchor}"`)),
      `${href}: no element with id="${anchor}"`,
    ).toBe(true);
  }
}

describe("the addresses apps/app's inbox sources carry", () => {
  const hrefs = inboxHrefs();

  test("are read in full: the Phase 5 rows' addresses are among them", () => {
    expect(hrefs.length).toBeGreaterThan(8);
    expect(hrefs).toContain("/admin/system#attention");
    expect(hrefs).toContain("/admin/system#transcripts");
    expect(hrefs).toContain("/admin/system/jobs");
    expect(hrefs).toContain(`/admin/clinics/${CLINIC}/deliveries`);
    expect(hrefs).toContain(`/admin/clinics/${CLINIC}/setup#setup-window`);
  });

  test("each opens a page that exists and an anchor that is rendered", () => {
    for (const href of hrefs) expectConsolePage(href);
  });

  test("the guard catches a retired address and a missing anchor", () => {
    expect(() => expectConsolePage(`/admin/ops/${CLINIC}/care`)).toThrow();
    expect(() => expectConsolePage("/admin/system#no-such-section")).toThrow();
  });

  test("the anchors this app's own hash map names are rendered on their pages", () => {
    const setup = join("admin", "clinics", "[clinicId]", "setup");
    const where: Record<(typeof CARD_ANCHORS)[number], string> = {
      availability: setup,
      "setup-window": setup,
      voice: setup,
      "calendar-writes": setup,
      reminders: join("admin", "clinics", "[clinicId]", "deliveries"),
    };
    for (const anchor of CARD_ANCHORS) {
      expect(sourcesUnder(join(APP, where[anchor])).some((text) => text.includes(`id="${anchor}"`)), anchor).toBe(true);
    }
    for (const anchor of SYSTEM_ANCHORS) {
      expect(sourcesUnder(join(APP, "admin", "system")).some((text) => text.includes(`id="${anchor}"`)), anchor).toBe(true);
    }
  });
});

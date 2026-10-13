import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import DataDeletionPage from "@/app/data-deletion/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { LEGAL_LAST_UPDATED, LEGAL_VERSION } from "@/lib/legal";

/**
 * A legal page cannot change without a new version.
 *
 * Every legal page prints LEGAL_VERSION and LEGAL_LAST_UPDATED at its foot,
 * so a clinic can say which text it agreed to. That holds only if the version
 * moves whenever the text does, and on 1 October 2026 it did not: a4c8e7e
 * changed terms § 9 and /subprocessors and left the version alone, so two
 * different texts went out under one number.
 *
 * /subprocessors and /trust were pinned here too until 9 October 2026, when
 * the owner retired them: the vendor list is no longer published, and /trust's
 * content is the terms' closing annex, which this pin covers with the rest of
 * the terms.
 *
 * So the text of each page is hashed and pinned here beside the version it
 * was published under. Change a page and its hash moves, and this fails until
 * the version is bumped and the new hash pinned, in the same commit. The text
 * is everything inside <main> except the version line itself, read the way
 * terms-copy.test.ts reads it: tags out, entities decoded, whitespace
 * collapsed, so a class name or a wrapper element is not a change and a word
 * is. The navbar and the footer are outside <main> and outside the pin: they
 * change for reasons of their own, and the footer prints the current year.
 *
 * Everything a page renders counts, including what it reads from elsewhere:
 * a price in packages/catalog/src/plans.ts is a term of the contract, and
 * changing one changes the terms.
 */

const PINNED = {
  version: "2026-10-13.3",
  lastUpdated: "13 October 2026",
  /**
   * The version these pages replace: the last one that went out, which was
   * main's live text when this one was numbered. A note may cite it, an earlier
   * version or `version` above, and no other (the last test in this file).
   * Move it to the old version when you bump one that went out. Leave it alone
   * when you renumber a version that never did, because that number was never
   * published.
   */
  replaces: "2026-10-13.2",
  sha256: {
    "/terms": "214a0ad3b882fdfda8b22ca497d504b076b1a8c173fd4ecdf7b2d62e806e9310",
    "/privacy": "09bd029fb37aef18efd3dc4f04250563026354b1b0d90c0fdbd53ff6babcc0de",
    "/data-deletion": "9752f82fd6a7ba423a3c5731af43a461dc9fe64645fabedeff981da79abd4745",
  },
} as const;

const PAGES = [
  ["/terms", TermsPage],
  ["/privacy", PrivacyPage],
  ["/data-deletion", DataDeletionPage],
] as const;

function legalText(Page: () => React.ReactElement): string {
  const markup = renderToStaticMarkup(h(Page));
  const main = markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
  return main
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(`Version ${LEGAL_VERSION} · last updated ${LEGAL_LAST_UPDATED}`, "")
    .trim();
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the legal pages carry the version their text was published under", () => {
  test("the pins below were taken at the version the pages print", () => {
    expect(
      { version: LEGAL_VERSION, lastUpdated: LEGAL_LAST_UPDATED },
      "LEGAL_VERSION or LEGAL_LAST_UPDATED in src/lib/legal.ts moved, and the pins in src/lib/legal-version.test.ts did not. Set PINNED.version and PINNED.lastUpdated to match, and pin each page's hash at the new version. If the old version went out, set PINNED.replaces to it.",
    ).toEqual({ version: PINNED.version, lastUpdated: PINNED.lastUpdated });
  });

  test.each(PAGES)("%s has the text pinned for its version", (path, Page) => {
    const text = legalText(Page);
    // A page that failed to render would hash too; make sure it did not.
    expect(text).toContain(`questions to`);
    expect(text.length).toBeGreaterThan(1_000);
    const actual = sha256(text);
    expect(
      actual,
      `The text of ${path} no longer matches the hash pinned for version ${PINNED.version}. ` +
        `A legal page may not change under an old version: bump LEGAL_VERSION and LEGAL_LAST_UPDATED ` +
        `in src/lib/legal.ts, then update the pinned hash for ${path} in src/lib/legal-version.test.ts ` +
        `to ${actual} (and PINNED.version and PINNED.lastUpdated to the new version).`,
    ).toBe(PINNED.sha256[path]);
  });
});

/**
 * A note that names a legal version names one the pages went out under.
 *
 * The counsel notes and the comments beside the pages' text say which version
 * made a change ("Terms 2026-10-07.1 drop the exception"), so that a reader can
 * find the text a decision went out in. A text is numbered before it goes out,
 * and the number can change before it does. This one was numbered 2026-10-06.5,
 * then 2026-10-07.1 when it missed 6 October. The comments moved with it, but
 * the counsel note on the guarantee kept the old number, which no page will
 * ever print.
 *
 * So every dated version in docs/counsel, and every `LEGAL_VERSION <version>`
 * in this app's sources, must be the version the pages print, or
 * PINNED.replaces or earlier. Tests are left out: a fixture may carry any
 * version, a stale one on purpose.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const COUNSEL = fileURLToPath(new URL("../../../../docs/counsel", import.meta.url));

/** Any dated version. The counsel notes have nothing else in this shape. */
const ANY_VERSION = /\b\d{4}-\d{2}-\d{2}\.\d+\b/g;
/** Only an explicit citation, because the consent versions in src share the shape. */
const LEGAL_VERSION_CITED = /\bLEGAL_VERSION`?\s+`?(\d{4}-\d{2}-\d{2}\.\d+)\b/g;

function citedVersions(): Array<{ file: string; version: string }> {
  const cited: Array<{ file: string; version: string }> = [];
  for (const file of readdirSync(COUNSEL, { recursive: true }) as string[]) {
    if (!file.endsWith(".md")) continue;
    for (const match of readFileSync(join(COUNSEL, file), "utf8").matchAll(ANY_VERSION)) {
      cited.push({ file: `docs/counsel/${file}`, version: match[0] });
    }
  }
  for (const file of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    for (const match of readFileSync(join(SRC, file), "utf8").matchAll(LEGAL_VERSION_CITED)) {
      cited.push({ file: `apps/web/src/${file}`, version: match[1] ?? "" });
    }
  }
  return cited;
}

/** The day, then the number, so that .10 sorts after .9. */
function sortable(version: string): string {
  const [day = "", n = ""] = version.split(".");
  return `${day}.${n.padStart(4, "0")}`;
}

describe("a note that names a legal version names one the pages went out under", () => {
  test("docs/counsel and this app's sources cite this version or one that went out", () => {
    const cited = citedVersions();
    expect(cited.length, "The scan found no cited version: it is broken.").toBeGreaterThan(0);
    const neverPublished = cited.filter(
      ({ version }) => version !== LEGAL_VERSION && sortable(version) > sortable(PINNED.replaces),
    );
    expect(
      neverPublished,
      `These name a version no legal page went out under. The pages print ${LEGAL_VERSION}, and ` +
        `the version before it was ${PINNED.replaces}. A number this text carried before it went ` +
        `out was never published, so name ${LEGAL_VERSION} instead. If a version named here did ` +
        `go out, set PINNED.replaces in src/lib/legal-version.test.ts to it.`,
    ).toEqual([]);
  });
});

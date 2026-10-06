import { createHash } from "node:crypto";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import DataDeletionPage from "@/app/data-deletion/page";
import PrivacyPage from "@/app/privacy/page";
import SubprocessorsPage from "@/app/subprocessors/page";
import TermsPage from "@/app/terms/page";
import TrustPage from "@/app/trust/page";
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
  version: "2026-10-07.1",
  lastUpdated: "7 October 2026",
  sha256: {
    "/terms": "ebe445a386546e55454a77e90bd2cc51bd1e0bc05cad575a264ea438e8809cac",
    "/privacy": "4d9448b6ad8560bf35adc243545522b7acdbb2c2882d40647845b991002f92c4",
    "/subprocessors": "422ca0fb5b523151eec403f316dcaf4108aea3c057ccff6d231c7e4b7efd8cae",
    "/trust": "3afd18cd5d363f861bca400dea22b94b952b069a2459f6cbeb82cfb9f5b52691",
    "/data-deletion": "c176eca3132e36d15ee7924b829b7d8c70c30e655bb1a068606d10289b1531be",
  },
} as const;

const PAGES = [
  ["/terms", TermsPage],
  ["/privacy", PrivacyPage],
  ["/subprocessors", SubprocessorsPage],
  ["/trust", TrustPage],
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
      "LEGAL_VERSION or LEGAL_LAST_UPDATED in src/lib/legal.ts moved, and the pins in src/lib/legal-version.test.ts did not. Set PINNED.version and PINNED.lastUpdated to match, and pin each page's hash at the new version.",
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

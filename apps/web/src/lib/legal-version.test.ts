import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BAA_1_6_0_RELEASED, BAA_1_7_0_RELEASED } from "@healdesk/catalog";
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

/**
 * The text if BAA 1.6.0 were not released (BAA_1_6_0_RELEASED false in
 * packages/catalog/src/baa.ts). It is hypothetical now: 1.6.0 went out with
 * 2026-10-29.4, and the flag cannot go back without a new version. Its pins
 * still match what the pages render with the flag off, so turning the flag
 * off fails here only if the text moved. From 2026-10-30.1 both sides carry
 * one number (LEGAL_VERSION no longer reads the flag), and `replaces` is the
 * live text on either side. Before that this side was 2026-10-29.3, which
 * never went out.
 */
const PINNED_BEFORE_1_6_0 = {
  version: "2026-10-30.2",
  lastUpdated: "30 October 2026",
  /**
   * The version these pages replace: the last one that went out, which was
   * main's live text when this one was numbered. A note may cite it, an earlier
   * version or `version` above, and no other (the last test in this file).
   * Move it to the old version when you bump one that went out. Leave it alone
   * when you renumber a version that never did, because that number was never
   * published.
   */
  replaces: "2026-10-30.1",
  sha256: {
    // 2026-10-30.2: section 8's "Payment-link texts" softened and section 3's
    // "provisional" sentence dropped, without 1.6.0's section 9 sentence.
    "/terms": "2917808c14d1199bae75982aaecb0432e4837c8a7e81b1f701ab2cfad123309d",
    // Privacy does not read the flag: the same text as on the 1.6.0 side.
    "/privacy": "82ff31ac73c289db7b2565be604f7162c0ad24b414ddc272ee5cce5decd6aff2",
    "/data-deletion": "d77557279849e427006387afa3c427ee976e10be5afd29cbba04a7356afd1042",
  },
} as const;

/**
 * The text once BAA 1.6.0 is released (BAA_1_6_0_RELEASED in
 * packages/catalog/src/baa.ts): terms section 9 says "The Business Associate
 * Agreement states the same" again, and LEGAL_VERSION was 2026-10-29.4
 * (numbered 2026-10-28.2, then 2026-10-28.4, before the payment-text wording
 * took 2026-10-29.1, then 2026-10-29.2 before the Meta deposit-link wording
 * took 2026-10-29.3; none of those numbers went out). 2026-10-29.4 went live
 * on 29 October 2026. 2026-10-29.5 added the 30-day missed-contact record to
 * Privacy § 6, and went live. 2026-10-30.1 softens terms section 8's
 * "Payment-link texts" (owner, 30 October 2026): no carrier registration or
 * "one to four weeks" promised. Privacy and the deletion page are word for
 * word the same, and went live. 2026-10-30.2 also drops terms section 3's
 * "provisional until we have measured what that usage costs to serve" (owner,
 * 30 October 2026); Privacy and the deletion page are word for word the same.
 * `replaces` records the live text this one replaces: 2026-10-30.1.
 */
const PINNED_WITH_1_6_0 = {
  version: "2026-10-30.2",
  /**
   * Written out, not copied from the pin above: LEGAL_LAST_UPDATED in
   * src/lib/legal.ts and this value move together (the page prints it,
   * outside the hash). "30 October 2026" is what legal.ts says today.
   */
  lastUpdated: "30 October 2026",
  /**
   * 2026-10-30.1 is the live text this one replaces (healdesk.io/terms printed
   * it on 30 October 2026, checked when 2026-10-30.2 was numbered).
   */
  replaces: "2026-10-30.1",
  sha256: {
    ...PINNED_BEFORE_1_6_0.sha256,
    // 2026-10-30.2: section 8's "Payment-link texts" softened (2026-10-30.1),
    // and section 3 no longer calls the block prices provisional.
    "/terms": "ca53cfbe4da6da82471f80b353297953757755c4f3cdb228e6cfe132d325d893",
    // Since 2026-10-29.5: Privacy § 6 lists the 30-day missed-contact record.
    "/privacy": "82ff31ac73c289db7b2565be604f7162c0ad24b414ddc272ee5cce5decd6aff2",
  },
} as const;

/**
 * The text once BAA 1.7.0 and DPA 1.2.0 are released (BAA_1_7_0_RELEASED;
 * the owner's release of 30 October 2026, landed 1 November 2026): Terms'
 * security annex and Privacy § 9 say a breach or security incident is
 * reported in no case later than 10 calendar days after discovery, where
 * 2026-10-30.2 said 60. Nothing else moves, and the deletion page is word for
 * word the same. Its branch numbered it 2026-10-30.1, which main had already
 * published for other text, so it carries 2026-11-01.1.
 */
const PINNED_WITH_1_7_0 = {
  version: "2026-11-01.1",
  lastUpdated: "1 November 2026",
  /** 2026-10-30.2 is the live text this one replaces. */
  replaces: "2026-10-30.2",
  sha256: {
    ...PINNED_WITH_1_6_0.sha256,
    // 2026-10-30.2's text with the security annex's 60 calendar days said
    // as 10, and nothing else (checked by swapping the number back: the
    // hash is 2026-10-30.2's).
    "/terms": "be63612cbc961b21af9554f094b0b20ba9d05b08e97a25d1bde6002dcea37ff1",
    // Privacy § 9 with 10 for 60, and nothing else; the same text the
    // branch pinned for its 2026-10-30.1.
    "/privacy": "4540676f387dc1a097c28f1019a696ac2f28f4723fb6c9bf3b558301a0193abd",
  },
} as const;

const PINNED = BAA_1_7_0_RELEASED
  ? PINNED_WITH_1_7_0
  : BAA_1_6_0_RELEASED
    ? PINNED_WITH_1_6_0
    : PINNED_BEFORE_1_6_0;

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

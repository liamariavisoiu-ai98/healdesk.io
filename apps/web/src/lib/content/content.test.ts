import { describe, expect, it } from "vitest";

import { glossary, glossaryReviewed, glossarySources } from "@/lib/content/glossary";
import { plain } from "@/lib/content/inline";
import { allPieces } from "@/lib/content/registry";
import type { Block, Piece, Source } from "@/lib/content/types";

/**
 * The editorial pages' two guards, beside the copy guard in
 * lib/site-copy.test.ts, which already reads every string here for the
 * claims the product may never make.
 *
 * ## Evidence
 *
 * Every citation resolves to a listed source, every listed source is cited,
 * and every source was opened within the last twelve months. That last check
 * runs against the real clock on purpose: a figure nobody has rechecked in a
 * year fails the build until somebody opens the page again and either moves
 * its `checked` date or fixes the sentence (strategy, "Technical
 * foundations", change 4).
 *
 * ## House style
 *
 * The banned words, openers and tics are the strategy's "Never in the copy"
 * list, and the sentence limit is its "none over 35". Tables, lists and
 * quotations are exempt from the length limit: a statute's words are not
 * ours to shorten, and a table cell is not a sentence.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

const BANNED: readonly { pattern: RegExp; label: string; proseOnly?: boolean }[] = [
  { pattern: /\bin today's\b/i, label: "opener 'In today's'" },
  { pattern: /^imagine\b/i, label: "opener 'Imagine'" },
  { pattern: /\blet's dive in\b|\bhere's the thing\b/i, label: "a delaying opener" },
  {
    pattern:
      /\bgame[\s-]?changer|\brevolutionary\b|\bcutting[\s-]edge\b|\bseamless(?:ly)?\b|\bunlock(?:s|ed|ing)?\b|\belevate[sd]?\b|\bempower(?:s|ed|ing)?\b|\bleverag(?:e|es|ed|ing)\b|\bsupercharg|\brobust\b|\bdelve|\blandscape\b|\bthe future of\b/i,
    label: "a hype word",
  },
  { pattern: /\bspoiler\b|\bplot twist\b|\byes, really\b/i, label: "a tic" },
  {
    pattern: /\bthe best\b|\bbest[\s-]in[\s-]class\b|#1\b|\bmost advanced\b|\b(?:industry[\s-])?leading (?!to\b)/i,
    label: "a superlative nobody measured",
  },
  { pattern: /\byou'?re losing money\b|\bdon'?t get left behind\b/i, label: "pressure" },
  // Ours only: a product line or a statute quoted verbatim in a table keeps its own punctuation.
  { pattern: /!/, label: "an exclamation mark", proseOnly: true },
  { pattern: /\p{Extended_Pictographic}/u, label: "an emoji" },
];

/**
 * Split prose into sentences without breaking at the abbreviations legal
 * writing is full of: "Cal. Penal Code", "18 U.S.C. § 2511", "Kearney v.
 * Salomon", "N.D. Cal.". A full stop ends a sentence only when the word
 * before it is not a short capitalised abbreviation, not dotted, and not "v".
 * "healdesk" starts a sentence in lower case, as the house style writes it.
 */
function sentences(text: string): string[] {
  const source = plain(text);
  const out: string[] = [];
  let start = 0;
  for (const match of source.matchAll(/[.?!]["”)]?\s+(?=["“(]?(?:[A-Z0-9]|healdesk\b))/g)) {
    const before = source.slice(start, match.index).split(/\s+/).at(-1) ?? "";
    const abbreviation = /^[A-Z][a-z]{0,2}$/.test(before) || /\.[A-Za-z]/.test(before) || before === "v" || before === "vs";
    if (match[0].startsWith(".") && abbreviation) continue;
    out.push(source.slice(start, match.index + 1));
    start = match.index + match[0].length;
  }
  out.push(source.slice(start));
  return out.map((sentence) => sentence.trim()).filter(Boolean);
}

function words(sentence: string): number {
  return sentence.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/** Every string a reader sees, with where it sits, and whether the sentence limit applies. */
function textsOf(piece: Piece): { where: string; text: string; prose: boolean }[] {
  const out: { where: string; text: string; prose: boolean }[] = [
    { where: "title", text: piece.title, prose: false },
    { where: "description", text: piece.description, prose: true },
    { where: "answer", text: piece.answer, prose: true },
  ];
  piece.aya.forEach((text, i) => out.push({ where: `aya[${String(i)}]`, text, prose: true }));
  for (const section of piece.sections) {
    out.push({ where: `${section.id} heading`, text: section.heading, prose: false });
    section.blocks.forEach((block, i) => out.push(...blockTexts(block, `${section.id}[${String(i)}]`)));
  }
  return out;
}

function blockTexts(block: Block, where: string): { where: string; text: string; prose: boolean }[] {
  switch (block.kind) {
    case "p":
    case "note":
      return [{ where, text: block.text, prose: true }];
    case "h3":
      return [{ where, text: block.text, prose: false }];
    case "list":
      return block.items.map((text, i) => ({ where: `${where}.${String(i)}`, text, prose: false }));
    case "table":
      return [
        { where: `${where} caption`, text: block.caption, prose: false },
        ...block.head.map((text, i) => ({ where: `${where} head ${String(i)}`, text, prose: false })),
        ...block.rows.flatMap((row, r) =>
          row.map((text, c) => ({ where: `${where} ${String(r)}:${String(c)}`, text, prose: false })),
        ),
      ];
    case "quote":
      return [{ where, text: block.text, prose: false }];
  }
}

function citesOf(piece: Piece): string[] {
  return piece.sections.flatMap((section) =>
    section.blocks.flatMap((block) => {
      if (block.kind === "quote") return [block.cite];
      if ("cite" in block && block.cite) return [...block.cite];
      return [];
    }),
  );
}

function checkSources(sources: readonly Source[], label: string): void {
  const ids = sources.map((source) => source.id);
  expect(new Set(ids).size, `${label}: duplicate source ids`).toBe(ids.length);
  for (const source of sources) {
    expect(source.url, `${label} ${source.id}: url`).toMatch(/^https:\/\//);
    expect(source.checked, `${label} ${source.id}: checked`).toMatch(ISO);
    const age = Date.now() - Date.parse(source.checked);
    expect(age, `${label} ${source.id}: checked in the future`).toBeGreaterThan(-YEAR_MS / 365);
    expect(age, `${label} ${source.id}: not rechecked in twelve months`).toBeLessThan(YEAR_MS);
  }
}

describe("editorial pieces", () => {
  const pieces = allPieces();

  it("have unique slugs", () => {
    const slugs = pieces.map((piece) => `${piece.family}/${piece.slug}`);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  for (const piece of pieces) {
    describe(piece.slug, () => {
      it("is dated, described within a search snippet, and answered at the top", () => {
        expect(piece.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(piece.published).toMatch(ISO);
        expect(piece.lastReviewed).toMatch(ISO);
        expect(piece.lastReviewed >= piece.published).toBe(true);
        expect(piece.description.length).toBeLessThanOrEqual(165);
        expect(sentences(piece.answer).length).toBeGreaterThanOrEqual(1);
        expect(sentences(piece.answer).length).toBeLessThanOrEqual(3);
        expect(piece.aya.length).toBeGreaterThanOrEqual(1);
        expect(piece.sections.length).toBeGreaterThan(0);
      });

      it("cites only listed sources, and lists only cited ones", () => {
        const cited = new Set(citesOf(piece));
        const listed = new Set(piece.sources.map((source) => source.id));
        for (const id of cited) expect(listed.has(id), `cites unknown source ${id}`).toBe(true);
        for (const id of listed) expect(cited.has(id), `lists uncited source ${id}`).toBe(true);
        checkSources(piece.sources, piece.slug);
      });

      it("keeps the house style", () => {
        for (const { where, text, prose } of textsOf(piece)) {
          for (const { pattern, label, proseOnly } of BANNED) {
            if (proseOnly && !prose) continue;
            expect(pattern.test(plain(text)), `${where}: ${label} in "${text}"`).toBe(false);
          }
          if (!prose) continue;
          for (const sentence of sentences(text)) {
            expect(words(sentence), `${where}: over 35 words: "${sentence}"`).toBeLessThanOrEqual(35);
          }
        }
      });

      it("says who checked it before it went live, if it is live and legal", () => {
        if (piece.stage === "live" && piece.legal) expect(piece.review ?? "").not.toBe("");
      });
    });
  }
});

describe("glossary", () => {
  it("defines each term once, in one sentence that stands on its own", () => {
    const terms = glossary.map((entry) => entry.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    for (const entry of glossary) {
      expect(sentences(entry.definition), entry.term).toHaveLength(1);
      expect(words(entry.definition), entry.term).toBeLessThanOrEqual(45);
      for (const { pattern, label } of BANNED) {
        expect(pattern.test(entry.definition), `${entry.term}: ${label}`).toBe(false);
      }
    }
  });

  it("cites only listed sources, opened within twelve months", () => {
    const listed = new Set(glossarySources.map((source) => source.id));
    for (const entry of glossary) for (const id of entry.cite ?? []) expect(listed.has(id), id).toBe(true);
    checkSources(glossarySources, "glossary");
    expect(glossaryReviewed).toMatch(ISO);
  });
});

import { createHash } from "node:crypto";

import { agreementKindOfVersion, DPA_VERSION_PREFIX } from "@healdesk/catalog";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import type { baaAcceptances } from "@/db/schema";

/**
 * A stored acceptance, rendered as a file the clinic can keep: a business
 * associate agreement, or a Data Protection Agreement, which shares the table
 * and this renderer and differs only in what the file calls itself (see
 * `DOCUMENT_NAMES`).
 *
 * Until this existed the counterparty to a HIPAA business associate agreement
 * held nothing: the signature lived in our database, the clinic had a screen
 * they had already navigated away from, and "can you produce the agreement"
 * had exactly one answer, ours. A contract only one side can produce is a bad
 * position in a dispute and an embarrassing one in an audit — of the clinic,
 * by their own regulator, over an agreement they signed with us.
 *
 * So this module turns a row of `baa_acceptances` into a PDF. What it does NOT
 * do is re-render the agreement from the template and the variables. The stored
 * `renderedText` is the evidence (see the column comment in db/schema.ts); this
 * lays that text out on pages and adds nothing to it. Wrapping and pagination
 * are the only transformations, because a page is finite. No reflow into
 * paragraphs, no re-styling of headings, no "improvements".
 *
 * ## Why pdf-lib and not a headless browser
 *
 * HTML-to-PDF via Chromium renders more beautifully and costs a ~300MB browser
 * download, a sandbox, and a second attack surface sitting inside the service
 * that holds signed agreements. Beauty is not the requirement here; a file that
 * can be produced years from now, from a dependency that is pure JavaScript and
 * does not execute anything it renders, is.
 *
 * ## Why the body is typeset and not transcribed
 *
 * This file used to set everything in Courier, on the argument that a monospace
 * page reads as a transcript rather than a typeset document and makes the
 * renderer's wrap points obvious to anyone comparing it against the stored
 * text. That argument does not survive contact with the reader. Nobody diffs a
 * contract by eye, and nothing about this file's fidelity was ever carried by
 * its letterforms: the mechanism that ties it to the record is the SHA-256 on
 * every page, and that works whatever the text is set in. What the typeface
 * actually decided is whether the first document a clinic owner and their
 * lawyer ever receive from healdesk looks like a contract or like a listing.
 *
 * So the body is Helvetica — of the fourteen standard PDF fonts it is the one
 * closest to the sans the brand is set in everywhere else, and a serif would
 * read as somebody's Word document. Courier is kept for exactly the places
 * where alignment is the meaning: the SHA-256 strings, and the label/value
 * columns of the record of assent. A hash in a proportional face is harder to
 * compare character by character, which is the one thing that string is for.
 *
 * The cost of proportional type is that the stored text stops lining itself up.
 * `renderedText` indents a clause body with two spaces and a lettered sub-item
 * with four, which cost nothing in a monospace face; drawn as spaces in
 * Helvetica the same indents would collapse to about half their depth and the
 * shape of the clause list would go with them. Leading whitespace is therefore
 * counted and turned into a measured x-offset instead of being drawn — see
 * INDENT_UNIT. Not one character of the text changes; where the line starts on
 * the page does.
 *
 * Both faces are standard PDF fonts, so neither is embedded. That is the same
 * constraint the [U+XXXX] substitution below exists to honour: no font binary
 * ships inside the service that holds the signed agreements.
 *
 * ## The wordmark
 *
 * Top right of every page, drawn as text in the two brand colours rather than
 * placed as an image — for the reason above, and because a logo asset is one
 * more binary to keep in step with a brand it does not know has changed. It is
 * set small and it sits well clear of the first baseline: this is a contract,
 * not a brochure, and nothing up there is worth crowding a clause for.
 *
 * ## The hash on every page is the point
 *
 * Every page footer carries the template version and the SHA-256 of the
 * agreement text. That single string is what lets someone holding only this PDF
 * — a clinic's lawyer, an OCR investigator, a court — ask us for the record and
 * check that the two are the same document, years after everyone involved has
 * left. It is the most valuable thing on the page, so it is on every page and
 * not only the last one, which is the page most likely to go missing.
 *
 * The hash is of the STORED TEXT, not of this file. A PDF cannot state its own
 * digest, and the wrapping here is not reversible — a line break in this file
 * may be a break in the source or one this renderer introduced — so nobody can
 * recompute the agreement hash from the PDF. The footer says so in words. The
 * digest of the file itself is returned as `AgreementPdf.sha256`, for the
 * caller to store next to the send.
 *
 * ## We refuse rather than assert something false
 *
 * Before rendering, the text is hashed and compared with the stored
 * `documentHash`. If they disagree the record is corrupt or has been tampered
 * with, and a PDF that prints a hash its own body does not produce would be
 * manufactured evidence — worse than no copy at all, because it looks like
 * proof. Same for an unparseable acceptance date: it dates the signature.
 *
 * ## Determinism
 *
 * Same acceptance in, byte-identical PDF out: the creation and modification
 * dates come from `acceptedAt` rather than the clock, the producer strings are
 * fixed, and nothing random is embedded (pdf-lib writes no trailer /ID). That
 * is what makes the returned `sha256` worth storing — a file whose bytes change
 * on every render cannot be checked against anything later.
 *
 * The guarantee is bounded by the pdf-lib version: an upgrade may lay the same
 * text out into different bytes. That is a property of every renderer, and it
 * is why the digest that identifies the AGREEMENT is over the text and not over
 * the file.
 *
 * So the dependency is pinned to an EXACT version in apps/app/package.json,
 * not to a caret range. `copy_document_sha256` is write-once and is the answer
 * to "what does the clinic actually hold": a patch release that moves one byte
 * would leave every re-render of an old acceptance disagreeing with the digest
 * already recorded, with nothing in the diff to say why. The lockfile pins the
 * installed tree, but the RANGE is what an `npm update`, a fresh resolution or
 * a dependency bot reads, so the range is where the bound has to be stated.
 * Widening it is a deliberate act with a consequence: from that point on, the
 * bytes may move and old digests may stop reproducing.
 *
 * The typography is under the same rule. Every constant below — the faces, the
 * type scale, the leading, the indent unit — is an input to those bytes, so
 * changing one re-paginates every re-render of every acceptance ever signed.
 */

/**
 * What this renderer needs from an acceptance.
 *
 * Derived from the table rather than re-declared, so renaming a column breaks
 * this file at compile time instead of quietly rendering a blank field. A full
 * `baaAcceptances` row satisfies it, which is what every caller has.
 */
export type BaaAcceptanceRecord = Pick<
  typeof baaAcceptances.$inferSelect,
  | "documentVersion"
  | "documentHash"
  | "renderedText"
  | "assentLabel"
  | "acceptedByName"
  | "acceptedByEmail"
  | "acceptedByTitle"
  | "ipAddress"
  | "userAgent"
  | "acceptedAt"
>;

export type AgreementPdf = {
  /** The file. */
  bytes: Uint8Array;
  /** Safe for a Content-Disposition header and a filesystem. Carries no PHI. */
  filename: string;
  /** SHA-256 of `bytes` — of the FILE. The agreement text has its own hash. */
  sha256: string;
};

/** US Letter. The clinics are American and so is the regulator. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
/** One inch, which is what a contract has. */
const MARGIN_X = 72;
/**
 * The top margin, and what lives in it.
 *
 * The wordmark's baseline sits 48pt down from the paper's edge and the first
 * line of text 78pt, which leaves the better part of two lines of air between
 * them. That gap is the whole reason the body starts lower than it used to:
 * a mark that has to be squeezed past by the opening clause is worse than no
 * mark at all.
 */
const WORDMARK_BASELINE = PAGE_HEIGHT - 48;
const WORDMARK_SIZE = 8.5;
const FIRST_BASELINE = PAGE_HEIGHT - 78;
/** Text stops here; the footer lives below it. */
const BODY_BOTTOM = 96;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

/**
 * The body, sized so the stored text fills the column it is given.
 *
 * `renderedText` is hard-wrapped at about seventy-eight characters and never
 * reflows, so the type block's right edge is set by the type size and by
 * nothing else. Courier at 9pt put those characters across 421 of a 504pt
 * measure. Helvetica is narrower: at 10.5pt the same line covers 383pt of a
 * 468pt column, leaving an inch and a fifth of white down the right of every
 * page — while the footer rule, the footer's own text, the section rule, the
 * wordmark and the record of assent all run the full measure. Two right edges
 * an inch apart on one page read as a text block that slipped left, not as a
 * margin.
 *
 * At 12pt the longest line covers 93% of the column and the two edges agree.
 * The measure in the sense that matters to a reader is unchanged — the source
 * decides the characters to a line, not the point size — so the larger face
 * buys the fit for nothing, and on the current template for no extra page.
 * The remaining 7% is headroom: a future revision with a longer line wraps
 * rather than reaching the margin, which is a rag, not a defect.
 */
const BODY_SIZE = 12;
const BODY_LEADING = 16;
const FOOTER_SIZE = 7.5;

/**
 * The record of assent, a size down from the body.
 *
 * Not a matter of taste. The widest row in that block is the label column plus
 * a 64-character SHA-256, and presenting that digest as one unbroken string is
 * the whole job of the row. LABEL_COLUMNS + 64 characters of Courier at 0.6em
 * each have to fit the measure, which caps this at 8.8pt for a 468pt column;
 * 8.5 leaves a character in hand. Set it larger and the hash wraps, which is
 * the one thing a hash must not do.
 */
const MONO_SIZE = 8.5;

/**
 * One leading space of the stored text, measured as width on the page.
 *
 * An en — half the body size — so a two-space clause body opens 12pt in, a
 * four-space lettered sub-item 24pt and its seven-space continuation 42pt.
 * Tied to the type scale rather than fixed, because an indent that did not
 * grow with the face would shrink as a proportion of the line and the clause
 * list would flatten the moment the body size moved.
 * Drawing the spaces instead would cut every one of those roughly in half:
 * Helvetica's space is 0.278em against Courier's 0.6em, and the clause list
 * would flatten towards a single left edge.
 */
const INDENT_UNIT = BODY_SIZE / 2;

/**
 * How far in the text may be pushed, whatever the source says.
 *
 * `renderedText` is a stored string. A line arriving with a hundred leading
 * spaces would otherwise be laid out in a column of negative width, which the
 * wrapper answers with one character per line and a document thousands of pages
 * long. Structure is worth honouring up to a quarter of the measure; past that
 * it is not structure.
 */
const MAX_INDENT = CONTENT_WIDTH / 4;

/** Characters of label column in the record-of-assent block. Monospace, so exact. */
const LABEL_COLUMNS = 24;

const INK = rgb(0, 0, 0);
const QUIET = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.6, 0.6, 0.6);

/**
 * The wordmark: `heal` then `desk`, set tight, lowercase.
 *
 * #e23a2a and #f47b1f, the same two values the console header and the
 * marketing nav read out of --color-red and --color-orange.
 */
const BRAND_RED = rgb(0xe2 / 255, 0x3a / 255, 0x2a / 255);
const BRAND_ORANGE = rgb(0xf4 / 255, 0x7b / 255, 0x1f / 255);

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Shown wherever a fact was not recorded. Never blank, never a plausible zero. */
const ABSENT = "Not recorded";

/**
 * What the file calls the document, by the kind its stored version carries
 * (`agreementKindOfVersion`, the mirror of the generated
 * `baa_acceptances.agreement_kind`): the running title in every footer, the
 * PDF's own title, and the start of the file name. A Data Protection
 * Agreement printed as a business associate agreement would misname the
 * contract on every page of the copy the practice keeps.
 *
 * The BAA's three are the strings this file has always drawn, so a BAA's
 * bytes, and every `copy_document_sha256` already recorded, do not move.
 */
const DOCUMENT_NAMES = {
  baa: {
    running: "healdesk business associate agreement",
    title: "healdesk Business Associate Agreement",
    fileStem: "healdesk-baa",
  },
  dpa: {
    running: "healdesk data protection agreement",
    title: "healdesk Data Protection Agreement",
    fileStem: "healdesk-dpa",
  },
} as const;

function documentNamesFor(version: string | null | undefined) {
  return DOCUMENT_NAMES[agreementKindOfVersion(String(version ?? ""))];
}

export async function renderAgreementPdf(
  acceptance: BaaAcceptanceRecord,
): Promise<AgreementPdf> {
  const acceptedAt = acceptance.acceptedAt;
  if (!(acceptedAt instanceof Date) || Number.isNaN(acceptedAt.getTime())) {
    throw new Error(
      "Cannot render an agreement PDF without a valid acceptedAt: it dates the signature and fixes the file's own timestamps.",
    );
  }

  const text = acceptance.renderedText;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(
      "Cannot render an agreement PDF from empty renderedText: the document is the evidence.",
    );
  }

  const storedHash = acceptance.documentHash?.trim().toLowerCase() ?? "";
  if (!SHA256_HEX.test(storedHash)) {
    throw new Error(
      "Cannot render an agreement PDF without a SHA-256 documentHash: the hash printed on every page is what makes the copy verifiable.",
    );
  }

  /**
   * The body and the footer must describe the same document.
   *
   * A mismatch means the row no longer holds the text that was hashed. Printing
   * the stored hash under text that does not produce it would assert something
   * we know to be untrue, on a page designed to be relied on.
   */
  const actualHash = createHash("sha256").update(text, "utf8").digest("hex");
  if (actualHash !== storedHash) {
    throw new Error(
      `Refusing to render: the stored agreement text hashes to ${actualHash}, not to the recorded ${storedHash}.`,
    );
  }

  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  /** Kept for the two places a column has to line up. See the header. */
  const mono = await pdf.embedFont(StandardFonts.Courier);

  /**
   * Standard PDF fonts encode WinAnsi and nothing else, and `drawText` throws
   * on anything outside it. The stored text is not ours to filter — the
   * 0.1.0-draft preamble opens with a "⚠️", and the assent label arrives from a
   * browser — so an unrepresentable code point is rendered as [U+XXXX] rather
   * than dropped, and the count is disclosed on the page. Nothing is removed,
   * the substitution is visible, and the original code point is recoverable.
   *
   * The alternative was embedding a Unicode TTF, which means shipping a font
   * binary and a subsetter into this service for the sake of one warning sign.
   * Helvetica and Courier are both standard fonts and cover the same WinAnsi
   * set, so which face a run is drawn in cannot change what is representable.
   */
  const encodable = new Map<number, boolean>();
  let substitutions = 0;

  const canEncode = (codePoint: number): boolean => {
    const known = encodable.get(codePoint);
    if (known !== undefined) return known;
    let ok: boolean;
    try {
      body.widthOfTextAtSize(String.fromCodePoint(codePoint), BODY_SIZE);
      ok = true;
    } catch {
      ok = false;
    }
    encodable.set(codePoint, ok);
    return ok;
  };

  const safe = (raw: string): string => {
    let out = "";
    for (const ch of raw) {
      const codePoint = ch.codePointAt(0) ?? 0;
      // Tabs are whitespace, and whitespace-for-whitespace is a layout choice,
      // not an alteration of the text.
      if (ch === "\t") {
        out += "    ";
        continue;
      }
      if (canEncode(codePoint)) {
        out += ch;
        continue;
      }
      substitutions += 1;
      out += `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
    }
    return out;
  };

  const charWidth = mono.widthOfTextAtSize("0", MONO_SIZE);
  const valueIndent = " ".repeat(LABEL_COLUMNS);
  const valueWidth = CONTENT_WIDTH - LABEL_COLUMNS * charWidth;

  const pages: PDFPage[] = [];
  let page = newPage();
  let y = FIRST_BASELINE;

  function newPage(): PDFPage {
    const created = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(created);
    return created;
  }

  /**
   * One line, at the current baseline, `indent` points in from the margin.
   *
   * The indent is a number and not a string of spaces on purpose: it is the
   * only thing standing between the stored text's structure and a proportional
   * face. See INDENT_UNIT.
   */
  const writeLine = (
    line: string,
    font: PDFFont = body,
    indent = 0,
    size = BODY_SIZE,
  ): void => {
    if (y < BODY_BOTTOM) {
      page = newPage();
      y = FIRST_BASELINE;
    }
    if (line.length > 0) {
      page.drawText(line, {
        x: MARGIN_X + indent,
        y,
        font,
        size,
        color: INK,
      });
    }
    // One leading for every line whatever its size, so the record of assent
    // sits on the same baseline grid as the clauses above it.
    y -= BODY_LEADING;
  };

  // ---------------------------------------------------------------------
  // The agreement, verbatim.
  // ---------------------------------------------------------------------

  // CRLF and lone CR become LF: they are line separators, and left in place a
  // carriage return would be drawn as an unrepresentable code point. The hash
  // above was checked against the raw text, before this.
  const sourceLines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < sourceLines.length; index += 1) {
    // Measured after safe(), because safe() is where a tab becomes spaces.
    const rendered = safe(sourceLines[index] ?? "");
    const leading = (/^ */.exec(rendered)?.[0] ?? "").length;
    const indent = Math.min(leading * INDENT_UNIT, MAX_INDENT);

    const laidOut = wrapToWidth(
      rendered.slice(leading),
      body,
      BODY_SIZE,
      CONTENT_WIDTH - indent,
    );

    /**
     * A line standing on its own does not get left at the foot of a page.
     *
     * The stored text separates its blocks with blank lines, so a non-blank
     * line with a blank line on either side is a block of one — in this
     * template, every clause heading. Left as the last line of a page it reads
     * as a mistake: the heading on one sheet, the clause it names on the next,
     * and a reader has to turn back to find out what they are reading.
     *
     * This is a judgement about where a line falls, not about what it says.
     * Nothing is measured but blank lines, no line is styled differently for
     * having qualified, and the text is untouched either way. Bounded, too: a
     * fresh page always has room for three lines, so the break can fire once
     * and never twice.
     */
    const standsAlone =
      laidOut.length === 1 &&
      rendered.trim().length > 0 &&
      (index === 0 || (sourceLines[index - 1] ?? "").trim().length === 0) &&
      (sourceLines[index + 1] ?? "").trim().length === 0 &&
      index + 2 < sourceLines.length;

    if (standsAlone && y - 2 * BODY_LEADING < BODY_BOTTOM) {
      page = newPage();
      y = FIRST_BASELINE;
    }

    for (const line of laidOut) {
      writeLine(line, body, indent);
    }
  }

  // ---------------------------------------------------------------------
  // The record of assent.
  // ---------------------------------------------------------------------

  // Sanitised once: it is printed in the block below and again in every footer,
  // and running it through safe() twice would double-count a substitution
  // against the disclosure this block carries.
  const versionLabel = present(acceptance.documentVersion, safe);
  const names = documentNamesFor(acceptance.documentVersion);

  const assentRows: [string, string][] = [
    ["Accepted by", safe(acceptance.acceptedByName)],
    ["Title", present(acceptance.acceptedByTitle, safe)],
    ["Email", safe(acceptance.acceptedByEmail)],
    // Quoted so the exact bounds of the label — leading and trailing space
    // included — are visible. What the button said is the whole question.
    ["Assent label", `"${safe(oneLine(acceptance.assentLabel))}"`],
    ["Accepted at (UTC)", acceptedAt.toISOString()],
    ["IP address", present(acceptance.ipAddress, safe)],
    ["User agent", present(acceptance.userAgent, safe)],
    ["Template version", versionLabel],
    ["Agreement text SHA-256", storedHash],
  ];

  const assentLines: { text: string; font: PDFFont; size: number }[] = [
    { text: "RECORD OF ASSENT", font: bold, size: BODY_SIZE },
    { text: "", font: body, size: BODY_SIZE },
  ];

  /**
   * A paragraph of our own words, wrapped to the measure.
   *
   * These sentences are healdesk's, not the agreement's, so nothing here is
   * under the verbatim rule — they are wrapped rather than hard-broken, which
   * is what lets them be set in the body face without leaving a column of
   * lines that stop short of the margin.
   */
  const pushProse = (paragraph: string): void => {
    for (const line of wrapToWidth(paragraph, body, BODY_SIZE, CONTENT_WIDTH)) {
      assentLines.push({ text: line, font: body, size: BODY_SIZE });
    }
  };

  pushProse(
    "This is the record of an electronic signature. The text above is what was displayed to the person below at the moment they accepted it. The facts in this block were recorded by healdesk at that moment and are stored with it.",
  );
  assentLines.push({ text: "", font: body, size: BODY_SIZE });

  // Courier from here to the end of the rows: the label column is padded in
  // characters, so it is only a column while a character is a fixed width.
  for (const [label, value] of assentRows) {
    const wrapped = wrapToWidth(value, mono, MONO_SIZE, valueWidth);
    wrapped.forEach((chunk, index) => {
      const prefix = index === 0 ? label.padEnd(LABEL_COLUMNS) : valueIndent;
      assentLines.push({ text: prefix + chunk, font: mono, size: MONO_SIZE });
    });
  }

  assentLines.push({ text: "", font: body, size: BODY_SIZE });
  pushProse(
    "The SHA-256 in the page footer is of the agreement text as healdesk stores it, not of this file: long lines are wrapped to the page here, so the two are the same document but not the same bytes. Quote it when asking for the record this copy was made from.",
  );

  if (substitutions > 0) {
    assentLines.push({ text: "", font: body, size: BODY_SIZE });
    pushProse(
      `${substitutions} character${substitutions === 1 ? "" : "s"} of the stored text cannot be represented in this file's character set and are shown as [U+XXXX]. Nothing was removed.`,
    );
  }

  /**
   * Keep the block whole where it can be — and never rule off one page for a
   * block that begins on the next.
   *
   * A signature block split from its heading reads as an afterthought stapled
   * to the end of somebody's contract, so where the whole thing still fits on a
   * fresh page it gets one. Where it cannot — an assent record longer than a
   * page, which one long user agent is enough to produce — the block has to
   * break somewhere, and the only thing still worth insisting on is that it not
   * break between the rule and the heading the rule introduces.
   *
   * Which is why the page is chosen ONCE, here, for the rule and the block
   * together, and why the blank lines around the rule are placed by hand
   * instead of through writeLine(). writeLine() starts a new page by itself
   * when the baseline has run out, and the rule is drawn from the page and the
   * baseline it leaves behind: on the branch where it broke, the rule was ruled
   * across the foot of the outgoing page, above a RECORD OF ASSENT that had
   * moved to the next one. A rule under the last clause of a contract, with
   * nothing beneath it, reads as the end of the document.
   */
  const blockHeight = (assentLines.length + 2) * BODY_LEADING;
  const pageHeight = FIRST_BASELINE - BODY_BOTTOM;

  // The least that must fit below the current baseline for the block to start
  // here at all: the blank line above the rule, the blank line below it, and
  // the block's own first line.
  const leadIn = 3 * BODY_LEADING;
  const needed = blockHeight <= pageHeight ? blockHeight : leadIn;

  if (y - needed < BODY_BOTTOM) {
    page = newPage();
    y = FIRST_BASELINE;
  }

  // The blank line above the rule, taken on both branches. On a fresh page it
  // looks like air the top margin was already providing — but the rule is
  // stroked from this baseline, and without the line it lands ABOVE the first
  // baseline, out in the margin, a few points under the wordmark. There it
  // reads as a letterhead rule that happens to appear on one page and not the
  // others, and it divides nothing: on that page there is no clause above it
  // to divide the block from. The rule belongs inside the text block.
  y -= BODY_LEADING;

  page.drawLine({
    start: { x: MARGIN_X, y: y + BODY_LEADING - 4 },
    end: { x: PAGE_WIDTH - MARGIN_X, y: y + BODY_LEADING - 4 },
    thickness: 0.5,
    color: RULE,
  });
  // The blank line below the rule. Reserved by `needed` above, so it cannot be
  // the thing that turns the page.
  y -= BODY_LEADING;

  for (const line of assentLines) {
    writeLine(line.text, line.font, 0, line.size);
  }

  // ---------------------------------------------------------------------
  // The wordmark and the footers. Drawn last, because "of M" is not known
  // until M is, and because both belong to every page rather than to the flow.
  // ---------------------------------------------------------------------

  // Two runs, no gap between them: "healdesk" is one word in two colours, and
  // drawing it as two adjacent strings is the only way pdf-lib will give it a
  // colour change mid-word. Right-aligned off the combined width.
  const healWidth = bold.widthOfTextAtSize("heal", WORDMARK_SIZE);
  const deskWidth = bold.widthOfTextAtSize("desk", WORDMARK_SIZE);
  const wordmarkX = PAGE_WIDTH - MARGIN_X - (healWidth + deskWidth);

  const total = pages.length;
  pages.forEach((sheet, index) => {
    sheet.drawText("heal", {
      x: wordmarkX,
      y: WORDMARK_BASELINE,
      font: bold,
      size: WORDMARK_SIZE,
      color: BRAND_RED,
    });
    sheet.drawText("desk", {
      x: wordmarkX + healWidth,
      y: WORDMARK_BASELINE,
      font: bold,
      size: WORDMARK_SIZE,
      color: BRAND_ORANGE,
    });

    sheet.drawLine({
      start: { x: MARGIN_X, y: 78 },
      end: { x: PAGE_WIDTH - MARGIN_X, y: 78 },
      thickness: 0.5,
      color: RULE,
    });

    const pageLabel = `Page ${index + 1} of ${total}`;
    const pageLabelWidth = mono.widthOfTextAtSize(pageLabel, FOOTER_SIZE);

    // The footer is one band and it is Courier throughout, not only across the
    // hash: it is the part of the page meant to be read against another copy,
    // and a fixed measure is what lets the clamp below promise the running
    // title will never reach the page number.
    //
    // Clamped, not wrapped: a running footer that collided with the page
    // number would read as a corrupted document. The full version is stated
    // in the record of assent, so nothing is only ever seen truncated.
    const left = clampToWidth(
      `${names.running} — template ${versionLabel}`,
      mono,
      FOOTER_SIZE,
      CONTENT_WIDTH - pageLabelWidth - 12,
    );
    sheet.drawText(left, {
      x: MARGIN_X,
      y: 64,
      font: mono,
      size: FOOTER_SIZE,
      color: QUIET,
    });

    sheet.drawText(pageLabel, {
      x: PAGE_WIDTH - MARGIN_X - pageLabelWidth,
      y: 64,
      font: mono,
      size: FOOTER_SIZE,
      color: QUIET,
    });

    sheet.drawText(`SHA-256 of the agreement text  ${storedHash}`, {
      x: MARGIN_X,
      y: 52,
      font: mono,
      size: FOOTER_SIZE,
      color: QUIET,
    });
  });

  // Fixed metadata. Anything derived from the clock here would change the
  // bytes on every render and make the returned digest meaningless.
  pdf.setTitle(`${names.title} ${versionLabel}`);
  pdf.setSubject(`Executed copy — agreement text SHA-256 ${storedHash}`);
  pdf.setAuthor("healdesk");
  pdf.setProducer("healdesk");
  pdf.setCreator("healdesk");
  pdf.setCreationDate(acceptedAt);
  pdf.setModificationDate(acceptedAt);

  // No object streams: the file structure stays plain, so a reader with nothing
  // but zlib can pull the text back out and check it against the record.
  const bytes = await pdf.save({ useObjectStreams: false });

  return {
    bytes,
    filename: buildFilename(acceptance.documentVersion, acceptedAt),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/**
 * `healdesk-baa-<version>-<YYYY-MM-DD>.pdf`, or for a Data Protection
 * Agreement `healdesk-dpa-<version>-<YYYY-MM-DD>.pdf`, and nothing else. A
 * DPA's version is namespaced ("dpa/1.0.0"); the stem already says which
 * agreement it is, so the namespace is not repeated ("healdesk-dpa-1.0.0-…").
 *
 * No clinic name and no signer name: this string travels in a
 * Content-Disposition header, an inbox, and whatever the clinic's mail server
 * logs. It is also the reason `documentVersion` is filtered down to a known
 * alphabet rather than interpolated — a stored value that reached a header or a
 * path verbatim is how a filename becomes a header injection or a traversal.
 */
function buildFilename(version: string, acceptedAt: Date): string {
  const names = documentNamesFor(version);
  const raw = (version ?? "").trim();
  const unprefixed =
    names === DOCUMENT_NAMES.dpa ? raw.slice(DPA_VERSION_PREFIX.length) : raw;
  const slug = unprefixed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const date = acceptedAt.toISOString().slice(0, 10);
  return `${names.fileStem}-${slug.length > 0 ? slug : "unversioned"}-${date}.pdf`;
}

/**
 * Break a line to the column, and never off the column.
 *
 * A token wider than the column is split mid-word rather than clipped: this is
 * a contract, and a clause that runs past the right margin is a clause the
 * clinic did not receive.
 *
 * Indentation is the caller's business now — a body line arrives here with its
 * leading whitespace already counted into an x-offset and stripped — so every
 * line returned is drawn at the same x, and a wrapped clause keeps the left
 * edge its source line opened on instead of dropping back to the margin. That
 * is not a hanging indent invented for text we have no opinions about; it is
 * the indent the text already had, held for the length of the line.
 */
function wrapToWidth(
  line: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (line.length === 0) return [""];
  if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];

  const out: string[] = [];
  let current = "";

  for (const word of line.split(" ")) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      out.push(current);
      current = "";
    }

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    let chunk = "";
    for (const ch of word) {
      if (
        chunk.length > 0 &&
        font.widthOfTextAtSize(chunk + ch, size) > maxWidth
      ) {
        out.push(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    current = chunk;
  }

  out.push(current);
  return out;
}

/** As much of a one-line label as fits, cut at a character boundary. */
function clampToWidth(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;

  let out = "";
  for (const ch of value) {
    if (font.widthOfTextAtSize(out + ch, size) > maxWidth) break;
    out += ch;
  }
  return out;
}

/** A value, or the honest statement that there isn't one. */
function present(
  value: string | null | undefined,
  clean: (raw: string) => string,
): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? clean(trimmed) : ABSENT;
}

/**
 * The assent label on one line.
 *
 * It arrives from a browser and is stored as sent, so it may carry newlines
 * that would otherwise silently split the quoted value across rows and hide
 * where it ends. Line breaks become spaces; nothing is dropped.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

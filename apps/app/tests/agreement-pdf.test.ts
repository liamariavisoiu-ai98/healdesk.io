import {
  assentSentence,
  currentBaaTemplate,
  getBaaTemplate,
  hashBaaText,
  prepareBaa,
  type BaaVariables,
} from "@healdesk/catalog";
import { createHash } from "node:crypto";
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFFont,
} from "pdf-lib";
import { describe, expect, test } from "vitest";

import {
  renderAgreementPdf,
  type BaaAcceptanceRecord,
} from "@/lib/agreements/pdf";

/**
 * The PDF a clinic keeps.
 *
 * The properties defended here are the ones somebody would rely on years from
 * now, holding nothing but the file: that its bytes are stable enough to hash
 * and re-check, that the digest identifying the agreement is on every page,
 * that the words in it are the words that were signed — none of them dropped
 * off the right margin or off the end — and that the assent block states what
 * was actually recorded rather than a tidy blank.
 *
 * The text is read back out of the file itself rather than trusted from the
 * input. pdf-lib inflates its own content streams, and the standard fonts write
 * WinAnsi, so a round trip needs no third-party parser: decode the hex strings
 * the text operators carry and put them through a windows-1252 decoder.
 *
 * Some of what is defended here is not in the text at all. The stored document
 * indents a clause body with spaces, and those spaces are not drawn — they are
 * counted into an x-offset, because a proportional face would flatten them. So
 * the position, the colour and the face of each mark are read back too, and the
 * standard fonts are re-embedded here to measure what the renderer drew.
 */

const VARS: BaaVariables = {
  clinicLegalName: "Radiance Med Spa",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  signatoryEmail: "alex@radiance.test",
  effectiveDate: "2026-08-18",
  specialty: "Med spa",
  isCoveredEntity: false,
  attributionMode: "estimated",
  connectedPlatform: null,
  outboundMessaging: true,
};

const SIGNED = prepareBaa(currentBaaTemplate(), VARS);
const ACCEPTED_AT = new Date("2026-08-18T14:03:11.000Z");

/**
 * What signAgreement stores as the label: the full sentence beside the
 * checkbox, derived from the clinic name, not the fixed half the browser
 * sends as proof. Long enough to wrap, which the verbatim test relies on.
 */
const ASSENT_LABEL = assentSentence(VARS.clinicLegalName);

function acceptance(
  over: Partial<BaaAcceptanceRecord> = {},
): BaaAcceptanceRecord {
  return {
    documentVersion: SIGNED.version,
    documentHash: SIGNED.hash,
    renderedText: SIGNED.text,
    assentLabel: ASSENT_LABEL,
    acceptedByName: "Alex Chen",
    acceptedByEmail: "alex@radiance.test",
    acceptedByTitle: "Owner",
    ipAddress: "203.0.113.42",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    acceptedAt: ACCEPTED_AT,
    ...over,
  };
}

/** An acceptance of some other text, hashed the way the writer hashes it. */
function acceptanceOf(
  text: string,
  over: Partial<BaaAcceptanceRecord> = {},
): BaaAcceptanceRecord {
  return acceptance({
    renderedText: text,
    documentHash: hashBaaText(text),
    ...over,
  });
}

const WIN_ANSI = new TextDecoder("windows-1252");

/**
 * Each page's content stream, decompressed, in page order.
 *
 * Per page rather than per object, because some of what is defended here is
 * about WHICH page a mark landed on, and a flat list of everything the file
 * draws cannot answer that.
 */
async function pageStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);

  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => doc.context.lookup(ref))
        : [contents];

    return streams
      .map((stream) =>
        stream instanceof PDFRawStream
          ? WIN_ANSI.decode(decodePDFRawStream(stream).decode())
          : "",
      )
      .join("\n");
  });
}

/** Every string one page draws, in the order it draws them. */
function textOn(stream: string): string[] {
  return [...stream.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((match) =>
    WIN_ANSI.decode(Buffer.from(match[1] ?? "", "hex")),
  );
}

/** One string the page drew, and everything about it that is not the string. */
type Mark = {
  text: string;
  x: number;
  y: number;
  size: number;
  /** The page's resource name, e.g. `Helvetica-Bold-6540482195`. */
  font: string;
  color: [number, number, number];
};

/**
 * pdf-lib writes one `q BT <r g b> rg /<font> <size> Tf … Tm <hex> Tj ET Q`
 * block per drawText, so a single pass over the stream recovers where every
 * mark landed, what colour it was, and which face drew it.
 */
const MARK =
  /BT\s+([\d.]+) ([\d.]+) ([\d.]+) rg\s+\/(\S+) ([\d.]+) Tf[\s\S]{0,80}?1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s+<([0-9A-Fa-f]*)>\s*Tj/g;

function marksOn(stream: string): Mark[] {
  return [...stream.matchAll(MARK)].map((match) => ({
    color: [Number(match[1]), Number(match[2]), Number(match[3])] as [
      number,
      number,
      number,
    ],
    font: match[4] ?? "",
    size: Number(match[5]),
    x: Number(match[6]),
    y: Number(match[7]),
    text: WIN_ANSI.decode(Buffer.from(match[8] ?? "", "hex")),
  }));
}

/** US Letter, one-inch margins — the page the renderer lays out on. */
const PAGE_WIDTH = 612;
const MARGIN_X = 72;
const RIGHT_MARGIN = PAGE_WIDTH - MARGIN_X;
/** Below this the page belongs to the footer, not to the body. */
const BODY_BOTTOM = 96;

/** #e23a2a and #f47b1f, the wordmark's two colours. */
const BRAND_RED = [0xe2 / 255, 0x3a / 255, 0x2a / 255];
const BRAND_ORANGE = [0xf4 / 255, 0x7b / 255, 0x1f / 255];

/**
 * The standard faces, re-embedded here so a mark can be measured.
 *
 * Longest resource-name prefix wins, so `Helvetica-Bold-123` is not read as
 * Helvetica. Nothing is embedded in the file itself — these are the fourteen
 * fonts every PDF reader already has, which is why the renderer ships no font
 * binary and why this can measure its output without one either.
 */
let faces: [string, PDFFont][] | null = null;

async function widthOf(mark: Mark): Promise<number> {
  if (faces === null) {
    const scratch = await PDFDocument.create();
    faces = [
      ["Helvetica-Bold", await scratch.embedFont(StandardFonts.HelveticaBold)],
      ["Helvetica", await scratch.embedFont(StandardFonts.Helvetica)],
      ["Courier", await scratch.embedFont(StandardFonts.Courier)],
    ];
  }
  const face = faces.find(([name]) => mark.font.startsWith(name));
  if (!face) throw new Error(`Unknown face in the output: ${mark.font}`);
  return face[1].widthOfTextAtSize(mark.text, mark.size);
}

/**
 * How many body lines the first page holds, asked of the renderer itself.
 *
 * The pagination trap below has to be sprung at the exact foot of a page, and
 * the type scale that decides where that foot is belongs to the renderer. A
 * hard-coded line count would quietly stop being a trap the first time the
 * leading or the top margin moved, and the test would keep passing.
 */
async function bodyLinesPerPage(): Promise<number> {
  const probe = Array.from({ length: 400 }, (_, i) => `PROBE ${i + 1}`).join(
    "\n",
  );
  const pdf = await renderAgreementPdf(acceptanceOf(probe));
  const first = textOn((await pageStreams(pdf.bytes))[0] ?? "");
  return first.filter((line) => /^PROBE \d+$/.test(line)).length;
}

/**
 * What one leading space of the stored text is worth on the page, asked of the
 * renderer itself.
 *
 * The indent unit is a typographic constant of the renderer's choosing. A copy
 * of it written down here would go stale the first time the type scale moved,
 * and the round trip below would quietly start rebuilding the document's
 * indentation against the wrong ruler.
 */
async function indentUnit(): Promise<number> {
  const pdf = await renderAgreementPdf(acceptanceOf("PROBE\n PROBE"));
  const probes = marksOn((await pageStreams(pdf.bytes))[0] ?? "").filter(
    (mark) => mark.text === "PROBE",
  );
  if (probes.length !== 2) throw new Error("the indent probe did not render");
  return probes[1]!.x - probes[0]!.x;
}

/**
 * The y of every rule stroked on one page.
 *
 * pdf-lib's drawLine emits `x y m ... x y l S`; the y of the lineTo is the
 * height the rule sits at. Every page carries the footer's at 78, so anything
 * else is a rule the body drew.
 */
function ruleHeightsOn(stream: string): number[] {
  return [...stream.matchAll(/(-?[\d.]+) (-?[\d.]+) l\b/g)].map((match) =>
    Number(match[2]),
  );
}

/** Every string the file actually draws, in page order. */
async function drawnLines(bytes: Uint8Array): Promise<string[]> {
  return (await pageStreams(bytes)).flatMap(textOn);
}

/** Wrapping turns a space into a line break; comparing collapsed puts it back. */
function collapsed(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("renderAgreementPdf", () => {
  test("is byte-for-byte deterministic, so the digest can be stored", async () => {
    const first = await renderAgreementPdf(acceptance());
    const second = await renderAgreementPdf(acceptance());

    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(
      true,
    );
    expect(second.sha256).toBe(first.sha256);
    // And the digest is of these bytes, not of anything else.
    expect(first.sha256).toBe(
      createHash("sha256").update(Buffer.from(first.bytes)).digest("hex"),
    );
    expect(first.sha256).not.toBe(SIGNED.hash);
  });

  test("carries the agreement hash and the page count on every page", async () => {
    const pdf = await renderAgreementPdf(acceptance());
    const doc = await PDFDocument.load(pdf.bytes);
    const pageCount = doc.getPageCount();
    const lines = await drawnLines(pdf.bytes);

    expect(pageCount).toBeGreaterThan(1);

    const footers = lines.filter((line) =>
      line.startsWith("SHA-256 of the agreement text"),
    );
    expect(footers).toHaveLength(pageCount);
    for (const footer of footers) {
      expect(footer).toContain(SIGNED.hash);
    }

    for (let page = 1; page <= pageCount; page += 1) {
      expect(lines).toContain(`Page ${page} of ${pageCount}`);
    }

    const withVersion = lines.filter((line) =>
      line.startsWith("healdesk business associate agreement"),
    );
    expect(withVersion).toHaveLength(pageCount);
    for (const line of withVersion) {
      expect(line).toContain(SIGNED.version);
    }
  });

  test("carries the wordmark, in the brand's two colours, on every page", async () => {
    /**
     * The mark is drawn, not placed: there is no logo file in this repository
     * and there is not going to be one, for the same reason there is no font
     * binary. So what is checked is what "drawn" has to mean — two runs, the
     * right colours, adjacent to the point, and far enough above the text that
     * a clause can never be crowded by a letterhead.
     */
    const pdf = await renderAgreementPdf(acceptance());
    const pages = await pageStreams(pdf.bytes);
    expect(pages.length).toBeGreaterThan(1);

    for (const stream of pages) {
      const marks = marksOn(stream);
      const at = marks.findIndex((mark) => mark.text === "heal");
      expect(at).toBeGreaterThan(-1);

      const heal = marks[at]!;
      const desk = marks[at + 1]!;
      expect(desk.text).toBe("desk");

      // One word in two colours, which is the only way pdf-lib will colour a
      // word in halves — so "desk" has to begin exactly where "heal" ends.
      heal.color.forEach((channel, i) =>
        expect(channel).toBeCloseTo(BRAND_RED[i]!, 6),
      );
      desk.color.forEach((channel, i) =>
        expect(channel).toBeCloseTo(BRAND_ORANGE[i]!, 6),
      );
      expect(desk.x).toBeCloseTo(heal.x + (await widthOf(heal)), 6);
      expect(desk.y).toBe(heal.y);

      // Top right: hard against the right margin and above everything else on
      // the page, with a clear line of air under it. At 8.5pt the mark is at
      // most 8.5pt tall, so 16pt of baseline separation cannot be a collision.
      expect(heal.size).toBeLessThanOrEqual(10);
      expect(desk.x + (await widthOf(desk))).toBeCloseTo(RIGHT_MARGIN, 6);
      expect(heal.x).toBeGreaterThan(PAGE_WIDTH / 2);

      const rest = marks.filter(
        (_, index) => index !== at && index !== at + 1,
      );
      expect(rest.length).toBeGreaterThan(0);
      const highest = Math.max(...rest.map((mark) => mark.y));
      expect(heal.y).toBeGreaterThanOrEqual(highest + 16);
    }
  });

  test("keeps the stored text's indentation as a measured offset", async () => {
    /**
     * The agreement indents with spaces, which lined themselves up for free in
     * a monospace face and would collapse to about half their depth drawn in a
     * proportional one. So the leading whitespace is counted and turned into an
     * x-offset instead of being drawn — the characters reach the page unaltered
     * and the shape of the clause list survives the change of face.
     */
    const source = [
      "1. A CLAUSE",
      "  the clause body, indented two",
      "    a. a lettered sub-item, indented four",
      "       its continuation, indented seven",
    ].join("\n");

    const pdf = await renderAgreementPdf(acceptanceOf(source));
    const marks = marksOn((await pageStreams(pdf.bytes))[0] ?? "");
    const find = (needle: string): Mark => {
      const mark = marks.find((candidate) => candidate.text.startsWith(needle));
      expect(mark, needle).toBeDefined();
      return mark!;
    };

    const heading = find("1. A CLAUSE");
    const two = find("the clause body");
    const four = find("a. a lettered");
    const seven = find("its continuation");

    // Drawn without the spaces. The indent is a position now, not characters.
    expect(two.text).toBe("the clause body, indented two");
    expect(seven.text).toBe("its continuation, indented seven");

    // The heading is at the margin and every level sits strictly right of the
    // one above it — a four-space line further right than a two-space line is
    // the whole of what "the structure survived" means.
    expect(heading.x).toBe(MARGIN_X);
    expect(two.x).toBeGreaterThan(heading.x);
    expect(four.x).toBeGreaterThan(two.x);
    expect(seven.x).toBeGreaterThan(four.x);

    // And in proportion to the spaces counted: four spaces is exactly twice the
    // offset of two, seven is three and a half times it. A renderer that had
    // gone back to drawing the spaces would fail this even if it passed the
    // ordering above, because a space is not the indent unit.
    const unit = two.x - MARGIN_X;
    expect(unit).toBeGreaterThan(0);
    expect(four.x - MARGIN_X).toBeCloseTo(2 * unit, 6);
    expect(seven.x - MARGIN_X).toBeCloseTo(3.5 * unit, 6);

    // The body is set in the proportional face; the mono is reserved.
    for (const mark of [heading, two, four, seven]) {
      expect(mark.font).toMatch(/^Helvetica/);
    }
  });

  test("draws nothing past the right margin, however deep the indent", async () => {
    /**
     * Indenting by an offset takes width away from the column, and a stored
     * line is free to open with as much whitespace as it likes. If the offset
     * were not subtracted from the wrap measure — or not bounded at all — a
     * clause would run off the paper, which is a clause the clinic did not
     * receive. Checked on the real agreement, and on a line indented past all
     * reason.
     */
    const runaway = `${" ".repeat(200)}A line that opens two hundred spaces in and then keeps going for long enough to need the wrapper.`;

    for (const record of [acceptance(), acceptanceOf(`OPENING\n${runaway}`)]) {
      const pdf = await renderAgreementPdf(record);
      const marks = (await pageStreams(pdf.bytes)).flatMap(marksOn);
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark.x).toBeGreaterThanOrEqual(MARGIN_X);
        expect(mark.x + (await widthOf(mark))).toBeLessThanOrEqual(
          RIGHT_MARGIN + 0.001,
        );
      }
    }
  });

  test("reproduces the assent label verbatim, and the rest of the assent record", async () => {
    const lines = await drawnLines(
      (await renderAgreementPdf(acceptance())).bytes,
    );
    const text = collapsed(lines.join("\n"));

    // The label is long enough to wrap; quoted so its bounds are visible.
    expect(text).toContain(`"${ASSENT_LABEL}"`);
    expect(ASSENT_LABEL.length).toBeGreaterThan(60);

    expect(lines).toContain("RECORD OF ASSENT");
    expect(text).toContain("Accepted by Alex Chen");
    expect(text).toContain("Title Owner");
    expect(text).toContain("Email alex@radiance.test");
    expect(text).toContain("Accepted at (UTC) 2026-08-18T14:03:11.000Z");
    expect(text).toContain("IP address 203.0.113.42");
    expect(text).toContain(`Agreement text SHA-256 ${SIGNED.hash}`);

    // And drawn as ONE mark. The block is set in Courier at a size chosen so
    // the label column plus 64 hex characters fit the measure; a digest broken
    // across two lines is a digest nobody can paste back to us.
    const marks = (await pageStreams(
      (await renderAgreementPdf(acceptance())).bytes,
    )).flatMap(marksOn);
    const row = marks.filter((mark) =>
      mark.text.startsWith("Agreement text SHA-256"),
    );
    expect(row).toHaveLength(1);
    expect(row[0]!.text.endsWith(SIGNED.hash)).toBe(true);
    expect(row[0]!.font).toMatch(/^Courier/);
  });

  test("states what was not recorded instead of leaving it blank", async () => {
    const lines = await drawnLines(
      (
        await renderAgreementPdf(
          acceptance({ acceptedByTitle: null, ipAddress: null, userAgent: "" }),
        )
      ).bytes,
    );
    const text = collapsed(lines.join("\n"));

    expect(text).toContain("Title Not recorded");
    expect(text).toContain("IP address Not recorded");
    expect(text).toContain("User agent Not recorded");
  });

  test("paginates a clause longer than a page instead of truncating it", async () => {
    const clause =
      "OPENING-TOKEN " + "indemnify ".repeat(3000) + "CLOSING-TOKEN";
    const pdf = await renderAgreementPdf(
      acceptanceOf(`SECTION 99. LIABILITY\n\n${clause}\n\nAFTER THE CLAUSE`),
    );

    const doc = await PDFDocument.load(pdf.bytes);
    expect(doc.getPageCount()).toBeGreaterThan(2);

    const text = collapsed((await drawnLines(pdf.bytes)).join("\n"));
    expect(text).toContain("OPENING-TOKEN indemnify");
    expect(text).toContain("indemnify CLOSING-TOKEN");
    expect(text).toContain("AFTER THE CLAUSE");
    // Not one word of it lost to a margin or a page break.
    expect(text.split("indemnify").length - 1).toBe(3000);
  });

  test("keeps the section rule on the page the assent block starts on", async () => {
    /**
     * The rule that introduces the record of assent must never be stroked
     * across the foot of one page above a block that begins on the next. A rule
     * with nothing under it reads as the end of the document — on a contract,
     * to somebody who was not there.
     *
     * Both halves of the trap are set here deliberately. The body fills the
     * first page to its last baseline but one, which puts the block's start at
     * the very bottom — the count comes from the renderer rather than from a
     * number written down here, so the trap survives a change of type scale.
     * And the assent block is made taller than a page by a long user agent —
     * stored as the browser sent it, never truncated — which is what takes the
     * renderer down the branch that cannot move the whole block to a fresh
     * page. Given both, the earlier code stroked the rule at the foot of page
     * one and started RECORD OF ASSENT on page two.
     */
    const capacity = await bodyLinesPerPage();
    const body = Array.from(
      { length: capacity - 1 },
      (_, index) => `CLAUSE LINE ${index + 1}`,
    ).join("\n");
    const userAgent = `Mozilla/5.0 ${"compatible-agent-token/1.0 ".repeat(200)}`;

    const pdf = await renderAgreementPdf(acceptanceOf(body, { userAgent }));
    const pages = await pageStreams(pdf.bytes);
    const drawn = pages.map(textOn);

    // The footer rule is on every page at 78; a body rule is anything else.
    const sectionRules = pages.map((stream) =>
      ruleHeightsOn(stream).filter((y) => y !== 78),
    );

    // The premises, asserted rather than assumed: the body filled the first
    // page, and the block that follows is taller than a page on its own.
    expect(drawn[0]).toContain(`CLAUSE LINE ${capacity - 1}`);
    const continuations = drawn
      .flat()
      .filter((line) => line.trimStart().startsWith("compatible-agent-token"));
    expect(continuations.length).toBeGreaterThan(capacity);

    const heading = drawn.findIndex((lines) =>
      lines.includes("RECORD OF ASSENT"),
    );
    expect(heading).toBeGreaterThan(-1);

    // One rule, on the heading's page, and on no other.
    expect(sectionRules[heading]).toHaveLength(1);
    expect(sectionRules.flat()).toHaveLength(1);
    // And it is above the heading, not below it.
    expect(sectionRules[heading]?.[0]).toBeGreaterThan(96);

    // The block really did have to break: it does not end on the page it
    // starts on. That is the case the whole-block branch cannot serve, and the
    // only one in which the rule could be left behind.
    expect(pages.length).toBeGreaterThan(heading + 1);

    // A layout fix must not cost the property the digest depends on.
    const again = await renderAgreementPdf(acceptanceOf(body, { userAgent }));
    expect(Buffer.from(again.bytes).equals(Buffer.from(pdf.bytes))).toBe(true);
    expect(again.sha256).toBe(pdf.sha256);
  });

  test("breaks a single unspaced token rather than running it off the page", async () => {
    const token = "Z".repeat(4000);
    const pdf = await renderAgreementPdf(acceptanceOf(`A\n${token}\nB`));

    const lines = await drawnLines(pdf.bytes);
    // Every line that is nothing but the token, reassembled: none of it lost,
    // and none of it left hanging past the right margin.
    const chunks = lines.filter((line) => /^Z+$/.test(line));
    expect(chunks.join("")).toHaveLength(4000);

    // Measured, not counted. A character count was only ever a proxy for width
    // and it was a proxy calibrated to a monospace body; the thing that has to
    // be true is that the mark ends inside the margin.
    const marks = (await pageStreams(pdf.bytes))
      .flatMap(marksOn)
      .filter((mark) => /^Z+$/.test(mark.text));
    expect(marks.length).toBe(chunks.length);
    for (const mark of marks) {
      expect(mark.x + (await widthOf(mark))).toBeLessThanOrEqual(RIGHT_MARGIN);
    }

    expect(lines).toContain("A");
    expect(lines).toContain("B");
  });

  test("the agreement text survives the round trip, line for line", async () => {
    /**
     * Every line of the stored text, rebuilt out of the marks the file draws —
     * the characters from the string, the leading spaces from where the mark
     * landed — and compared against the source unmodified.
     *
     * Collapsing whitespace before the comparison, which is what this test used
     * to do, cannot see either of the two things this renderer newly puts at
     * risk. The indentation is no longer in the drawn text at all, it is in the
     * x-offset, so a renderer that dropped it entirely would still pass. And a
     * run of spaces INSIDE a line — a column somebody aligned by hand in the
     * stored document — would collapse to one space without a word going
     * missing. Both survive today. Until now neither was pinned, and a document
     * whose alignment quietly flattened is a document that no longer reads the
     * way the person who signed it read it.
     */
    const pdf = await renderAgreementPdf(acceptance());
    const unit = await indentUnit();
    const marks = (await pageStreams(pdf.bytes)).flatMap(marksOn);

    const end = marks.findIndex((mark) => mark.text === "RECORD OF ASSENT");
    expect(end).toBeGreaterThan(0);

    // The body only: black, proportional, above the footer band. That drops the
    // wordmark (coloured) and the footers (Courier, and below the rule) without
    // needing to know where on the page any of them sit.
    const drawn = marks
      .slice(0, end)
      .filter(
        (mark) =>
          mark.font.startsWith("Helvetica") &&
          mark.color.every((channel) => channel === 0) &&
          mark.y > BODY_BOTTOM,
      )
      .map(
        (mark) => " ".repeat(Math.round((mark.x - MARGIN_X) / unit)) + mark.text,
      );

    // A line of nothing but whitespace draws no mark, so it accounts for none.
    const source = SIGNED.text
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(source.length).toBeGreaterThan(50);

    // A source line may have been wrapped onto several drawn ones: take drawn
    // lines until the source line is accounted for, and rejoin them the way
    // wrapping broke them — at a space, with the continuation's indent removed.
    let taken = 0;
    for (const line of source) {
      const parts: string[] = [];
      let rebuilt = "";
      while (taken < drawn.length && rebuilt.length < line.length) {
        parts.push(drawn[taken]!);
        taken += 1;
        rebuilt = parts
          .map((part, index) => (index === 0 ? part : part.trimStart()))
          .join(" ");
      }
      expect(rebuilt).toBe(line);
    }

    // And the file drew nothing the source did not account for.
    expect(taken).toBe(drawn.length);
  });

  test("keeps a run of spaces inside a line, and does not draw the ones in front", async () => {
    /**
     * The same two properties as the round trip above, on a document built to
     * exercise them: a hand-aligned column, and an indent on a line that also
     * carries interior runs. Separate from the round trip because the stored
     * agreement is not obliged to contain a case like this forever, and the
     * guarantee is not conditional on it doing so.
     */
    const source = [
      "SCHEDULE A",
      "COLUMN ONE      COLUMN TWO      COLUMN THREE",
      "  indented once      and spaced      inside",
    ].join("\n");

    const pdf = await renderAgreementPdf(acceptanceOf(source));
    const unit = await indentUnit();
    const marks = marksOn((await pageStreams(pdf.bytes))[0] ?? "");

    const find = (needle: string): Mark => {
      const mark = marks.find((candidate) => candidate.text.startsWith(needle));
      expect(mark, needle).toBeDefined();
      return mark!;
    };

    // Interior runs reach the page character for character.
    expect(find("COLUMN ONE").text).toBe("COLUMN ONE      COLUMN TWO      COLUMN THREE");

    // The leading run does not — it is a position instead, and the rest of the
    // line is untouched by having been moved.
    const indented = find("indented once");
    expect(indented.text).toBe("indented once      and spaced      inside");
    expect(indented.x).toBeCloseTo(MARGIN_X + 2 * unit, 6);
  });

  test("refuses a record whose text does not hash to its recorded hash", async () => {
    await expect(
      renderAgreementPdf(
        acceptance({ renderedText: `${SIGNED.text}\n\nAND ONE MORE CLAUSE.` }),
      ),
    ).rejects.toThrow(/hashes to/);
  });

  test("refuses an empty document, a bad hash, and an unusable date", async () => {
    await expect(
      renderAgreementPdf(acceptanceOf("   ")),
    ).rejects.toThrow(/empty renderedText/);

    await expect(
      renderAgreementPdf(acceptance({ documentHash: "not-a-digest" })),
    ).rejects.toThrow(/SHA-256/);

    await expect(
      renderAgreementPdf(acceptance({ acceptedAt: new Date("nonsense") })),
    ).rejects.toThrow(/acceptedAt/);
  });

  test("shows characters it cannot encode, and discloses that it did", async () => {
    // The 0.1.0-draft preamble opens with a warning sign, so this is the real
    // stored text of every acceptance signed before counsel approved 1.0.0 —
    // not a synthetic edge case.
    const draft = getBaaTemplate("0.1.0-draft");
    expect(draft).toBeDefined();
    const prepared = prepareBaa(draft!, VARS);
    expect(prepared.text).toContain("⚠");

    const pdf = await renderAgreementPdf(
      acceptance({
        documentVersion: prepared.version,
        documentHash: prepared.hash,
        renderedText: prepared.text,
      }),
    );

    const text = collapsed((await drawnLines(pdf.bytes)).join("\n"));
    expect(text).toContain("[U+26A0]");
    expect(text).toContain("DRAFT");
    expect(text).toMatch(/characters? of the stored text cannot be represented/);
    expect(pdf.filename).toBe("healdesk-baa-0.1.0-draft-2026-08-18.pdf");
  });

  test("does not disclose a substitution that did not happen", async () => {
    const text = collapsed(
      (await drawnLines((await renderAgreementPdf(acceptance())).bytes)).join(
        "\n",
      ),
    );
    expect(text).not.toContain("cannot be represented");
  });

  test("keeps the footer clear of the page number, however long the version", async () => {
    // Not a realistic version, but the version is a stored string: a running
    // title that ran into the page number would read as damage.
    const version = "%".repeat(400);
    const bytes = (
      await renderAgreementPdf(acceptance({ documentVersion: version }))
    ).bytes;
    const lines = await drawnLines(bytes);
    const pages = await pageStreams(bytes);

    /**
     * Measured, not counted.
     *
     * Character arithmetic against a column width was only ever a proxy for
     * this, and a fragile one twice over: it silently stopped meaning anything
     * when the margins moved — a bound wider than the real column is a bound
     * that never fires — and it holds only while the footer is monospace, which
     * makes a typographic choice load-bearing for a test about collision. The
     * property is geometric and true of any face: the title ends before the
     * number starts, and neither leaves the measure.
     */
    expect(pages.length).toBeGreaterThan(0);
    for (const stream of pages) {
      const marks = marksOn(stream);
      const title = marks.find((mark) =>
        mark.text.startsWith("healdesk business associate agreement"),
      );
      const number = marks.find((mark) => /^Page \d+ of \d+$/.test(mark.text));
      expect(title).toBeDefined();
      expect(number).toBeDefined();

      expect(title!.x).toBeGreaterThanOrEqual(MARGIN_X);
      expect(title!.x + (await widthOf(title!))).toBeLessThan(number!.x);
      expect(number!.x + (await widthOf(number!))).toBeLessThanOrEqual(
        RIGHT_MARGIN + 0.001,
      );
    }

    // Truncated in the footer, whole in the record of assent, where it wraps.
    expect(lines.join("").split("%").length - 1).toBeGreaterThanOrEqual(400);
  });

  test("names the file by version and date, and by nothing else", async () => {
    const pdf = await renderAgreementPdf(acceptance());
    // The record's version, which is the current template's — 1.2.0 today.
    expect(SIGNED.version).toBe("1.2.0");
    expect(pdf.filename).toBe(`healdesk-baa-${SIGNED.version}-2026-08-18.pdf`);
    expect(pdf.filename).not.toContain("Radiance");
    expect(pdf.filename).not.toContain("Alex");

    // 23:30 UTC is already tomorrow in half the world. The name follows the
    // record, not the machine that rendered it.
    const lateNight = await renderAgreementPdf(
      acceptance({ acceptedAt: new Date("2026-08-18T23:30:00.000Z") }),
    );
    expect(lateNight.filename).toBe(`healdesk-baa-${SIGNED.version}-2026-08-18.pdf`);

    // A stored version is still a string that ends up in a header and a path.
    const hostile = await renderAgreementPdf(
      acceptance({ documentVersion: "../../etc/pa ss\r\nwd" }),
    );
    expect(hostile.filename).toMatch(/^healdesk-baa-[a-z0-9._-]+-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(hostile.filename).not.toMatch(/[/\\\r\n]/);
  });
});

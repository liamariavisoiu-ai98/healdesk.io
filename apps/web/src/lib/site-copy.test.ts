import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, test } from "vitest";

import DataDeletionPage from "@/app/data-deletion/page";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { Footer } from "@/components/Footer";
import { KnowMore } from "@/components/KnowMore";
import { SUBPROCESSORS } from "@/lib/subprocessors";

/**
 * What the site may never say, wherever its copy lives.
 *
 * Every phrase below has been on this site or in its demo, or is one the spec
 * and the counsel pack rule out by name:
 *
 * - "never miss". The 404 said AYA "never misses a call" while the
 *   first-month guarantee, the promise that backs reliability, provides for a
 *   miss. A line broader than the guarantee is what
 *   docs/counsel/guarantee-and-refund.md ("Advertising the guarantee", rule
 *   3) forbids.
 * - "money-back" and "risk-free". 16 CFR 239.3(a) keeps "money-back" for a
 *   refund of the full price at the buyer's request; ours excludes the setup
 *   fee and turns on a measured miss.
 * - "HIPAA compliant", unqualified. Nobody certifies it; the accurate line is
 *   that healdesk signs a business associate agreement and handles patient
 *   data under it (docs/v1-product-spec.md, "Copy and pricing changes").
 * - "live in 2 minutes" and its kin. Set-up is per channel (the spec's
 *   "Honest headline timing").
 * - The three claims cut back on 3 October 2026 (agreement-changes.md § 8):
 *   "US infrastructure" while the voice provider's region is unconfirmed,
 *   encryption "in transit and at rest" with no exception for the telephone
 *   or Meta, and "never over email" where the agreement says email that would
 *   carry patient information goes only over an encrypted connection.
 * - "with every clinic". The claim is the spec's line, "We sign a business
 *   associate agreement and handle patient data under it": a practice HIPAA
 *   does not reach signs a data protection agreement instead (plan Part L).
 * - "live the same day" and its kin. No timing before purchase (the owner's
 *   rule of 6 October 2026): copy says how a channel goes live, never when.
 * - Access per role ("Your owner, manager and billing contact each get their
 *   own access"). v1 has one shared sign-in per clinic, at the clinic's one
 *   email address, and each phone or computer adds its own passkey; the
 *   spec's three roles are deferred past v1.
 * - Any @healdesk.io address but hello@. It is the only one, for legal
 *   notices, privacy requests and everything else (owner, 9 October 2026):
 *   the legal pages named legal@ and privacy@, mailboxes nobody reads.
 *
 * Copy is every string, template and piece of JSX text under src/, outside
 * the tests, read with the TypeScript parser so that comments, which often
 * name a phrase to explain why it is banned, are not copy. Strings joined
 * with + and JSX text split across elements are read joined, as a reader
 * would see them.
 *
 * A phrase may appear only where it is quoted rather than claimed. Each such
 * place is listed in QUOTED, as its exact text, with the reason, and a listing
 * that no longer matches its file fails too, so the list cannot outlive the
 * sentence it excuses. packages/leadgen/src/enrich/copy-guard.ts does the same
 * job for cold email.
 */

const BANNED: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bnever miss/i, label: "'never miss': broader than the first-month guarantee" },
  { pattern: /\bmoney[\s\u2010\u2011-]*back\b/i, label: "'money-back': 16 CFR 239.3(a), and the setup fee is excluded" },
  { pattern: /\brisk[\s\u2010\u2011-]*free\b/i, label: "'risk-free'" },
  { pattern: /\bHIPAA[\s\u2010\u2011-]*compliant\b/i, label: "an unqualified 'HIPAA compliant'" },
  {
    pattern:
      /\blive in (?:(?:under|less than|about|just) )?(?:(?:\d+|one|two|three|five|a few|a couple of) )?min(?:ute)?s?\b|\bunder (?:2|two) minutes\b/i,
    label: "a 'live in 2 minutes' promise: set-up is per channel",
  },
  {
    pattern: /\b(?:US|U\.S\.|United States) infrastructure\b|\bUS-based (?:servers?|hosting)\b|\bstored in the (?:US|U\.S\.|United States)\b/i,
    label: "a US-infrastructure claim while the voice provider's region is unconfirmed",
  },
  {
    pattern: /\bencrypt(?:ed|ion) (?:in transit and at rest|at rest and in transit)\b/i,
    label: "encryption in transit with no exception for the telephone or Meta",
  },
  {
    pattern: /\bnever (?:sent |sends |goes )?(?:over|by|via) e-?mail\b|\bno patient (?:information|data) (?:over|by|via) e-?mail\b/i,
    label: "'never over email': the agreement says only over an encrypted connection",
  },
  { pattern: /\bwith every clinic\b/i, label: "'with every clinic': not every practice signs the same agreement" },
  {
    pattern:
      /\bowner, manager and billing contact\b|\beach (?:get|gets|have|has) (?:their|its) own (?:access|sign[\s-]?in|log[\s-]?in|login|account)\b/i,
    label: "access per role: v1 has one shared sign-in per clinic",
  },
  {
    // Our timing, not a patient's: "same-day intent" is what a caller wants.
    pattern: /\b(?:live|answer\w*|ready|forwarding is set)\b[^.]{0,60}\bsame[\s\u2010\u2011-]day\b/i,
    label: "'live the same day': no timing before purchase",
  },
  {
    pattern: /\b(?!hello@)[\w.+-]+@healdesk\.io\b/i,
    label: "an address other than hello@healdesk.io: it is the only one",
  },
];

/** Where a banned phrase is quoted, not claimed. Paths are relative to src/. */
const QUOTED: readonly { file: string; text: string; why: string }[] = [
  {
    file: "lib/demo-prompt.ts",
    text: "Never claim healdesk is 'HIPAA compliant'",
    why: "tells the demo agent not to say it",
  },
  {
    file: "lib/demo-prompt.ts",
    text: "Never promise everything live in minutes.",
    why: "tells the demo agent not to say it",
  },
  {
    file: "lib/demo/clinic-prompts.ts",
    text: "Never say healdesk is HIPAA compliant",
    why: "tells the personalised demo's voice agent not to say it",
  },
  {
    file: "lib/voice-demo-prompt.ts",
    text: 'Never say healdesk is "HIPAA compliant"',
    why: "tells the demo call agent not to say it",
  },
  {
    file: "lib/knowledge/index.ts",
    text: '"We never miss calls."',
    why: "an owner's objection, quoted so the demo agent can answer it",
  },
  {
    file: "lib/knowledge/niches.ts",
    text: "never 'never miss a call'",
    why: "tells the demo agent not to pitch it",
  },
];

const SRC = fileURLToPath(new URL("..", import.meta.url));

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) yield full;
  }
}

/** What a reader sees: entities decoded, whitespace collapsed. */
function normalise(text: string): string {
  return text
    .replace(/&(?:rsquo|lsquo|apos|#x27|#39);/g, "'")
    .replace(/&(?:rdquo|ldquo|quot);/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * An expression whose value is not in the source reads as "…", never as a
 * space, so two words it separates are never read as adjacent.
 */
const UNKNOWN = "…";

function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((span) => UNKNOWN + span.literal.text).join("");
}

function joined(node: ts.Expression): string {
  if (ts.isParenthesizedExpression(node)) return joined(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return templateText(node);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return joined(node.left) + joined(node.right);
  }
  return UNKNOWN;
}

function jsxText(node: ts.JsxElement | ts.JsxFragment): string {
  return node.children
    .map((child) => {
      if (ts.isJsxText(child)) return child.text;
      if (ts.isJsxElement(child) || ts.isJsxFragment(child)) return jsxText(child);
      const expression = ts.isJsxExpression(child) ? child.expression : undefined;
      if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
        return expression.text;
      }
      return UNKNOWN;
    })
    .join("");
}

const isPlus = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

const isJsxParent = (node: ts.Node | undefined): boolean =>
  node !== undefined && (ts.isJsxElement(node) || ts.isJsxFragment(node));

/** Every piece of copy in one file, in source order. */
function copyOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const pieces: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) pieces.push(node.text);
    else if (ts.isTemplateExpression(node)) pieces.push(templateText(node));
    // A chain of +, read once from its top, as one string.
    else if (isPlus(node) && !isPlus(node.parent)) pieces.push(joined(node));
    // JSX text, read once from the outermost element, across inline elements.
    else if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && !isJsxParent(node.parent)) {
      pieces.push(jsxText(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return pieces.map(normalise).filter((piece) => /[a-z]/i.test(piece));
}

const COPY = new Map<string, string[]>(
  [...sources(SRC)].map((file) => [relative(SRC, file).split("\\").join("/"), copyOf(file)]),
);

describe("the site makes none of the claims it may not make", () => {
  test("the scan reads the copy, not only the code", () => {
    // A guard that silently stops reading is worse than none: these pieces
    // must be found, or the extraction has broken.
    const all = [...COPY.values()].flat();
    expect(COPY.size).toBeGreaterThan(50);
    expect(all.some((piece) => piece.includes("Ask us anything."))).toBe(true);
    expect(all.some((piece) => piece.includes("We sign a business associate agreement and handle patient data under it."))).toBe(true);
    expect(all.some((piece) => piece.includes("picks up when your desk can't. This page, she can't find."))).toBe(true);
  });

  test.each(BANNED.map((rule) => [rule.label, rule] as const))("no %s", (_label, { pattern }) => {
    const offenders: string[] = [];
    for (const [file, pieces] of COPY) {
      const quoted = QUOTED.filter((q) => q.file === file).map((q) => q.text);
      for (const piece of pieces) {
        const claimed = quoted.reduce((text, q) => text.split(q).join(UNKNOWN), piece);
        const hit = claimed.match(pattern);
        if (hit) offenders.push(`${file}: "${hit[0]}" in "${piece.slice(0, 120)}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every quoted exception is still where it says it is", () => {
    for (const { file, text } of QUOTED) {
      const pieces = COPY.get(file) ?? [];
      expect(pieces.some((piece) => piece.includes(text)), `${file} no longer quotes ${text}`).toBe(true);
    }
  });
});

/**
 * Anthropic keeps inputs for 30 days, except content its automated
 * trust-and-safety systems flag or the law requires it to keep, which it may
 * keep for up to two years, even under its BAA (agreement-changes.md, finding
 * A3). Every paragraph, list item or table cell that states the 30 days must
 * carry the exception, on every surface that states it.
 */
describe("the model provider's 30 days always travel with the two-year exception", () => {
  const SURFACES = {
    footer: h(Footer),
    "the homepage FAQ": h(KnowMore),
    "/terms": h(TermsPage),
    "/data-deletion": h(DataDeletionPage),
    "/privacy": h(PrivacyPage),
  } as const;

  function blocks(markup: string): string[] {
    return markup
      .split(/<\/(?:p|li|td|th|h[1-6]|summary)>/)
      .map((block) => normalise(block.replace(/<[^>]+>/g, " ")))
      .filter(Boolean);
  }

  test.each(Object.entries(SURFACES))("%s", (_name, element) => {
    const retention = blocks(renderToStaticMarkup(element)).filter(
      (block) => /\b30 days\b/.test(block) && /model provider|AI model|Anthropic/i.test(block),
    );
    for (const block of retention) {
      expect(block, "a 30-day retention statement without its exception").toMatch(/two years/);
    }
  });

  test("and the surfaces that state it still do", () => {
    // So the check above cannot pass by the sentence going missing. The
    // footer stated it until 9 October 2026, when its patient-data strip
    // became the homepage FAQ's answer.
    for (const element of [h(KnowMore), h(TermsPage), h(DataDeletionPage)]) {
      expect(blocks(renderToStaticMarkup(element)).some((block) => /\b30 days\b/.test(block) && /two years/.test(block))).toBe(true);
    }
  });
});

/**
 * No vendor of ours is named on a legal page (owner, 9 October 2026).
 *
 * The list of the subcontractors that handle patient information is given to
 * signed clinics on request, under the business associate agreement, and the
 * pages describe every vendor by what it does: privacy § 5 by category, the
 * prose as "our AI model provider" and the like. The names come from the
 * internal register, so a vendor added there is covered here the day it is
 * added. Google and Meta are left out on purpose: they are the platforms a
 * clinic connects, which the pages must name to say what happens to the data
 * from them, and Google's and Meta's app reviews read those sections.
 */
describe("the legal pages name no vendor of ours", () => {
  const PLATFORMS = /^(?:Google|Meta)\b/;
  const names = [
    ...new Set(
      SUBPROCESSORS.filter((vendor) => !PLATFORMS.test(vendor.name)).map(
        (vendor) => vendor.name.split(/[\s(]/)[0]!,
      ),
    ),
    // What the register's names stand for, or what they make.
    "AWS",
    "Claude",
    "Synthflow",
  ];

  test("the register still has the names to look for", () => {
    expect(names).toEqual(expect.arrayContaining(["Amazon", "Anthropic", "Retell", "Stripe"]));
  });

  test.each([
    ["/terms", h(TermsPage)],
    ["/privacy", h(PrivacyPage)],
    ["/data-deletion", h(DataDeletionPage)],
  ] as const)("%s", (_path, element) => {
    // The page's own text: the navbar and the footer have owners of their own.
    const markup = renderToStaticMarkup(element);
    const main = markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
    expect(main.length).toBeGreaterThan(1_000);
    const words = normalise(main.replace(/<[^>]+>/g, " "));
    const named = names.filter((name) => new RegExp(`\\b${name}\\b`).test(words));
    expect(named).toEqual([]);
  });
});

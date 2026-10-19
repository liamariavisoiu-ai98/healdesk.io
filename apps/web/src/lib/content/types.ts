/**
 * The shape of every editorial page on the public site: the guides, the
 * research, the standards pages and the About page.
 *
 * ## Why content is TypeScript data and not Markdown or a CMS
 *
 * `lib/site-copy.test.ts` reads every string under `src/` with the TypeScript
 * parser and fails the build on the claims the product may never make. Pages
 * written as data in `.ts` files are read by that guard for free; Markdown
 * files, MDX or a hosted CMS would each need the guard rebuilt for their
 * format, and until then a banned claim could ship in an article. The same
 * holds for `lib/content/style.test.ts`, which enforces the house style.
 *
 * ## Why a page carries its stage
 *
 * A piece is written as `draft`, becomes `audited` when an independent check
 * of every figure, quotation and statute against its source has passed, and
 * is `live` only then. Only `live` pieces get a route, a sitemap entry or a
 * link; the admin SEO tab reads the rest, so the pipeline and the site can
 * never disagree about what is published.
 *
 * ## Inline markup
 *
 * Strings may carry `[label](href)` links and nothing else: no bold, no
 * emphasis (house style puts no emphasis inside sentences). `lib/content/
 * inline.tsx` renders them. An href starting with `/` is a page on this site.
 */

export type Family = "guides" | "research" | "standards";

export type Stage = "draft" | "audited" | "live";

/** What kind of publisher a source is, which decides how a page may state it. */
export type SourceKind =
  | "statute"
  | "regulation"
  | "court"
  | "government"
  | "peer-reviewed"
  | "association"
  | "vendor"
  | "news"
  | "company";

export type Source = {
  /** Unique within the piece; blocks cite it by this id. */
  id: string;
  /** As the publisher titles it, or the statute's citation. */
  title: string;
  publisher: string;
  url: string;
  kind: SourceKind;
  /** ISO date the page was last opened and the cited text found on it. */
  checked: string;
};

export type Block =
  | { kind: "p"; text: string; cite?: readonly string[] }
  | { kind: "h3"; text: string }
  | { kind: "list"; ordered?: boolean; items: readonly string[]; cite?: readonly string[] }
  | {
      kind: "table";
      caption: string;
      head: readonly string[];
      rows: readonly (readonly string[])[];
      cite?: readonly string[];
    }
  | { kind: "quote"; text: string; cite: string }
  | { kind: "note"; text: string };

export type Section = {
  /** The anchor; lowercase words joined by hyphens. */
  id: string;
  /** Phrased as the question people type, where the section answers one. */
  heading: string;
  blocks: readonly Block[];
};

export type Piece = {
  /** The last path segment. */
  slug: string;
  family: Family;
  /** The H1: the question people actually type, or the page's plain name. */
  title: string;
  /** The meta description: one or two sentences, under 160 characters. */
  description: string;
  /** The first two sentences, which answer the title on their own. */
  answer: string;
  stage: Stage;
  /** True for the four legal pieces: they carry the "not legal advice" notice. */
  legal: boolean;
  /** ISO dates. */
  published: string;
  lastReviewed: string;
  /** Who or what checked the piece before it went live, as printed under it. */
  review?: string;
  sections: readonly Section[];
  /**
   * "How AYA handles this": two or three factual sentences without
   * adjectives. The page adds the one link to the demo itself.
   */
  aya: readonly string[];
  sources: readonly Source[];
  /** Slugs of related pieces, any family. */
  related?: readonly string[];
};

export type GlossaryEntry = {
  term: string;
  /** One sentence that stands on its own. */
  definition: string;
  /** Optional source ids from the glossary's own source list. */
  cite?: readonly string[];
  /** A page on this site that goes further. */
  see?: string;
};

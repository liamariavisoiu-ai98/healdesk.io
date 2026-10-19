import { PIECES } from "@/lib/content/pieces";
import type { Family, Piece } from "@/lib/content/types";

/**
 * Every editorial page, and the one place that decides which are public.
 *
 * A piece is routed, listed in the sitemap, offered in llms.txt and linked
 * from the hub only when its stage is `live`. Drafts and audited pieces stay
 * in the repo, where the admin SEO tab shows them, but nothing public can
 * reach them: the family routes set `dynamicParams = false` and build only
 * from `livePieces()`.
 */

export const FAMILIES: Readonly<Record<Family, { label: string; plural: string; blurb: string }>> = {
  guides: {
    label: "Guide",
    plural: "Guides",
    blurb: "What the rules say about AI at a clinic's front desk, and how to set up the phone side.",
  },
  research: {
    label: "Research",
    plural: "Research",
    blurb: "Figures traced to their sources, and trackers rechecked against the primary text.",
  },
  standards: {
    label: "Standards",
    plural: "Standards",
    blurb: "The questions any clinic can put to an AI receptionist vendor, and our own answers.",
  },
};

export const FAMILY_ORDER: readonly Family[] = ["guides", "research", "standards"];

/** The hub that lists every live piece; the middle step of each breadcrumb. */
export const HUB = { name: "Guides and research", path: "/guides" } as const;

export function piecePath(piece: Pick<Piece, "family" | "slug">): string {
  return `/${piece.family}/${piece.slug}`;
}

export function allPieces(): readonly Piece[] {
  return PIECES;
}

export function livePieces(family?: Family): readonly Piece[] {
  return PIECES.filter((piece) => piece.stage === "live" && (family === undefined || piece.family === family));
}

export function findLivePiece(family: Family, slug: string): Piece | undefined {
  return livePieces(family).find((piece) => piece.slug === slug);
}

/** A live piece by slug in any family, for "related" links. */
export function liveBySlug(slug: string): Piece | undefined {
  return livePieces().find((piece) => piece.slug === slug);
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** "2026-10-19" as "19 October 2026", the site's date style, without time zones. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${String(day)} ${MONTHS[month - 1] ?? ""} ${String(year)}`;
}

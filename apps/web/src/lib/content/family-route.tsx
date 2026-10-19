import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ArticlePage } from "@/components/content/ArticlePage";
import { findLivePiece, livePieces, piecePath } from "@/lib/content/registry";
import type { Family } from "@/lib/content/types";

/**
 * The three family routes (/guides/[slug], /research/[slug],
 * /standards/[slug]) are this one route with a different family, so they
 * cannot drift apart. Each page file sets `dynamicParams = false` itself,
 * because Next reads that export statically: a slug that is not a live
 * piece is a 404, never rendered on demand.
 */

type Params = { params: Promise<{ slug: string }> };

export function familyRoute(family: Family) {
  return {
    generateStaticParams(): { slug: string }[] {
      return livePieces(family).map((piece) => ({ slug: piece.slug }));
    },

    async generateMetadata({ params }: Params): Promise<Metadata> {
      const { slug } = await params;
      const piece = findLivePiece(family, slug);
      if (!piece) return {};
      const path = piecePath(piece);
      return {
        title: piece.title,
        description: piece.description,
        alternates: { canonical: path },
        openGraph: {
          type: "article",
          url: path,
          title: piece.title,
          description: piece.description,
          publishedTime: piece.published,
          modifiedTime: piece.lastReviewed,
        },
      };
    },

    async Page({ params }: Params) {
      const { slug } = await params;
      const piece = findLivePiece(family, slug);
      if (!piece) notFound();
      return <ArticlePage piece={piece} />;
    },
  };
}

import type { Metadata } from "next";

import { Footer } from "@/components/Footer";
import { JsonLd } from "@/components/JsonLd";
import { Nav } from "@/components/Nav";
import { FAMILIES, FAMILY_ORDER, HUB, formatDate, livePieces, piecePath } from "@/lib/content/registry";
import { site } from "@/lib/site";
import { breadcrumbLd } from "@/lib/structured-data";

export const metadata: Metadata = {
  alternates: { canonical: HUB.path },
  title: "Guides and research on AI receptionists for clinics",
  description:
    "Sourced, dated guides to the laws on AI at a clinic's front desk, traced statistics, and the questions to ask any AI receptionist vendor.",
};

/**
 * The hub: every live piece, by family, so that each one is two clicks from
 * the footer and a crawler finds them all without the sitemap. A family with
 * no live piece is left out rather than shown empty.
 */
export default function GuidesHub() {
  const families = FAMILY_ORDER.map((family) => ({ family, pieces: livePieces(family) })).filter(
    (entry) => entry.pieces.length > 0,
  );

  return (
    <>
      <JsonLd
        data={breadcrumbLd([
          { name: "Home", path: "/" },
          { name: HUB.name, path: HUB.path },
        ])}
      />
      <Nav />
      <main className="mx-auto max-w-page px-5 pt-16 pb-24 sm:px-8 sm:pt-20 lg:px-14">
        <div className="max-w-[60ch]">
          <p className="eyebrow-tag">Library</p>
          <h1 className="font-display mt-3 text-[clamp(var(--text-3xl),5.4vw,var(--text-6xl))] leading-[1.04] font-medium tracking-[-0.026em]">
            {HUB.name}
          </h1>
          <p className="text-muted mt-5 text-base leading-[1.6] font-medium">
            Each page answers one question a clinic asks about AI at the front desk. Every figure names its
            source, every law links to its text, and every page carries the date it was last checked. {site.name}{" "}
            sells an AI receptionist, and{" "}
            <a href="/about#sourcing" className="underline underline-offset-2">
              how we source and correct
            </a>{" "}
            is on our About page.
          </p>
        </div>

        {families.map(({ family, pieces }) => (
          <section key={family} aria-labelledby={`${family}-heading`} className="mt-16">
            <h2
              id={`${family}-heading`}
              className="font-display text-[clamp(var(--text-2xl),3.2vw,var(--text-3xl))] leading-tight font-medium tracking-[-0.022em]"
            >
              {FAMILIES[family].plural}
            </h2>
            <p className="text-muted mt-2 max-w-[60ch] text-sm">{FAMILIES[family].blurb}</p>
            <ul className="mt-6 grid gap-4 md:grid-cols-2">
              {pieces.map((piece) => (
                <li key={piece.slug} className="border-line rounded-lg border p-5">
                  <a href={piecePath(piece)} className="font-display text-lg leading-snug font-medium hover:underline">
                    {piece.title}
                  </a>
                  <p className="text-muted mt-2 text-sm leading-relaxed">{piece.description}</p>
                  <p className="text-muted mt-3 text-xs">Last reviewed {formatDate(piece.lastReviewed)}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <section aria-labelledby="more-heading" className="mt-16">
          <h2
            id="more-heading"
            className="font-display text-[clamp(var(--text-2xl),3.2vw,var(--text-3xl))] leading-tight font-medium tracking-[-0.022em]"
          >
            Reference
          </h2>
          <ul className="mt-4 space-y-2 text-sm">
            <li>
              <a href="/glossary" className="underline underline-offset-2">
                Glossary of AI receptionist terms
              </a>
            </li>
            <li>
              <a href="/about" className="underline underline-offset-2">
                About {site.name}, and how we source and correct what we publish
              </a>
            </li>
            <li>
              <a href="/pricing" className="underline underline-offset-2">
                What {site.agent} costs
              </a>
            </li>
          </ul>
        </section>
      </main>
      <Footer />
    </>
  );
}

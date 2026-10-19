import { PRODUCTS, STEP_UNITS, type ProductId } from "@healdesk/catalog";

import type { GlossaryEntry, Piece } from "@/lib/content/types";
import { absoluteUrl } from "@/lib/seo";
import { site } from "@/lib/site";

/**
 * The schema.org facts the site states about itself, as JSON-LD.
 *
 * Search engines and AI assistants read these to learn what healdesk is, what
 * it costs and who published a page. Google requires every marked-up fact to
 * be visible on the page as well, so each builder here takes its values from
 * the same source the page prints: `site` for the company, the catalog for
 * prices, the content registry for articles. Nothing is typed twice.
 *
 * ## What is left out on purpose
 *
 * - `legalName`. The operating company appears only on the Terms and Privacy
 *   pages (owner, 9 October 2026), and the markup does not widen that.
 * - `aggregateRating` and `review`. There are no published reviews of AYA
 *   yet, and a rating in the markup with none on the page is the kind of
 *   mismatch Google treats as spam.
 * - `FAQPage`. Google withdrew FAQ rich results on 7 May 2026, and no page
 *   here is a list of questions and answers.
 */

type Json = Record<string, unknown>;

const ORG_ID = `${site.url}/#organization`;
const SITE_ID = `${site.url}/#website`;

export function organizationLd(): Json {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: site.name,
    url: site.url,
    logo: absoluteUrl("/icon.png"),
    description: site.entityDescription,
    email: site.email,
    ...(site.profiles.length > 0 ? { sameAs: [...site.profiles] } : {}),
  };
}

export function websiteLd(): Json {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": SITE_ID,
    name: site.name,
    url: site.url,
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
  };
}

const UNIT_TEXT: Record<ProductId, string> = {
  voice: `${String(STEP_UNITS)} voice minutes a month`,
  webchat: `${String(STEP_UNITS)} chat conversations a month`,
  metachat: `${String(STEP_UNITS)} chat conversations a month`,
};

/**
 * AYA as a product with its prices, for /pricing. One offer per product at
 * the price of one step of 100, which is how the page and checkout price it,
 * plus the one-time setup fee as a second price component.
 */
export function softwareApplicationLd(): Json {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: site.agent,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "AI receptionist",
    operatingSystem: "Web",
    description: site.entityDescription,
    url: absoluteUrl("/pricing"),
    publisher: { "@id": ORG_ID },
    offers: Object.values(PRODUCTS).map((product) => ({
      "@type": "Offer",
      name: product.name,
      url: absoluteUrl("/pricing"),
      priceCurrency: "USD",
      price: product.perStepMonthlyUsd,
      priceSpecification: [
        {
          "@type": "UnitPriceSpecification",
          price: product.perStepMonthlyUsd,
          priceCurrency: "USD",
          priceComponentType: "https://schema.org/Subscription",
          unitText: UNIT_TEXT[product.id],
          billingDuration: "P1M",
        },
        {
          "@type": "UnitPriceSpecification",
          price: product.setupFeeUsd,
          priceCurrency: "USD",
          priceComponentType: "https://schema.org/ActivationFee",
          unitText: "one-time setup",
        },
      ],
    })),
  };
}

export function articleLd(piece: Piece, path: string): Json {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: piece.title,
    description: piece.description,
    mainEntityOfPage: absoluteUrl(path),
    url: absoluteUrl(path),
    datePublished: piece.published,
    dateModified: piece.lastReviewed,
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
    citation: piece.sources.map((source) => source.url),
  };
}

export function breadcrumbLd(trail: readonly { name: string; path: string }[]): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: absoluteUrl(step.path),
    })),
  };
}

export function definedTermSetLd(entries: readonly GlossaryEntry[], path: string): Json {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    name: "Glossary of AI receptionist terms",
    url: absoluteUrl(path),
    publisher: { "@id": ORG_ID },
    hasDefinedTerm: entries.map((entry) => ({
      "@type": "DefinedTerm",
      name: entry.term,
      description: entry.definition,
      url: `${absoluteUrl(path)}#${termAnchor(entry.term)}`,
    })),
  };
}

/** The anchor a glossary term is linked by. */
export function termAnchor(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The payload of a `<script type="application/ld+json">`. `<` is escaped so a
 * string can never close the script element (Next's JSON-LD guide).
 */
export function serializeLd(data: Json | readonly Json[]): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

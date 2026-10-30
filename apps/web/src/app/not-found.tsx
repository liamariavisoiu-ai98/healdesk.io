import type { Metadata } from "next";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Page not found",
  // Belt and braces: Next injects noindex on 404 responses, but a streamed
  // not-found can go out as a 200 (see the not-found.js reference), and this
  // page must never rank.
  robots: { index: false, follow: false },
};

/**
 * The 404, for the whole app. Next renders it for any URL nothing else claims.
 *
 * ## Why it is a full page and not a card
 *
 * Once cold email and ads point at this domain, broken links are a certainty:
 * link-tracking rewrites truncate URLs, people mistype, and a share from a
 * chat app drops the trailing segment. The person arriving here was sent by
 * something that promised a product, so this page has to look like the
 * product, with the same navbar and the same footer as everywhere else, and
 * offer the places they were most likely trying to reach: AYA herself, and
 * the buy flow, which shows the packages and their prices. (A third button
 * went to /pricing until the owner disabled that page on 9 October 2026.)
 * The tone is AYA's: the whole pitch is that she picks up, so the one thing this page
 * must not do is sound like a machine that has given up. The headline is not
 * an absolute: until 3 October 2026 it said she "never misses a call", a
 * promise broader than the first-month guarantee, which provides for a miss
 * (docs/counsel/guarantee-and-refund.md, "Advertising the guarantee").
 *
 * The navbar's "Get Started" button falls back to a link here because there
 * is no BuyModalProvider on this route. That is deliberate: the modal's
 * checkout flow assumes a real page under it, and a 404 is not one.
 */
export default function NotFound() {
  return (
    <>
      <Nav />

      <main className="mx-auto max-w-page px-5 pt-16 pb-24 sm:px-8 sm:pt-24 lg:px-14">
        <div className="max-w-[52ch]">
          <p className="eyebrow-tag">
            404
          </p>
          <h1 className="font-display mt-3 text-[clamp(var(--text-4xl),6vw,var(--text-6xl))] leading-[1.03] font-medium tracking-[-0.028em]">
            {site.agent} picks up when your desk can&rsquo;t. This page, she can&rsquo;t find.
          </h1>
          <p className="text-muted mt-5 text-lg font-medium">
            The link you followed is missing a piece, or points somewhere that
            has moved. Everything on the site starts from one of these.
          </p>

          {/* The site's two buttons, not two pills (owner, 12 October 2026):
              the red block BuyButton draws and the `btn-outline` beside it,
              both 6px rectangles, as in the navbar and the hero. The hero's
              grid too: one column on a phone, two equal ones from 640px, so
              the pair is the same size whatever their labels. Meet AYA keeps
              the solid one, as it kept the gradient: she is what the visitor
              was most likely looking for. */}
          <div className="mt-9 grid w-full max-w-[480px] grid-cols-1 gap-3 sm:grid-cols-2">
            <a
              href="/"
              className="bg-red hover:bg-red-deep inline-flex h-[54px] w-full items-center justify-center gap-2 rounded-sm px-6 text-lg font-semibold whitespace-nowrap text-white transition-colors duration-fast"
            >
              Meet {site.agent}
            </a>
            <a
              href={site.cta.primary.href}
              className="btn-outline h-[54px] w-full px-6 text-lg whitespace-nowrap"
            >
              {site.cta.primary.label}
            </a>
          </div>

          <p className="text-muted mt-8 text-sm">
            If you typed the address from an email or an ad and landed here,
            tell us at{" "}
            <a
              href={`mailto:${site.email}`}
              className="text-red-deep underline underline-offset-2"
            >
              {site.email}
            </a>{" "}
            so we can fix the link.
          </p>
        </div>
      </main>

      <Footer />
    </>
  );
}

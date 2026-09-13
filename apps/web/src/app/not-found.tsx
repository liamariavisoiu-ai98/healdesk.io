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
 * offer the three places they were most likely trying to reach. The tone is
 * AYA's: the whole pitch is that she never misses a call, so the one thing
 * this page must not do is sound like a machine that has given up.
 *
 * The navbar's "Get Started" button falls back to a link here because there
 * is no BuyModalProvider on this route. That is deliberate: the modal's
 * checkout flow assumes a real page under it, and a 404 is not one.
 */
export default function NotFound() {
  return (
    <>
      <Nav />

      <main className="mx-auto max-w-[1240px] px-5 pt-16 pb-24 sm:px-8 sm:pt-24 lg:px-14">
        <div className="max-w-[52ch]">
          <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
            404
          </p>
          <h1 className="font-display mt-3 text-[clamp(40.8px,6vw,69.6px)] leading-[1.03] font-medium tracking-[-0.028em]">
            {site.agent} never misses a call. This page, she can&rsquo;t find.
          </h1>
          <p className="text-muted mt-5 text-[20.4px] font-medium">
            The link you followed is missing a piece, or points somewhere that
            has moved. Everything on the site is one of these.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <a
              href="/"
              className="bg-brand-gradient shadow-brand inline-flex items-center justify-center rounded-full px-7 py-3.5 text-base font-bold text-white transition-transform duration-200 hover:-translate-y-0.5"
            >
              Meet {site.agent}
            </a>
            <a
              href="/pricing"
              className="border-line text-ink hover:border-orange inline-flex items-center justify-center rounded-full border bg-white px-7 py-3.5 text-base font-bold transition-transform duration-200 hover:-translate-y-px"
            >
              Pricing
            </a>
            <a
              href={site.cta.primary.href}
              className="border-line text-ink hover:border-orange inline-flex items-center justify-center rounded-full border bg-white px-7 py-3.5 text-base font-bold transition-transform duration-200 hover:-translate-y-px"
            >
              {site.cta.primary.label}
            </a>
          </div>

          <p className="text-muted mt-8 text-[15.6px]">
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

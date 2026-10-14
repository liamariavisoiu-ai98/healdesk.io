import type { Metadata, Viewport } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";

import { CookieNotice } from "@/components/analytics/CookieNotice";
import { CampaignMemory } from "@/components/analytics/CampaignMemory";
import { PostHogProvider } from "@/components/analytics/PostHogProvider";
import { RevealOnScroll } from "@/components/RevealOnScroll";
import { site } from "@/lib/site";

import "./globals.css";

// Self-hosted by next/font, no render-blocking request to Google, and no
// layout shift from a late-arriving webfont.

/**
 * Two faces, and only two (owner, 12 October 2026): Fraunces for every
 * heading and figure, Instrument Sans for everything else.
 *
 * TAN Ashford (figures), Helvetica Now Display (section labels) and the
 * system monospace on the hero's announcement tag went the same day; their
 * files are in git history. The admin console keeps a monospace for the
 * codes and keys it prints, which are data rather than typography, and the
 * month-one phone draws its lock screen in the device's own face, as a
 * phone would (globals.css, "What changes in month one").
 *
 * Fraunces is loaded whole, as a variable font, with its optical-size axis
 * (`opsz`, 9 to 144) as well as its weight, rather than as three fixed
 * weights. Fixed weights are cut at one optical size, so a 64px heading was
 * drawn with the same coarse, low-contrast shapes as 14px text; with the axis
 * in the file the browser picks the cut from the size (`font-optical-sizing:
 * auto`, the default), and large headings get the sharper display design.
 * The soft and wonky axes stay out: nothing uses them and each one adds to
 * the file.
 */
const fraunces = Fraunces({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

/**
 * Instrument Sans, the body face from 12 October 2026, replacing Hanken
 * Grotesk. Variable, 400 to 700: a class asking for 800 resolves to 700
 * rather than being synthesised.
 */
const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
  display: "swap",
});

/**
 * Site-wide metadata. Per-page files set `title` and `description` and the
 * template below appends the name.
 *
 * No `openGraph.images` or `twitter.images` here on purpose. The share card is
 * app/opengraph-image.tsx (and twitter-image.tsx), which Next turns into the
 * og:image / twitter:image tags with the right width, height, type and alt.
 * Declaring an image here as well would emit two, and validators pick the
 * first one they meet, which is not reliably ours. Same for icons: app/icon.png
 * and app/apple-icon.png become the <link rel="icon"> tags by convention.
 *
 * `metadataBase` is `site.url`, which reads NEXT_PUBLIC_SITE_URL and falls
 * back to the production domain, so every relative URL Next builds from the
 * file conventions resolves against the deployed origin, and a preview deploy
 * with the variable set previews its own cards.
 */
export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  applicationName: site.name,
  title: {
    default: `${site.name}, ${site.tagline}`,
    template: `%s, ${site.name}`,
  },
  description: site.description,
  openGraph: {
    type: "website",
    locale: "en_US",
    url: site.url,
    siteName: site.name,
    title: `${site.name}, ${site.tagline}`,
    description: site.description,
  },
  twitter: {
    card: "summary_large_image",
    title: `${site.name}, ${site.tagline}`,
    description: site.description,
  },
  // Pages that must not rank (/get-started, the 404) override this locally;
  // robots.ts keeps crawlers out of the funnel before it is ever fetched.
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#FDFDFD",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      // Next 16 no longer neutralises `scroll-behavior: smooth` (globals.css)
      // during route transitions unless this attribute is present.
      data-scroll-behavior="smooth"
      className={`${fraunces.variable} ${instrument.variable}`}
    >
      <body className="min-h-screen antialiased">
        {children}
        {/* Analytics initialises only after the visitor accepts the notice,
            and never on /admin or a personalised demo. No advertising pixel or
            tag manager may ever be added here — see src/lib/analytics.ts and
            docs/architecture.md "No conversion attribution to ad platforms". */}
        <RevealOnScroll />
        <PostHogProvider />
        <CookieNotice />
        <CampaignMemory />
      </body>
    </html>
  );
}

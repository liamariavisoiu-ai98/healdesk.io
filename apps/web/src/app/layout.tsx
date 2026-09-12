import type { Metadata, Viewport } from "next";
import { Fraunces, Hanken_Grotesk } from "next/font/google";
import localFont from "next/font/local";

import { site } from "@/lib/site";

import "./globals.css";

// Self-hosted by next/font, no render-blocking request to Google, and no
// layout shift from a late-arriving webfont.

/**
 * TAN Ashford, and it is only ever a number.
 *
 * It ran the whole display layer for an afternoon and has been pulled back to
 * figures: the rating, the prices, the money the calculator works out. A face
 * this assertive earns its place on a lone 4.9 the size of a fist and fights
 * every heading it sits under, which is what happens when a display face has
 * one weight and a lot of personality.
 *
 * Licensed, so it ships from this repo rather than from a font service.
 *
 * ⚠️ One weight, 700. Figures carry `font-semibold` and resolve to it, and a
 * browser asked for a LIGHTER weight than exists uses the nearest real face
 * rather than synthesising, so nothing is faux-bolded. Do not reach for
 * `font-bold` expecting heavier; there is nothing heavier and that IS the case
 * a browser fakes. The file also has no ellipsis glyph, which no figure needs.
 */
const ashford = localFont({
  src: "./fonts/ashford-bold.woff2",
  weight: "700",
  style: "normal",
  variable: "--font-ashford",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-hanken",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name}, ${site.tagline}`,
    template: `%s, ${site.name}`,
  },
  description: site.description,
  openGraph: {
    type: "website",
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
      className={`${fraunces.variable} ${hanken.variable} ${ashford.variable}`}
    >
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

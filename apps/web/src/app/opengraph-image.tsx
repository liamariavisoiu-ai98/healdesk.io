import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { site } from "@/lib/site";

/**
 * The share card: what a healdesk.io link becomes in Slack, iMessage, LinkedIn
 * and X. Until this existed the card was a grey box with a globe on it, which
 * for a product sold cold to strangers reads as abandoned.
 *
 * ## Rendered, not a PNG in the repo
 *
 * The wordmark is read from public/brand at build time and the tagline comes
 * from src/lib/site.ts, so a change to either shows up here without anyone
 * remembering to re-export a card. It is statically optimised: no request-time
 * API is used, so Next renders it once at build and serves the bytes.
 *
 * ## Typography
 *
 * Satori, which draws this, takes TTF/OTF/WOFF and not WOFF2, and the only
 * font shipped in the repo (TAN Ashford) is WOFF2 and is reserved for figures
 * anyway. The site's display face arrives through next/font at build time and
 * is not on disk to read. So the tagline sets in the bundled default sans,
 * which is honest rather than a near-miss imitation of Fraunces. If a TTF of
 * the display face is ever added under app/fonts, pass it in `fonts` below.
 *
 * ## Layout
 *
 * 1200×630, the size every network's validator agrees on. Paper ground, the
 * wordmark large at the top left, the tagline under it in ink, and the brand
 * gradient as a band along the bottom edge so the card carries the logo's
 * colour even when the preview is cropped to a square.
 */
export const alt = `${site.name}, ${site.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Same values as --color-paper, --color-ink, --color-red, --color-orange. */
const PAPER = "#fdfdfd";
const INK = "#172a3a";
const MUTED = "#5c6e7e";
const GRADIENT = "linear-gradient(90deg, #e62627 6%, #ff761e 94%)";

/** 2400×437, see components/Wordmark.tsx. Rendered at this width. */
const WORDMARK_WIDTH = 720;
const WORDMARK_HEIGHT = Math.round(WORDMARK_WIDTH / 5.492);

export default async function Image() {
  const wordmark = await readFile(
    join(process.cwd(), "public/brand/healdesk-logo.png"),
  );
  const wordmarkSrc = `data:image/png;base64,${wordmark.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          padding: "72px 80px 0",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <img
            src={wordmarkSrc}
            width={WORDMARK_WIDTH}
            height={WORDMARK_HEIGHT}
            alt=""
          />
          <div
            style={{
              marginTop: 56,
              fontSize: 64,
              fontWeight: 600,
              lineHeight: 1.08,
              letterSpacing: "-0.03em",
              maxWidth: 980,
            }}
          >
            {site.tagline}
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 28,
              fontWeight: 400,
              lineHeight: 1.35,
              color: MUTED,
              maxWidth: 900,
            }}
          >
            {site.description}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingBottom: 40,
            fontSize: 26,
            fontWeight: 600,
            color: MUTED,
          }}
        >
          <span>{site.domain}</span>
        </div>

        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 18,
            backgroundImage: GRADIENT,
          }}
        />
      </div>
    ),
    { ...size },
  );
}

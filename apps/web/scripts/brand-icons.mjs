/**
 * Cut the favicon and iOS home-screen icon out of the wordmark.
 *
 *   node apps/web/scripts/brand-icons.mjs
 *
 * Writes src/app/icon.png and src/app/apple-icon.png, which Next's metadata
 * file convention turns into <link rel="icon"> and <link rel="apple-touch-icon">
 * with the right type and sizes attributes, no hand-written <head> tags.
 *
 * ## Why the "h", and why it is cut rather than drawn
 *
 * The site has exactly one piece of art: the wordmark in public/brand. It has
 * no separate glyph mark, and a favicon that shows the whole word at 16px is
 * an orange smear. The first letter, in the logo red, at the logo's own weight
 * and swash, is the brand mark this site actually has; anything invented here
 * would be a second logo that nobody approved. So the script locates the "h"
 * by scanning the wordmark's alpha channel for the first run of opaque
 * columns, trims it, and centres it on a square. Re-export the wordmark and
 * re-run this; nothing is measured by hand.
 *
 * ## Two files, two backgrounds
 *
 * icon.png keeps its transparency: browser tabs sit on light and dark chrome
 * and the letter should float on either. apple-icon.png gets the page's paper
 * colour behind it, because iOS discards alpha and fills with black, and a red
 * "h" on black is not the brand.
 *
 * sharp is not a declared dependency of this workspace. It is here because
 * Next depends on it for image optimisation, so it is present wherever the
 * app builds. If a Next upgrade ever drops it, `npm i -D sharp` in apps/web.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, "../public/brand/healdesk-logo.png");
const ICON = resolve(here, "../src/app/icon.png");
const APPLE_ICON = resolve(here, "../src/app/apple-icon.png");

/** Same value as --color-paper in globals.css. */
const PAPER = { r: 0xfd, g: 0xfd, b: 0xfd, alpha: 1 };

/** Pixels above this alpha count as ink; the wordmark has a soft drop shadow. */
const INK_ALPHA = 40;

/** Breathing room around the glyph, as a fraction of the square's side. */
const PADDING = 0.12;

/**
 * The x-range of the first glyph: the first run of columns containing ink.
 * The wordmark's letters do not touch, so the run ends at the gap before "e".
 */
async function firstGlyphColumns(source) {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const inked = (x) => {
    for (let y = 0; y < info.height; y++) {
      if (data[(y * info.width + x) * info.channels + 3] > INK_ALPHA) return true;
    }
    return false;
  };

  let start = 0;
  while (start < info.width && !inked(start)) start++;
  let end = start;
  while (end < info.width && inked(end)) end++;

  if (start === end) throw new Error(`no ink found in ${source}`);
  return { left: start, width: end - start, height: info.height };
}

async function main() {
  const { left, width, height } = await firstGlyphColumns(SOURCE);

  // Trim vertically too: the letter is shorter than the canvas, and the
  // canvas height includes the descender room for ".io".
  // Two passes, not one chain: sharp applies trim before extract whatever
  // order they are called in, so a single pipeline trims the whole wordmark
  // and then tries to extract the "h" from a canvas that no longer has it.
  const column = await sharp(SOURCE)
    .extract({ left, top: 0, width, height })
    .png()
    .toBuffer();
  const glyph = await sharp(column).trim({ threshold: INK_ALPHA }).png().toBuffer();
  const meta = await sharp(glyph).metadata();

  const side = Math.round(Math.max(meta.width, meta.height) * (1 + 2 * PADDING));
  const padX = Math.round((side - meta.width) / 2);
  const padY = Math.round((side - meta.height) / 2);

  // Materialised before resizing for the same reason as above: extend runs
  // after resize in sharp's fixed pipeline, so chaining them pads the 512px
  // output instead of the glyph and the result is not square.
  const squared = async (background) =>
    sharp(glyph)
      .extend({
        top: padY,
        bottom: side - meta.height - padY,
        left: padX,
        right: side - meta.width - padX,
        background,
      })
      .png()
      .toBuffer();

  await sharp(await squared({ r: 0, g: 0, b: 0, alpha: 0 }))
    .resize(512, 512)
    .png()
    .toFile(ICON);
  await sharp(await squared(PAPER))
    .flatten({ background: PAPER })
    .resize(180, 180)
    .png()
    .toFile(APPLE_ICON);

  console.log(`glyph ${width}x${meta.height} at x=${left} → ${ICON} (512), ${APPLE_ICON} (180)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

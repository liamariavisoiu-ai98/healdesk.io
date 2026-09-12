/**
 * The healdesk wordmark, as the real logo asset.
 *
 * ## One component, three placements
 *
 * The navbar logo and the giant mark behind AVA are two halves of one scroll
 * hand-off (see HeroMark.tsx), and that only works if the two are geometrically
 * congruent at the crossover frame. When both were CSS text this had to be
 * maintained by hand, same face, same size, same tracking, same em-relative
 * `.io`, and any drift showed as a visible pop mid-animation.
 *
 * Rendering one image at one fixed height makes congruence structural instead:
 * the hero mark is literally the navbar mark with a `scale` on it, so there is
 * nothing left to keep in sync.
 *
 * ## Sizing
 *
 * Height is fixed rather than inherited from font-size, because the hand-off
 * measures this element's box to work out how far it has to shrink. A mark that
 * changed size with its container would move the target it is aiming at.
 *
 * The asset is 2400px wide. The hero mark peaks at roughly 7x navbar size,
 * about 1140 CSS px on a wide viewport, 2280 device px at 2x, so it renders at
 * or below native resolution and never upscales.
 *
 * `alt=""` on purpose: every call site wraps this in a link that already
 * carries an accessible name, and the hero copy is `aria-hidden` outright. A
 * second "healdesk.io" announcement here would be a duplicate, not a help.
 */

/** 2400 / 437, from the exported asset. */
export const WORDMARK_ASPECT = 5.492;

/** The one size this renders at. The hero scales it; it never re-lays out. */
export const WORDMARK_HEIGHT = 28;

export function WordmarkGlyphs() {
  return (
    <img
      src="/brand/healdesk-logo.webp"
      alt=""
      width={Math.round(WORDMARK_HEIGHT * WORDMARK_ASPECT)}
      height={WORDMARK_HEIGHT}
      draggable={false}
      className="block h-[28px] w-auto max-w-none select-none"
    />
  );
}

/**
 * The lockup with the slogan under it. Footer only.
 *
 * Deliberately not used anywhere the mark has to be small: the strapline sets
 * at roughly a tenth of the lockup's height, so anything under about 150px wide
 * renders it as texture rather than words.
 */
export const WORDMARK_SLOGAN_ASPECT = 2.887;

export function WordmarkSlogan({ className = "" }: { className?: string }) {
  return (
    <img
      src="/brand/healdesk-logo-slogan.webp"
      alt=""
      width={220}
      height={Math.round(220 / WORDMARK_SLOGAN_ASPECT)}
      draggable={false}
      className={`block h-auto w-[200px] max-w-full select-none sm:w-[220px] ${className}`}
    />
  );
}

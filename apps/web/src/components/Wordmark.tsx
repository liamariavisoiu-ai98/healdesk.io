/**
 * The healdesk wordmark, as the real logo asset.
 *
 * It was also the giant mark behind AYA in the hero, scaled up from this one
 * in a scroll hand-off, which is why it renders as one image at one fixed
 * height. The hero is static now and the hand-off is gone: this is the logo
 * in the navbar, and on the checkout and admin sign-in pages, which have none.
 *
 * ## Sizing
 *
 * 28px tall wherever there is room for it. Where there is not, a phone under
 * about 360px wide with the navbar's two buttons beside it, it narrows to the
 * room it has and the artwork scales down inside its box, rather than push
 * the buttons off the edge of the screen. The box stays 28px tall either way,
 * so the navbar does not change height.
 *
 * `alt=""` on purpose: every call site wraps this in a link that already
 * carries an accessible name. A second "healdesk.io" announcement here would
 * be a duplicate, not a help.
 */

/** 2400 / 437, from the exported asset. */
export const WORDMARK_ASPECT = 5.492;

/** The size this renders at wherever it fits. */
export const WORDMARK_HEIGHT = 28;

export function WordmarkGlyphs() {
  return (
    <img
      src="/brand/healdesk-logo.webp"
      alt=""
      width={Math.round(WORDMARK_HEIGHT * WORDMARK_ASPECT)}
      height={WORDMARK_HEIGHT}
      draggable={false}
      className="block h-[28px] w-auto max-w-full object-contain select-none"
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

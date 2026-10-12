/**
 * The healdesk wordmark, as the real logo asset.
 *
 * It was also the giant mark behind AYA in the hero, scaled up from this one
 * in a scroll hand-off, which is why it renders as one image at one fixed
 * height. The hero is static now and the hand-off is gone: this is the logo
 * in the navbar and, since 9 October 2026, the footer, and on the checkout
 * and admin sign-in pages, which have no navbar.
 *
 * ## Sizing
 *
 * 28px tall wherever there is room for it, and 36px in the navbar (owner,
 * 12 October 2026: it read too small there), which is still under the
 * navbar's 44px buttons, so the bar keeps its height. Where there is not
 * room, a phone with the navbar's two buttons beside it, it narrows to the
 * room it has and the artwork scales down inside its box, rather than push
 * the buttons off the edge of the screen. The box keeps its height either
 * way, so the navbar does not change height.
 *
 * `alt=""` on purpose: every call site wraps this in a link that already
 * carries an accessible name. A second "healdesk.io" announcement here would
 * be a duplicate, not a help.
 */

/** 2400 / 437, from the exported asset. */
export const WORDMARK_ASPECT = 5.492;

/** The size this renders at wherever it fits. */
export const WORDMARK_HEIGHT = 28;

/** The navbar's, larger than everywhere else. */
export const NAV_WORDMARK_HEIGHT = 36;

export function WordmarkGlyphs({ height = WORDMARK_HEIGHT }: { height?: number }) {
  return (
    <img
      src="/brand/healdesk-logo.webp"
      alt=""
      width={Math.round(height * WORDMARK_ASPECT)}
      height={height}
      draggable={false}
      style={{ height }}
      className="block w-auto max-w-full object-contain select-none"
    />
  );
}

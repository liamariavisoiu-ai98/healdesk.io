/**
 * The hand-off from payment to the portal (plan Part A4 and C3), shared by
 * the two apps because each holds one end of it.
 *
 * apps/web, when the buyer presses Pay, sets a random nonce in this cookie on
 * the paying browser (HttpOnly, SameSite=Lax, Path=/welcome, on the parent
 * domain so app.healdesk.io can read it) and sends only its SHA-256 to apps/app
 * with the purchase. apps/app's /welcome hands the one-time sign-in link only
 * to a browser presenting the nonce whose hash the purchase carries: the
 * browser that paid, and no one who merely learns the success URL.
 */
export const WELCOME_NONCE_COOKIE = "hd_welcome";

/** Long enough to pay, short enough to be gone by the time anyone else is at the keyboard. */
export const WELCOME_NONCE_TTL_SECONDS = 30 * 60;

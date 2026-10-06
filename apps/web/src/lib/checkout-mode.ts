/**
 * Who may buy right now: anyone, or only people we sent a setup link to.
 *
 * Until Google verifies the calendar app, the purchase opens by invitation.
 * A prospect asks for setup ("Tell us about your clinic"), and an operator
 * replies with a setup link from /admin; only that link opens the checkout.
 * Once verification lands, `HEALDESK_CHECKOUT_MODE=public` opens it to
 * everyone (docs/design/funnel-onboarding-portal-2026-10-06.md, A2).
 *
 * ## Fail-closed
 *
 * Unset, blank, misspelt or anything other than exactly "public" is
 * "pilot". A deploy that forgets the variable keeps the gate shut, which is
 * the cheap mistake; the expensive one is a public checkout nobody meant to
 * open, selling a product whose calendar connection still shows Google's
 * unverified-app warning to more than 100 accounts.
 *
 * ## "Pilot" is an internal word
 *
 * Nothing a client sees says "pilot", "beta", "early access" or anything
 * else that suggests we are new (the owner's rule of 5 October 2026). The
 * form is "Tell us about your clinic"; the link is "your setup link". Keep
 * the word in code, logs and /admin only.
 */
export type CheckoutMode = "pilot" | "public";

export function checkoutMode(env: NodeJS.ProcessEnv = process.env): CheckoutMode {
  return env.HEALDESK_CHECKOUT_MODE?.trim().toLowerCase() === "public" ? "public" : "pilot";
}

/**
 * May /admin send setup links yet? (Gate A in the plan.)
 *
 * A setup link promises the purchase the plan describes: package, clinic,
 * data agreement, then the setup fee only, with the monthly plan starting
 * the day AYA first answers a patient. Until that purchase exists (M2) and
 * the rest of the launch checklist is done, the checkout still charges the
 * first month up front, so a link sent today would describe a purchase the
 * clinic cannot make. Production refuses to send one until the owner sets
 * `HEALDESK_SETUP_LINKS=open`. Outside production the flow stays testable.
 */
export function setupLinksOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HEALDESK_SETUP_LINKS?.trim().toLowerCase() === "open") return true;
  return env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production";
}

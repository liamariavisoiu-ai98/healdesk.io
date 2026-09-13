/**
 * Single source of truth for brand identity and site-wide copy.
 *
 * The domain lives here rather than being inlined so switching it is one edit.
 *
 * ## The shape of the site is deliberate, and small
 *
 * One page carries the argument: hero, the two live demos, the specialties we
 * know, the money question, and a way to get in touch. Pricing and contact
 * exist as their own pages but are linked ONLY from the footer, because a nav
 * full of links is an invitation to leave before the demo has done its job.
 *
 * So the navbar holds a wordmark and two calls to action, in that order of
 * weight: "Get Started" opens the purchase flow, and "Interact with AYA" moves
 * the viewport to the demo. Nothing else.
 */

export const site = {
  name: "healdesk",
  domain: "healdesk.io",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://healdesk.io",

  /** The agent's name. She is the face in the hero and the voice on the phone. */
  agent: "AYA",

  tagline: "Meet AYA. She never misses a call.",
  subtitle:
    "An AI front desk for eight specialties, answering, qualifying, booking and following up.",

  description:
    "healdesk answers every call, text, and DM for high-ticket elective clinics, " +
    "then shows you which recovered call became collected revenue.",

  /** The anchor the secondary CTA scrolls to. Owned here so the two cannot drift. */
  demoAnchor: "#aya",

  cta: {
    /**
     * Opens the purchase flow. Where a BuyModalProvider is present this is a
     * button that opens it in place; everywhere else it falls back to this
     * href, so the CTA is never dead.
     */
    primary: { label: "Get Started", href: "/get-started" },
    secondary: { label: "Interact with AYA", href: "#aya" },
  },

  /**
   * Footer only. There is no primary nav, see the note at the top of the file.
   * Paths are absolute so the same list works from every page.
   */
  footerLinks: [
    { label: "Pricing", href: "/pricing" },
    { label: "Contact us", href: "/contact" },
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Subprocessors", href: "/subprocessors" },
    { label: "Trust", href: "/trust" },
  ],

  email: "hello@healdesk.io",
} as const;

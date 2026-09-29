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
 * So the navbar holds a wordmark, one link and two calls to action, in that
 * order of weight: "Get Started" opens the purchase flow, "Talk to AYA" moves
 * the viewport to the demo, and "Why wait?" goes to the calculator, which
 * left the homepage on 23 September 2026 so that the homepage could be about
 * meeting her. Nothing else.
 */

export const site = {
  name: "healdesk",
  domain: "healdesk.io",
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://healdesk.io",

  /** The agent's name. She is the face in the hero and the voice on the phone. */
  agent: "AYA",

  /**
   * The hero's headline and its supporting line. One claim each, and both
   * have to survive the footer's commitments: AYA holds a consult against the
   * calendar and the desk confirms it, because her access is read-only, so
   * the copy says "for your desk to confirm" rather than "books". Rewritten
   * 23 September 2026 against the reception.ai hero as the reference for
   * what the supporting line has to carry: who answers, when, what she
   * handles, what she books, and where she sends the rest. The headline
   * itself is the owner's: reliability is the promise, and the paragraph
   * under it is the evidence.
   */
  tagline: "An AI front desk you can rely on.",
  subtitle:
    "AYA answers your phone, web chat and DMs around the clock. She knows your " +
    "services, prices and hours, handles the questions patients actually ask, " +
    "pencils consults into your real availability for your desk to confirm, and " +
    "passes anything that needs a person straight to your team.",

  description:
    "healdesk answers every call, text, and DM for high-ticket elective clinics, " +
    "then shows you which recovered call became collected revenue.",

  /**
   * The line in the bar above the hero headline, after jasper.ai's "NEW"
   * announcement. One claim, and it has to be true on the day it ships: the
   * Meta channels are in the catalog as packages a clinic can buy today.
   * Chosen by the owner on 23 September 2026.
   */
  announcement: {
    tag: "New",
    text: "AYA now answers Instagram and WhatsApp DMs, as well as your phone.",
    cta: "Get started",
  },

  cta: {
    /**
     * Opens the purchase flow. Where a BuyModalProvider is present this is a
     * button that opens it in place; everywhere else it falls back to this
     * href, so the CTA is never dead.
     */
    primary: { label: "Get Started", href: "/get-started" },
    secondary: { label: "Talk to AYA", href: "#aya" },
  },

  /** The one link in the navbar. See the note at the top of the file. */
  navLinks: [{ label: "Why wait?", href: "/why-wait" }],

  /**
   * Footer. Paths are absolute so the same list works from every page.
   */
  footerLinks: [
    { label: "Why wait?", href: "/why-wait" },
    { label: "Pricing", href: "/pricing" },
    { label: "Contact us", href: "/contact" },
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Subprocessors", href: "/subprocessors" },
    { label: "Trust", href: "/trust" },
  ],

  email: "hello@healdesk.io",
} as const;

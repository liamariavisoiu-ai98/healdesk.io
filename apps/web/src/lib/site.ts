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
   * have to survive the footer's commitments. In v1 AYA books: she writes the
   * appointment into the clinic's Google Calendar during the conversation,
   * and "Auto-confirm bookings" is on by default. A clinic that turns it off,
   * or whose booking system does not read Google for conflicts, gets each
   * booking as a request its staff approve instead (docs/v1-product-spec.md,
   * "Every switch in the portal"). So the copy says "books", and says where.
   * Deposits are taken in chat, never on the phone, so the deposit clause
   * says "in chat". The supporting line carries who answers, when, what she
   * handles, what she books, and where she sends the rest, after the
   * reception.ai hero of 23 September 2026. The headline itself is the
   * owner's: reliability is the promise, and the paragraph under it is the
   * evidence.
   */
  tagline: "An AI front desk you can rely on.",
  subtitle:
    "AYA answers your phone, website chat, Instagram, Messenger and WhatsApp, " +
    "day or night. She knows your services, prices and hours, books patients " +
    "straight into your calendar during the conversation, takes the deposit in " +
    "chat where you want one, and routes anything clinical to the right person " +
    "on your team.",

  /**
   * The site-wide meta description, the Open Graph and Twitter description,
   * and the text on the rendered share image. No texting (v1 has no SMS) and
   * no revenue claim (attribution is phase two).
   */
  description:
    "healdesk answers every call, chat and DM for high-ticket elective clinics, " +
    "day or night, and books appointments straight into your calendar.",

  /**
   * The line in the bar above the hero headline, after jasper.ai's "NEW"
   * announcement. One claim, and it has to be true on the day it ships. It
   * says "launching with" rather than "now answers": Meta Business
   * Verification and App Review are still open gates, and "now" is only true
   * once Meta has approved the messaging permissions. Switch the wording on
   * the day it is, and leave WhatsApp out if it is not live with the other
   * two (docs/v1-product-spec.md, "External gates on the launch date").
   */
  announcement: {
    tag: "New",
    text: "Launching with Instagram, Messenger and WhatsApp, alongside your phone and website chat.",
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
    { label: "Data deletion", href: "/data-deletion" },
    { label: "Terms", href: "/terms" },
    { label: "Subprocessors", href: "/subprocessors" },
    { label: "Trust", href: "/trust" },
  ],

  email: "hello@healdesk.io",
} as const;

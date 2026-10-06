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
 * order of weight: "Get AYA" opens the purchase flow, "Talk to AYA" moves
 * the viewport to the demo, and "Why wait?" goes to the calculator, which
 * left the homepage on 23 September 2026 so that the homepage could be about
 * meeting her. Nothing else.
 */

/**
 * NEXT_PUBLIC_SITE_URL as an origin, or null when it is unset or blank.
 *
 * The value is typed by hand into Vercel's dashboard, and the two easy
 * mistakes are both fatal at build time: `new URL()` in layout.tsx's
 * metadataBase throws on a bare "healdesk.io" and on an empty string, and
 * every route fails page-data collection with it. That is what a Production
 * build that Preview passed looks like, since Preview leaves the variable
 * unset and falls back. So a missing scheme becomes https, a trailing slash
 * goes (every caller appends its own path), and anything still not a URL
 * fails with the variable's name in the message instead of "Invalid URL".
 */
export function normalizeSiteUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`NEXT_PUBLIC_SITE_URL is not a URL: ${JSON.stringify(raw)}`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

export const site = {
  name: "healdesk",
  domain: "healdesk.io",
  url: normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL) ?? "https://healdesk.io",

  /** The agent's name. She is the voice in the chat and on the phone. */
  agent: "AYA",

  /**
   * The hero's headline. One claim, and it has to survive the footer's
   * commitments. The headline is the owner's: reliability is the promise. The
   * supporting paragraph that sat under it was removed on the owner's word on
   * 5 October 2026, so the heading makes this one claim and nothing else.
   */
  tagline: "An AI front desk you can rely on.",

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
   * announcement. One claim, and it has to be true on the day it ships.
   *
   * The owner's wording of 6 October 2026, replacing "Launching with…",
   * which read as a company that is new rather than a feature that is. It
   * rests on the owner's rule from the same day: a channel is sold only once
   * it is ready, and one that isn't comes off the product list. So if Meta's
   * approvals are not in by launch, the Meta channels come out of this line
   * too, WhatsApp on its own if only it lags (docs/v1-product-spec.md,
   * "External gates on the launch date").
   */
  announcement: {
    tag: "New",
    text: "Instagram, Messenger and WhatsApp, now available alongside your phone and website chat.",
    cta: "Get AYA",
  },

  cta: {
    /**
     * Opens the purchase flow. Where a BuyModalProvider is present this is a
     * button that opens it in place; everywhere else it falls back to this
     * href, so the CTA is never dead.
     */
    primary: { label: "Get AYA", href: "/get-started" },
    secondary: { label: "Talk to AYA", href: "#aya" },
  },

  /**
   * "Get in touch" in the navbar: a call with us, booked in Calendly's
   * scheduler opened over the page (GetInTouch.tsx). Its length is the
   * event's, set in Calendly; nothing on the site states it. The URL is also
   * the button's href, so the call can be booked from a browser that has not
   * run the page's script, and its origin is the one the security policy lets
   * the site frame (security-headers.ts, which a test keeps in step with it).
   *
   * It is the event's own link, so changing that link in Calendly breaks the
   * button: the "30min" link this replaced went to a 404 on 6 October 2026,
   * the day the button shipped.
   */
  meeting: { label: "Get in touch", url: "https://calendly.com/healdesk-io/get-in-touch" },

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

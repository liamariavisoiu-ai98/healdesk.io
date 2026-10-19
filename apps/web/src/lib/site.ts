/**
 * Single source of truth for brand identity and site-wide copy.
 *
 * The domain lives here rather than being inlined so switching it is one edit.
 *
 * ## The shape of the site is deliberate, and small
 *
 * One page carries the argument: hero, the two live demos, the specialties we
 * know, the money question, and a way to get in touch. Contact exists as its
 * own page but is linked ONLY from the footer, because a nav full of links is
 * an invitation to leave before the demo has done its job. There is no
 * pricing page since 9 October 2026 (owner): prices are shown in the purchase
 * flow.
 *
 * So the navbar holds a wordmark, one link and two calls to action, in that
 * order of weight: "Get AYA" opens the purchase flow, "Try AYA for free"
 * (until 9 October 2026 "Talk to AYA") moves the viewport to the demo, and "Why wait?" goes to the calculator, which
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
   * The words buyers search with, in the homepage <title> (owner's
   * strategy, 14 October 2026: "AI receptionist" appeared nowhere on the
   * site). The visible headline stays `tagline`.
   */
  category: "AI receptionist for elective clinics",

  /**
   * The site-wide meta description, the Open Graph and Twitter description,
   * and the text on the rendered share image. No texting (v1 has no SMS) and
   * no revenue claim (attribution is phase two).
   *
   * It said "answers every call" until 19 October 2026. AYA answers the calls
   * a clinic forwards to it, in the mode the clinic picks, and the default
   * forwards only overflow and after-hours calls, so the copy guard now bans
   * the phrase.
   */
  description:
    "An AI receptionist for elective clinics. AYA answers the calls you forward to her, " +
    "your website chat and your Instagram, Messenger and WhatsApp messages, and books the visit.",

  /**
   * The one description of the company, in the third person: the
   * Organization markup, and the LinkedIn, Crunchbase, G2 and Capterra
   * profiles, which must all say the same thing so that search and AI
   * engines learn one entity rather than several.
   */
  entityDescription:
    "healdesk is an AI receptionist for elective clinics. Its assistant, AYA, answers the " +
    "calls a clinic forwards to it, its website chat and its Instagram, Messenger and " +
    "WhatsApp messages, and books appointments into the clinic's Google Calendar.",

  /**
   * The company's profiles elsewhere, for the Organization markup's `sameAs`.
   * Add each URL the day its profile goes live; an empty list is honest, a
   * guessed URL is not.
   */
  profiles: [] as readonly string[],

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
    // One line, as a pill (owner, 12 October 2026). `cta` is no longer
    // printed: the whole pill is the way in, and `cta` is what its name says
    // it does.
    text: "Now on Instagram, Messenger and WhatsApp",
    cta: "Get AYA",
  },

  cta: {
    /**
     * Opens the purchase flow. Where a BuyModalProvider is present this is a
     * button that opens it in place; everywhere else it falls back to this
     * href, so the CTA is never dead.
     */
    primary: { label: "Get AYA", href: "/get-started" },
    secondary: { label: "Try AYA for free", href: "#aya" },
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
    { label: "Pricing", href: "/pricing" },
    // The editorial library (strategy of 14 October 2026), so every guide is
    // two clicks from any page and a crawler finds them without the sitemap.
    { label: "Guides", href: "/guides" },
    { label: "Why wait?", href: "/why-wait" },
    { label: "Contact us", href: "/contact" },
    { label: "Privacy", href: "/privacy" },
    { label: "Data deletion", href: "/data-deletion" },
    { label: "Terms", href: "/terms" },
  ],

  email: "hello@healdesk.io",

  /**
   * AYA's demo line: the number clinic owners dial to hear her answer. A
   * Retell toll-free number, answered by the inbound demo agent and used as
   * the caller ID of the demo call (scripts/retell-demo-agent.ts binds both).
   * It is a demonstration line, not a support line: it reaches AYA, never a
   * person, and the copy beside it must not suggest otherwise.
   */
  demoLine: { e164: "+18886889404", display: "(888) 688-9404" },
} as const;

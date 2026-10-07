/**
 * The logos beside AYA in the hero, what a screen reader hears in their
 * place, and whose marks they are.
 *
 * HeroPortrait places HERO_LOGOS beside her and labels them with LABEL, and
 * the footer prints TRADEMARKS on every page. They live together so a logo
 * cannot reach the hero without its label and its attribution:
 * src/lib/integrations.test.ts fails if either is missing, if a logo's file
 * is not in public/, or if two logos overlap. What is there, and why in this
 * order, is in HeroPortrait.tsx.
 *
 * The files are the owner's own downloads, cut out of their backgrounds;
 * Calendly's and HighLevel's are their symbols without the wordmarks, which
 * would be unreadable at the size of an app icon. On 5 October 2026 the
 * owner chose to ship them as downloaded, after the review that built the
 * ring noted that two come from a stock site that marks brand logos for
 * editorial use and the website glyph from one that asks for a credit on its
 * free licence. Calendly's and HighLevel's, added the same day, are copies
 * from TrustRadius and from RingCentral's app gallery. Stripe's is the
 * owner's vector replacement for an untraceable Google Images thumbnail,
 * rendered from SVG at the canvas size.
 */

export type HeroLogo = {
  /** What the logo stands for, as the label names it. */
  name: string;
  src: string;
  /**
   * The trademark the logo is, or null for a glyph that is nobody's mark.
   * Required rather than optional so that a new logo cannot skip the
   * footer's attribution by leaving it out.
   */
  mark: string | null;
  /**
   * The logo's centre on the hero photo, in percent of its width and height.
   * HeroPortrait.tsx says how these were found; move them with the photo.
   */
  at: { x: number; y: number };
};

/**
 * Top to bottom down AYA's left side, alternately close to her and further
 * out: about 120 and 265 photo pixels from her outline, measured row by row.
 */
export const HERO_LOGOS: readonly HeroLogo[] = [
  {
    name: "website chat",
    src: "/integrations/website-chat.webp",
    mark: null,
    at: { x: 59.93, y: 10.2 },
  },
  {
    name: "Instagram",
    src: "/integrations/instagram.webp",
    mark: "Instagram",
    at: { x: 49.88, y: 20.19 },
  },
  // The owner's file is Facebook's "f"; the channel it stands for is Messenger.
  {
    name: "Messenger",
    src: "/integrations/facebook.webp",
    mark: "Facebook",
    at: { x: 57.95, y: 30.18 },
  },
  {
    name: "WhatsApp",
    src: "/integrations/whatsapp.webp",
    mark: "WhatsApp",
    at: { x: 49.46, y: 40.06 },
  },
  {
    name: "Google Calendar",
    src: "/integrations/google-calendar.webp",
    mark: "Google Calendar",
    at: { x: 61.24, y: 50.05 },
  },
  {
    name: "Cal.com",
    src: "/integrations/cal-com.webp",
    mark: "Cal.com",
    at: { x: 47.49, y: 60.04 },
  },
  {
    name: "Calendly",
    src: "/integrations/calendly.webp",
    mark: "Calendly",
    at: { x: 53.83, y: 69.93 },
  },
  {
    name: "HighLevel",
    src: "/integrations/highlevel.webp",
    mark: "HighLevel",
    at: { x: 43.0, y: 79.91 },
  },
  { name: "Stripe", src: "/integrations/stripe.webp", mark: "Stripe", at: { x: 52.33, y: 89.9 } },
];

export const LABEL =
  "AYA, linked to website chat, Instagram, Messenger and WhatsApp, to " +
  "Google Calendar for bookings, to Cal.com, Calendly and HighLevel " +
  "through that calendar, and to the clinic's own Stripe account for " +
  "deposits in chat.";

/**
 * Google's brand guidelines and Stripe's services agreement both ask for the
 * owner to be named wherever their marks are used. Messenger is named as
 * well as Facebook because the label and the copy call the channel that.
 * Each owner's name is as its own terms or privacy notice gives it.
 */
export const TRADEMARKS =
  "Google Calendar is a trademark of Google LLC; Cal.com of Cal.com, Inc.; " +
  "Calendly of Calendly, LLC; HighLevel of HighLevel LLC; Stripe of " +
  "Stripe, Inc.; and Facebook, Instagram, Messenger and WhatsApp of Meta " +
  "Platforms, Inc. Their logos show what healdesk works with and do not " +
  "imply any endorsement.";

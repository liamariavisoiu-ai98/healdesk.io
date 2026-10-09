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

/**
 * What a tool does for the clinic, and so which group its logo sits in
 * (owner, 9 October 2026): the places a patient writes in, the calendars a
 * booking lands in or blocks, and the deposit.
 */
export type LogoGroup = "messages" | "bookings" | "payments";

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
  group: LogoGroup;
  /**
   * The logo's centre on the hero photo, in percent of its width and height.
   * HeroPortrait.tsx says how these were found; move them with the photo.
   */
  at: { x: number; y: number };
};

/**
 * All around AYA, on the wall either side of her (owner, 9 October 2026):
 * the places a patient writes in on her left, in an arc down beside her hair,
 * and the calendars on her right with Stripe below them. Within each side
 * they alternate in and out so neighbours clear each other.
 */
export const HERO_LOGOS: readonly HeroLogo[] = [
  {
    name: "website chat",
    src: "/integrations/website-chat.webp",
    mark: null,
    group: "messages",
    at: { x: 15, y: 10 },
  },
  {
    name: "Instagram",
    src: "/integrations/instagram.webp",
    mark: "Instagram",
    group: "messages",
    at: { x: 7.8, y: 24.4 },
  },
  // The owner's file is Facebook's "f"; the channel it stands for is Messenger.
  {
    name: "Messenger",
    src: "/integrations/facebook.webp",
    mark: "Facebook",
    group: "messages",
    at: { x: 10.8, y: 41 },
  },
  {
    name: "WhatsApp",
    src: "/integrations/whatsapp.webp",
    mark: "WhatsApp",
    group: "messages",
    at: { x: 5.7, y: 56.3 },
  },
  {
    name: "Google Calendar",
    src: "/integrations/google-calendar.webp",
    mark: "Google Calendar",
    group: "bookings",
    at: { x: 84.9, y: 11.7 },
  },
  {
    name: "Cal.com",
    src: "/integrations/cal-com.webp",
    mark: "Cal.com",
    group: "bookings",
    at: { x: 93.3, y: 26 },
  },
  {
    name: "Calendly",
    src: "/integrations/calendly.webp",
    mark: "Calendly",
    group: "bookings",
    at: { x: 86.4, y: 42 },
  },
  {
    name: "HighLevel",
    src: "/integrations/highlevel.webp",
    mark: "HighLevel",
    group: "bookings",
    at: { x: 94.2, y: 57.4 },
  },
  {
    name: "Stripe",
    src: "/integrations/stripe.webp",
    mark: "Stripe",
    group: "payments",
    at: { x: 86.7, y: 73.3 },
  },
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

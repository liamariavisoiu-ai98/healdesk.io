/**
 * The logos on the hero's orbit, what a screen reader hears in their place,
 * and whose marks they are.
 *
 * HeroOrbit draws the ring from RING and labels it with LABEL, and the
 * footer prints TRADEMARKS on every page. They live together so a logo
 * cannot reach the ring without its label and its attribution:
 * src/lib/integrations.test.ts fails if either is missing, or if a logo's
 * file is not in public/. What is on the ring, and why in this order, is in
 * HeroOrbit.tsx.
 *
 * The files are the owner's own downloads, cut out of their backgrounds;
 * Calendly's and HighLevel's are their symbols without the wordmarks, which
 * would be unreadable at the size of an app icon. On 5 October 2026 the
 * owner chose to ship them as downloaded, after the review that built the
 * ring noted that two come from a stock site that marks brand logos for
 * editorial use and the website glyph from one that asks for a credit on its
 * free licence. Calendly's and HighLevel's, added the same day, are copies
 * from TrustRadius and from RingCentral's app gallery.
 */

export type RingLogo = {
  /** What the logo stands for on the ring, as the label names it. */
  name: string;
  src: string;
  /**
   * The trademark the logo is, or null for a glyph that is nobody's mark.
   * Required rather than optional so that a new logo cannot skip the
   * footer's attribution by leaving it out.
   */
  mark: string | null;
  /**
   * For an open mark only: the share of the logo's half-width the artwork
   * reaches along its spoke, where a disc stops the hairline showing through
   * the gaps (globals.css, "The hero orbit"). A solid tile hides the line
   * itself and has none.
   */
  disc?: number;
};

/** Clockwise from twelve o'clock. */
export const RING: readonly RingLogo[] = [
  { name: "Google Calendar", src: "/integrations/google-calendar.webp", mark: "Google Calendar" },
  { name: "Cal.com", src: "/integrations/cal-com.webp", mark: "Cal.com" },
  // A ring, so the same from any direction.
  { name: "Calendly", src: "/integrations/calendly.webp", mark: "Calendly", disc: 0.94 },
  // Where the arrows start seen from the soul, at this place on the ring;
  // measure again if it moves.
  { name: "HighLevel", src: "/integrations/highlevel.webp", mark: "HighLevel", disc: 0.72 },
  { name: "Stripe", src: "/integrations/stripe.webp", mark: "Stripe" },
  { name: "WhatsApp", src: "/integrations/whatsapp.webp", mark: "WhatsApp" },
  // The owner's file is Facebook's "f"; the channel it stands for is Messenger.
  { name: "Messenger", src: "/integrations/facebook.webp", mark: "Facebook" },
  { name: "Instagram", src: "/integrations/instagram.webp", mark: "Instagram" },
  { name: "website chat", src: "/integrations/website-chat.webp", mark: null },
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

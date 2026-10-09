/**
 * The logos beside AYA in the hero, what a screen reader hears in their
 * place, and whose marks they are.
 *
 * HeroPortrait places HERO_LOGOS round her on ORBITS and labels them with LABEL, and
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
 * What a tool does for the clinic, and so which orbit its logo sits on
 * (owner, 9 October 2026): the places a patient writes in or calls, the
 * calendars a booking lands in or blocks, and the deposit.
 */
export type LogoGroup = "messages" | "bookings" | "payments";

/** The hero photo, in pixels. Every place below is in these pixels. */
export const PHOTO = { width: 1672, height: 941 } as const;

/**
 * The three orbits round her (the owner's pick of 9 October 2026, "three
 * orbits mixed with the chips that fan out"): concentric ellipses about a
 * point under her nose, so they ring her head and pass beside her shoulders.
 * Each group has its own orbit and its own stretch of it, starting at its
 * chip: Messages & Calls down the wall on her left, Bookings down the wall
 * on her right, Payments low on the right. Angles are in degrees, clockwise
 * from three o'clock, as the screen draws them; `tail` is where the drawn arc
 * fades out past the last logo.
 *
 * Found by search against her outline, her face and the copy's box at every
 * desktop size from 1280×720 up (src/lib/integrations.test.ts checks the
 * result), then rounded.
 */
export const ORBIT_CENTRE = { x: 768, y: 419 } as const;

export type Orbit = {
  group: LogoGroup;
  /** The chip's title. */
  title: string;
  rx: number;
  ry: number;
  /** Where the chip sits, and where its logos fan out from as the page opens. */
  chip: number;
  tail: number;
};

export const ORBITS: readonly Orbit[] = [
  { group: "messages", title: "Messages & Calls", rx: 705, ry: 367, chip: -108, tail: -212 },
  { group: "bookings", title: "Bookings", rx: 760, ry: 396, chip: -77, tail: 6 },
  { group: "payments", title: "Payments", rx: 930, ry: 484, chip: 41, tail: 22 },
];

export function orbitOf(group: LogoGroup): Orbit {
  return ORBITS.find((orbit) => orbit.group === group)!;
}

/** A point on a group's orbit, in percent of the photo's width and height. */
export function onOrbit(group: LogoGroup, angle: number): { x: number; y: number } {
  const orbit = orbitOf(group);
  const radians = (angle * Math.PI) / 180;
  return {
    x: ((ORBIT_CENTRE.x + orbit.rx * Math.cos(radians)) / PHOTO.width) * 100,
    y: ((ORBIT_CENTRE.y + orbit.ry * Math.sin(radians)) / PHOTO.height) * 100,
  };
}

/**
 * What a logo shows when it is hovered, focused or tapped, in the owner's
 * words of 9 October 2026: a message received and replied to, with WhatsApp's
 * grey tick and blue double tick, a call answered and booked, a slot booked
 * or blocked, a deposit paid. Never a treatment, a name or a price list.
 */
export type ShowcaseLine = { text: string; mark?: "received" | "replied" | "paid" };

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
  /** Where on its orbit, in degrees (see ORBITS). */
  angle: number;
  /** Its centre on the photo, in percent of its width and height, from `angle`. */
  at: { x: number; y: number };
  showcase: readonly ShowcaseLine[];
};

const MESSAGE: readonly ShowcaseLine[] = [
  { text: "Received 9:41 PM", mark: "received" },
  { text: "Replied 9:41 PM", mark: "replied" },
];
const BLOCKED: readonly ShowcaseLine[] = [{ text: "Slot blocked · Thu 3:00 PM" }];

const LOGOS: readonly Omit<HeroLogo, "at">[] = [
  { name: "website chat", src: "/integrations/website-chat.webp", mark: null, group: "messages", angle: -122, showcase: MESSAGE },
  { name: "Instagram", src: "/integrations/instagram.webp", mark: "Instagram", group: "messages", angle: -141, showcase: MESSAGE },
  // The owner's file is Facebook's "f"; the channel it stands for is Messenger.
  { name: "Messenger", src: "/integrations/facebook.webp", mark: "Facebook", group: "messages", angle: -161, showcase: MESSAGE },
  { name: "WhatsApp", src: "/integrations/whatsapp.webp", mark: "WhatsApp", group: "messages", angle: -180, showcase: MESSAGE },
  // The clinic's own line, forwarded to her (owner, 9 October 2026). A
  // handset drawn for this site, nobody's mark.
  {
    name: "phone line",
    src: "/integrations/phone-line.svg",
    mark: null,
    group: "messages",
    angle: -200,
    showcase: [{ text: "Call answered 9:41 PM" }, { text: "Consultation booked" }],
  },
  {
    name: "Google Calendar",
    src: "/integrations/google-calendar.webp",
    mark: "Google Calendar",
    group: "bookings",
    angle: -60,
    showcase: [{ text: "Consultation booked · Thu 3:00 PM" }],
  },
  { name: "Cal.com", src: "/integrations/cal-com.webp", mark: "Cal.com", group: "bookings", angle: -42, showcase: BLOCKED },
  { name: "Calendly", src: "/integrations/calendly.webp", mark: "Calendly", group: "bookings", angle: -23, showcase: BLOCKED },
  { name: "HighLevel", src: "/integrations/highlevel.webp", mark: "HighLevel", group: "bookings", angle: -5, showcase: BLOCKED },
  {
    name: "Stripe",
    src: "/integrations/stripe.webp",
    mark: "Stripe",
    group: "payments",
    angle: 30,
    showcase: [{ text: "Deposit link sent" }, { text: "$100 · Paid", mark: "paid" }],
  },
];

/** On their orbits, in order: Messages & Calls, then Bookings, then Payments. */
export const HERO_LOGOS: readonly HeroLogo[] = LOGOS.map((logo) => ({ ...logo, at: onOrbit(logo.group, logo.angle) }));

/** What a logo's showcase says, read as one line: its accessible name. */
export function showcaseText(logo: HeroLogo): string {
  return `${logo.name}: ${logo.showcase.map((line) => line.text).join(", ")}`;
}

export const LABEL =
  "AYA, linked to the clinic's phone line, website chat, Instagram, Messenger and WhatsApp, to " +
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

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
 * calendar a booking lands in, the calendars that read it, and the deposit.
 *
 * "synced" was split out of "bookings" on 12 October 2026 (owner): with
 * Cal.com, Calendly and HighLevel beside Google Calendar under one
 * "Bookings" chip, they read as places AYA books into. v1 writes bookings to
 * Google Calendar and nothing else (CLAUDE.md, "Booking and payment"); the
 * three are calendars a clinic keeps in sync with it, which see the slot as
 * taken. So Bookings is Google Calendar alone, and the three have their own
 * stretch of the same circle under a chip that says what they are.
 */
export type LogoGroup = "messages" | "bookings" | "synced" | "payments";

/** The hero photo, in pixels. Every place below is in these pixels. */
export const PHOTO = { width: 1672, height: 941 } as const;

/**
 * The circles round her (the owner's pick of 9 October 2026, "three orbits
 * mixed with the chips that fan out"): true circles, about one point under
 * her chin, so they ring her head and pass beside her shoulders. The owner
 * asked on 12 October 2026 for perfect circles; the first version drew
 * flattened ovals. Each group has its own stretch of a circle, starting at
 * its chip. Angles are in degrees, clockwise from three o'clock, as the
 * screen draws them; `tail` is where the lit stretch fades out past the last
 * logo.
 *
 * Two circles, each carrying a stretch on either side of her (owner, 12
 * October 2026). There were three, and the outer one, which Messages & Calls
 * needs on her left, ran on round her right with nothing on it, while
 * Payments sat on a middle circle of its own: so the logos reached the
 * screen's edge on the left and stopped well short of it on the right, and
 * the whole arrangement leaned left of her. Payments now shares the outer
 * circle, on her right, and the middle circle is gone: the logos reach as far
 * on each side, centred on her.
 *
 * Messages & Calls (five logos) is on the outer circle because that is the
 * only one whose far left is clear of the copy's box; Bookings and the
 * synced calendars share the inner one, so the synced calendars stay exactly
 * where they stood. The places were found by search against her face, the
 * headset, the copy's box at every desktop size from 1280×720 to 2560×1440,
 * the photo's edges and each other, then rounded, and
 * src/lib/integrations.test.ts pins the result.
 */
export const ORBIT_CENTRE = { x: 827, y: 476 } as const;

export type Orbit = {
  group: LogoGroup;
  /** The chip's title. */
  title: string;
  /** The circle's radius, in the photo's pixels. */
  r: number;
  /** Where the chip sits, and where its logos fan out from as the page opens. */
  chip: number;
  /** Where the lit stretch fades out. */
  tail: number;
};

export const ORBITS: readonly Orbit[] = [
  { group: "messages", title: "Messages & Calls", r: 760, chip: -146, tail: -209 },
  // Bookings and the calendars synced with it share the inner circle, one
  // stretch each: Bookings from its chip down to just past Google Calendar,
  // and the synced calendars' chip between Google Calendar and Cal.com, its
  // stretch running on past HighLevel to where Bookings' tail used to be.
  { group: "bookings", title: "Bookings", r: 481, chip: -50.7, tail: -16 },
  { group: "synced", title: "Synced with Google", r: 481, chip: -12, tail: 52 },
  // Payments shares the outer circle with Messages & Calls, on her right,
  // level with them, so the two sides reach as far from her.
  { group: "payments", title: "Payments", r: 760, chip: -22, tail: 24 },
];

export function orbitOf(group: LogoGroup): Orbit {
  return ORBITS.find((orbit) => orbit.group === group)!;
}

/**
 * Sine and cosine are not the same to the last digit in every engine, and
 * these places are written into the server's HTML and compared by the
 * browser's own: a place that differed in its fifteenth digit between Node
 * and a visitor's browser was a hydration error in the console. So a place is
 * rounded here, to a hundredth of a pixel, where two engines cannot land on
 * different sides of the rounding.
 */
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** A point on a group's circle, in the photo's pixels. */
export function pointOnOrbit(group: LogoGroup, angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const { r } = orbitOf(group);
  return {
    x: round(ORBIT_CENTRE.x + r * Math.cos(radians), 2),
    y: round(ORBIT_CENTRE.y + r * Math.sin(radians), 2),
  };
}

/** A point on a group's circle, in percent of the photo's width and height. */
export function onOrbit(group: LogoGroup, angle: number): { x: number; y: number } {
  const { x, y } = pointOnOrbit(group, angle);
  return { x: round((x / PHOTO.width) * 100, 4), y: round((y / PHOTO.height) * 100, 4) };
}

/**
 * What a logo shows when it is hovered, focused or tapped: a small scene
 * drawn in that channel's or that tool's own look, one example per logo
 * (owner, 12 October 2026; until then every message channel shared one
 * "Received / Replied" card with WhatsApp's ticks, which Instagram and
 * Messenger do not have). HeroScenes.tsx draws them; `showcase` is the same
 * example in words, which a screen reader hears as the logo's name.
 *
 * Every line is a thing v1 does: she answers, books into Google Calendar and
 * nothing else (the auto-confirm switch turns a booking into a request staff
 * approve), sends a deposit link in chat, and on a call books and flags the
 * deposit rather than taking it. No treatment is named anywhere, and none in
 * a Meta channel above all, where the question asks for a clinician by name
 * (an invented one) rather than for a procedure.
 */
export type ShowcaseLine = { text: string };

/** Which scene a logo's card plays (HeroScenes.tsx). */
export type SceneKind =
  | "web"
  | "instagram"
  | "messenger"
  | "whatsapp"
  | "call"
  | "gcal"
  | "calcom"
  | "calendly"
  | "highlevel"
  | "stripe";

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
  scene: SceneKind;
  /**
   * Where the card opens from 1280px: out to the right (the default), or
   * above, for a logo too near the photo's right edge for a card beside it.
   */
  card?: "above";
  /**
   * Whether its example happens while the clinic is shut, which its card
   * says with an "After hours" tag (owner, 12 October 2026).
   */
  afterHours?: true;
  showcase: readonly ShowcaseLine[];
};

const SYNCED: readonly ShowcaseLine[] = [{ text: "Synced from Google Calendar" }, { text: "Thu 3:00 PM blocked" }];

const LOGOS: readonly Omit<HeroLogo, "at">[] = [
  {
    name: "website chat",
    src: "/integrations/website-chat.webp",
    mark: null,
    group: "messages",
    angle: -155,
    scene: "web",
    showcase: [{ text: "Asked about pricing" }, { text: "Pricing confirmed" }, { text: "Consultation booked · Thu 3:00 PM" }],
  },
  {
    name: "Instagram",
    src: "/integrations/instagram.webp",
    mark: "Instagram",
    group: "messages",
    angle: -165.3,
    scene: "instagram",
    afterHours: true,
    showcase: [
      { text: "After hours, Fri 11:48 PM, new message: Can I get a consultation with Dr. John Doe?" },
      { text: "Consultation booked · Sat 10:30 AM" },
    ],
  },
  // The owner's file is Facebook's "f"; the channel it stands for is Messenger.
  {
    name: "Messenger",
    src: "/integrations/facebook.webp",
    mark: "Facebook",
    group: "messages",
    angle: -175.6,
    scene: "messenger",
    showcase: [{ text: "Message seen" }, { text: "Opening hours answered" }],
  },
  {
    name: "WhatsApp",
    src: "/integrations/whatsapp.webp",
    mark: "WhatsApp",
    group: "messages",
    angle: -185.9,
    scene: "whatsapp",
    showcase: [{ text: "Received at 11:02 PM" }, { text: "Replied at 11:02 PM" }],
  },
  // The clinic's own line, forwarded to her (owner, 9 October 2026), drawn as
  // the iPhone's Phone icon (owner, 12 October 2026), which makes it Apple's.
  // On a call she cannot take a deposit: she books, and flags it for staff.
  {
    name: "phone line",
    src: "/integrations/phone-line.svg",
    mark: "Apple",
    group: "messages",
    angle: -196.2,
    scene: "call",
    afterHours: true,
    showcase: [{ text: "After hours, on a call, 0:42" }, { text: "Consultation booked, deposit flagged for your team" }],
  },
  // A request rather than a booking: what the card shows with "Auto-confirm
  // bookings" off, when staff approve each one (owner, 12 October 2026).
  {
    name: "Google Calendar",
    src: "/integrations/google-calendar.webp",
    mark: "Google Calendar",
    group: "bookings",
    angle: -22,
    scene: "gcal",
    showcase: [{ text: "Thu 3:00 PM: request sent for staff approval" }],
  },
  { name: "Cal.com", src: "/integrations/cal-com.webp", mark: "Cal.com", group: "synced", angle: -1.9, scene: "calcom", showcase: SYNCED },
  { name: "Calendly", src: "/integrations/calendly.webp", mark: "Calendly", group: "synced", angle: 18.2, scene: "calendly", showcase: SYNCED },
  { name: "HighLevel", src: "/integrations/highlevel.webp", mark: "HighLevel", group: "synced", angle: 38.3, scene: "highlevel", showcase: SYNCED },
  {
    name: "Stripe",
    src: "/integrations/stripe.webp",
    mark: "Stripe",
    group: "payments",
    angle: 6,
    scene: "stripe",
    card: "above",
    showcase: [{ text: "Deposit paid" }, { text: "Slot confirmed" }],
  },
];

/** On their orbits, in order: Messages & Calls, Bookings, the synced calendars, Payments. */
export const HERO_LOGOS: readonly HeroLogo[] = LOGOS.map((logo) => ({ ...logo, at: onOrbit(logo.group, logo.angle) }));

/**
 * The order the hero plays the cards in on its own, while nobody is hovering
 * (owner, 12 October 2026: the cards were hover-only, so most visitors never
 * read them): one logo from each group in turn, Messages & Calls, Bookings,
 * Payments, which is the order a booking happens in, then the calendars that
 * see the booking, then the next logo of each, until every logo has had its
 * card. A group with fewer logos drops out.
 */
export function storyOrder(logos: readonly HeroLogo[] = HERO_LOGOS): string[] {
  const groups: LogoGroup[] = ["messages", "bookings", "payments", "synced"];
  const lists = groups.map((group) => logos.filter((logo) => logo.group === group));
  const order: string[] = [];
  for (let i = 0; order.length < logos.length; i++) {
    for (const list of lists) if (list[i]) order.push(list[i]!.name);
  }
  return order;
}

/** What a logo's showcase says, read as one line: its accessible name. */
export function showcaseText(logo: HeroLogo): string {
  return `${logo.name}: ${logo.showcase.map((line) => line.text).join(", ")}`;
}

export const LABEL =
  "AYA, linked to the clinic's phone line, website chat, Instagram, Messenger and WhatsApp, to " +
  "Google Calendar for bookings, to Cal.com, Calendly and HighLevel " +
  "only as calendars kept in sync with it, and to the clinic's own Stripe account for " +
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
  "Stripe, Inc.; Facebook, Instagram, Messenger and WhatsApp of Meta " +
  "Platforms, Inc.; and the Phone icon, here for the phone line, of Apple " +
  "Inc. Their logos show what healdesk works with and do not imply any " +
  "endorsement.";

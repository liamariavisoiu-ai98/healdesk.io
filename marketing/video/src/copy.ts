/**
 * Every word the ad prints, and the made-up data it shows, in one place, so
 * the claims can be checked against docs/v1-product-spec.md without reading
 * the shots.
 *
 * - Aya, not AYA, in the ad (owner, 1 November 2026).
 * - "Booked value" is bookings at the clinic's own prices, a figure v1 may
 *   claim; never "revenue".
 * - "Try Aya free" is the Aya built from a clinic's website; healdesk has no
 *   free trial.
 * - No treatment is named in an Instagram, Messenger or WhatsApp message: Meta
 *   never signs a BAA. The website chat may name one.
 * - The deposit page shows the clinic, "Appointment deposit" and the amount:
 *   no treatment reaches Stripe (CLAUDE.md).
 * - healdesk's alert about a single patient carries an amount and a pointer
 *   into the portal, never a time or a treatment.
 */
export const LINES = {
  calls: ["Is your clinic", "missing", "calls?"],
  dms: "DMs?",
  focus: "Front desk closed",
  interrupt: ["Not on my", "watch."],
  hello: ["Hi, I'm", "Aya."],
  helloSub: "Your clinic's 24/7 assistant.",
  by: "by",
  badges: ["Built for medspas", "We sign a BAA"],
  website: ["Just add your", "website."],
  learned: "Aya learned",
  channels: ["Calls, DMs,", "chats.", "All at once."],
  channelsWide: ["Calls, DMs, chats.", "All at once."],
  bookedValue: "Booked value",
  atYourPrices: "at your own prices",
  deposit: "Appointment deposit",
  depositAlert: "Deposit received",
  depositAlertBody: "Open your portal for details",
  line: ["You do the", "treatments.", "Aya handles", "the rush."],
  lineWide: ["You do the treatments.", "Aya handles the rush."],
  tagline: "An AI front desk you can rely on.",
  cta: "Try Aya free",
} as const;

/** The fictional clinic. Check the name belongs to no real clinic before publishing. */
export const CLINIC = {
  name: "Bella Skin Studio",
  url: "bellaskinstudio.com",
  treatments: [
    { name: "Botox", price: 299 },
    { name: "Lip filler", price: 650 },
    { name: "HydraFacial", price: 200 },
  ],
  deposit: 100,
} as const;

/** The app icons, in public/. */
export const ICONS = {
  phone: "phone-line.svg",
  instagram: "instagram.webp",
  whatsapp: "whatsapp.webp",
  messenger: "messenger.svg",
  web: "web-chat.svg",
} as const;
export type Channel = keyof typeof ICONS;

/** The five bookings, one per channel, at the clinic's own prices: $1,648 in all. */
export const BOOKINGS: readonly { channel: Channel; value: number }[] = [
  { channel: "phone", value: 299 },
  { channel: "whatsapp", value: 650 },
  { channel: "instagram", value: 200 },
  { channel: "messenger", value: 299 },
  { channel: "web", value: 200 },
];

/** The after-hours pile-up: made-up 555 numbers and first names, everyday questions, nothing clinical. */
export const CALLER = "+1 (480) 555-0136";
export const DMS: readonly { channel: Channel; app: string; sender: string; body: string }[] = [
  { channel: "instagram", app: "Instagram", sender: "jess.miller", body: "Hi! Any openings this week?" },
  { channel: "whatsapp", app: "WhatsApp", sender: "Mia", body: "I'd like to book 🙂" },
  { channel: "messenger", app: "Messenger", sender: "Daniel R.", body: "How much is a consultation?" },
  { channel: "web", app: "Website chat", sender: "Visitor", body: "Are you open Saturday?" },
  { channel: "instagram", app: "Instagram", sender: "sophie.k", body: "do u have anything saturday?" },
  { channel: "whatsapp", app: "WhatsApp", sender: "Olivia", body: "Can I come Thursday after work?" },
  { channel: "messenger", app: "Messenger", sender: "Ava T.", body: "Any time next Wednesday?" },
];

export const money = (n: number, cents = false): string =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

/**
 * Every word the ad says or prints, and the timeline, in one place, so the
 * claims can be checked against the spec without reading the scenes.
 *
 * Two hooks. `soft` is the default and the one to publish until a primary
 * source for the voicemail statistics is named (SCRIPT.md, "Before
 * publishing", item 1). `stat` is the 85% / 82% / $1,500 version as
 * written, for the hook test once the source is in the small print.
 */
export type Hook = "soft" | "stat";

/** Scene boundaries in global frames at 30 fps. Scenes count their own frames from 0. */
export const SCENES = {
  hook: { from: 0, to: 150 },
  aya: { from: 150, to: 240 },
  url: { from: 240, to: 420 },
  channels: { from: 420, to: 600 },
  deposit: { from: 600, to: 720 },
  night: { from: 720, to: 900 },
  dare: { from: 900, to: 1080 },
} as const;

export const HOOK_COPY: Record<
  Hook,
  { slam: string; flip: string | null; line1: string; line2: string; line3: string; smallPrint: string | null }
> = {
  stat: {
    slam: "85%",
    flip: "82%",
    line1: "85% of callers who reach voicemail hang up without leaving a message.",
    line2: "…and most of them call your competitor next.",
    line3: "That's a $1,500 consult. Gone.",
    smallPrint: "Source: name the primary study here before publishing.",
  },
  soft: {
    slam: "Missed.",
    flip: null,
    line1: "Most callers who hit voicemail never call back.",
    line2: "…and many call your competitor next.",
    line3: "That booking? Gone.",
    smallPrint: null,
  },
};

/** A voiceover line, spread evenly over [from, to) in global frames. */
export type VoLine = { from: number; to: number; text: string };

/**
 * The voiceover, as burned-in captions. Timed to the scenes above; once a
 * voice is recorded, replace these with its word timestamps.
 *
 * One change from SCRIPT.md: "grab your free trial" reads "build your free
 * AYA". healdesk has no free trial (billing starts at the first answer and
 * the setup fee is paid at checkout); what is free is the AYA built from the
 * visitor's URL, which is what the end card offers.
 */
export const VO: readonly VoLine[] = [
  { from: 75, to: 140, text: "Busy line? After six? They're not waiting." },
  { from: 160, to: 236, text: "Not on my watch. Hi, I'm AYA, your 24/7 assistant." },
  {
    from: 250,
    to: 416,
    text: "Give me your website. Seconds later, I know your treatments, I sound like your clinic, and I'm ready for your patients.",
  },
  {
    from: 430,
    to: 708,
    text: "Calls, DMs, chats, all at once. I book them straight in, and I send the deposit link right in the chat. Honestly? It's kind of my thing.",
  },
  {
    from: 730,
    to: 896,
    text: "Now you close at six and still wake up to new bookings, deposits already in. Your team stops chasing the phone. And you get your evenings back.",
  },
  { from: 912, to: 1006, text: "Don't believe me? Click below, build your free AYA, and see for yourself." },
  { from: 1016, to: 1046, text: "I'll be here. Obviously." },
];

/** The fictional clinic of the demo. Prices are made up. */
export const CLINIC = {
  name: "Bella Skin Studio",
  url: "bellaskinstudio.com",
  treatments: [
    { name: "Botox", price: 299 },
    { name: "Lip filler", price: 650 },
    { name: "HydraFacial", price: 199 },
  ],
  deposit: 100,
} as const;

export type Channel = {
  key: string;
  icon: string;
  title: string;
  meta: string;
  ask: string | null;
  reply: string;
  day: number;
  time: string;
  value: number;
};

/**
 * Five ways in. No treatment is named in the Instagram, Messenger or WhatsApp
 * messages: Meta never signs a BAA, so those channels carry nothing
 * clinical. The website chat may name one; it runs on the BAA-covered host.
 * Each booking's value is the clinic's own price for it ("booked value", a
 * claim v1 may make), shown on the clinic's calendar, never in a Meta message.
 */
export const CHANNELS: readonly Channel[] = [
  { key: "phone", icon: "phone-line.svg", title: "Phone call", meta: "0:14", ask: null, reply: "Fri 2:00 PM. You're booked ✓", day: 4, time: "2:00 PM", value: 299 },
  { key: "whatsapp", icon: "whatsapp.webp", title: "WhatsApp", meta: "6:58 PM", ask: "Can I come Thursday after work?", reply: "Thu 5:30 PM is yours ✓", day: 3, time: "5:30 PM", value: 650 },
  { key: "instagram", icon: "instagram.webp", title: "Instagram", meta: "11:48 PM", ask: "do u have anything saturday?", reply: "Sat 11:00 AM, booked ✓", day: 5, time: "11:00 AM", value: 199 },
  { key: "messenger", icon: "messenger.svg", title: "Messenger", meta: "9:12 PM", ask: "Any time next Wednesday?", reply: "Wed 1:00 PM, booked ✓", day: 2, time: "1:00 PM", value: 299 },
  { key: "web", icon: "website-chat.webp", title: "Website chat", meta: "Now", ask: "First time. Can I book a HydraFacial?", reply: "$199. Mon 10:30 AM? Booked ✓", day: 0, time: "10:30 AM", value: 199 },
];

export const BOOKED_VALUE = CHANNELS.reduce((sum, ch) => sum + ch.value, 0);

/**
 * What the deposit's payment page shows: the clinic, an amount, a generic
 * descriptor and an opaque reference. No treatment name reaches Stripe, not
 * in the description, the metadata or the statement descriptor (CLAUDE.md,
 * "Booking and payment").
 */
export const CHECKOUT = {
  descriptor: "Appointment deposit",
  reference: "Ref BSS-4821",
  email: "jordan@example.com",
} as const;

export const money = (n: number, cents = false): string =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

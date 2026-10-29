import timeline from "./timeline.json";

/**
 * Every word the ad says or prints, and the timeline, in one place, so the
 * claims can be checked against the spec without reading the scenes.
 *
 * Two hooks. `soft` is the default and the one to publish until a primary
 * source for the voicemail statistics is named (SCRIPT.md, "Before
 * publishing", item 1). `stat` carries the 85% and $1,500 lines as the
 * script wrote them, for the hook test once the source is in the small print.
 */
export type Hook = "soft" | "stat";

/**
 * Scene boundaries in global frames at 30 fps, from timeline.json, which
 * scripts/soundtrack.mjs reads too. Scenes count their own frames from 0.
 */
export const SCENES = timeline.scenes;
export const DURATION = timeline.scenes.close.to;

/**
 * The opening, slow enough to read: two questions, one answer, one loss.
 * Both hooks share the questions; only the answer differs.
 */
export const HOOK_COPY: Record<Hook, { line: string; loss: string; smallPrint: string | null }> = {
  stat: {
    line: "85% of callers who reach voicemail hang up without leaving a message.",
    loss: "That's a $1,500 consult. Gone.",
    smallPrint: "Source: name the primary study here before publishing.",
  },
  soft: {
    line: "Most callers who hit voicemail never call back.",
    loss: "That booking? Gone.",
    smallPrint: null,
  },
};

/** A voiceover line, spread evenly over [from, to) in global frames. */
export type VoLine = { from: number; to: number; text: string; burn?: false };

/**
 * The voiceover. Burned in as captions except where the same words are
 * already on screen (the opening questions, the black card, Aya's hello,
 * the closing line), so nothing
 * is read twice. Once a voice is recorded, replace these with its word
 * timestamps.
 *
 * Changes from SCRIPT.md, each because the line said something the product
 * does not do: "grab your free trial" became the closing line (healdesk has
 * no free trial: billing starts at the first answer and the setup fee is
 * paid at checkout); "Seconds later, I know your treatments" lost its
 * "seconds", and the closer says "a few minutes", because the demo built
 * from a URL estimates about three minutes and has not been timed yet
 * (apps/web/src/lib/demo/build-progress.ts).
 */
/** The global frame `frame` frames of scene time into `scene`, honouring its speed. */
const at = (scene: keyof typeof SCENES, frame: number) => SCENES[scene].from + Math.round(frame / SCENES[scene].speed);

export const VO: readonly VoLine[] = [
  { from: at("hook", 10), to: at("hook", 200), text: "Missed calls? Missed DMs? After six, they're not waiting.", burn: false },
  { from: at("interrupt", 6), to: at("interrupt", 40), text: "Not on my watch.", burn: false },
  { from: at("aya", 6), to: at("aya", 66), text: "Hi, I'm Aya, your 24/7 assistant.", burn: false },
  {
    from: at("url", 10),
    to: at("url", 172),
    text: "Give me your website, and I learn your treatments, sound like your clinic, and get ready for your patients.",
  },
  {
    from: at("channels", 10),
    to: at("deposit", 110),
    text: "Calls, DMs, chats, all at once. I book them straight in, and I send the deposit link right in the chat. Honestly? It's kind of my thing.",
  },
  {
    from: at("night", 14),
    to: at("night", 140),
    text: "Now you close at six and still wake up to new bookings, deposits already in. And you get your evenings back.",
  },
  { from: at("close", 10), to: at("close", 120), text: "Try me out now. Just add your website, and I'll be ready in a few minutes.", burn: false },
];

/** The closing scene's words. */
export const CLOSE = {
  line: "Try me out now.",
  sub: "Just add your website, and I'll be ready in a few minutes.",
  button: "Try Aya free →",
  url: "yourwebsite.com",
} as const;

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

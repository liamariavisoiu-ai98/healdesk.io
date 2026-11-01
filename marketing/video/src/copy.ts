import timeline from "./timeline.json";

/**
 * Every word the ad says or prints, and the timeline, in one place, so the
 * claims can be checked against the spec without reading the scenes.
 *
 * The cut follows the owner's Apple-style storyboard of 1 November 2026:
 * missed calls, missed DMs, "Not on my watch.", Aya, every channel at once,
 * the deposit, "Try Aya free."
 */

/**
 * Scene boundaries in global frames at 30 fps, from timeline.json, which
 * scripts/soundtrack.mjs reads too. Scenes count their own frames from 0.
 */
export const SCENES = timeline.scenes;
export const DURATION = timeline.scenes.close.to;

/** One beat of the song, in frames. Every cut after the drop is a whole number of beats. */
export const BEAT = (timeline.fps * 60) / timeline.bpm;
export const beats = (n: number) => Math.round(n * BEAT);

/**
 * The on-screen lines, in order. Aya, not AYA, in the ad (owner, 1 November
 * 2026). The cuts after the drop fall on the song's beats: every scene
 * boundary in timeline.json is a whole number of beats after the drop.
 */
export const LINES = {
  calls: "Is your clinic missing calls?",
  dms: "Is your clinic missing DMs?",
  interrupt: "Not on my watch.",
  hello: "Hi, I'm Aya.",
  helloSub: "Your clinic's 24/7 assistant.",
  signature: "by",
  badges: ["Built for medspas", "We sign a BAA"],
  learned: "Aya learned",
  website: "Just add your website.",
  channels: ["Calls, DMs, chats.", "All at once."],
  bookedBy: "at your own prices",
  deposit: ["You do the treatments.", "Aya handles the rush."],
  close: "Try Aya free",
  tagline: "An AI front desk you can rely on.",
  domain: "healdesk.io",
} as const;

/** A voiceover line, spread evenly over [from, to) in global frames. */
export type VoLine = { from: number; to: number; text: string; burn?: false };

/**
 * The voiceover, for a recording session: the storyboard's own lines. Every
 * one is already on screen as type, so none is burned in as a subtitle
 * (`burn: false`); a line added that is not on screen would be subtitled.
 */
const at = (scene: keyof typeof SCENES, frame: number) => SCENES[scene].from + Math.round(frame / SCENES[scene].speed);

export const VO: readonly VoLine[] = [
  { from: at("missed", 10), to: at("missed", 120), text: LINES.calls, burn: false },
  { from: at("missed", 140), to: at("missed", 250), text: LINES.dms, burn: false },
  { from: at("interrupt", 2), to: at("interrupt", 40), text: LINES.interrupt, burn: false },
  { from: at("aya", 20), to: at("aya", 110), text: `${LINES.hello} ${LINES.helloSub}`, burn: false },
  { from: at("aya", 140), to: at("aya", 260), text: LINES.website, burn: false },
  { from: at("dashboard", 10), to: at("dashboard", 90), text: LINES.channels.join(" "), burn: false },
  { from: at("deposit", 100), to: at("deposit", 160), text: LINES.deposit.join(" "), burn: false },
  { from: at("close", 10), to: at("close", 90), text: `${LINES.close}. ${LINES.domain}`, burn: false },
];

/** The fictional clinic of the demo. Prices are made up. */
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
  { key: "instagram", icon: "instagram.webp", title: "Instagram", meta: "11:48 PM", ask: "do u have anything saturday?", reply: "Sat 11:00 AM, booked ✓", day: 5, time: "11:00 AM", value: 200 },
  { key: "messenger", icon: "messenger.svg", title: "Messenger", meta: "9:12 PM", ask: "Any time next Wednesday?", reply: "Wed 1:00 PM, booked ✓", day: 2, time: "1:00 PM", value: 299 },
  { key: "web", icon: "website-chat.webp", title: "Website chat", meta: "Now", ask: "First time. Can I book a HydraFacial?", reply: "$200. Mon 10:30 AM? Booked ✓", day: 0, time: "10:30 AM", value: 200 },
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

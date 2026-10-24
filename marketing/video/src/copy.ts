/**
 * Every word the ad says or prints, in one place, so the claims can be
 * checked against the spec without reading the scenes.
 *
 * Two hooks. `soft` is the default and the one to publish until a primary
 * source for the voicemail statistics is named (SCRIPT.md, "Before
 * publishing", item 1). `stat` is the 85% / 82% / $1,500 version as
 * written, for the hook test once the source is in the small print.
 */
export type Hook = "soft" | "stat";

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
 * The voiceover, as burned-in captions. Timed to the script's cue points;
 * once a voice is recorded, replace these with its word timestamps.
 *
 * One change from SCRIPT.md: "grab your free trial" reads "build your free
 * AYA". healdesk has no free trial (billing starts at the first answer and
 * the setup fee is paid at checkout); what is free is the AYA built from the
 * visitor's URL, which is what the end card offers.
 */
export const VO: readonly VoLine[] = [
  { from: 75, to: 140, text: "Busy line? After six? They're not waiting." },
  { from: 170, to: 262, text: "Not on my watch. Hi, I'm AYA, your 24/7 assistant." },
  {
    from: 280,
    to: 446,
    text: "Give me your website. Seconds later, I know your treatments, I sound like your clinic, and I'm ready for your patients.",
  },
  {
    from: 460,
    to: 684,
    text: "Calls, DMs, chats, all at once. I book them straight in, and I send the deposit link right in the chat. Honestly? It's kind of my thing.",
  },
  {
    from: 700,
    to: 896,
    text: "Now you close at six and still wake up to new bookings, deposits already in. Your team stops chasing the phone. And you get your evenings back.",
  },
  { from: 912, to: 1006, text: "Don't believe me? Click below, build your free AYA, and see for yourself." },
  { from: 1016, to: 1046, text: "I'll be here. Obviously." },
];

/** The fictional clinic of scenes 3 and 4. Prices are made up for the demo. */
export const CLINIC = {
  name: "Bella Skin Studio",
  url: "bellaskinstudio.com",
  treatments: [
    { name: "Botox", price: "$12 / unit" },
    { name: "Lip filler", price: "$650" },
    { name: "HydraFacial", price: "$199" },
  ],
} as const;

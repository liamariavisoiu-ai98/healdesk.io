/**
 * The channels a setup request can ask for, in the order the form lists them.
 *
 * Its own module, with no imports, because the form that shows them is a
 * client component and the module that stores requests talks to the Sheet:
 * importing the list from there would pull server code into the browser.
 *
 * These are what the clinic wants AYA on, in its own words. They are not the
 * catalog's billing channels (web, meta, voice): Instagram, Messenger and
 * WhatsApp are one package channel but three things a clinic asks for.
 */
export const SETUP_CHANNELS = [
  { id: "phone", label: "Phone", inSentence: "phone" },
  { id: "web", label: "Website chat", inSentence: "website chat" },
  { id: "instagram", label: "Instagram", inSentence: "Instagram" },
  { id: "messenger", label: "Messenger", inSentence: "Messenger" },
  { id: "whatsapp", label: "WhatsApp", inSentence: "WhatsApp" },
] as const;

export type ChannelId = (typeof SETUP_CHANNELS)[number]["id"];

export const CHANNEL_IDS: readonly ChannelId[] = SETUP_CHANNELS.map((c) => c.id);

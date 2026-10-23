/**
 * The greetings a clinic starts with (spec, "Phone greeting: pre-filled";
 * "Chat greeting: pre-filled"). Each is said after the locked AI line
 * (lib/compliance/disclosure.ts), which no greeting can replace or remove. A
 * clinic that never edits its greeting keeps these.
 */

/**
 * The phone greeting, said after the locked AI line. Since 23 October 2026
 * (owner) a choice of two rather than "Thanks for calling {clinic}. How can I
 * help you today?": the AI line already names the clinic, and an either-or
 * question tells a caller what AYA can do and gets an answer at once, where
 * an open one got "hello?". The parameter is kept so a later greeting can use
 * the name again without touching every caller.
 */
export function defaultPhoneGreeting(_clinicName?: string): string {
  return "Are you looking to book an appointment, or do you have a question?";
}

/** The chat greeting, written after the locked AI line. */
export function defaultChatGreeting(): string {
  return "How can I help you today?";
}

/**
 * What each greeting field is called, in Settings, in the wizard and in the
 * support chat's map of Settings. The chat greeting is website chat's only:
 * Instagram, Messenger and WhatsApp never say it, because a Meta reply
 * carries one greeting, the channel's fixed warning (lib/meta/front-door.ts,
 * metaChannelGreeting; BAA 1.3.0 gate 20). So its label names website chat,
 * and a clinic with the Meta channels is told so beside it.
 */
export const GREETING_LABELS = {
  phone: "When AYA answers a call",
  chat: "When someone opens your website chat",
} as const;

/** Beside the chat greeting, for a clinic with Instagram, Messenger and WhatsApp. */
export const META_GREETING_NOTE =
  "Instagram, Messenger and WhatsApp don't use it: each conversation there opens with a fixed line saying AYA is an AI assistant and the channel isn't secure.";

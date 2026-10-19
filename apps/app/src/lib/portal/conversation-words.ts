/**
 * What the Conversations screen calls things (plan Part F4): channels by the
 * names patients use (spec, "Portal design principles": "Channels have the
 * names patients use"), the five outcomes, and the transcript receipt's
 * statuses in plain words. Pure, with no server imports, so the screen's
 * client components and lib/portal/conversations.ts share one list.
 */

export type ConversationChannel =
  "voice" | "web_chat" | "instagram" | "messenger" | "whatsapp" | "sms" | "web_form";

export const CHANNEL_NAMES: Record<ConversationChannel, string> = {
  voice: "Phone",
  web_chat: "Website chat",
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  sms: "Text message",
  web_form: "Website form",
};

export const CONVERSATION_OUTCOMES = [
  "answered",
  "booked",
  "request",
  "handover",
  "urgent",
] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

export const OUTCOME_NAMES: Record<ConversationOutcome, string> = {
  answered: "Answered",
  booked: "Booked",
  request: "Booking request",
  handover: "Handover",
  urgent: "Urgent",
};

/** The badge for each outcome: urgent stands out, the rest are quiet. */
export const OUTCOME_STYLES: Record<ConversationOutcome, string> = {
  urgent: "border border-red-200 bg-white text-red-800",
  handover: "bg-tint-butter",
  booked: "bg-paper-2 text-green",
  request: "bg-paper-2",
  answered: "bg-paper-2 text-muted",
};

/**
 * Where a "Flag this answer" correction stands (lib/conversations/flags.ts):
 * live in the quick answers AYA reads, saved and waiting for the agent's
 * words to be approved again, removed from the quick answers since, or none
 * typed.
 */
export const CORRECTION_STATES = ["live", "waiting", "removed", "none"] as const;
export type CorrectionState = (typeof CORRECTION_STATES)[number];

/** The Flagged view's words for each, beside the flag. */
export const CORRECTION_WORDS: Record<CorrectionState, string> = {
  live: "Correction live in Quick answers",
  waiting: "Correction saved: AYA uses it once your answers are checked again",
  removed: "Correction no longer in Quick answers",
  none: "No correction added",
};

/** Today, yesterday, or this week (Monday to today), in the clinic's own time zone. */
export const DAY_CHIPS = ["today", "yesterday", "week"] as const;
export type DayChip = (typeof DAY_CHIPS)[number];

export function isDayChip(value: unknown): value is DayChip {
  return (DAY_CHIPS as readonly unknown[]).includes(value);
}

/** "(415) 555-0134" for a US number; any other as stored. */
export function phoneText(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}

/** A transcript's delivery, as the open view shows it: no words, no address. */
export type ReceiptFacts = {
  status: "open" | "pending" | "sent" | "bounced" | "delivered" | "expired" | "unconfirmed";
  sentAt: string | null;
  deliveredAt: string | null;
  attempts: number;
};

/**
 * Where an emailed transcript stands, in one sentence (spec, "Portal map":
 * "after that a receipt without the words shows when it was sent and
 * delivered"). `when` writes a moment in the clinic's zone. Null receipt:
 * none was queued (nobody spoke, or the conversation is older than the
 * outbox).
 */
export function receiptSentence(
  receipt: ReceiptFacts | null,
  when: (iso: string) => string,
): string {
  if (!receipt) return "No transcript was emailed for this conversation: nothing was said.";
  const at = (iso: string | null) => (iso ? ` at ${when(iso)}` : "");
  const sent = at(receipt.sentAt);
  switch (receipt.status) {
    case "open":
      return "The chat is still going. Its transcript is emailed to your clinic's address when it ends.";
    case "pending":
      return receipt.attempts > 0
        ? `Not sent yet, after ${receipt.attempts === 1 ? "1 try" : `${receipt.attempts} tries`}. healdesk keeps trying.`
        : "Waiting to be sent to your clinic's address.";
    case "sent":
      return `Sent${sent}. Waiting for your mail server to confirm it arrived.`;
    case "bounced":
      return `Sent${sent}, but your mail server turned it away. healdesk tries again within the hour.`;
    case "delivered":
      return `Delivered${at(receipt.deliveredAt)}. healdesk then deleted its copy, so it can't be sent again.`;
    case "expired":
      return "Not delivered within 30 days of the conversation, so healdesk deleted its copy.";
    case "unconfirmed":
      return `Sent${sent}, but your mail server never confirmed it within 72 hours, so healdesk deleted its copy.`;
  }
}

/** A booking request's status, as Bookings words it. */
export const REQUEST_STATUS_NAMES: Record<string, string> = {
  requested: "Waiting for your team",
  accepted: "Accepted",
  rescheduling: "Other times offered",
  confirmed: "Confirmed",
  declined: "Declined",
  expired: "Missed",
};

import { audienceSingular, type Channel } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import type { Block } from "./compose";
import type { TemplateContext } from "./types";

/**
 * What the live alerts share: L7, L10, L11, L12 and L34 in Annex X5 of the
 * funnel and portal plan, queued by notifyBookingAlert
 * (lib/notices/booking-alerts.ts) in the transaction that makes each true.
 *
 * Every one is a pointer (the spec: "Anything about a patient is a pointer
 * into the portal: never a name, number, time, service or any words from a
 * conversation"). It says what kind of thing happened, on which channel and
 * at which practice, and links into the clinic portal, where who, when and
 * what open behind sign-in and the passkey step-up. So it carries nothing a
 * business associate agreement would need to cover, goes on Resend with
 * phiClass "none", and the payload allowlist (lib/email/lint.ts) passes the
 * payload: a channel id, opaque ids, one flag and our own URL.
 */

/** Which of Meta's three platforms a Meta alert came in on: what staff can do differs (findThem). */
export type MetaAlertPlatform = "instagram" | "messenger" | "whatsapp";

export type BookingAlertPayload = {
  /** The channel it came in on, as the catalog names it, or null when the writer did not say. */
  channel: Channel | null;
  /**
   * On the Meta channel, which platform: staff answer an Instagram or
   * Messenger message in the clinic's own inbox there, and a WhatsApp number
   * has none (lib/meta/front-door.ts, staffCanReplyOn). Absent or null
   * elsewhere, and on a Meta payload queued before it was carried.
   */
  platform?: MetaAlertPlatform | null;
  /** The conversation it came from, when there is one to open yet. */
  conversationId: string | null;
  bookingRequestId: string | null;
  appointmentId: string | null;
  /**
   * L10 only: a deposit link nobody could check (a Stripe disconnect, or
   * Stripe unreachable while it lapsed) may already have been paid, so the
   * email says to check before asking again. A flag, never a sentence.
   */
  isPossiblyPaid: boolean;
  /**
   * L11 only: one email for several requests for a person on a call or in
   * the website chat, past the per-clinic cap (ALERT_BURST_AFTER,
   * lib/notices/booking-alerts.ts). It names no conversation and opens
   * Conversations, where each is marked. An urgent alert never carries it:
   * each one is its own email. Absent, read as false.
   */
  isBurst?: boolean;
  /** Where it opens in the clinic portal (alertPortalPath, lib/notices/booking-alerts.ts). */
  portalUrl: string;
};

/** Each Meta platform as staff know it. */
const PLATFORM_NAMES: Record<MetaAlertPlatform, string> = {
  instagram: "an Instagram",
  messenger: "a Messenger",
  whatsapp: "a WhatsApp",
};

/** "on a call to", "in the website chat of", "in a WhatsApp message to": where it happened, before the practice's name. */
export function wherePhrase(payload: Pick<BookingAlertPayload, "channel" | "platform">): string {
  switch (payload.channel) {
    case "voice":
      return "on a call to";
    case "web":
      return "in the website chat of";
    case "meta":
      return payload.platform
        ? `in ${PLATFORM_NAMES[payload.platform]} message to`
        : "in an Instagram, Messenger or WhatsApp message to";
    default:
      return "in a conversation with";
  }
}

/** The practice's name, or a fallback for a clinic with none on file. */
export function practiceOf(ctx: TemplateContext): string {
  return ctx.clinicName ?? "your practice";
}

/**
 * Where staff find who it is, which depends on what the alert points at:
 *
 *   - "portal": a call, or anything with a booking request or an
 *     appointment. healdesk holds a name and number for it, which open in the
 *     portal behind sign-in and the passkey step-up.
 *   - "meta_inbox": an Instagram or Messenger message with no request. Those
 *     channels share no name or number with healdesk and it keeps none of
 *     their messages, so the portal cannot say who it is: staff answer in the
 *     clinic's own inbox there, the Meta fallback.
 *   - "whatsapp": a WhatsApp message with no request. The same, except that
 *     there is no inbox: the number is on the Cloud API alone, and v1 has no
 *     staff inbox of its own, so nobody can answer the thread
 *     (lib/meta/front-door.ts, staffCanReplyOn).
 *   - "web_maybe": a website chat with no request. A name and number open in
 *     the portal only if the visitor left them; the chat's transcript, emailed
 *     to the clinic when the chat ends, has everything they wrote.
 *   - "burst": one email for several (isBurst), which opens Conversations.
 */
export type FindThem = "portal" | "meta_inbox" | "whatsapp" | "web_maybe" | "burst";

export function findThem(payload: BookingAlertPayload): FindThem {
  if (payload.isBurst === true) return "burst";
  if (payload.bookingRequestId || payload.appointmentId) return "portal";
  if (payload.channel === "meta") return payload.platform === "whatsapp" ? "whatsapp" : "meta_inbox";
  if (payload.channel === "web") return "web_maybe";
  return "portal";
}

/** Where to answer an Instagram or Messenger message, by its platform when the payload says. */
function inboxReply(payload: BookingAlertPayload): string {
  switch (payload.platform) {
    case "instagram":
      return "Reply to them in your Instagram inbox.";
    case "messenger":
      return "Reply to them in your Facebook Page's inbox.";
    default:
      // A payload that names no platform: only what holds on all three.
      return "If they wrote on Instagram or Messenger, reply to them in that inbox; a WhatsApp message has no inbox to reply from.";
  }
}

/** The preheader's last sentence: where to look, as findThem decides. */
export function findThemShort(payload: BookingAlertPayload): string {
  switch (findThem(payload)) {
    case "burst":
      return "Open Conversations in healdesk to see each one.";
    case "meta_inbox":
      return inboxReply(payload);
    case "whatsapp":
      return "There is no WhatsApp inbox to reply to them from.";
    case "web_maybe":
      return "Open healdesk to see whether they left a name and number.";
    case "portal":
      return "Open healdesk to see who it is.";
  }
}

/** Why the link shows so little for a Meta message: what healdesk does not have. */
const META_HOLDS_NOTHING =
  "Instagram, Messenger and WhatsApp share no name or number with healdesk, and it keeps none of their messages, so the link shows only when they wrote.";

/** The body's sentence on who it is, as findThem decides. */
function findThemLine(payload: BookingAlertPayload): string {
  switch (findThem(payload)) {
    case "burst":
      return "Each one opens in Conversations once you sign in and confirm it's you, marked as a request for a person.";
    case "meta_inbox":
      return `${inboxReply(payload)} ${META_HOLDS_NOTHING}`;
    case "whatsapp":
      return `There is no WhatsApp inbox to reply to them from: AYA alone answers your WhatsApp number. ${META_HOLDS_NOTHING}`;
    case "web_maybe":
      return "If they left a name and number, they open in healdesk once you sign in and confirm it's you. The chat's transcript, emailed to you when the chat ends, has everything they wrote.";
    case "portal":
      return "Who it is and how to reach them open in healdesk once you sign in and confirm it's you.";
  }
}

/**
 * The end every alert shares: the one link, a line for a call that is still
 * going on (its conversation is recorded when it ends, so the link opens
 * Conversations instead), a line for a Meta link that can move on, where to
 * find who it is (findThem), and why the email names nobody.
 */
export function openBlocks(payload: BookingAlertPayload, ctx: TemplateContext): Block[] {
  const person = audienceSingular(ctx.audience);
  const burst = payload.isBurst === true;
  return [
    { type: "action", label: "Open in healdesk", url: payload.portalUrl },
    ...(payload.channel === "voice" && !payload.conversationId && !burst
      ? [{ type: "paragraph" as const, text: "The call shows in Conversations once it ends." }]
      : []),
    // A Meta thread keeps only its current conversation (lib/meta/greeting.ts):
    // after a day's quiet a new message starts another, and this link no
    // longer opens.
    ...(payload.channel === "meta" && payload.conversationId && !burst
      ? [
          {
            type: "paragraph" as const,
            text: "If they write again after a day's quiet, their thread moves on to a new conversation and this link stops opening; find them in Conversations.",
          },
        ]
      : []),
    { type: "paragraph", text: `${findThemLine(payload)} This email carries no ${person} details on purpose.` },
  ];
}

/** A realistic fixture: a website chat's conversation, opened in Conversations. */
export function alertFixture(overrides: Partial<BookingAlertPayload> = {}): BookingAlertPayload {
  const conversationId = overrides.conversationId === undefined ? "5b0c8a1e-2f3d-4c5b-9a6e-7d8f9a0b1c2d" : overrides.conversationId;
  return {
    channel: "web",
    platform: null,
    conversationId,
    bookingRequestId: null,
    appointmentId: null,
    isPossiblyPaid: false,
    isBurst: false,
    portalUrl: publicUrl(
      conversationId
        ? `/c/radiance-med-spa/conversations/${conversationId}`
        : "/c/radiance-med-spa/conversations",
    ),
    ...overrides,
  };
}

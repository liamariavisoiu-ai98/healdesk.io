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

export type BookingAlertPayload = {
  /** The channel it came in on, as the catalog names it, or null when the writer did not say. */
  channel: Channel | null;
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
  /** Where it opens in the clinic portal (alertPortalPath, lib/notices/booking-alerts.ts). */
  portalUrl: string;
};

/** "on a call to", "in the website chat of", "in a message to": where it happened, before the practice's name. */
export function wherePhrase(channel: Channel | null): string {
  switch (channel) {
    case "voice":
      return "on a call to";
    case "web":
      return "in the website chat of";
    case "meta":
      return "in an Instagram, Messenger or WhatsApp message to";
    default:
      return "in a conversation with";
  }
}

/** The practice's name, or a fallback for a clinic with none on file. */
export function practiceOf(ctx: TemplateContext): string {
  return ctx.clinicName ?? "your practice";
}

/**
 * The end every alert shares: the one link, a line for a call that is still
 * going on (its conversation is recorded when it ends, so the link opens
 * Conversations instead), and why the email names nobody.
 */
export function openBlocks(payload: BookingAlertPayload, ctx: TemplateContext): Block[] {
  const person = audienceSingular(ctx.audience);
  return [
    { type: "action", label: "Open in healdesk", url: payload.portalUrl },
    ...(payload.channel === "voice" && !payload.conversationId
      ? [{ type: "paragraph" as const, text: "The call shows in Conversations once it ends." }]
      : []),
    {
      type: "paragraph",
      text: `Who it is and how to reach them open in healdesk once you sign in and confirm it's you. This email carries no ${person} details on purpose.`,
    },
  ];
}

/** A realistic fixture: a website chat's conversation, opened in Conversations. */
export function alertFixture(overrides: Partial<BookingAlertPayload> = {}): BookingAlertPayload {
  const conversationId = overrides.conversationId === undefined ? "5b0c8a1e-2f3d-4c5b-9a6e-7d8f9a0b1c2d" : overrides.conversationId;
  return {
    channel: "web",
    conversationId,
    bookingRequestId: null,
    appointmentId: null,
    isPossiblyPaid: false,
    portalUrl: publicUrl(
      conversationId
        ? `/c/radiance-med-spa/conversations/${conversationId}`
        : "/c/radiance-med-spa/conversations",
    ),
    ...overrides,
  };
}

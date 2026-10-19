import { audienceSingular, type Channel } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

import { compose, type Block } from "./compose";
import type { TemplateEntry } from "./registry";
import type { EmailTemplate, TemplateContext } from "./types";

/**
 * The live alerts (Annex X5 of the funnel and portal plan): L7 booking
 * request, L8 request still open, L9 missed, L10 deposit to collect, L11
 * handover, L12 urgent, L20 website message and L34 calendar check. Queued by
 * lib/notices/booking-alerts.ts in the transaction that makes each one true,
 * sent at once, at any hour; L12 is critical and goes in-process right after
 * commit.
 *
 * Every one is a POINTER (X1.1; the spec's "Email": "Anything about a patient
 * is a pointer into the portal: never a name, number, time, service or any
 * words from a conversation"). It says what kind of thing needs attention, at
 * which clinic, and links into the portal, where the details open behind
 * sign-in and step-up. The payloads carry ids, a channel, counts, a flag and
 * the link, and nothing a template could print about the person: there is no
 * field to print a name, a number, a time or a service from.
 */

/** What every live alert carries. Ids only, for the send-time checks; none is printed. */
export type BookingAlertPayload = {
  /** The portal screen the alert points at, behind sign-in and step-up. Null only when no public origin is set. */
  portalUrl: string | null;
  /** How the person reached the clinic, when known: a channel id, never a platform, a page or a number. */
  channel: Channel | null;
  bookingRequestId: string | null;
  appointmentId: string | null;
  conversationId: string | null;
};

/** L10: the alert, and whether its payment link may already have been paid (Package D, R23). */
export type DepositAlertPayload = BookingAlertPayload & { isPossiblyPaid: boolean };

/** L8: how many requests are still waiting at the clinic's opening hour. */
export type RequestsStillOpenPayload = {
  portalUrl: string | null;
  openCount: number;
  /** BOOKING_REQUEST_TTL_DAYS: a request still waiting this long after it was taken closes as missed. */
  closesAfterDays: number;
};

/** "on a call", "in your website chat": how the person reached the clinic, or nothing when unknown. */
function viaChannel(channel: Channel | null): string {
  switch (channel) {
    case "voice":
      return " on a call";
    case "web":
      return " in your website chat";
    case "meta":
      return " on Instagram, Messenger or WhatsApp";
    default:
      return "";
  }
}

/** Where the person's own words reach the clinic, which this email never carries. */
function whereTheDetailsAre(channel: Channel | null): Block[] {
  if (channel === "voice" || channel === "web") {
    return [
      {
        type: "paragraph",
        text: "The conversation's transcript is emailed to this address when it ends.",
      },
    ];
  }
  if (channel === "meta") {
    return [
      {
        type: "paragraph",
        text: "Their message is in your Instagram, Messenger or WhatsApp inbox.",
      },
    ];
  }
  return [];
}

/** The one next action: the portal screen, named after the screen the link opens. */
function openAction(url: string | null): Block[] {
  if (!url) {
    return [{ type: "paragraph", text: "Sign in to healdesk to see it." }];
  }
  const label = new URL(url).pathname.endsWith("/conversations")
    ? "Open Conversations"
    : "Open Bookings";
  return [{ type: "action", label, url }];
}

/** Why there is nothing about the person here, in the clinic's own word for them. */
function pointerLine(ctx: TemplateContext): Block {
  return {
    type: "paragraph",
    text: `This email carries no ${audienceSingular(ctx.audience)} details on purpose: they open in healdesk once you sign in.`,
  };
}

function clinicOf(ctx: TemplateContext): string {
  return ctx.clinicName ?? "your practice";
}

// -----------------------------------------------------------------------------
// L7: a booking request
// -----------------------------------------------------------------------------

export const renderBookingRequest: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "A booking request is waiting for your team",
      preheader: "Open Bookings in healdesk to confirm a time.",
      blocks: [
        {
          type: "paragraph",
          text: `Someone asked ${clinicOf(ctx)} for an appointment${viaChannel(payload.channel)}, and AYA took it as a request. Nothing is booked until your team confirms a time, and they've been told your team will confirm one with them.`,
        },
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );

// -----------------------------------------------------------------------------
// L8: requests still open at the clinic's opening hour
// -----------------------------------------------------------------------------

export const renderRequestStillOpen: EmailTemplate<RequestsStillOpenPayload> = (payload, ctx) => {
  const one = payload.openCount === 1;
  return compose(
    {
      subject: one
        ? "A booking request is still waiting"
        : `${payload.openCount} booking requests are still waiting`,
      preheader: "Open Bookings in healdesk to answer them.",
      blocks: [
        {
          type: "paragraph",
          text: one
            ? "A booking request AYA took is still waiting for your team. The person was told your team would confirm a time with them."
            : `${payload.openCount} booking requests AYA took are still waiting for your team. Each person was told your team would confirm a time with them.`,
        },
        ...openAction(payload.portalUrl),
        {
          type: "paragraph",
          text: `A request still waiting ${payload.closesAfterDays} days after it was taken closes as missed.`,
        },
        {
          type: "paragraph",
          text: "This comes at opening time because your daily summary is off. Turn the summary on in Settings to get every request in one morning email instead.",
        },
        pointerLine(ctx),
      ],
    },
    ctx,
  );
};

// -----------------------------------------------------------------------------
// L9: a request expired
// -----------------------------------------------------------------------------

export const renderRequestMissed: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Missed: they were told you'd call",
      preheader: "A booking request closed before a time was confirmed.",
      blocks: [
        {
          type: "paragraph",
          text: "A booking request AYA took has closed before a time was confirmed. The person was told you'd call them, so they may still be waiting to hear from you.",
        },
        { type: "paragraph", text: "It stays in Bookings, under Missed." },
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );

// -----------------------------------------------------------------------------
// L10: a deposit to collect
// -----------------------------------------------------------------------------

export const renderDepositToCollect: EmailTemplate<DepositAlertPayload> = (payload, ctx) => {
  const via = viaChannel(payload.channel);
  return compose(
    {
      subject: "A deposit to collect",
      preheader: "A booking needs your team to sort out its deposit.",
      blocks: [
        {
          type: "paragraph",
          text: payload.appointmentId
            ? `AYA booked an appointment${via} that needs a deposit, and left the deposit for your team to collect.`
            : `Someone asked for an appointment${via} that needs a deposit AYA couldn't take during the conversation. As your deposit settings ask, it's waiting for your team.`,
        },
        ...(payload.isPossiblyPaid
          ? [
              {
                type: "paragraph" as const,
                text: "Its payment link may already have been paid: check your Stripe account before asking for the deposit again.",
              },
            ]
          : []),
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );
};

// -----------------------------------------------------------------------------
// L11: someone asked for a person
// -----------------------------------------------------------------------------

export const renderHandover: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "Someone asked to speak with a person",
      preheader: "AYA told them your team would get back to them.",
      blocks: [
        {
          type: "paragraph",
          text: `Someone asked to speak with a person at ${clinicOf(ctx)}${viaChannel(payload.channel)}. AYA told them your team would get back to them, and asked for a name and number if she didn't have them.`,
        },
        ...whereTheDetailsAre(payload.channel),
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );

// -----------------------------------------------------------------------------
// L12: URGENT
// -----------------------------------------------------------------------------

export const renderUrgent: EmailTemplate<BookingAlertPayload> = (payload, ctx) => {
  // The fixed urgent reply, as the clinic set it up in the wizard's urgent
  // screen: a practice's urgent-help number, or a veterinary practice's
  // emergency referral clinic. Never what the person said.
  const reply =
    ctx.audience === "clients"
      ? "which tells them to call 911 if a person is in danger and gives them the emergency referral clinic you set, or the nearest emergency vet if you set none"
      : "which tells them to call 911 in an emergency and gives them the urgent-help number you set";
  return compose(
    {
      subject: "URGENT: a complication or urgent symptom was reported",
      preheader: "AYA gave them the fixed urgent reply. Please follow up now.",
      blocks: [
        {
          type: "paragraph",
          text: `Someone${viaChannel(payload.channel)} reported a complication or an urgent symptom to AYA. She gave no advice: she answered with the fixed urgent reply, ${reply}.`,
        },
        ...whereTheDetailsAre(payload.channel),
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );
};

// -----------------------------------------------------------------------------
// L20: a message left on the website
// -----------------------------------------------------------------------------

export const renderWebsiteMessage: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "A message was left on your website",
      preheader: "AYA wasn't answering your website chat, so your website took a message.",
      blocks: [
        {
          type: "paragraph",
          text: "While AYA wasn't answering your website chat, someone left a message on your website's contact form asking you to call them back. They were told you would.",
        },
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );

// -----------------------------------------------------------------------------
// L34: a booking that may not be in the calendar
// -----------------------------------------------------------------------------

export const renderCalendarCheck: EmailTemplate<BookingAlertPayload> = (payload, ctx) =>
  compose(
    {
      subject: "A booking may not be in your calendar",
      preheader: "Check it in Bookings and in your Google Calendar.",
      blocks: [
        {
          type: "paragraph",
          text: "AYA was booking an appointment into your Google Calendar, but Google didn't confirm it arrived, or your team had already decided on that request.",
        },
        {
          type: "paragraph",
          text: "Check it in Bookings, then make sure it's in your calendar once, and only once.",
        },
        ...openAction(payload.portalUrl),
        pointerLine(ctx),
      ],
    },
    ctx,
  );

// -----------------------------------------------------------------------------
// The registry's entries
// -----------------------------------------------------------------------------

/** The fixtures' ids: opaque, as every payload's are. */
const REQUEST_ID = "5d0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
const APPOINTMENT_ID = "6e1d2b3c-4d5e-4f60-9b7c-8d9e0f1a2b3c";
const CONVERSATION_ID = "7f2e3c4d-5e6f-4071-8c8d-9e0f1a2b3c4d";

function bookingsUrl(): string {
  return publicUrl("/c/radiance-med-spa/bookings");
}

function alertFixture(overrides: Partial<BookingAlertPayload> = {}): BookingAlertPayload {
  return {
    portalUrl: bookingsUrl(),
    channel: "voice",
    bookingRequestId: null,
    appointmentId: null,
    conversationId: null,
    ...overrides,
  };
}

// Getters, so the links are built from BETTER_AUTH_URL when a test or the
// seed script reads them, not when this module loads.

export const BOOKING_REQUEST_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderBookingRequest,
  get fixture() {
    return alertFixture({
      channel: "web",
      bookingRequestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
    });
  },
};

export const REQUEST_STILL_OPEN_ENTRY: TemplateEntry<RequestsStillOpenPayload> = {
  render: renderRequestStillOpen,
  get fixture() {
    return { portalUrl: bookingsUrl(), openCount: 2, closesAfterDays: 7 };
  },
};

export const REQUEST_MISSED_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderRequestMissed,
  get fixture() {
    return alertFixture({ bookingRequestId: REQUEST_ID });
  },
};

export const DEPOSIT_TO_COLLECT_ENTRY: TemplateEntry<DepositAlertPayload> = {
  render: renderDepositToCollect,
  get fixture() {
    return { ...alertFixture({ appointmentId: APPOINTMENT_ID }), isPossiblyPaid: true };
  },
};

export const HANDOVER_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderHandover,
  get fixture() {
    return alertFixture({ channel: "web", conversationId: CONVERSATION_ID });
  },
};

export const URGENT_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderUrgent,
  get fixture() {
    return alertFixture({ channel: "voice" });
  },
};

export const WEBSITE_MESSAGE_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderWebsiteMessage,
  get fixture() {
    return alertFixture({ channel: "web", bookingRequestId: REQUEST_ID });
  },
};

export const CALENDAR_CHECK_ENTRY: TemplateEntry<BookingAlertPayload> = {
  render: renderCalendarCheck,
  get fixture() {
    return alertFixture({ channel: null, bookingRequestId: REQUEST_ID });
  },
};

import type { BookingSystemId, CalendarAccount, CalendarTermsKind } from "@healdesk/catalog";

import { describeError, log } from "@/lib/log";

import { printableClinicName } from "./lint";
import { sendEmail, type SendEmailOptions } from "./send";
import { renderCalendarElectionRecorded } from "./templates/calendar_election_recorded";
import { renderCalendarLink, type CalendarLinkPurpose } from "./templates/calendar_link";
import { audienceFor, clinicReason } from "./templates/context";

/**
 * Sending the calendar backend's two emails through the email platform
 * (lib/email/send.ts): the calendar link and the practice's copy of an
 * election. Never throws, and never logs a URL or an address: a link is a
 * credential, and an address is the practice's. The caller has already
 * recorded the recipients on the link row (`sent_to`) before calling this.
 */

export type CalendarMailClinic = {
  clinicId: string;
  clinicName: string;
  specialty: string | null;
  timeZone: string;
};

export type CalendarMailDelivery = { recipients: number; sent: number; failed: number };

/** One link, to each of the practice's addresses (in v1, its one address). */
export async function mailCalendarLink(
  input: CalendarMailClinic & {
    recipients: readonly string[];
    url: string;
    expiresAt: Date;
    purpose: CalendarLinkPurpose;
    /** The link's row id: the `delivery` tag and the idempotency key. Never the token. */
    linkId: string;
  },
  options: SendEmailOptions = {},
): Promise<CalendarMailDelivery> {
  // The name as the email may print it, or none (lib/email/lint.ts).
  const printed = printableClinicName(input.clinicName);
  const payload = {
    linkUrl: input.url,
    expiresAt: input.expiresAt.toISOString(),
    purpose: input.purpose,
  };
  const rendered = renderCalendarLink(
    payload,
    {
      clinicName: printed,
      audience: audienceFor(input.specialty),
      reason: clinicReason(printed),
      raisedAt: options.now ?? new Date(),
      timeZone: input.timeZone,
    },
  );
  return sendEach(input.recipients, (to, n) =>
    sendEmail(
      {
        to,
        kind: "calendar_link",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        clinicId: input.clinicId,
        clinicName: printed,
        deliveryId: input.linkId,
        idempotencyKey: `hd-calendar_link-${input.linkId}-${n}`,
      },
      options,
    ),
  ).then((delivery) => {
    log.info("calendar link mailed", {
      clinicId: input.clinicId,
      deliveryId: input.linkId,
      purpose: input.purpose,
      count: delivery.sent,
      failures: delivery.failed,
    });
    return delivery;
  });
}

/** The practice's copy of an election it recorded. */
export async function mailCalendarElectionCopy(
  input: CalendarMailClinic & {
    recipients: readonly string[];
    electionId: string;
    kind: CalendarTermsKind;
    calendarAccount: CalendarAccount;
    bookingSystem: BookingSystemId;
    electedAt: Date;
  },
  options: SendEmailOptions = {},
): Promise<CalendarMailDelivery> {
  // The name as the email may print it, or none (lib/email/lint.ts).
  const printed = printableClinicName(input.clinicName);
  const payload = {
    electionId: input.electionId,
    kind: input.kind,
    type: input.calendarAccount,
    provider: input.bookingSystem,
    electedAt: input.electedAt.toISOString(),
  };
  let rendered: ReturnType<typeof renderCalendarElectionRecorded>;
  try {
    rendered = renderCalendarElectionRecorded(
      payload,
      {
        clinicName: printed,
        audience: audienceFor(input.specialty),
        reason: clinicReason(printed),
        raisedAt: options.now ?? new Date(),
        timeZone: input.timeZone,
      },
    );
  } catch (error) {
    log.error("calendar election copy not rendered", {
      clinicId: input.clinicId,
      error: describeError(error),
    });
    return { recipients: input.recipients.length, sent: 0, failed: input.recipients.length };
  }
  return sendEach(input.recipients, (to, n) =>
    sendEmail(
      {
        to,
        kind: "calendar_election_recorded",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        payload,
        clinicId: input.clinicId,
        clinicName: printed,
        deliveryId: input.electionId,
        idempotencyKey: `hd-calendar_election_recorded-${input.electionId}-${n}`,
      },
      options,
    ),
  );
}

async function sendEach(
  recipients: readonly string[],
  send: (to: string, n: number) => Promise<{ status: string }>,
): Promise<CalendarMailDelivery> {
  const delivery: CalendarMailDelivery = { recipients: recipients.length, sent: 0, failed: 0 };
  for (const [index, to] of recipients.entries()) {
    try {
      const result = await send(to, index + 1);
      if (result.status === "failed") delivery.failed += 1;
      else delivery.sent += 1;
    } catch (error) {
      delivery.failed += 1;
      log.error("calendar email not sent", { error: describeError(error) });
    }
  }
  return delivery;
}

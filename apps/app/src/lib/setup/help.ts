import { SENDER_IDENTITY } from "@healdesk/catalog";

import { publicUrl } from "@/lib/public-url";

/**
 * Help, as the wizard, the clinic's page and the setup emails offer it (plan
 * Part F7): hello@healdesk.io always; the support voicemail number and the
 * five-minute call only while the owner has set them, so a line that goes
 * nowhere is never shown (contracts §8).
 *
 * Both values are the owner's and public, and come from the environment only,
 * read at call time: `HEALDESK_SUPPORT_PHONE` (E.164) and
 * `HEALDESK_CALL_BOOKING_URL` (an https scheduling page). A value that is not
 * one of those counts as unset, so a typo hides the line instead of printing
 * a number that rings nobody.
 *
 * Emails link the call through `/help/call` on this app's own origin rather
 * than to the scheduling page itself: an email sits in an inbox for months,
 * and the redirect follows the variable, so the link in an old email still
 * reaches today's page, and the email platform's link scanner keeps every
 * link on our own origin.
 */

export type HelpContacts = {
  /** Always: the one inbox, which every email's reply also reaches. */
  email: string;
  /** The voicemail line, E.164, or null while unset. */
  phoneE164: string | null;
  /** The scheduling page for the five-minute call, or null while unset. */
  callBookingUrl: string | null;
};

const E164 = /^\+[1-9]\d{6,14}$/;

export function helpContacts(): HelpContacts {
  return {
    email: SENDER_IDENTITY.replyTo,
    phoneE164: supportPhone(),
    callBookingUrl: callBookingUrl(),
  };
}

function supportPhone(): string | null {
  const raw = process.env.HEALDESK_SUPPORT_PHONE?.trim();
  return raw && E164.test(raw) ? raw : null;
}

function callBookingUrl(): string | null {
  const raw = process.env.HEALDESK_CALL_BOOKING_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The call link an email carries: this app's redirect, while a scheduling page is set. */
export function emailCallUrl(): string | null {
  return callBookingUrl() ? publicUrl("/help/call") : null;
}

/**
 * A US number the way people write it, "(888) 688-9404"; any other number
 * in its E.164 form, which is unambiguous.
 */
export function formatPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}

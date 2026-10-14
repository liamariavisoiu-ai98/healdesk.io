/**
 * The email that tells the owner somebody just signed in to /admin.
 *
 * With one account and no colleagues there is nobody to notice an unfamiliar
 * session in a list. This email is the whole of detection: the only way the
 * person who owns the credential learns it was used without them. So it goes
 * out on every successful sign-in, never only on "suspicious" ones, because a
 * filter that decides which sign-ins are worth mentioning is a filter that
 * will one day decline to mention the one that mattered.
 *
 * ## Sent from here since 14 October 2026
 *
 * apps/app used to send it (`opSendSignInAlert`, over the signed ops API) and
 * write a `security_events` row beside it. The second factor moved onto
 * Vercel that day so that /admin can be signed into while the AWS host is
 * off, and an alert that needed the host would have gone quiet in exactly
 * that case. It is now apps/web's own Resend mail, to apps/web's own
 * `HEALDESK_ADMIN_EMAIL`, with the same content. What it lost is the durable
 * row: apps/web has no audit table, so the session route writes one
 * structured log line per attempt instead, and this email is the record the
 * owner holds.
 *
 * Who it goes to is the account's own address and is never an argument. The
 * address is also what the session token is bound to, so changing it to
 * redirect the alert also ends every session: the alert can be silenced only
 * by somebody who can already rewrite this project's environment, which is
 * the same person who holds both factors.
 *
 * ## What is in it, and what must never be
 *
 * The time in UTC, the address the request came from, the browser string, and
 * what to do if it was not them. No session id, no token, no code, no
 * password, no link. A sign-in alert that carries a credential is a phishing
 * template with our domain on it, and one that carries a link teaches the
 * recipient to click links in mail about their own account.
 *
 * Plain text only (apps/web's sender sends text), so nothing here is HTML to
 * escape. What does need escaping is the user agent, the one string in the
 * message somebody else wrote: a header can carry a carriage return, and a
 * line break in it would let the caller write a forged "Time:" line under the
 * real one. Control characters and bidirectional overrides are therefore
 * shown as `\uXXXX` rather than passed through, and it is capped at 256
 * characters, as apps/app capped it.
 *
 * No patient is in it and nowhere for one to appear, which is why Resend is
 * the right transport.
 */

import { adminEmail } from "@/lib/admin/operator";
import { sendSafely, type SendResult } from "@/lib/email";

export type SignInEvent = {
  at: Date;
  /** The request's apparent address, a claim by whoever sent it. */
  ipAddress?: string;
  /** The browser's own User-Agent header, untrusted and caller-written. */
  userAgent?: string;
};

export type RenderedAlert = { subject: string; text: string };

const MAX_USER_AGENT = 256;
const MAX_IP = 64;

/**
 * Everything a header could use to rewrite the message around it: C0 and C1
 * controls (CR and LF among them), DEL, the line and paragraph separators, and
 * the bidirectional overrides and isolates that reorder what a reader sees.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Truncate, then show every unsafe character as its escape. */
export function printable(value: string, max: number): string {
  return value
    .slice(0, max)
    .replace(UNSAFE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The message, from the event alone. Pure, so the test reads exactly what is sent. */
export function renderSignInAlert(event: SignInEvent): RenderedAlert {
  const when = `${event.at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  // "not recorded" rather than a blank line. An absent value and an unknown
  // one read identically in an email, and only one of them is true here.
  const from =
    event.ipAddress !== undefined && event.ipAddress.length > 0
      ? printable(event.ipAddress, MAX_IP)
      : "not recorded";
  const browser =
    event.userAgent !== undefined && event.userAgent.length > 0
      ? printable(event.userAgent, MAX_USER_AGENT)
      : "not recorded";

  const subject = `healdesk admin: signed in at ${when}`;

  const text = [
    `Someone signed in to the healdesk admin console.`,
    ``,
    `Time:    ${when}`,
    `Address: ${from}`,
    `Browser: ${browser}`,
    ``,
    `If that was you, there is nothing to do.`,
    ``,
    `If it was not, both factors are compromised, because there is only one`,
    `account and both are needed to reach this point. Change the admin password,`,
    `rotate HEALDESK_ADMIN_SECRET (which ends every session), run the admin:totp`,
    `script to make a new authenticator secret and replace`,
    `HEALDESK_ADMIN_TOTP_SECRET in Vercel, then check who can reach the Vercel`,
    `project, since that is where both factors are kept.`,
    ``,
    `healdesk will never email you a code, a password, or a link to sign in.`,
    `This message contains none of those, and any message that does is not from`,
    `us.`,
  ].join("\n");

  return { subject, text };
}

/**
 * Send it. Never throws: `sendSafely` turns a missing transport into a failed
 * result, and an unconfigured account address is a skipped one. The caller
 * runs this after the response and logs anything but "sent", because an alert
 * that fails quietly is worse than none.
 */
export async function sendSignInAlert(event: SignInEvent): Promise<SendResult> {
  const to = adminEmail();
  if (to === null) return { status: "skipped", reason: "HEALDESK_ADMIN_EMAIL is not set" };
  const message = renderSignInAlert(event);
  return sendSafely({
    to,
    subject: message.subject,
    text: message.text,
    // A Resend tag, for the dashboard: letters, digits, `_` and `-` only.
    tag: "admin-sign-in",
  });
}

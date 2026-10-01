import {
  getTransport,
  type DeliveryTarget,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";

/**
 * The email that carries a clinic's one-time connection link.
 *
 * PHASE TWO: attribution read-back. Not sent in v1: the ops operation that
 * calls it (issueConnectLink) refuses unless HEALDESK_PHASE_TWO_ATTRIBUTION is
 * "true". When phase two revives it, the pasted credential should become a
 * login button wherever the platform offers one (v1 spec, onboarding
 * principle 2), and the copy should point at the clinic portal.
 *
 * The copy must stand on its own: if this email is unclear the clinic has no
 * second place to work out what it is being asked to do.
 *
 * ## Why it reuses the report transport
 *
 * Same reason invite.ts does: same SES account, same configuration set, same
 * `TlsPolicy: REQUIRE`. A second sending path with its own settings is how the
 * BAA's promise about encrypted transmission quietly stops being true. The
 * alternative considered — a small dedicated mailer for "operational" mail —
 * was rejected because "operational" is exactly the label under which someone
 * later sends something that is not.
 *
 * ## Why the link is in the body and never in the subject
 *
 * The subject line is the part of a message that gets replayed everywhere: lock
 * screens, notification centres, mail-gateway logs, ticketing systems that
 * ingest a mailbox. The token is a live credential for five minutes of work; it
 * belongs in the body, once, and nowhere else.
 *
 * ## No PHI, and not merely because the BAA is signed
 *
 * `to` is a business address and is very often a shared front-desk inbox. Even
 * with a BAA covering the transport, anything patient-level here is disclosed
 * to whoever else reads that inbox. So this email names a clinic and describes
 * an access grant, and that is all it will ever be allowed to name. See
 * docs/hipaa-compliance.md.
 *
 * ## Why it states "works once" and the expiry, in both renderings
 *
 * Not politeness — it changes what a failure means. A clinic that was told the
 * link works once reads a second click's "no longer valid" page as expected
 * behaviour and asks for another. A clinic that was not told reads the same
 * page as "healdesk is broken" and stops. The link is genuinely single-use (see
 * the connect-link store), so the copy has to match the mechanism.
 *
 * No CAN-SPAM footer, deliberately, and for the same reason invite.ts has none:
 * this is a transactional message inside an existing paid relationship, sent
 * because the customer bought the thing it sets up. The unsubscribe machinery
 * belongs to the outreach path, not here — offering to unsubscribe someone from
 * the one email that provisions their service would be nonsense.
 */

export type ConnectLinkEmail = {
  /** Business contact address. May be a shared inbox — hence no PHI, ever. */
  to: string;
  clinicId: string;
  clinicName: string;
  /**
   * The absolute, single-use URL.
   *
   * The only copy of this token that will ever exist outside the recipient's
   * mailbox — the database holds a SHA-256 of it and nothing else. Never log
   * it, never put it in audit metadata, never echo it into an error string.
   */
  url: string;
  expiresAt: Date;
};

export type ConnectLinkResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function renderConnectLink(email: ConnectLinkEmail): {
  subject: string;
  text: string;
  html: string;
} {
  const expiry = formatExpiry(email.expiresAt);
  const subject = `One-time link to connect ${email.clinicName} to healdesk`;

  const text = [
    `To report which appointments healdesk actually recovered for ${email.clinicName},`,
    `we need read-only access to your booking system. Otherwise the numbers we`,
    `send you are estimates.`,
    ``,
    `Open this link and follow the steps for your platform:`,
    email.url,
    ``,
    `It takes a few minutes. You will create a read-only user for us and paste`,
    `one credential — we never ask for your own login, and this access cannot`,
    `change anything in your system.`,
    ``,
    `The link works once and expires on ${expiry}.`,
    ``,
    `If it has already been used or has expired, contact us and we will send a`,
    `new one.`,
  ].join("\n");

  // Escaped even though a token is URL-safe by construction: the clinic name is
  // operator-entered, and an href that is escaped only when someone remembers
  // to is an href that will one day not be.
  const href = escapeHtml(email.url);

  const html = [
    `<p>To report which appointments healdesk actually recovered for `,
    `<strong>${escapeHtml(email.clinicName)}</strong>, we need read-only access to `,
    `your booking system. Otherwise the numbers we send you are estimates.</p>`,
    `<p><a href="${href}">Connect your booking system</a></p>`,
    `<p>It takes a few minutes. You will create a read-only user for us and paste `,
    `one credential — we never ask for your own login, and this access cannot `,
    `change anything in your system.</p>`,
    `<p><strong>The link works once and expires on ${escapeHtml(expiry)}.</strong></p>`,
    `<p>If it has already been used or has expired, contact us and we will send `,
    `a new one.</p>`,
  ].join("");

  return { subject, text, html };
}

/**
 * Send it.
 *
 * Returns rather than throws, and the reason matters more here than it does for
 * an invitation: by the time this runs the link has been minted and its token
 * exists in exactly one place — the value the caller is about to return to the
 * operator. Throwing would discard that value along with the stack, leaving a
 * live single-use credential in the database that nobody can ever present. So
 * delivery failure is reported, the caller still hands the operator the URL,
 * and the operator sends it themselves.
 *
 * Today that is every time: HEALDESK_EMAIL_TRANSPORT is unset, so getTransport()
 * returns the console stub in development and throws in production. Both are
 * honest. Neither pretends a message went out.
 */
export async function sendConnectLink(
  email: ConnectLinkEmail,
): Promise<ConnectLinkResult> {
  const message: OutgoingEmail = {
    ...renderConnectLink(email),
    /**
     * No PHI. It carries a clinic name, an expiry and a single-use URL — the
     * message that grants access to a booking system, before any appointment
     * has been read out of one. The token is a credential, which is why it is
     * redacted out of every reason string below; a credential is not patient
     * information, and no transport setting would make mailing one safer.
     */
    phiClass: "none",
  };

  const target: DeliveryTarget = {
    to: email.to,
    clinicId: email.clinicId,
    clinicName: email.clinicName,
  };

  try {
    const result = await getTransport(message.phiClass).send(target, message);
    if (result.status === "sent") {
      return { status: "sent", messageId: result.messageId };
    }
    if (result.status === "skipped") {
      return { status: "skipped", reason: redact(result.reason, email.url) };
    }
    return { status: "failed", reason: redact(result.reason, email.url) };
  } catch (error) {
    return {
      status: "failed",
      reason: redact(
        error instanceof Error ? error.message : "Unknown error",
        email.url,
      ),
    };
  }
}

/**
 * Strip the link out of anything on its way to a log line.
 *
 * A transport that echoes its request back in an error message is not
 * hypothetical, and the caller writes this string to the server log. One
 * `console.error` is all it takes to turn a single-use credential into a
 * permanently retained one.
 */
function redact(reason: string, url: string): string {
  return url ? reason.split(url).join("[connect link redacted]") : reason;
}

/**
 * UTC, spelled out.
 *
 * The clinic's own timezone is not knowable from here, and "expires at 6pm"
 * with no zone is the kind of ambiguity that produces a support email at 6:30.
 * Minute precision, because a link measured in days does not need seconds.
 */
function formatExpiry(at: Date): string {
  return `${at.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import { getTransport, type DeliveryTarget } from "@/lib/reporting/deliver";

/**
 * The one email the product must send before it sends any other.
 *
 * The checkout success screen told the buyer "we've sent a link to your email
 * to choose a password" and nothing anywhere sent it. Provisioning created the
 * organization, the clinic and the invitation, and then stopped — so every
 * purchase ended with a customer waiting for a message that did not exist, and
 * an account nobody could ever reach.
 *
 * ## Why this reuses the report transport
 *
 * Same SES account, same configuration set, same TLS enforcement. That last one
 * is the reason. The BAA now promises healdesk will not transmit patient
 * information over a channel that cannot negotiate encryption, and while an
 * invitation carries no PHI, a second sending path with its own weaker settings
 * is exactly how that promise quietly stops being true.
 *
 * ## Why the link is not a separate magic token
 *
 * The invitation id IS the credential. The accept page looks it up, and the
 * Better Auth create hook independently refuses any signup without a matching
 * pending invitation for that address — so possession of the link plus the
 * address is the check, and it expires in 14 days.
 */

export type InviteEmail = {
  to: string;
  clinicName: string;
  invitationId: string;
  /** Absolute, because it is going into a mail client. */
  consoleUrl: string;
};

export type InviteResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export function renderInvite(invite: InviteEmail): {
  subject: string;
  text: string;
  html: string;
} {
  const link = `${invite.consoleUrl.replace(/\/$/, "")}/accept-invite?id=${invite.invitationId}`;
  const subject = `Finish setting up ${invite.clinicName} on healdesk`;

  const text = [
    `${invite.clinicName} is set up on healdesk.`,
    ``,
    `Choose a password and finish setup here:`,
    link,
    ``,
    `This link is valid for 14 days and can only be used once.`,
    ``,
    `If you did not sign up for healdesk, ignore this email — no account can be`,
    `opened without it.`,
  ].join("\n");

  const html = [
    `<p><strong>${escapeHtml(invite.clinicName)}</strong> is set up on healdesk.</p>`,
    `<p><a href="${link}">Choose a password and finish setup</a></p>`,
    `<p>This link is valid for 14 days and can only be used once.</p>`,
    `<p>If you did not sign up for healdesk, ignore this email — no account can be opened without it.</p>`,
  ].join("\n");

  return { subject, text, html };
}

/**
 * Send it.
 *
 * Returns rather than throws on a delivery failure, because the account already
 * exists by the time this runs. Throwing would fail the Stripe webhook and
 * trigger a retry that re-provisions — trading a missing email for a duplicate
 * account, which is the worse outcome. The caller logs it and an operator can
 * resend.
 */
export async function sendInvite(invite: InviteEmail): Promise<InviteResult> {
  const rendered = renderInvite(invite);

  const target: DeliveryTarget = {
    to: invite.to,
    clinicId: "",
    clinicName: invite.clinicName,
  };

  try {
    const result = await getTransport().send(target, rendered as never);
    if (result.status === "sent") {
      return { status: "sent", messageId: result.messageId };
    }
    if (result.status === "skipped") {
      return { status: "skipped", reason: result.reason };
    }
    return { status: "failed", reason: result.reason };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

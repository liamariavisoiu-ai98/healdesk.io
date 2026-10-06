import { specialties } from "@healdesk/catalog";

import { clinicAiNotice } from "@/lib/compliance/disclosure";
import {
  getTransport,
  type DeliveryTarget,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";

/**
 * The email that carries a clinic's one-time setup link — the minimum-
 * information step of the design of 23 September 2026 (§H.2).
 *
 * It is the second and last thing a clinic is ever asked to open in a
 * browser, after (or before — they are independent) the connect link in
 * connect-link.ts, and it is modelled on that file for every reason given
 * there: same transport, link in the body and never the subject, no PHI,
 * "works once" and the expiry stated in both renderings, no CAN-SPAM footer
 * on a transactional message inside a paid relationship.
 *
 * ## What it asks, and what happens if nobody answers
 *
 * The practice confirms which of a closed catalogue of booking-request
 * fields the assistant may ask for. The catalogue admits nothing clinical
 * (packages/catalog/src/booking-requirements.ts), so the worst a practice
 * can do on the page is choose fewer fields. That is why the copy can
 * honestly say the defaults apply if the link expires unopened: the outcome
 * of silence is a sensible, minimal set, not a blocked account, and
 * lib/onboarding/requirements.ts stamps it (§H.5).
 *
 * ## No PHI, by construction
 *
 * A clinic name, its specialty as a word, an expiry, a single-use URL, and
 * the written AI notice, which names the clinic and leaves its number blank.
 * `to` is a business address that is very often a shared front-desk inbox.
 * The token is a credential and is redacted from every reason string.
 */

export type SetupLinkEmail = {
  /** Business contact address. May be a shared inbox — hence no PHI, ever. */
  to: string;
  clinicId: string;
  clinicName: string;
  /** Catalogue specialty id; rendered as its display name. */
  specialty: string;
  /** The absolute, single-use URL. Never logged, never in audit metadata. */
  url: string;
  expiresAt: Date;
};

export type SetupLinkResult =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** "med-spa" → "Med spa", or the id when the catalogue does not know it. */
export function specialtyNameFor(id: string): string {
  return specialties.find((s) => s.id === id)?.name ?? id;
}

/**
 * Around the written AI notice (lib/compliance/disclosure.ts). The notice is
 * the clinic's, for its own website and intake form, and whether it meets a
 * state's law is the clinic's to judge (terms § 8, "Your own notices"): the
 * copy offers it, says what to fill in, and warrants nothing.
 */
const NOTICE_INTRO =
  `Separately, for your website and intake form: some states expect a practice that uses an AI assistant to say so in writing. ` +
  `Here is a plain-language notice you can use. Replace [your direct line] with a number that reaches a person at the practice and is not forwarded to the assistant.`;
const NOTICE_CAVEAT =
  `We offer this wording as a convenience, not a warranty that it meets any state's requirements. ` +
  `Any disclosure your state requires you to make to patients remains yours to make.`;

/**
 * §H.2, verbatim: subject and body. Then, below the link and set apart from
 * it, the written AI notice (docs/counsel/state-disclosure.md, decision 8).
 * Until the portal or the wizard exists this is the one email every clinic
 * is sure to get, so the notice travels in it.
 */
export function renderSetupLink(email: SetupLinkEmail): {
  subject: string;
  text: string;
  html: string;
} {
  const expiry = formatExpiry(email.expiresAt);
  const specialty = specialtyNameFor(email.specialty);
  const subject = `One thing to set up for ${email.clinicName}`;
  const notice = clinicAiNotice({ clinicName: email.clinicName });

  const body =
    `Before your assistant takes its first call, tell us what it should ask for when someone wants to book — and nothing more. ` +
    `We've chosen a sensible set for a ${specialty} practice; open this link once to confirm or adjust it. ` +
    `Nothing clinical can be selected. It takes two minutes, works once, and expires on ${expiry}; ` +
    `if nobody opens it by then, the set we chose applies and you can change it at any time by telling us.`;

  const text = [body, ``, email.url, ``, NOTICE_INTRO, ``, notice, ``, NOTICE_CAVEAT].join("\n");

  const href = escapeHtml(email.url);
  const html = [
    `<p>Before your assistant takes its first call, tell us what it should ask for when someone wants to book — and nothing more. `,
    `We've chosen a sensible set for a ${escapeHtml(specialty)} practice; open this link once to confirm or adjust it. `,
    `Nothing clinical can be selected. It takes two minutes, works once, and expires on ${escapeHtml(expiry)}; `,
    `if nobody opens it by then, the set we chose applies and you can change it at any time by telling us.</p>`,
    `<p><a href="${href}">Confirm what the assistant asks for</a></p>`,
    `<p>${escapeHtml(NOTICE_INTRO)}</p>`,
    `<blockquote>${escapeHtml(notice)}</blockquote>`,
    `<p>${escapeHtml(NOTICE_CAVEAT)}</p>`,
  ].join("");

  return { subject, text, html };
}

/**
 * Send it. Returns rather than throws, for the reason connect-link.ts gives:
 * the link is already minted, and the caller (provisioning, or the ops op)
 * must go on to record or display it whatever the mailer did.
 */
export async function sendSetupLink(email: SetupLinkEmail): Promise<SetupLinkResult> {
  const message: OutgoingEmail = {
    ...renderSetupLink(email),
    /** No PHI: a clinic name, a specialty, an expiry, a single-use URL and the clinic's own AI notice. */
    phiClass: "none",
  };

  const target: DeliveryTarget = {
    to: email.to,
    clinicId: email.clinicId,
    clinicName: email.clinicName,
  };

  try {
    const result = await getTransport(message.phiClass).send(target, message);
    if (result.status === "sent") return { status: "sent", messageId: result.messageId };
    if (result.status === "skipped") return { status: "skipped", reason: redact(result.reason, email.url) };
    return { status: "failed", reason: redact(result.reason, email.url) };
  } catch (error) {
    return {
      status: "failed",
      reason: redact(error instanceof Error ? error.message : "Unknown error", email.url),
    };
  }
}

/** Strip the link out of anything on its way to a log line. */
function redact(reason: string, url: string): string {
  return url ? reason.split(url).join("[setup link redacted]") : reason;
}

/** UTC, spelled out, minute precision — as connect-link.ts. */
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

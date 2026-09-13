import {
  getTransport,
  type DeliveryTarget,
  type EmailTransport,
  type OutgoingEmail,
} from "@/lib/reporting/deliver";
import { log } from "@/lib/log";

/**
 * The counterparty's copy of the business associate agreement.
 *
 * Until this existed, healdesk held the only copy of a contract with two
 * parties to it. The clinic signed on a web page, was shown the text once, and
 * left with nothing — no email, no attachment, no download. That is a bad
 * position to be in and a worse one to explain: a covered entity is required to
 * retain its business associate contracts (45 CFR 164.530(j)), and it cannot
 * retain a document it was never given. "Ask us and we'll dig it out" is not a
 * plan for a relationship that has since gone wrong.
 *
 * So the signer is mailed a PDF at signature. A file, not a link to one. A link
 * needs an endpoint, the endpoint needs an authorisation model, and the only
 * thing a pre-payment signer holds is the address they just typed — that road
 * ends at a bearer token in an email, which is a worse artefact to have created
 * than the document is to have sent. A file in a mailbox is the thing the other
 * party can actually produce years later.
 *
 * ## Why it reuses the report transport
 *
 * Same reason invite.ts and connect-link.ts do: one SES account, one
 * configuration set, one `TlsPolicy: REQUIRE`. It matters most on this message
 * of all of them. The attached document contains healdesk's own promise not to
 * transmit over a channel that cannot negotiate encryption — mailing THAT over
 * opportunistic TLS would refute itself in the act of delivery.
 *
 * ## Why the PDF arrives as bytes
 *
 * Rendering is a separate concern with a separate failure mode. Taking the
 * buffer in means the renderer can be tested without a mailbox and this can be
 * tested without a renderer, and — the load-bearing part — the caller hashes
 * the exact bytes it hands over, so `copy_document_sha256` is a claim about
 * what was sent rather than about what a renderer said it produced.
 *
 * ## No PHI, and no credential
 *
 * This goes to whatever address the signer typed into a form, and that address
 * is not verified — nor will it be before this is sent, because a copy that
 * waits for a verification round-trip is a copy that mostly never arrives. So
 * the body is fixed copy plus four facts: the practice's name, who signed, the
 * template version and when, and the document hash. Nothing patient-level can
 * reach it, and nothing in it grants access to anything.
 *
 * The acceptance id is deliberately NOT in the email. It is the lookup key
 * getAgreement() takes, and a database key mailed to an unverified address is
 * where entitlement bugs come from. The document hash serves the same purpose
 * for a human — it names one specific document without opening anything.
 *
 * If it does reach the wrong address, what leaks is a business contract naming
 * a practice and a signatory: no patient data, so not a breach under the rule.
 * It is still wrong, so the email says plainly what to do about it.
 *
 * No CAN-SPAM footer, for the reason connect-link.ts sets out: this is a
 * transactional message sent once because the recipient signed a contract and
 * is entitled to a copy. There is nothing here to unsubscribe from.
 */

/**
 * What has to be true to write the email and attach the file.
 *
 * A subset of the value lib/agreements.ts assembles from the acceptance row, in
 * its field names — that module is the single place that knows how the row maps
 * onto this, and it passes a variable rather than a literal precisely so this
 * can ask for less than it is given.
 */
export type AgreementCopyRequest = {
  /** The signer's frozen address. Unverified: they typed it. */
  to: string;
  /** Frozen at acceptance. */
  signatoryName: string;
  /** The practice the agreement names. */
  clinicName: string;
  /** Template version, e.g. "0.0.0-draft". */
  version: string;
  /** SHA-256 of the rendered agreement TEXT, hex. Not of the PDF. */
  documentHash: string;
  acceptedAt: Date;
  /** The rendered agreement. Bytes, not a promise and not a path. */
  pdf: Uint8Array;
  /** Optional; sanitised again by the transport before it reaches a header. */
  filename?: string;
};

/** Injected in tests. Defaults to the configured transport. */
export type AgreementCopyContext = {
  transport?: EmailTransport;
};

/**
 * `sent` is the question every caller actually has; `status` keeps the
 * distinction between "the transport declined" and "the transport broke",
 * because those need different things done about them — a skip is a
 * misconfigured environment and a failure is usually the address.
 *
 * `reason` is present exactly when `sent` is false, so a caller cannot log an
 * undefined explanation for a copy that did not arrive.
 */
export type AgreementCopyResult =
  | { sent: true; status: "sent"; reason?: undefined }
  | { sent: false; status: "skipped" | "failed"; reason: string };

const CONTACT = "hello@healdesk.io";

export function renderAgreementCopy(copy: {
  signatoryName: string;
  clinicName: string;
  version: string;
  documentHash: string;
  acceptedAt: Date;
}): { subject: string; text: string; html: string } {
  const when = formatSignedAt(copy.acceptedAt);
  const subject = `Your signed business associate agreement for ${copy.clinicName}`;

  const text = [
    `Attached, as a PDF, is the business associate agreement you signed for`,
    `${copy.clinicName}. It is the document we recorded at signature, word for`,
    `word — the same text that was on your screen.`,
    ``,
    `Signed by ${copy.signatoryName} on ${when}.`,
    `Agreement version ${copy.version}.`,
    ``,
    `Please keep it. This is a contract with two parties to it, and healdesk`,
    `should not be the only one holding a copy — if your practice is ever asked`,
    `to produce its business associate agreements, this is the file.`,
    ``,
    `Our reference for it is the SHA-256 of the agreement text:`,
    copy.documentHash,
    ``,
    `If you need another copy, or this reached the wrong address, email`,
    `${CONTACT} and a person will deal with it.`,
    ``,
    `If you did not sign anything, someone has typed this address by mistake.`,
    `You can ignore this email; if you would rather tell us, ${CONTACT}`,
    `reaches a person.`,
  ].join("\n");

  const html = [
    `<p>Attached, as a PDF, is the business associate agreement you signed for `,
    `<strong>${escapeHtml(copy.clinicName)}</strong>. It is the document we recorded `,
    `at signature, word for word — the same text that was on your screen.</p>`,
    `<p>Signed by ${escapeHtml(copy.signatoryName)} on ${escapeHtml(when)}.<br>`,
    `Agreement version ${escapeHtml(copy.version)}.</p>`,
    `<p><strong>Please keep it.</strong> This is a contract with two parties to it, `,
    `and healdesk should not be the only one holding a copy — if your practice is `,
    `ever asked to produce its business associate agreements, this is the file.</p>`,
    `<p>Our reference for it is the SHA-256 of the agreement text:<br>`,
    `<code style="word-break:break-all">${escapeHtml(copy.documentHash)}</code></p>`,
    `<p>If you need another copy, or this reached the wrong address, email `,
    `<a href="mailto:${CONTACT}">${CONTACT}</a> and a person will deal with it.</p>`,
    `<p>If you did not sign anything, someone has typed this address by mistake. `,
    `You can ignore this email; if you would rather tell us, `,
    `<a href="mailto:${CONTACT}">${CONTACT}</a> reaches a person.</p>`,
  ].join("");

  return { subject, text, html };
}

/**
 * Send it.
 *
 * **Never throws**, and the reason is stronger here than it is for an
 * invitation. By the time this runs the agreement is signed and the row is in
 * an append-only table — there is no undo. Throwing would fail the signing
 * request and invite a retry that signs the same document again, producing two
 * acceptance rows for one act of assent, which is a mess in precisely the
 * record we most need to be able to testify about.
 *
 * It is not swallowed either. A signature that succeeded while its copy quietly
 * failed is a real and invisible state: the clinic believes it holds the
 * document and does not, and nobody discovers that until the day someone asks
 * for it. So the reason comes back for the caller to record — and is logged
 * here as well, so that "not swallowed" is a property of this function rather
 * than a hope about its callers.
 */
export async function sendAgreementCopy(
  acceptance: AgreementCopyRequest,
  ctx: AgreementCopyContext = {},
): Promise<AgreementCopyResult> {
  const to = acceptance.to.trim();

  // Refused before the transport, not after. An empty buffer would produce a
  // message announcing an attached agreement with nothing attached — worse than
  // sending nothing, because the recipient is left believing they hold a copy,
  // which is the exact failure this whole feature exists to end.
  if (acceptance.pdf.byteLength === 0) {
    return failed(acceptance, "The rendered agreement was empty; no copy was sent.");
  }
  if (!to) {
    return failed(acceptance, "The acceptance has no signatory address.");
  }
  // "Signed by Dr Lovelace on NaN undefined NaN" is not a sentence to put in
  // front of a counterparty, and the date is one of the four facts this email
  // exists to state. An honest absence is not an option here either — the email
  // has no purpose without it — so the copy waits for an operator instead.
  if (Number.isNaN(acceptance.acceptedAt.getTime())) {
    return failed(acceptance, "The acceptance has no usable signature date.");
  }

  const message: OutgoingEmail = {
    ...renderAgreementCopy(acceptance),
    /**
     * No PHI, so this may go over a transport with no BAA behind it.
     *
     * The body is fixed copy plus four facts — the practice's name, who signed,
     * the template version and when, and the document hash — and the attachment
     * is the agreement itself: a contract between healdesk and the clinic, not
     * anything about a patient. The clinic is the counterparty here, not a
     * subject of the data.
     *
     * This is the message where the class most needs stating out loud, because
     * it is the one carrying a file: the attachment is the one part of an email
     * no PHI guard can read inside. Anything that ever changes what is attached
     * has to revisit this line.
     */
    phiClass: "none",
    attachments: [
      {
        filename: acceptance.filename ?? defaultFilename(acceptance),
        contentType: "application/pdf",
        content: acceptance.pdf,
      },
    ],
  };

  const target: DeliveryTarget = {
    to,
    // No clinic exists yet: the agreement is signed before payment, so this is
    // the identity plane and there is nothing with a clinic id. The transport
    // uses these for its own logging only.
    clinicId: "",
    clinicName: acceptance.clinicName,
  };

  try {
    const result = await (
      ctx.transport ?? getTransport(message.phiClass)
    ).send(target, message);
    if (result.status === "sent") return { sent: true, status: "sent" };
    if (result.status === "skipped") {
      return outcome(acceptance, "skipped", result.reason);
    }
    return failed(acceptance, result.reason);
  } catch (error) {
    return failed(
      acceptance,
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

function failed(
  acceptance: AgreementCopyRequest,
  reason: string,
): AgreementCopyResult {
  return outcome(acceptance, "failed", reason);
}

/**
 * One place where a failure becomes both a log line and a return value.
 *
 * The signer's address is stripped out of the reason on the way through. A
 * transport that echoes its request back inside an error message is not
 * hypothetical — "550 5.1.1 <owner@clinic.com>: user unknown" is the ordinary
 * shape of a bounce — and this string is written to the server log and handed
 * to a caller that writes it to an audit table. Neither needs a second copy of
 * the one personal datum in the message; the acceptance row already holds it.
 *
 * The log line names the document hash rather than the acceptance id, for the
 * same reason the email does: it identifies the row for an operator without
 * being the key that opens it.
 */
function outcome(
  acceptance: AgreementCopyRequest,
  status: "skipped" | "failed",
  reason: string,
): AgreementCopyResult {
  const safe = redactAddress(reason, acceptance.to);
  // The clinic's legal name is business data, not PHI, but it is still not
  // an identifier the log needs: the document hash finds the row.
  log.error("agreement copy not delivered", {
    status,
    hint: `document ${acceptance.documentHash}`,
    reason: safe,
  });
  return { sent: false, status, reason: safe };
}

/**
 * The address out of a transport's error message — by name, and then by shape.
 *
 * The exact match is the one that reads well in a log ("[signatory address]"
 * says whose it was). It is not sufficient on its own, and the reason is the
 * whole point of doing this at all: a bounce is written by the RECEIVING
 * server, which quotes the address back in whatever form it liked. The stored
 * one is lowercased and trimmed at signature, so "550 5.1.1
 * <OWNER@CLINIC.TEST>: user unknown" — an ordinary shape for a bounce — walks
 * straight past a case-sensitive substring match and into `console.error`.
 *
 * Application logs have none of the protections the acceptance row has: no
 * grants, no BAA on whoever aggregates them. So anything else email-shaped goes
 * too, which is also what catches an address that is not the signer's at all
 * (a forwarding host, an admin contact named in a diagnostic). The scrubber in
 * lib/agreements.ts does the same to what reaches the audit table; this is the
 * half that guards the log line, and neither should rely on the other.
 */
function redactAddress(reason: string, address: string): string {
  const trimmed = address.trim();
  const named = trimmed
    ? reason.split(trimmed).join("[signatory address]")
    : reason;
  return named.replace(EMAIL_SHAPED, "[address]");
}

/** Deliberately greedier than `isEmail`: this one is looking, not validating. */
const EMAIL_SHAPED = /[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}/g;

function defaultFilename(acceptance: AgreementCopyRequest): string {
  const at = acceptance.acceptedAt;
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return `healdesk-business-associate-agreement-${acceptance.version}-${day}.pdf`;
}

/**
 * UTC, spelled out, for the reason connect-link.ts spells out an expiry: the
 * signer's own timezone is not knowable from here, and this date is a fact
 * about a contract. In words rather than digits so it cannot be read as the
 * other way round, and assembled from UTC parts rather than toLocale* so the
 * string does not depend on which ICU data the container happens to ship.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function formatSignedAt(at: Date): string {
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ` +
    `at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

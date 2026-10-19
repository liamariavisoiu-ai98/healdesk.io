import { agreementCopyFilename, isSafeTypedText, renderAgreementCopy } from "@healdesk/catalog";

import type { EmailTransport } from "@/lib/reporting/deliver";
import { log } from "@/lib/log";

import { isAllowedClinicName } from "./lint";
import { sendEmail } from "./send";
import { renderAgreementCopyEmail, type AgreementCopyPayload } from "./templates/agreement_copy";

// The words and the file name are the catalog's since 14 October 2026, so that
// apps/web, which mails the copy at signature, and this module, which mails it
// again on an operator's resend, cannot word one document two ways.
export { renderAgreementCopy };

/**
 * The counterparty's copy of the business associate agreement, or of the
 * Data Protection Agreement a practice HIPAA does not reach signs instead
 * (plan Part L). The email is worded by the kind the stored version carries
 * (`agreementKindOfVersion`; plan Annex X, P6): the subject, the opening line
 * and the reason to keep the file name the document that is attached. A
 * BAA's wording is what it always was.
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
 * ## Through the email platform, since 19 October 2026
 *
 * It used to call a transport itself (getTransport), so an operator's resend
 * went with no tags, no idempotency key and no link scan, and Resend's events
 * for it, untagged, were handled by apps/web as its own marketing mail: a
 * bounce marked a lead. It goes through sendEmail now, like every other email
 * apps/app sends (Annex X3), as the direct kind `agreement_copy`: the `app`,
 * `kind` and `delivery` tags (the acceptance's id), a key per acceptance and
 * minute, so an operator's double click sends once and a resend a minute
 * later sends again, the link scanner, and the payload allowlist at send
 * time. Resend's enforced TLS covers it as it covers all of healdesk.io's
 * mail (Annex X2).
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
 * No opt-out, for the reason connect-link.ts sets out: this is a
 * transactional message sent because the recipient signed a contract and is
 * entitled to a copy. There is nothing here to unsubscribe from. It carries
 * the footer every email does (X1.9), which the catalog's renderer writes.
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
  /** The acceptance's id: the `delivery` tag and the idempotency key, never in the email. */
  agreementId: string;
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

/** Injected in tests. Defaults to the transport the environment names (sendEmail). */
export type AgreementCopyContext = {
  transport?: EmailTransport;
  now?: Date;
};

/**
 * What the allowlist will let the email print, from the frozen acceptance: a
 * name it would refuse (a legal name past 120 characters, a signer's name with
 * a link or a number in it) is left out, so the copy still goes, saying "your
 * practice" or "Signed on …". The PDF attached is the document itself.
 */
export function agreementCopyPayload(acceptance: AgreementCopyRequest): AgreementCopyPayload {
  const clinicName = acceptance.clinicName.trim();
  const signatoryName = acceptance.signatoryName.trim();
  return {
    clinicName: isAllowedClinicName(clinicName) ? clinicName : null,
    signatoryName: isSafeTypedText(signatoryName, 120) ? signatoryName : null,
    documentVersion: acceptance.version,
    documentHash: acceptance.documentHash,
    acceptedAt: acceptance.acceptedAt.toISOString(),
  };
}

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

  // One key per acceptance and minute (X1.4): a double click inside Resend's
  // window sends once, a deliberate resend a minute later sends again. The
  // body renders only from the frozen row, so a retry repeats it exactly.
  const minute = Math.floor((ctx.now ?? new Date()).getTime() / 60_000);

  try {
    const payload = agreementCopyPayload(acceptance);
    // The catalog's words, footer and all: the context is not read.
    const rendered = renderAgreementCopyEmail(payload, {
      clinicName: payload.clinicName,
      audience: "patients",
      reason: "",
      raisedAt: acceptance.acceptedAt,
      timeZone: "UTC",
    });
    const result = await sendEmail(
      {
        to,
        kind: "agreement_copy",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        /**
         * No PHI, so this may go over a transport with no BAA behind it.
         *
         * The body is fixed copy plus four facts — the practice's name, who
         * signed, the template version and when, and the document hash — and
         * the attachment is the agreement itself: a contract between healdesk
         * and the clinic, not anything about a patient. The clinic is the
         * counterparty here, not a subject of the data.
         *
         * This is the message where the class most needs stating out loud,
         * because it is the one carrying a file: the attachment is the one part
         * of an email no PHI guard can read inside. Anything that ever changes
         * what is attached has to revisit this line.
         */
        phiClass: "none",
        payload,
        clinicName: payload.clinicName,
        // No clinic exists before payment: no clinic tag, the acceptance's id
        // as the delivery tag.
        deliveryId: acceptance.agreementId,
        idempotencyKey: `hd-agreement_copy-${acceptance.agreementId}-1-${minute}`,
        attachments: [
          {
            filename: acceptance.filename ?? agreementCopyFilename(acceptance),
            contentType: "application/pdf",
            content: acceptance.pdf,
          },
        ],
      },
      { transport: ctx.transport, now: ctx.now },
    );
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

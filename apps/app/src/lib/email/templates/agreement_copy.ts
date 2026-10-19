import { renderAgreementCopy } from "@healdesk/catalog";

import type { TemplateEntry } from "./registry";
import type { EmailTemplate } from "./types";

/**
 * P6, the signer's copy of the agreement, as apps/app sends it: again, on an
 * operator's resend from the console, and at signature for its own demo
 * clinic (lib/agreements.ts deliverSignedCopy; apps/web mails the copy at
 * every other signature).
 *
 * The words are the catalog's renderAgreementCopy, the one rendering both
 * apps use, so the two cannot word one document two ways; that renderer
 * writes its own footer (Annex X1.9), which is why the context is not read.
 * The payload is what the allowlist checks at send time (lib/email/send.ts):
 * the practice's name, who signed (a person's name of safe characters only),
 * the template version, the document's SHA-256 and when it was signed.
 * Neither name is required: one the allowlist would refuse is left out by the
 * sender (lib/email/agreement-copy.ts), and the email says "your practice" or
 * "Signed on …" instead. The attached PDF carries the document itself.
 */

export type AgreementCopyPayload = {
  /** The practice's legal name, or null for one the allowlist would refuse. */
  clinicName: string | null;
  /** Who signed, or null for a name the allowlist would refuse. */
  signatoryName: string | null;
  /** The template version: "1.6.0", or a DPA's "dpa/1.0.0". */
  documentVersion: string;
  /** SHA-256 of the agreement's text, hex: the email's one reference for the document. */
  documentHash: string;
  /** When it was signed, ISO 8601. */
  acceptedAt: string;
};

export const renderAgreementCopyEmail: EmailTemplate<AgreementCopyPayload> = (payload) => {
  const words = renderAgreementCopy({
    signatoryName: payload.signatoryName,
    clinicName: payload.clinicName ?? "your practice",
    version: payload.documentVersion,
    documentHash: payload.documentHash,
    acceptedAt: new Date(payload.acceptedAt),
  });
  return { ...words, preheader: "The agreement you signed, attached as a PDF, to keep." };
};

export const AGREEMENT_COPY_FIXTURE: AgreementCopyPayload = {
  clinicName: "Radiance Med Spa LLC",
  signatoryName: "Alex Chen",
  documentVersion: "1.6.0",
  documentHash: "9f2c4e1a7b3d5f6081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708",
  acceptedAt: "2026-10-06T14:32:00.000Z",
};

export const AGREEMENT_COPY_ENTRY: TemplateEntry<AgreementCopyPayload> = {
  render: renderAgreementCopyEmail,
  fixture: AGREEMENT_COPY_FIXTURE,
};

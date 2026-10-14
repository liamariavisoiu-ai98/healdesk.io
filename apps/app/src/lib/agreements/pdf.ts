import type { AgreementPdfRecord } from "@healdesk/catalog/agreement-pdf";

import type { baaAcceptances } from "@/db/schema";

/**
 * The agreement PDF, rendered by the catalog since 14 October 2026
 * (packages/catalog/src/agreement-pdf.ts, whose header explains the file):
 * apps/web renders the copy it mails at signature and the buyer's download
 * from the same code this app uses for an operator's resend and the portal's
 * download, so the two sides produce one file and `copy_document_sha256` means
 * the same thing whichever wrote it.
 */
export { renderAgreementPdf, type AgreementPdf } from "@healdesk/catalog/agreement-pdf";

/**
 * What the renderer needs from an acceptance, derived from the table rather
 * than re-declared, so renaming a column breaks this file at compile time
 * instead of quietly rendering a blank field. A full `baaAcceptances` row
 * satisfies it, which is what every caller here has.
 */
export type BaaAcceptanceRecord = Pick<
  typeof baaAcceptances.$inferSelect,
  | "documentVersion"
  | "documentHash"
  | "renderedText"
  | "assentLabel"
  | "acceptedByName"
  | "acceptedByEmail"
  | "acceptedByTitle"
  | "ipAddress"
  | "userAgent"
  | "acceptedAt"
>;

/** Fails to compile the day a column stops being what the renderer reads. */
type Assignable<T extends AgreementPdfRecord> = T;
export type BaaAcceptanceRecordIsRenderable = Assignable<BaaAcceptanceRecord>;

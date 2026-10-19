import {
  AGREEMENT_COPY,
  agreementPlatformFor,
  applicableClauses,
  buildBaaSelections,
  currentBaaTemplate,
  getBaaTemplate,
  renderBaa,
  type BaaExplainerTerm,
  type BaaVariables,
  type BookingSystemId,
  type CalendarAccount,
  type SpecialtyId,
} from "@healdesk/catalog";

/**
 * The re-sign screen's document (lib/agreements/resign.ts), rendered in the
 * browser exactly as the server renders it to hash it: through the catalog's
 * one builder, as the funnel's agreement step does (apps/web's
 * agreement-kinds.ts, renderBaaPreview), from the practice's own answers and
 * the signature being typed. Pure, with no database and no clock, so the
 * client component and a test can both call it, and the test can hold it
 * against prepareSigning byte for byte.
 */

/**
 * What the re-sign screen renders the BAA from: the practice's own answers,
 * validated when it signed the agreement in force (the DPA, or an older
 * BAA), and nothing the browser chose.
 * The signatory's name and title are the screen's to type; the address is
 * the clinic's one address, which is its notice address.
 */
export type ResignDocument = {
  clinicLegalName: string;
  specialty: SpecialtyId;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  /**
   * As the agreement records the answer: true for "Yes", null for "Not
   * sure". From a DPA it is never false, since "No" is what the DPA covers;
   * from an older BAA it is the clinic's record, "No" included.
   */
  isCoveredEntity: boolean | null;
  signatoryEmail: string;
  /** Who signed the DPA, to start the fields from; the screen may change them. */
  signatoryName: string;
  signatoryTitle: string;
  templateVersion: string;
};

export type ResignClauseNote = BaaExplainerTerm & { id: string; heading: string };

/** The document a signature would sign today, with the notes beside its clauses. */
export function renderResignPreview(
  document: ResignDocument,
  signature: { signatoryName: string; signatoryTitle: string },
  effectiveDate: string,
): { text: string; notes: ResignClauseNote[] } {
  const template = getBaaTemplate(document.templateVersion) ?? currentBaaTemplate();
  const variables: BaaVariables = {
    ...buildBaaSelections({
      specialtyId: document.specialty,
      attributionMode: "estimated",
      bookingSystem: document.bookingSystem,
      platformId: agreementPlatformFor(document.bookingSystem),
      isCoveredEntity: document.isCoveredEntity,
      calendarAccount: document.calendarAccount,
      template,
    }),
    clinicLegalName: document.clinicLegalName.trim(),
    signatoryName: signature.signatoryName.trim() || "[your name]",
    signatoryTitle: signature.signatoryTitle.trim() || undefined,
    signatoryEmail: document.signatoryEmail.trim().toLowerCase(),
    effectiveDate,
  };
  const text = renderBaa(template, variables);
  const notes = applicableClauses(template, variables).flatMap((clause) => {
    const note = AGREEMENT_COPY.baa.clauseNote(template.version, clause.id);
    return note ? [{ id: clause.id, heading: clause.heading, ...note }] : [];
  });
  return { text, notes };
}

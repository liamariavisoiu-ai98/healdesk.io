import {
  AGREEMENT_COPY as CATALOG_COPY,
  agreementPlatformFor,
  type AgreementKind,
  applicableClauses,
  type BaaExplainerTerm,
  type BaaTemplate,
  type BaaVariables,
  type BookingSystemId,
  buildBaaSelections,
  type CalendarAccount,
  currentBaaTemplate,
  renderBaa,
  type SpecialtyId,
} from "@healdesk/catalog";

/**
 * The agreement the buyer signs, by kind: its name, its explainer, its
 * assent wording and its document, looked up by what `agreementKindFor`
 * decided and never chosen by the step itself (plan Part L).
 *
 * Only the Business Associate Agreement is here. The Data Protection
 * Agreement, for a practice HIPAA does not reach, plugs in as `dpa` with its
 * own explainer, assent label and renderer once it is released; until then
 * `agreementKindFor` never answers "dpa", and a step that somehow asked for
 * it would find no entry and sign nothing. The BAA's explainer is the BAA's
 * alone: it never appears beside the other document.
 *
 * ## One template, one version, everything said about it
 *
 * A kind's entry is built from the template it renders, and everything the
 * step shows is read off that one template: the version the request signs,
 * the document, the notes beside its clauses and the bullets of "Why you're
 * signing this". The bullets come through the catalogue's
 * `AGREEMENT_COPY[kind].explainer(version)` (`baaExplainerFor`), as the notes
 * come through `clauseNote(version, id)`, because 1.3.0 words two of them
 * differently from 1.2.1: a 1.3.0 buyer must not read "use it only" and
 * "materially breach" above a clause that says more (agreement-changes.md
 * §12.14, release gate 11). While 1.2.1 is current the entry is exactly what
 * it was, BAA_EXPLAINER and all.
 */

export type AgreementExplainer = {
  heading: string;
  lead: string;
  objection: string;
  terms: readonly BaaExplainerTerm[];
  disclaimer: string;
};

/** What the document is rendered from: the buyer's answers and the signatory. */
export type AgreementDocumentInput = {
  clinicLegalName: string;
  specialty: SpecialtyId;
  /** true, false, or null for "not sure", as `agreementKindFor` reports it. */
  isCoveredEntity: boolean | null;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  signatoryName: string;
  signatoryTitle?: string;
  /** Lower-cased, as the server lower-cases it before rendering its own copy. */
  signatoryEmail: string;
  /** The UTC date, as the server sets it. */
  effectiveDate: string;
};

export type ClauseNote = BaaExplainerTerm & { id: string; heading: string };

export type AgreementCopy = {
  kind: AgreementKind;
  /** The document's own name. */
  title: string;
  /** "Why you're signing this", for `version`: its bullets are that version's. */
  explainer: AgreementExplainer;
  /** The fixed half of the assent sentence, sent with the signature as proof this screen showed it. */
  assentLabel: string;
  assentSentence: (clinicLegalName: string) => string;
  actionLabel: string;
  /** The version the step renders and the signature request names. */
  version: string;
  /** Released by the owner; a draft is flagged on screen and provisions synthetic accounts only. */
  released: boolean;
  /**
   * The document, rendered exactly as the server renders it to hash it, with
   * a note for each clause that describes the service rather than the law.
   * Throws (BaaRenderError) on answers no document can be written from.
   */
  render: (input: AgreementDocumentInput) => { text: string; notes: ClauseNote[] };
  /** The start of the file name the buyer's copy downloads under. */
  fileStem: string;
};

/**
 * The Business Associate Agreement's entry for one template: the current one
 * in the funnel, and any other only in a test that shows the step a version
 * it does not offer yet.
 */
export function baaAgreementCopy(template: BaaTemplate): AgreementCopy {
  const catalog = CATALOG_COPY.baa;
  return {
    kind: "baa",
    title: catalog.title,
    explainer: catalog.explainer(template.version),
    assentLabel: catalog.assentLabel,
    assentSentence: catalog.assentSentence,
    actionLabel: catalog.actionLabel,
    version: template.version,
    released: template.approvedByCounsel,
    render: (input) => renderBaaPreview(template, input),
    fileStem: "healdesk-baa",
  };
}

/** The document as the server will render it to hash it, and the notes beside its clauses. */
function renderBaaPreview(
  template: BaaTemplate,
  input: AgreementDocumentInput,
): { text: string; notes: ClauseNote[] } {
  // Through the catalog's one builder, with the platform the signature
  // request sends, so the preview and the server's copy are built from the
  // same selections for this template.
  const selections = buildBaaSelections({
    specialtyId: input.specialty,
    attributionMode: "estimated",
    bookingSystem: input.bookingSystem,
    platformId: agreementPlatformFor(input.bookingSystem),
    isCoveredEntity: input.isCoveredEntity,
    calendarAccount: input.calendarAccount,
    template,
  });
  const variables: BaaVariables = {
    ...selections,
    clinicLegalName: input.clinicLegalName,
    signatoryName: input.signatoryName,
    signatoryTitle: input.signatoryTitle || undefined,
    signatoryEmail: input.signatoryEmail,
    effectiveDate: input.effectiveDate,
  };
  const text = renderBaa(template, variables);
  const notes = applicableClauses(template, variables).flatMap((clause) => {
    const note = CATALOG_COPY.baa.clauseNote(template.version, clause.id);
    return note ? [{ id: clause.id, heading: clause.heading, ...note }] : [];
  });
  return { text, notes };
}

export const AGREEMENT_COPY: { readonly baa: AgreementCopy; readonly dpa?: AgreementCopy } = {
  baa: baaAgreementCopy(currentBaaTemplate()),
};

export function agreementCopyFor(kind: AgreementKind): AgreementCopy | null {
  return AGREEMENT_COPY[kind] ?? null;
}

/** Today in UTC, as the server dates the document. */
export function effectiveDateToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

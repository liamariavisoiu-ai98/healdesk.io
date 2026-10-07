import {
  agreementPlatformFor,
  type AgreementKind,
  applicableClauses,
  assentSentence,
  BAA_ACTION_LABEL,
  BAA_ASSENT_LABEL,
  BAA_EXPLAINER,
  type BaaExplainerTerm,
  type BaaVariables,
  type BookingSystemId,
  buildBaaSelections,
  type CalendarAccount,
  clauseExplainer,
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
  explainer: AgreementExplainer;
  /** The fixed half of the assent sentence, sent with the signature as proof this screen showed it. */
  assentLabel: string;
  assentSentence: (clinicLegalName: string) => string;
  actionLabel: string;
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

const baa: AgreementCopy = {
  kind: "baa",
  title: "Business Associate Agreement",
  explainer: BAA_EXPLAINER,
  assentLabel: BAA_ASSENT_LABEL,
  assentSentence,
  actionLabel: BAA_ACTION_LABEL,
  version: currentBaaTemplate().version,
  released: currentBaaTemplate().approvedByCounsel,
  render(input) {
    const template = currentBaaTemplate();
    // Through the catalog's one builder, with the platform the signature
    // request sends, so the preview and the server's copy are built from the
    // same selections for whichever template is current.
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
      const note = clauseExplainer(template.version, clause.id);
      return note ? [{ id: clause.id, heading: clause.heading, ...note }] : [];
    });
    return { text, notes };
  },
  fileStem: "healdesk-baa",
};

export const AGREEMENT_COPY: { readonly baa: AgreementCopy; readonly dpa?: AgreementCopy } = {
  baa,
};

export function agreementCopyFor(kind: AgreementKind): AgreementCopy | null {
  return AGREEMENT_COPY[kind] ?? null;
}

/** Today in UTC, as the server dates the document. */
export function effectiveDateToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

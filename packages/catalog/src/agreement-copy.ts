import type { AgreementKind } from "./agreement-kind";
import { assentSentence, BAA_ACTION_LABEL, BAA_ASSENT_LABEL, CURRENT_BAA_VERSION } from "./baa";
import { baaExplainerFor, clauseExplainer, type BaaExplainerTerm } from "./baa-explainer";
import { CURRENT_DPA_VERSION, DPA_ACTION_LABEL, DPA_ASSENT_LABEL, dpaAssentSentence } from "./dpa";
import { dpaClauseExplainer, dpaExplainerFor } from "./dpa-explainer";

/**
 * Everything the signing screen says about the agreement, by kind (plan Part
 * L, "Copy"), so a screen that renders the DPA cannot pick up a BAA string by
 * reaching for the constant it used before there were two kinds.
 * `agreementKindFor` decides the kind; this decides the words.
 *
 * BAA_EXPLAINER, the BAA's clause notes (which cite 45 CFR 164.504(e)) and the
 * BAA's assent label never appear beside a DPA: `AGREEMENT_COPY.dpa` holds
 * none of them, which agreement-copy.test.ts asserts.
 *
 * What the screen says about the document is read by the version it renders,
 * never off a constant: the explainer, whose bullets 1.3.0 words differently
 * from 1.2.1 (`baaExplainerFor`, agreement-changes.md §12.14, release gate
 * 11), as the clause notes are (`clauseExplainer`).
 */

/** "Why you're signing this": the shape BAA_EXPLAINER and DPA_EXPLAINER share. */
export type AgreementExplainer = {
  heading: string;
  lead: string;
  objection: string;
  terms: readonly BaaExplainerTerm[];
  disclaimer: string;
};

export type AgreementCopy = {
  kind: AgreementKind;
  /** The document's name, as the signing screen and the downloads title it. */
  title: string;
  /** The version a buyer signs today: the kind's template at [0]. */
  currentVersion: string;
  /** "Why you're signing this", for the version the screen renders. */
  explainer: (templateVersion: string) => AgreementExplainer;
  /** The plain-English note beside one clause of one version, or undefined. */
  clauseNote: (templateVersion: string, clauseId: string) => BaaExplainerTerm | undefined;
  /** The fixed half of the sentence beside the tick box, which the server checks the browser showed. */
  assentLabel: string;
  /** The whole sentence beside the tick box, as the server stores it. */
  assentSentence: (clinicLegalName: string) => string;
  /** The words on the button that signs. */
  actionLabel: string;
};

export const AGREEMENT_COPY: Readonly<Record<AgreementKind, AgreementCopy>> = {
  baa: {
    kind: "baa",
    title: "Business Associate Agreement",
    currentVersion: CURRENT_BAA_VERSION,
    explainer: baaExplainerFor,
    clauseNote: clauseExplainer,
    assentLabel: BAA_ASSENT_LABEL,
    assentSentence,
    actionLabel: BAA_ACTION_LABEL,
  },
  dpa: {
    kind: "dpa",
    title: "Data Protection Agreement",
    currentVersion: CURRENT_DPA_VERSION,
    explainer: dpaExplainerFor,
    clauseNote: dpaClauseExplainer,
    assentLabel: DPA_ASSENT_LABEL,
    assentSentence: dpaAssentSentence,
    actionLabel: DPA_ACTION_LABEL,
  },
};

import type { AgreementKind } from "./agreement-kind";
import { assentSentence, BAA_ACTION_LABEL, BAA_ASSENT_LABEL, CURRENT_BAA_VERSION } from "./baa";
import { BAA_EXPLAINER, clauseExplainer, type BaaExplainerTerm } from "./baa-explainer";
import { CURRENT_DPA_VERSION, DPA_ACTION_LABEL, DPA_ASSENT_LABEL, dpaAssentSentence } from "./dpa";
import { DPA_EXPLAINER, dpaClauseExplainer } from "./dpa-explainer";

/**
 * Everything the signing screen says about the agreement, by kind (plan Part
 * L, "Copy"), so a screen that renders the DPA cannot pick up a BAA string by
 * reaching for the constant it used before there were two kinds.
 * `agreementKindFor` decides the kind; this decides the words.
 *
 * BAA_EXPLAINER, the BAA's clause notes (which cite 45 CFR 164.504(e)) and the
 * BAA's assent label never appear beside a DPA: `AGREEMENT_COPY.dpa` holds
 * none of them, which agreement-copy.test.ts asserts.
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
  explainer: AgreementExplainer;
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
    explainer: BAA_EXPLAINER,
    clauseNote: clauseExplainer,
    assentLabel: BAA_ASSENT_LABEL,
    assentSentence,
    actionLabel: BAA_ACTION_LABEL,
  },
  dpa: {
    kind: "dpa",
    title: "Data Protection Agreement",
    currentVersion: CURRENT_DPA_VERSION,
    explainer: DPA_EXPLAINER,
    clauseNote: dpaClauseExplainer,
    assentLabel: DPA_ASSENT_LABEL,
    assentSentence: dpaAssentSentence,
    actionLabel: DPA_ACTION_LABEL,
  },
};

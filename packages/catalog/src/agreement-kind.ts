import { currentDpaTemplate } from "./dpa";
import { isSpecialtyId, regimeFor, type SpecialtyId } from "./specialties";

/**
 * Which data agreement a practice signs (plan Part L), decided in one place.
 * The funnel's agreement step, the agreement API, the checkout intent,
 * provisioning and the go-live check all ask this function, so no two of
 * them can disagree about a practice.
 *
 * - A specialty HIPAA always reaches (plastic surgery, fertility, dental,
 *   GLP-1) signs the Business Associate Agreement, whatever it answers.
 * - A specialty HIPAA reaches only if the practice is a covered entity (med
 *   spas, hair restoration, massage and chiropractic) signs the BAA on "Yes"
 *   or "Not sure", and the Data Protection Agreement on "No".
 * - A veterinary practice is outside HIPAA, because its patients are not
 *   people, and signs the DPA without being asked.
 *
 * Until the owner releases the DPA (Gate A), "No" signs the BAA, as it
 * always has, and a veterinary practice cannot buy: there is no agreement
 * for it to sign. The release is the DPA template's own flag (dpa.ts), read
 * here at call time, so setting it is the one switch.
 */

export type AgreementKind = "baa" | "dpa";

export const AGREEMENT_KINDS: readonly AgreementKind[] = ["baa", "dpa"];

export function isAgreementKind(value: unknown): value is AgreementKind {
  return typeof value === "string" && (AGREEMENT_KINDS as readonly string[]).includes(value);
}

/** The namespace every DPA template version carries ("dpa/1.0.0"). BAA versions carry none. */
export const DPA_VERSION_PREFIX = "dpa/";

/**
 * Which kind a stored acceptance is, from its document version alone: the
 * TypeScript mirror of the generated column `baa_acceptances.agreement_kind`
 * (drizzle/0051), whose parity test runs both over the same versions.
 */
export function agreementKindOfVersion(version: string): AgreementKind {
  return version.startsWith(DPA_VERSION_PREFIX) ? "dpa" : "baa";
}

/**
 * The funnel's covered-entity question, worded around what decides it: "Do
 * you bill any health insurance electronically, yourself or through a
 * clearinghouse?"
 */
export type CoveredAnswer = "yes" | "no" | "not_sure";

export const COVERED_ANSWERS: readonly CoveredAnswer[] = ["yes", "no", "not_sure"];

export function isCoveredAnswer(value: unknown): value is CoveredAnswer {
  return typeof value === "string" && (COVERED_ANSWERS as readonly string[]).includes(value);
}

/**
 * Whether the Data Protection Agreement can be signed yet: the current DPA
 * template's release flag (`approvedByCounsel`, the one the BAA templates
 * carry). False until the owner reads docs/dpa-v1.0.0.txt and releases it,
 * with the veterinary readiness items (plan Part L). A function, not a
 * constant, so nothing caches the answer.
 */
export function isDpaReleased(): boolean {
  return currentDpaTemplate().approvedByCounsel;
}

export type AgreementChoice =
  | {
      ok: true;
      kind: AgreementKind;
      /** The BAA's and the DPA's `isCoveredEntity`: null when the practice was not sure. */
      isCoveredEntity: boolean | null;
    }
  | { ok: false; reason: "unknown_specialty" | "dpa_not_released" };

export function agreementKindFor(input: {
  specialty: string;
  /** Null when the question was not asked (a veterinary practice) or not yet answered. */
  covered: CoveredAnswer | null;
  /** For tests and previews of the released DPA; production reads isDpaReleased(). */
  dpaReleased?: boolean;
}): AgreementChoice {
  if (!isSpecialtyId(input.specialty)) return { ok: false, reason: "unknown_specialty" };
  const released = input.dpaReleased ?? isDpaReleased();

  switch (regimeFor(input.specialty)) {
    case "hipaa":
      return { ok: true, kind: "baa", isCoveredEntity: coveredFlag(input.covered) };
    case "hipaa-if-covered":
      if (input.covered === "no") {
        return { ok: true, kind: released ? "dpa" : "baa", isCoveredEntity: false };
      }
      return { ok: true, kind: "baa", isCoveredEntity: coveredFlag(input.covered) };
    case "non-hipaa":
      return released
        ? { ok: true, kind: "dpa", isCoveredEntity: false }
        : { ok: false, reason: "dpa_not_released" };
  }
}

/** Whether the funnel asks the covered-entity question: never of a practice HIPAA cannot reach. */
export function asksCoveredQuestion(id: SpecialtyId): boolean {
  return regimeFor(id) !== "non-hipaa";
}

/**
 * Whether the funnel offers a specialty at all. A veterinary practice can buy
 * only once there is an agreement it can sign: the released DPA.
 */
export function specialtyOffered(id: SpecialtyId, dpaReleased: boolean = isDpaReleased()): boolean {
  return regimeFor(id) !== "non-hipaa" || dpaReleased;
}

function coveredFlag(answer: CoveredAnswer | null): boolean | null {
  if (answer === "yes") return true;
  if (answer === "no") return false;
  return null;
}

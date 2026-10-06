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
 * for it to sign.
 */

export type AgreementKind = "baa" | "dpa";

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
 * Whether the Data Protection Agreement can be signed yet: false until the
 * owner reads docs/dpa-v1.0.0.txt and releases it, with the veterinary
 * readiness items (plan Part L). The DPA's template replaces this constant
 * with its own release flag, the one the BAA templates carry.
 */
export const DPA_RELEASED = false;

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
  /** For tests and previews of the released DPA; production reads DPA_RELEASED. */
  dpaReleased?: boolean;
}): AgreementChoice {
  if (!isSpecialtyId(input.specialty)) return { ok: false, reason: "unknown_specialty" };
  const released = input.dpaReleased ?? DPA_RELEASED;

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
export function specialtyOffered(id: SpecialtyId, dpaReleased: boolean = DPA_RELEASED): boolean {
  return regimeFor(id) !== "non-hipaa" || dpaReleased;
}

function coveredFlag(answer: CoveredAnswer | null): boolean | null {
  if (answer === "yes") return true;
  if (answer === "no") return false;
  return null;
}

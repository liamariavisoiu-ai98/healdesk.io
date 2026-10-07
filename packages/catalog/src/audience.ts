import { isSpecialtyId, regimeFor } from "./specialties";

/**
 * Who a practice's customers are, in its own words (plan Part L, "Copy"):
 * "clients" at a veterinary practice, whose patients are animals and whose
 * customers own them, and "patients" everywhere else. Every surface that
 * names them asks this, from the funnel and the agreement step to the
 * emails, the portal and the support chat, so a vet is never told its
 * patients are people.
 *
 * Read from the specialty's regime rather than its id, so a second animal
 * specialty needs no change here. An unknown or missing specialty is
 * "patients", the wording of every practice HIPAA can reach.
 */
export type Audience = "patients" | "clients";

export function audienceFor(specialty: string | null | undefined): Audience {
  return isSpecialtyId(specialty) && regimeFor(specialty) === "non-hipaa" ? "clients" : "patients";
}

/** One of them: "patient" or "client", for a sentence like the plan-start sentence. */
export function audienceSingular(audience: Audience): "patient" | "client" {
  return audience === "clients" ? "client" : "patient";
}

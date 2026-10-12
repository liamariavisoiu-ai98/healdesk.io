import { PATIENT_REQUESTERS, type PatientRequester } from "@/db/schema";

/**
 * Who asked, as the operator chooses it and the console shows it: for a
 * deletion, an amendment and a correction alike. Chosen, never typed: a
 * "who asked" of free text carried a name ("Jane Doe's mother, by
 * telephone") into the append-only audit log, where it outlived the
 * deletion of the very person it named (review of 12 October 2026). Only the
 * practice asks (docs/handover.md, "Deletion requests", "Amendments"); the
 * other two say whose request it passed on.
 */
export const REQUESTER_LABELS: Record<PatientRequester, string> = {
  practice: "The practice",
  person_via_practice: "The person, through the practice",
  representative_via_practice: "A legal representative, through the practice",
};

export function isPatientRequester(value: unknown): value is PatientRequester {
  return (PATIENT_REQUESTERS as readonly unknown[]).includes(value);
}

export { PATIENT_REQUESTERS, type PatientRequester };

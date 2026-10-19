import { PATIENT_REQUEST_KINDS, type PatientRequestKind } from "@/db/schema";

/**
 * What a patient asked healdesk for about their information (L32; BAA 1.5.1
 * clause 14): the closed set the operator chooses from and every screen and
 * email prints, so nothing the patient wrote is stored or shown. Pure, so the
 * email template and the portal share it.
 */
export const PATIENT_REQUEST_KIND_LABELS: Record<PatientRequestKind, string> = {
  access: "To see or get a copy of their information",
  amendment: "To correct their information",
  accounting: "To know who their information was shared with",
  deletion: "To delete their information",
  other: "Another request about their information",
};

export function isPatientRequestKind(value: unknown): value is PatientRequestKind {
  return (PATIENT_REQUEST_KINDS as readonly unknown[]).includes(value);
}

/** A request's own page in the portal, off Home, behind the passkey step-up. */
export function patientRequestPath(slug: string, requestId: string): string {
  return `/c/${slug}/patient-requests/${requestId}`;
}

export { PATIENT_REQUEST_KINDS, type PatientRequestKind };

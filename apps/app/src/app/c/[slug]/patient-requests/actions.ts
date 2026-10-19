"use server";

import { notFound, redirect, RedirectType } from "next/navigation";

import { patientRequestPath } from "@/lib/patient-rights/request-kinds";
import { requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";
import {
  markPatientRequestReceived,
  PatientRequestNotFoundError,
} from "@/lib/portal/patient-requests";

/**
 * "Mark as received" on a patient's request passed to the practice (L32;
 * lib/patient-rights/patient-requests.ts, "The acknowledgement mark"),
 * behind the passkey step-up: the request is opened in the page's patient
 * transaction, its access row written, and marked received from the
 * step-up's device, once. The clinic is the page's (requirePatientPage),
 * never anything the browser sent; an id this clinic does not hold is "not
 * found". Bound to the slug and the request's id by the page's form.
 */
export async function markReceived(slug: string, requestId: string): Promise<void> {
  const path = patientRequestPath(String(slug), String(requestId));
  const page = await requirePatientPage(String(slug), { returnTo: path });
  try {
    await withPatientPage(page, (tx) => markPatientRequestReceived(tx, String(requestId)));
  } catch (error) {
    if (error instanceof PatientRequestNotFoundError) notFound();
    throw error;
  }
  redirect(path, RedirectType.replace);
}

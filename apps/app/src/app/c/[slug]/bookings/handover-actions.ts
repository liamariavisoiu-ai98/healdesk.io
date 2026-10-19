"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";

import {
  bookingsPath,
  HandoverNotFoundError,
  markHandoverHandled,
} from "@/lib/portal/bookings";
import { requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";

/**
 * Bookings' third write: a handover (someone asked AYA for a person) marked
 * handled, behind the passkey step-up, by the device whose passkey is live
 * (markHandoverHandled). The clinic is the page's, never anything the browser
 * sent; an id that is not this clinic's handover is "not found".
 */

export type HandoverFormState =
  | { status: "idle" }
  | { status: "saved"; message: string }
  | { status: "failed"; message: string };

export async function markHandover(
  slug: string,
  _previous: HandoverFormState,
  formData: FormData,
): Promise<HandoverFormState> {
  const page = await requirePatientPage(String(slug), { returnTo: bookingsPath(String(slug)) });
  const handoverId = formData.get("handoverId");
  if (typeof handoverId !== "string") {
    return { status: "failed", message: "That didn't go through. Reload Bookings and try again." };
  }
  let changed: boolean;
  try {
    changed = (await withPatientPage(page, (tx) => markHandoverHandled(tx, handoverId))).changed;
  } catch (error) {
    if (error instanceof HandoverNotFoundError) notFound();
    throw error;
  }
  revalidatePath(bookingsPath(String(slug)));
  return {
    status: "saved",
    message: changed ? "Marked handled." : "Someone on your team already marked this handled.",
  };
}

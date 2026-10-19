"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect, RedirectType } from "next/navigation";

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

export type HandoverFormState = { status: "idle" } | { status: "failed"; message: string };

/**
 * Marked, or already marked by a colleague: Bookings is read again without
 * it and says so in its page-level status region (`?handled=`), since the
 * card, and anything said inside it, goes with the re-read.
 */
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
  let result: Awaited<ReturnType<typeof markHandoverHandled>>;
  try {
    result = await withPatientPage(page, (tx) => markHandoverHandled(tx, handoverId));
  } catch (error) {
    if (error instanceof HandoverNotFoundError) notFound();
    throw error;
  }
  if (!result.ok) {
    return { status: "failed", message: "Your portal is read-only while your account closes, so nothing was changed." };
  }
  revalidatePath(bookingsPath(String(slug)));
  // The handover's id makes each result its own URL, so a second card marked
  // is announced again.
  const params = new URLSearchParams({ handled: result.changed ? "marked" : "already", h: handoverId });
  redirect(`${bookingsPath(String(slug))}?${params.toString()}`, RedirectType.replace);
}

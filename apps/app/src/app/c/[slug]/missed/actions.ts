"use server";

import { notFound, redirect, RedirectType } from "next/navigation";

import { missedPath } from "@/lib/channels/answer-notices";
import { markCalledBack } from "@/lib/portal/missed-contacts";
import { requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";

/**
 * "Called back" on a missed contact (missed_contacts; lib/portal/
 * missed-contacts.ts), behind the passkey step-up: opened in the page's
 * patient transaction, its access row written, and ticked once. The clinic
 * is the page's (requirePatientPage), never anything the browser sent; an id
 * this clinic does not hold is "not found". Bound to the slug, the id and
 * the page to come back to by the page's form.
 */
export async function calledBack(slug: string, missedContactId: string, backToOne: boolean): Promise<void> {
  const back = backToOne ? missedPath(String(slug), String(missedContactId)) : missedPath(String(slug));
  const page = await requirePatientPage(String(slug), { returnTo: back });
  const outcome = await withPatientPage(page, (tx) => markCalledBack(tx, String(missedContactId)));
  if (outcome.status === "not_found") notFound();
  redirect(back, RedirectType.replace);
}

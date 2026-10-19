"use server";

import {
  decideFromBookings,
  freeTimesFor,
  markBookingOutcome,
  markDepositPaid,
  parseDecision,
  type DecideResult,
  type FreeTimesResult,
  type MarkResult,
} from "@/lib/portal/bookings";
import { requirePatientPage } from "@/lib/portal/patient-page";

/**
 * Bookings' server actions (plan Part F5): a decision on a request, its free
 * times, "Deposit paid" and a booking's outcome. Each calls
 * requirePatientPage itself, so each needs this session's live passkey
 * step-up (without one, Next follows the redirect to the step-up page), and
 * each writes its access-log row naming the passkey before it reads or
 * changes anything (lib/portal/bookings.ts). The clinic is the one the
 * session's portal access opened; nothing the browser sends names it.
 *
 * Nothing here sends anything to a patient: staff call them.
 */

export async function decideAction(slug: string, requestId: string, form: FormData): Promise<DecideResult> {
  const page = await requirePatientPage(String(slug));
  const parsed = parseDecision(form);
  if (!parsed.ok) return { status: "refused", message: parsed.message };
  return decideFromBookings(page, String(requestId), parsed);
}

export async function freeTimesAction(slug: string, requestId: string): Promise<FreeTimesResult> {
  const page = await requirePatientPage(String(slug));
  return freeTimesFor(page, String(requestId));
}

export async function depositPaidAction(slug: string, appointmentId: string): Promise<MarkResult> {
  const page = await requirePatientPage(String(slug));
  return markDepositPaid(page, String(appointmentId));
}

export async function outcomeAction(slug: string, appointmentId: string, outcome: string): Promise<MarkResult> {
  const page = await requirePatientPage(String(slug));
  return markBookingOutcome(page, String(appointmentId), outcome);
}

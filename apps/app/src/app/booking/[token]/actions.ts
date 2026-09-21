"use server";

import { redirect, RedirectType } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { decideBookingRequest, type BookingDecision } from "@/lib/meta/booking-requests";
import { log } from "@/lib/log";

/**
 * The desk's one write: confirm a slot, accept with a call-back, or decline.
 *
 * No session, no account — the token in the form is re-resolved server-side
 * and the clinic comes from the row it finds, never from anything the
 * browser sent. `decideBookingRequest()` is one conditional UPDATE, so two
 * people at the desk clicking at once produce one decision, and the trigger
 * in drizzle/0039 stops a decided row being re-decided afterwards, with one
 * permitted second step: a call-back acceptance can be confirmed to a slot
 * later from the same page.
 *
 * Confirming is the only place in the product an appointment row is created
 * from an agent's conversation. The agent semi-confirmed; this click is the
 * booking.
 *
 * Success comes back to the same page: a decided request still renders
 * (read-only, with its outcome), so there is no spent-link oracle to guard
 * against here and no separate "done" URL is needed. A dead link goes to
 * /booking/invalid for the same reason /connect does.
 */
export type DecideFormState = { status: "idle" } | { status: "failed"; message: string };

const DECISIONS: readonly BookingDecision[] = ["accepted", "declined", "confirmed"];

export async function decideRequest(_previous: DecideFormState, formData: FormData): Promise<DecideFormState> {
  const token = formData.get("token");
  const decision = formData.get("decision");
  if (typeof token !== "string" || typeof decision !== "string" || !DECISIONS.includes(decision as BookingDecision)) {
    return { status: "failed", message: "This link is no longer valid." };
  }
  const request = await connectRequestContext();
  if (!withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    return { status: "failed", message: "That's several attempts in a row. Give it ten minutes and try again." };
  }
  const note = formData.get("note");
  const name = formData.get("name");
  const treatment = formData.get("treatment");

  // The slot, from a datetime-local input: no zone, read as the desk's
  // browser clock. The desk and the clinic are in the same place.
  let confirmedFor: Date | null = null;
  if (decision === "confirmed") {
    const raw = formData.get("confirmedFor");
    const offset = formData.get("tzOffsetMinutes");
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) {
      return { status: "failed", message: "Pick the date and time you are confirming." };
    }
    const minutes = typeof offset === "string" && /^-?\d{1,4}$/.test(offset) ? Number(offset) : 0;
    confirmedFor = new Date(new Date(`${raw}:00Z`).getTime() + minutes * 60_000);
    if (!Number.isFinite(confirmedFor.getTime()) || confirmedFor.getTime() < Date.now() - 60 * 60_000) {
      return { status: "failed", message: "That time has already passed. Pick a time from now on." };
    }
  }

  let outcome: Awaited<ReturnType<typeof decideBookingRequest>>;
  try {
    outcome = await decideBookingRequest(token, decision as BookingDecision, {
      decidedByLabel: typeof name === "string" ? name : null,
      deskNote: typeof note === "string" ? note : null,
      confirmedFor,
      treatment: typeof treatment === "string" ? treatment : null,
      request,
    });
  } catch (error) {
    log.error("booking decision failed", { error: error instanceof Error ? error.name : "unknown" });
    return { status: "failed", message: "We couldn't save that. Please try again in a moment." };
  }
  if (outcome.outcome === "invalid") redirect("/booking/invalid", RedirectType.replace);
  // Decided, or decided a moment ago by a colleague: either way the page now
  // shows the outcome, and the follow-up status with it.
  redirect(`/booking/${token}?followup=${outcome.followUp ?? "none"}`, RedirectType.replace);
}

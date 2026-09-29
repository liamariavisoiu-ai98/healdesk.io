"use server";

import { redirect, RedirectType } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { decideBookingRequest, MAX_PROPOSED_SLOTS, type BookingDecision } from "@/lib/meta/booking-requests";
import { log } from "@/lib/log";

/**
 * The desk's one write: confirm a slot, accept with a call-back, propose up
 * to three other times, or decline.
 *
 * No session, no account — the token in the form is re-resolved server-side
 * and the clinic comes from the row it finds, never from anything the
 * browser sent. `decideBookingRequest()` is one conditional UPDATE, so two
 * people at the desk clicking at once produce one decision, and the trigger
 * in drizzle/0040 stops a decided row being re-decided afterwards, with the
 * permitted second steps: a call-back acceptance can be confirmed to a slot
 * or turned into proposed times later from the same page, and proposed
 * times can be confirmed, replaced or declined.
 *
 * Confirming is the one place in the product an appointment row is created
 * from an agent's conversation. The agent semi-confirmed; this click is the
 * booking. Where the clinic connected a writable calendar the slot comes
 * from its free times (an ISO instant in `slotAt`) and the appointment is
 * also written there, after this decision has committed; a typed time in
 * `confirmedFor` still works, calendar or not.
 *
 * Success comes back to the same page: a decided request still renders
 * (read-only, with its outcome), so there is no spent-link oracle to guard
 * against here and no separate "done" URL is needed. A dead link goes to
 * /booking/invalid for the same reason /connect does.
 */
export type DecideFormState = { status: "idle" } | { status: "failed"; message: string };

const DECISIONS: readonly BookingDecision[] = ["accepted", "declined", "confirmed", "rescheduling"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

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
  const offset = formData.get("tzOffsetMinutes");
  const minutes = typeof offset === "string" && /^-?\d{1,4}$/.test(offset) ? Number(offset) : 0;

  // A typed time comes from a datetime-local input: no zone, read as the
  // desk's browser clock. The desk and the clinic are in the same place.
  const fromLocal = (raw: FormDataEntryValue | null): Date | null => {
    if (typeof raw !== "string" || !LOCAL_INPUT.test(raw)) return null;
    const at = new Date(new Date(`${raw.slice(0, 16)}:00Z`).getTime() + minutes * 60_000);
    return Number.isFinite(at.getTime()) ? at : null;
  };
  // A calendar slot is an ISO instant the page rendered; nothing to adjust.
  const fromIso = (raw: FormDataEntryValue | null): Date | null => {
    if (typeof raw !== "string" || !ISO_INSTANT.test(raw)) return null;
    const at = new Date(raw);
    return Number.isFinite(at.getTime()) ? at : null;
  };
  const stillAhead = (at: Date) => at.getTime() >= Date.now() - 60 * 60_000;

  let confirmedFor: Date | null = null;
  if (decision === "confirmed") {
    // A typed time is the deliberate choice when both are present.
    confirmedFor = fromLocal(formData.get("confirmedFor")) ?? fromIso(formData.get("slotAt"));
    if (!confirmedFor) return { status: "failed", message: "Pick the date and time you are confirming." };
    if (!stillAhead(confirmedFor)) return { status: "failed", message: "That time has already passed. Pick a time from now on." };
  }

  let proposedSlots: { at: Date; source: "calendar" | "desk" }[] = [];
  if (decision === "rescheduling") {
    const seen = new Set<number>();
    const add = (at: Date | null, source: "calendar" | "desk") => {
      if (at && !seen.has(at.getTime())) {
        seen.add(at.getTime());
        proposedSlots.push({ at, source });
      }
    };
    for (const raw of formData.getAll("proposedSlot")) add(fromIso(raw), "calendar");
    for (const raw of formData.getAll("proposedAt")) add(fromLocal(raw), "desk");
    proposedSlots = proposedSlots.slice(0, MAX_PROPOSED_SLOTS);
    if (proposedSlots.length === 0) return { status: "failed", message: "Pick one to three times to propose." };
    if (!proposedSlots.every((s) => stillAhead(s.at))) return { status: "failed", message: "One of those times has already passed. Propose times from now on." };
  }

  let outcome: Awaited<ReturnType<typeof decideBookingRequest>>;
  try {
    outcome = await decideBookingRequest(token, decision as BookingDecision, {
      decidedByLabel: typeof name === "string" ? name : null,
      deskNote: typeof note === "string" ? note : null,
      confirmedFor,
      treatment: typeof treatment === "string" ? treatment : null,
      proposedSlots,
      request,
    });
  } catch (error) {
    log.error("booking decision failed", { error: error instanceof Error ? error.name : "unknown" });
    return { status: "failed", message: "We couldn't save that. Please try again in a moment." };
  }
  if (outcome.outcome === "invalid") redirect("/booking/invalid", RedirectType.replace);
  // Decided, or decided a moment ago by a colleague: either way the page now
  // shows the outcome, the follow-up status and the calendar write with it.
  const params = new URLSearchParams({
    followup: outcome.followUp ?? "none",
    calendar: outcome.calendarWrite ?? "none",
    callback: outcome.callback ? (outcome.callback.scheduled ? "scheduled" : outcome.callback.reason) : "none",
  });
  redirect(`/booking/${token}?${params.toString()}`, RedirectType.replace);
}

"use server";

import { revalidatePath } from "next/cache";
import { notFound, redirect, RedirectType } from "next/navigation";

import { log } from "@/lib/log";
import {
  decideBookingRequest,
  MAX_PROPOSED_SLOTS,
  type BookingDecision,
  type DecisionOutcome,
} from "@/lib/meta/booking-requests";
import {
  AppointmentNotFoundError,
  bookingRequestPath,
  bookingsPath,
  deskActorOf,
  isAppointmentOutcome,
  markAppointmentOutcome,
  openRequestForDecision,
  RequestNotFoundError,
  type AppointmentOutcome,
} from "@/lib/portal/bookings";
import { requirePatientPage, withPatientPage } from "@/lib/portal/patient-page";

/**
 * Bookings' two writes (plan Part F5), each behind the passkey step-up:
 *
 * - **decideBooking:** Confirm a time, Propose up to three others, or
 *   Decline, through `decideBookingRequest` keyed by this clinic and the
 *   request's id, with the sign-in and the step-up's passkey as the actor.
 *   The request is opened first in a patient transaction that writes its
 *   access row; one that is not this clinic's is "not found". Confirming is
 *   the one place in the product an appointment row is created from a
 *   request, and the calendar write follows the decision's commit, under the
 *   location's calendar terms (lib/booking/calendar.ts).
 * - **markOutcome:** Showed, No-show or Cancelled on one of AYA's bookings.
 *
 * The clinic is the page's (requirePatientPage), never anything the browser
 * sent; the slug only names which portal, and a sign-in that does not open
 * it gets "not found".
 */

export type DecideFormState =
  | { status: "idle" }
  | { status: "failed"; message: string }
  /**
   * Google shows the time busy: the form offers "Confirm anyway" for exactly
   * this time, carrying the name and note so the audited confirmation keeps
   * who made it and why.
   */
  | {
      status: "busy";
      message: string;
      slotAt: string;
      treatment: string | null;
      name: string | null;
      note: string | null;
    };

/** The desk path's refusals (plan §7.10), in the desk's words. */
const CHECKING_LINE =
  "We're still checking whether AYA's booking reached your calendar. Try again in a minute.";
const LIVE_CALL_LINE =
  "Someone is booking that time on a call right now. Pick another time, or try again in a minute.";
const TAKEN_LINE =
  "Another booking made through healdesk already holds this time. Pick another time.";
const BUSY_LINE =
  "Your calendar shows that time as busy. Pick another time, or confirm it anyway if you know it is free.";
const LAPSED_LINE =
  "This request can't be decided any more: it has lapsed or was decided. Reload Bookings to see where it is.";

/** What the portal offers (plan Part F5): Confirm, Propose and Decline. "Call" is a tel: link. */
const DECISIONS: readonly BookingDecision[] = ["confirmed", "rescheduling", "declined"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const LOCAL_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export async function decideBooking(
  slug: string,
  _previous: DecideFormState,
  formData: FormData,
): Promise<DecideFormState> {
  const page = await requirePatientPage(String(slug), { returnTo: bookingsPath(String(slug)) });
  const requestId = formData.get("requestId");
  const decision = formData.get("decision");
  if (
    typeof requestId !== "string" ||
    typeof decision !== "string" ||
    !DECISIONS.includes(decision as BookingDecision)
  ) {
    return { status: "failed", message: "That didn't go through. Reload Bookings and try again." };
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
    if (!confirmedFor)
      return { status: "failed", message: "Pick the date and time you are confirming." };
    if (!stillAhead(confirmedFor)) {
      return {
        status: "failed",
        message: "That time has already passed. Pick a time from now on.",
      };
    }
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
    if (proposedSlots.length === 0) {
      return { status: "failed", message: "Pick one to three times to propose." };
    }
    if (!proposedSlots.every((s) => stillAhead(s.at))) {
      return {
        status: "failed",
        message: "One of those times has already passed. Propose times from now on.",
      };
    }
  }

  // Open the request in this clinic, with its access row naming the passkey.
  try {
    await withPatientPage(page, (tx) => openRequestForDecision(tx, requestId));
  } catch (error) {
    if (error instanceof RequestNotFoundError) notFound();
    throw error;
  }

  const typedName = typeof name === "string" ? name.trim() : "";
  let outcome: DecisionOutcome;
  try {
    outcome = await decideBookingRequest(
      { clinicId: page.portal.clinicId, requestId },
      decision as BookingDecision,
      {
        actor: deskActorOf(page),
        // The shared sign-in says which device decided; a typed name, if any, says who.
        decidedByLabel: typedName || page.stepUp.deviceLabel,
        deskNote: typeof note === "string" ? note : null,
        confirmedFor,
        treatment: typeof treatment === "string" ? treatment : null,
        proposedSlots,
        addAnyway: decision === "confirmed" && formData.get("addAnyway") === "1",
        request: page.request,
      },
    );
  } catch (error) {
    log.error("booking decision failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { status: "failed", message: "We couldn't save that. Please try again in a moment." };
  }
  if (outcome.outcome === "invalid") return { status: "failed", message: LAPSED_LINE };
  if (outcome.outcome === "checking") return { status: "failed", message: CHECKING_LINE };
  if (outcome.outcome === "slot_taken") {
    return {
      status: "failed",
      message: outcome.takenBy === "live_call" ? LIVE_CALL_LINE : TAKEN_LINE,
    };
  }
  if (outcome.outcome === "calendar_busy" && confirmedFor) {
    return {
      status: "busy",
      message: BUSY_LINE,
      slotAt: confirmedFor.toISOString(),
      treatment: typeof treatment === "string" ? treatment : null,
      name: typeof name === "string" ? name : null,
      note: typeof note === "string" ? note : null,
    };
  }
  // Decided, decided a moment ago by a colleague, or booked by AYA after
  // all: Bookings opens on the request, with the follow-up and the calendar
  // write said beside it. The query carries an id and two status words.
  const params = new URLSearchParams({
    followup: outcome.followUp ?? "none",
    calendar: outcome.calendarWrite ?? "none",
    // DEP-META slice 1: whether a Meta confirmation's deposit link went on the thread.
    ...(outcome.depositLink ? { deposit: outcome.depositLink } : {}),
  });
  redirect(
    `${bookingRequestPath(String(slug), requestId)}&${params.toString()}`,
    RedirectType.replace,
  );
}

export type OutcomeFormState =
  | { status: "idle" }
  | { status: "saved"; message: string; outcome: AppointmentOutcome }
  /** Cancelling an appointment still ahead: what it does, before it is done. */
  | { status: "confirm"; message: string }
  | { status: "failed"; message: string };

const OUTCOME_SAVED: Record<AppointmentOutcome, string> = {
  showed: "Marked as showed.",
  no_show: "Marked as a no-show.",
  cancelled: "Marked as cancelled here. Cancel it in your calendar too if it's still there.",
};

/** What Cancelled does to an appointment still ahead, said before it is done. */
const CANCEL_CONFIRM_LINE =
  "Cancelling frees this time in healdesk, so AYA may book it for someone else. It doesn't change your calendar, and it can't be undone here.";
/** A calendar write still on its way (plan §7.12): cancelling now could let it land afterwards. */
const CANCEL_CHECKING_LINE =
  "We're still checking whether this booking reached your calendar. Try again in a minute.";

export async function markOutcome(
  slug: string,
  _previous: OutcomeFormState,
  formData: FormData,
): Promise<OutcomeFormState> {
  const page = await requirePatientPage(String(slug), { returnTo: bookingsPath(String(slug)) });
  const appointmentId = formData.get("appointmentId");
  const outcome = formData.get("outcome");
  if (typeof appointmentId !== "string" || !isAppointmentOutcome(outcome)) {
    return { status: "failed", message: "That didn't go through. Reload Bookings and try again." };
  }
  let result: Awaited<ReturnType<typeof markAppointmentOutcome>>;
  try {
    result = await withPatientPage(page, (tx) =>
      markAppointmentOutcome(tx, appointmentId, outcome, new Date(), {
        confirmed: formData.get("confirm") === "1",
      }),
    );
  } catch (error) {
    if (error instanceof AppointmentNotFoundError) notFound();
    throw error;
  }
  if (!result.ok) {
    if (result.reason === "confirm") return { status: "confirm", message: CANCEL_CONFIRM_LINE };
    return {
      status: "failed",
      message:
        result.reason === "not_yet"
          ? "Showed and No-show can be marked once the appointment has started."
          : result.reason === "checking"
            ? CANCEL_CHECKING_LINE
            : "That didn't go through. Reload Bookings and try again.",
    };
  }
  revalidatePath(bookingsPath(String(slug)));
  return { status: "saved", message: OUTCOME_SAVED[result.status], outcome: result.status };
}

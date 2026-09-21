"use server";

import { redirect, RedirectType } from "next/navigation";

import { connectRequestContext } from "@/app/connect/[token]/request-context";
import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { decideBookingRequest, type BookingDecision } from "@/lib/meta/booking-requests";
import { log } from "@/lib/log";

/**
 * The desk's one write: accept or decline.
 *
 * No session, no account — the token in the form is re-resolved server-side
 * and the clinic comes from the row it finds, never from anything the
 * browser sent. `decideBookingRequest()` is one conditional UPDATE, so two
 * people at the desk clicking at once produce one decision, and the trigger
 * in drizzle/0037 stops a decided row being re-decided afterwards.
 *
 * Success comes back to the same page: a decided request still renders
 * (read-only, with its outcome), so there is no spent-link oracle to guard
 * against here and no separate "done" URL is needed. A dead link goes to
 * /booking/invalid for the same reason /connect does.
 */
export type DecideFormState = { status: "idle" } | { status: "failed"; message: string };

export async function decideRequest(_previous: DecideFormState, formData: FormData): Promise<DecideFormState> {
  const token = formData.get("token");
  const decision = formData.get("decision");
  if (typeof token !== "string" || (decision !== "accepted" && decision !== "declined")) {
    return { status: "failed", message: "This link is no longer valid." };
  }
  const request = await connectRequestContext();
  if (!withinConnectAttemptLimit("submit", token, request.ipAddress ?? null)) {
    return { status: "failed", message: "That's several attempts in a row. Give it ten minutes and try again." };
  }
  const note = formData.get("note");
  const name = formData.get("name");
  let outcome: Awaited<ReturnType<typeof decideBookingRequest>>;
  try {
    outcome = await decideBookingRequest(
      token,
      decision as BookingDecision,
      {
        decidedByLabel: typeof name === "string" ? name : null,
        deskNote: typeof note === "string" ? note : null,
        request,
      },
    );
  } catch (error) {
    log.error("booking decision failed", { error: error instanceof Error ? error.name : "unknown" });
    return { status: "failed", message: "We couldn't save that. Please try again in a moment." };
  }
  if (outcome.outcome === "invalid") redirect("/booking/invalid", RedirectType.replace);
  // Decided, or decided a moment ago by a colleague: either way the page now
  // shows the outcome, and the follow-up status with it.
  redirect(`/booking/${token}?followup=${outcome.followUp ?? "none"}`, RedirectType.replace);
}

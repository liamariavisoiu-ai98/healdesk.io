"use client";

import { useActionState, useState } from "react";

import { markOutcome, type OutcomeFormState } from "./actions";

/**
 * The one-click outcome on a booking (spec, "The claims": showed, no-show or
 * cancelled). Three buttons, the current one pressed; Showed and No-show wait
 * for the appointment to start. Cancelling one still ahead asks first, with
 * what it does: it frees the time in healdesk, leaves the clinic's calendar
 * as it is, and cannot be undone here. The server asks (markOutcome answers
 * "confirm" until the form says so), so the step holds without a script too.
 * The result is said in a polite status region (plan Part F8), and Bookings
 * is read again with it.
 */
const BUTTONS = [
  { outcome: "showed", label: "Showed" },
  { outcome: "no_show", label: "No-show" },
  { outcome: "cancelled", label: "Cancelled" },
] as const;

export function OutcomeControl(props: {
  slug: string;
  appointmentId: string;
  current: string;
  started: boolean;
}) {
  const [state, action, pending] = useActionState<OutcomeFormState, FormData>(
    markOutcome.bind(null, props.slug),
    { status: "idle" },
  );
  // "Keep it" puts the question away until Cancelled is pressed again.
  const [kept, setKept] = useState<OutcomeFormState | null>(null);
  const asking = state.status === "confirm" && kept !== state;
  const current = state.status === "saved" ? state.outcome : props.current;
  return (
    <div className="mt-3">
      <form action={action}>
        <input type="hidden" name="appointmentId" value={props.appointmentId} />
        <div role="group" aria-label="How it went" className="flex flex-wrap gap-2">
          {BUTTONS.map((b) => {
            const waits = b.outcome !== "cancelled" && !props.started;
            return (
              <button
                key={b.outcome}
                type="submit"
                name="outcome"
                value={b.outcome}
                aria-pressed={current === b.outcome}
                disabled={pending || waits}
                className={`min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-50 ${
                  current === b.outcome ? "border-ink bg-ink text-white" : "border-line bg-white"
                }`}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </form>
      {asking ? (
        <form
          action={action}
          className="border-line bg-tint-butter mt-2 grid gap-2 rounded-md border px-3 py-3 text-sm"
        >
          <input type="hidden" name="appointmentId" value={props.appointmentId} />
          <input type="hidden" name="outcome" value="cancelled" />
          <input type="hidden" name="confirm" value="1" />
          <p role="alert">{state.message}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={pending}
              className="bg-ink min-h-11 rounded-full px-4 font-semibold text-white disabled:opacity-50"
            >
              Mark cancelled
            </button>
            <button
              type="button"
              onClick={() => setKept(state)}
              className="border-line min-h-11 rounded-full border bg-white px-4 font-semibold"
            >
              Keep it
            </button>
          </div>
        </form>
      ) : null}
      <p aria-live="polite" className="text-muted mt-1 text-sm">
        {state.status === "idle" || state.status === "confirm"
          ? props.started
            ? null
            : "Showed and No-show open once the appointment starts."
          : state.message}
      </p>
    </div>
  );
}

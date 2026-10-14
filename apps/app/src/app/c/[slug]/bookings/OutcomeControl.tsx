"use client";

import { useActionState } from "react";

import { markOutcome, type OutcomeFormState } from "./actions";

/**
 * The one-click outcome on a booking (spec, "The claims": showed, no-show or
 * cancelled). Three buttons, the current one pressed; Showed and No-show wait
 * for the appointment to start. The result is said in a polite status region
 * (plan Part F8), and Bookings is read again with it.
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
  const current = state.status === "saved" ? state.outcome : props.current;
  return (
    <form action={action} className="mt-3">
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
      <p aria-live="polite" className="text-muted mt-1 text-sm">
        {state.status === "idle"
          ? props.started
            ? null
            : "Showed and No-show open once the appointment starts."
          : state.message}
      </p>
    </form>
  );
}

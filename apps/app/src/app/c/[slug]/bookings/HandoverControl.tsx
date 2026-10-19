"use client";

import { useActionState } from "react";

import { markHandover, type HandoverFormState } from "./handover-actions";

/**
 * "Mark handled" on a handover under Needs you: one button, once the desk
 * has spoken to the person. It cannot be undone, and the result is said in a
 * polite status region (plan Part F8) while Bookings is read again without it.
 */
export function HandoverControl(props: { slug: string; handoverId: string }) {
  const [state, action, pending] = useActionState<HandoverFormState, FormData>(
    markHandover.bind(null, props.slug),
    { status: "idle" },
  );
  return (
    <div className="mt-3">
      <form action={action}>
        <input type="hidden" name="handoverId" value={props.handoverId} />
        <button
          type="submit"
          disabled={pending || state.status === "saved"}
          aria-describedby={`handover-${props.handoverId}-name`}
          className="border-line min-h-11 rounded-full border bg-white px-4 text-sm font-semibold disabled:opacity-50"
        >
          Mark handled
        </button>
      </form>
      <p aria-live="polite" className="text-muted mt-1 text-sm">
        {state.status === "idle" ? null : state.message}
      </p>
    </div>
  );
}

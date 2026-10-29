"use client";

import { ErrorState, STATE_ACTION_CLASS } from "./states";

/**
 * The portal's route-level error boundary. It shows our sentence, never the
 * thrown message (which can carry a query or a patient's detail); the digest
 * is an opaque id for the log. Retry re-renders the segment.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <ErrorState
        reference={error.digest ?? null}
        action={
          <button type="button" onClick={reset} className={STATE_ACTION_CLASS}>
            Try again
          </button>
        }
      />
    </div>
  );
}

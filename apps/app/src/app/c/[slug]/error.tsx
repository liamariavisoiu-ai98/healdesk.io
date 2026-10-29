"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { ErrorState, STATE_ACTION_CLASS } from "./states";

/**
 * The portal's route-level error boundary. It renders without PortalShell, so
 * it offers its own way home and points at no menu. It shows our sentence,
 * never the thrown message (which can carry a query or a patient's detail);
 * the digest is an opaque id for the log. `retry` re-fetches and re-renders
 * the segment, which is what Try again should do after a failed read; `reset`
 * would only clear the error and re-render what failed to load.
 */
export default function PortalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : null;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <ErrorState
        as="h1"
        reference={error.digest ?? null}
        action={
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => retry()} className={STATE_ACTION_CLASS}>
              Try again
            </button>
            {slug ? (
              <Link href={`/c/${encodeURIComponent(slug)}`} className={STATE_ACTION_CLASS}>
                Back to Home
              </Link>
            ) : null}
          </div>
        }
      />
    </main>
  );
}

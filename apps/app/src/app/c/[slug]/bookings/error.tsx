"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * Bookings could not load. Says so plainly, offers a retry and a way home,
 * and shows nothing from the error (it could carry a patient detail).
 */
export default function BookingsError({ reset }: { error: Error; reset: () => void }) {
  const params = useParams<{ slug: string }>();
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Bookings</h1>
      <div role="alert" className="border-line mt-4 rounded-xl border bg-white px-4 py-3">
        <p className="font-semibold">We couldn&rsquo;t load your bookings.</p>
        <p className="text-muted mt-1 text-sm">
          Nothing was changed. Try again, and if it keeps happening, tell us from Help.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white"
          >
            Try again
          </button>
          <Link
            href={`/c/${params.slug}`}
            className="border-line inline-flex min-h-11 items-center rounded-full border bg-white px-5 text-sm font-semibold"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </main>
  );
}

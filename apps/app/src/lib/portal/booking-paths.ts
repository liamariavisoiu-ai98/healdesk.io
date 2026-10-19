/**
 * Where Bookings lives, and one request on it: the emailed links and a
 * decision land here. Pure, with no imports, so the background worker's jobs
 * (the daily summary) build the same links as the portal without loading the
 * portal's request-scoped modules. lib/portal/bookings.ts re-exports both.
 */

/** Bookings, or one request on it: where the emailed link, and a decision, land. */
export function bookingsPath(slug: string): string {
  return `/c/${slug}/bookings`;
}

/** One request on Bookings. The id is a UUID, never anything of the person. */
export function bookingRequestPath(slug: string, requestId: string): string {
  return `${bookingsPath(slug)}?request=${encodeURIComponent(requestId)}`;
}

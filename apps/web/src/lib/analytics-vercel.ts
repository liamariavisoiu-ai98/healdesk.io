import { isAnalyticsExcludedPath, scrubUrl } from "@/lib/analytics";

/** The two events Vercel Web Analytics hands to `beforeSend` (a page view, or a custom event). */
export type VercelAnalyticsEvent = { type: "pageview" | "event"; url: string };

/**
 * `beforeSend` for Vercel Web Analytics (added 25 October 2026), held to the
 * same rules as PostHog (components/analytics/PostHogProvider.tsx):
 *
 *   - nothing is sent for a visitor who opted out or whose browser sends
 *     Global Privacy Control (`allowed`, from lib/consent-store.ts, is read
 *     again for every event, so an opt-out made mid-visit stops the next one);
 *   - nothing is sent from /admin or a personalised demo, whose slug is the
 *     only key to that demo (isAnalyticsExcludedPath);
 *   - on the purchase pages the query string and fragment are dropped, since
 *     they carry a lead id, a campaign or a setup token (scrubUrl).
 *
 * Returning null discards the event, the documented way to filter in
 * @vercel/analytics. Pure, so it is tested without the vendor.
 */
export function vercelBeforeSend<E extends VercelAnalyticsEvent>(event: E, allowed: boolean): E | null {
  if (!allowed) return null;
  let pathname: string;
  try {
    pathname = new URL(event.url, "https://healdesk.invalid").pathname;
  } catch {
    // A URL that cannot be read cannot be shown to be safe.
    return null;
  }
  if (isAnalyticsExcludedPath(pathname)) return null;
  return { ...event, url: scrubUrl(event.url) };
}

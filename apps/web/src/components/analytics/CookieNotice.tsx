"use client";

import { useEffect, useState } from "react";

import { getConsent, setConsent } from "@/lib/consent-store";

/**
 * The cookie notice.
 *
 * A small band at the bottom of the screen, not a modal: it does not block
 * reading, does not trap focus, and both buttons persist a real answer.
 * "Decline" is as easy as "Accept" and the site is identical either way —
 * the only thing consent switches on is funnel analytics
 * (components/analytics/PostHogProvider.tsx).
 *
 * Rendered only after mount, so the server and first client paint agree
 * (localStorage does not exist on the server) and the notice never flashes
 * for a visitor who already answered.
 */
export function CookieNotice() {
  const [open, setOpen] = useState(false);

  // One read after mount, for the reason given above. useSyncExternalStore over
  // onConsentChange would also open and close the notice as other tabs answer or
  // clear the choice; with one read it follows the answer stored when the page
  // loaded and this tab's own buttons.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage, after hydration
    setOpen(getConsent() === null);
  }, []);

  // The only thing consent switches on is PostHog, and PostHogProvider never
  // initialises without this key. A notice offering "Accept analytics" for
  // analytics that cannot run is a question with no consequence, so a build
  // without the key asks nothing. Inlined at build time, like every
  // NEXT_PUBLIC_ value, so this is a constant per deployment.
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  if (!open) return null;

  const answer = (state: "granted" | "denied") => {
    setConsent(state);
    setOpen(false);
  };

  return (
    <aside
      role="region"
      aria-label="Cookie notice"
      aria-live="polite"
      className="border-line fixed inset-x-3 bottom-3 z-40 mx-auto max-w-[720px] rounded-md border bg-white p-4 shadow-lg sm:inset-x-6 sm:p-5"
    >
      <p className="text-ink text-[15px] leading-relaxed">
        We measure page views and funnel steps to see what works — no ads, no
        resale, nothing shared with advertising platforms. The demo sets one
        functional cookie regardless.{" "}
        <a href="/privacy" className="text-red-deep underline underline-offset-2">
          Privacy policy
        </a>
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => answer("granted")}
          className="bg-ink rounded-full px-4 py-2 text-[14.5px] font-bold text-white transition-opacity hover:opacity-90"
        >
          Accept analytics
        </button>
        <button
          type="button"
          onClick={() => answer("denied")}
          className="border-line-strong text-ink hover:border-ink rounded-full border px-4 py-2 text-[14.5px] font-bold transition-colors"
        >
          Decline
        </button>
      </div>
    </aside>
  );
}

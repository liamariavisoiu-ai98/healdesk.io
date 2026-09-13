"use client";

import { clearConsent } from "@/lib/consent-store";

/**
 * "Change my cookie choice", for the privacy policy.
 *
 * The cookie-notice answer lives in localStorage, so "clear your cookies"
 * would not re-ask it — which is why the policy offers this button instead
 * of that instruction. Clearing the stored answer and reloading is the
 * simplest thing that is guaranteed to show the notice again with analytics
 * off; PostHog's own cookie, if one was set, is abandoned by the opt-out on
 * the next load and expires on its own.
 */
export function CookieChoice() {
  return (
    <button
      type="button"
      onClick={() => {
        clearConsent();
        window.location.reload();
      }}
      className="border-line-strong text-ink hover:border-ink rounded-full border px-3 py-1 text-[14px] font-bold transition-colors"
    >
      Change my cookie choice
    </button>
  );
}

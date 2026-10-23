"use client";

import { useSyncExternalStore } from "react";

import { getConsent, onConsentChange, setConsent } from "@/lib/consent-store";

/**
 * The analytics opt-out, for the privacy policy.
 *
 * The choice lives in localStorage, so "clear your cookies" would not undo it,
 * which is why the policy offers this button instead of that instruction.
 * Turning analytics off takes effect at once: PostHogProvider hears the change
 * and stops capturing in the same tab; its cookie is abandoned and expires on
 * its own. The button turns it back on the same way.
 */
export function CookieChoice() {
  const state = useSyncExternalStore(
    (notify) => onConsentChange(() => notify()),
    getConsent,
    () => null,
  );
  const off = state === "denied";

  return (
    <button
      type="button"
      onClick={() => setConsent(off ? "granted" : "denied")}
      className="border-line-strong text-ink hover:border-ink rounded-full border px-3 py-1 text-[14px] font-bold transition-colors"
    >
      {off ? "Analytics is off. Turn it back on" : "Turn analytics off"}
    </button>
  );
}

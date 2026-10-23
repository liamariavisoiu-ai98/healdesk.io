"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { attachAnalyticsClient, isAnalyticsExcludedPath, scrubEvent } from "@/lib/analytics";
import { analyticsAllowed, getConsent, onConsentChange, type ConsentState } from "@/lib/consent-store";

/**
 * Initialises PostHog, unless the visitor opted out.
 *
 * Opt-out since 23 October 2026 (owner; the cookie note informs and asks
 * nothing, lib/consent-store.ts). Nothing here runs on the server, nothing
 * runs without NEXT_PUBLIC_POSTHOG_KEY, and nothing runs for a visitor who
 * opted out on /privacy or whose browser sends Global Privacy Control. The
 * library is imported dynamically inside the allowed branch, so a visitor who
 * opted out never even downloads it.
 *
 * Settings, and why each one:
 *   - api_host on the US cloud: the client base is US, so the data stays
 *     in the region the customers are in (moved from the EU cloud on
 *     23 September 2026).
 *   - persistence "localStorage+cookie": the cookie is set from the first
 *     visit, which is what the cookie note says; an opt-out creates no client
 *     at all, or stops the one running.
 *   - autocapture off: clicks and form fields are never harvested; only the
 *     named events in src/lib/analytics.ts are sent.
 *   - session recording and surveys off, mask_all_text on as defence in depth.
 *   - respect_dnt: a browser that asks not to be tracked is not tracked.
 *   - capture_pageview "history_change": one pageview per client-side route
 *     change; never on the excluded paths.
 *   - before_send `scrubEvent`: the purchase pages' query strings (a lead id,
 *     a campaign, a package) never leave the browser in a URL property.
 */
export function PostHogProvider() {
  const pathname = usePathname();

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;
    if (isAnalyticsExcludedPath(pathname)) {
      attachAnalyticsClient(null);
      return;
    }

    let cancelled = false;
    let instance: Awaited<typeof import("posthog-js")>["default"] | null = null;

    async function start(state: ConsentState) {
      if (!analyticsAllowed(state)) {
        if (instance) instance.opt_out_capturing();
        attachAnalyticsClient(null);
        return;
      }
      if (!instance) {
        const mod = await import("posthog-js");
        if (cancelled) return;
        instance = mod.default;
        instance.init(key as string, {
          api_host: "https://us.i.posthog.com",
          ui_host: "https://us.posthog.com",
          persistence: "localStorage+cookie",
          autocapture: false,
          capture_pageview: "history_change",
          capture_pageleave: false,
          disable_session_recording: true,
          disable_surveys: true,
          mask_all_text: true,
          mask_all_element_attributes: true,
          respect_dnt: true,
          person_profiles: "identified_only",
          before_send: scrubEvent,
        });
      }
      instance.opt_in_capturing();
      attachAnalyticsClient(instance);
    }

    void start(getConsent());
    const off = onConsentChange((state) => void start(state));
    return () => {
      cancelled = true;
      off();
    };
  }, [pathname]);

  return null;
}

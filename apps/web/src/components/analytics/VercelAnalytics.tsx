"use client";

import { Analytics } from "@vercel/analytics/next";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

import { vercelBeforeSend } from "@/lib/analytics-vercel";
import { isAnalyticsExcludedPath } from "@/lib/analytics";
import { analyticsAllowed, getConsent, onConsentChange } from "@/lib/consent-store";

const subscribe = (notify: () => void) => onConsentChange(() => notify());
const allowedNow = () => analyticsAllowed(getConsent());
// On the server, and while hydrating, nothing is allowed: the first paint
// matches the server's and the script is mounted only after the browser has
// read the visitor's choice.
const allowedOnServer = () => false;

/**
 * Vercel Web Analytics, cookieless and first-party (`/_vercel/insights`), held
 * to the same rules as PostHog (see lib/analytics-vercel.ts): not mounted for
 * a visitor who opted out or sends Global Privacy Control, not on /admin or a
 * personalised demo, and its events lose the purchase pages' query strings.
 * Nothing renders on the server. A visitor who opted out never downloads the
 * script; one who opts out mid-visit stops sending at the next event
 * (`beforeSend` reads the choice again every time) and loses the component on
 * the change.
 *
 * Web Analytics must also be switched on for the project in Vercel (the
 * Analytics tab); until then the script request is a 404 and nothing is sent.
 */
export function VercelAnalytics() {
  const pathname = usePathname();
  const allowed = useSyncExternalStore(subscribe, allowedNow, allowedOnServer);

  if (!allowed || isAnalyticsExcludedPath(pathname)) return null;
  return <Analytics beforeSend={(event) => vercelBeforeSend(event, analyticsAllowed(getConsent()))} />;
}

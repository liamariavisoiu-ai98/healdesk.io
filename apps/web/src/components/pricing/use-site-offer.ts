"use client";

import { useEffect, useState } from "react";

/**
 * The website's setup offer as a page sees it: 30% off the setup fee for 48
 * hours from the first time this browser was shown it (catalog
 * `SITE_SETUP_CREDIT`, owner, 13 October 2026).
 *
 * The page never decides the offer. On mount it asks POST /api/site-offer,
 * which starts the clock in a signed httpOnly cookie if it has not started
 * and answers when it ends (lib/site-offer.ts); /api/checkout reads the same
 * cookie to decide whether the credit goes on the Session. So the countdown
 * here is a display of the server's moment, and a visitor who edits the clock
 * on the page changes nothing they are charged.
 *
 * Until the answer arrives, and whenever it is null or past, the offer is
 * off: server rendering, a blocked script and a failed request all show the
 * list price, never a discount the server would not honour.
 */
export type SiteOffer = {
  /** When the offer ends, or null when there is none. */
  endsAt: Date | null;
  /** Milliseconds left, 0 when there is no offer. */
  remainingMs: number;
  live: boolean;
};

export function useSiteOffer(): SiteOffer {
  const [endsAt, setEndsAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/site-offer", { method: "POST", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { endsAt?: unknown } | null) => {
        if (cancelled || !body || typeof body.endsAt !== "string") return;
        const at = new Date(body.endsAt);
        if (Number.isFinite(at.getTime())) {
          setNow(Date.now());
          setEndsAt(at);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const remainingMs = endsAt ? Math.max(0, endsAt.getTime() - now) : 0;
  const live = remainingMs > 0;

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [live]);

  return { endsAt, remainingMs, live };
}

/** "47:59:12": hours, minutes and seconds left, the hours unpadded past 99. */
export function countdownLabel(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1_000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)}`;
}

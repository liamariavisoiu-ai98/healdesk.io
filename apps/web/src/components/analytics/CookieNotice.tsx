"use client";

import { useEffect, useState } from "react";

import { cookieNoteSeen, markCookieNoteSeen } from "@/lib/consent-store";

/**
 * The cookie note.
 *
 * One quiet line in the bottom corner that says what the site does, and goes
 * the moment the visitor does anything: scrolls, presses, taps, types. It asks
 * nothing, because analytics is opt-out (owner, 23 October 2026; the opt-out
 * is on /privacy, lib/consent-store.ts). It is not a banner and not a modal:
 * a pill the width of its words, never over the middle of the page, with
 * `pointer-events` only on itself so it blocks nothing beneath it.
 *
 * Once it has gone it does not come back on this browser (the seen flag in
 * lib/consent-store.ts). A browser that cannot store it shows it once per
 * visit, which is the safe direction.
 *
 * Rendered only after mount, so the server and first client paint agree
 * (localStorage does not exist on the server) and it never flashes for a
 * visitor who has already seen it. A scroll in the first moments is the
 * browser restoring a position or the page settling, not the visitor, so
 * interaction counts only after a short grace.
 */

/** Long enough to be read before the page's own first scroll or layout shift can count as the visitor. */
const GRACE_MS = 1200;
/** Matches the fade in globals.css (`.cookie-note`). */
const FADE_MS = 280;

const INTERACTIONS = ["scroll", "wheel", "touchstart", "pointerdown", "keydown"] as const;

export function CookieNotice() {
  const [phase, setPhase] = useState<"hidden" | "shown" | "leaving">("hidden");

  useEffect(() => {
    // The only thing the note describes is PostHog's cookie, and PostHogProvider
    // never starts without this key, so a build without it says nothing. Inlined
    // at build time like every NEXT_PUBLIC_ value: a constant per deployment.
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || cookieNoteSeen()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage, after hydration
    setPhase("shown");

    let armed = false;
    let leave: number | undefined;
    const arm = window.setTimeout(() => {
      armed = true;
    }, GRACE_MS);

    const dismiss = (event: Event) => {
      if (!armed) return;
      // Pressing the note's own link is an interaction with the note, not a
      // reason to take it away from under the pointer before the click lands.
      if (event.target instanceof Element && event.target.closest("[data-cookie-note]")) return;
      for (const name of INTERACTIONS) window.removeEventListener(name, dismiss, true);
      markCookieNoteSeen();
      setPhase("leaving");
      leave = window.setTimeout(() => setPhase("hidden"), FADE_MS);
    };
    for (const name of INTERACTIONS) window.addEventListener(name, dismiss, { capture: true, passive: true });

    return () => {
      window.clearTimeout(arm);
      window.clearTimeout(leave);
      for (const name of INTERACTIONS) window.removeEventListener(name, dismiss, true);
    };
  }, []);

  if (phase === "hidden") return null;

  return (
    <aside
      data-cookie-note
      data-leaving={phase === "leaving" ? "" : undefined}
      role="note"
      aria-label="Cookies"
      className="cookie-note"
    >
      <span>This site uses a cookie to count visits.</span>{" "}
      <a href="/privacy#cookies">Opt out</a>
    </aside>
  );
}

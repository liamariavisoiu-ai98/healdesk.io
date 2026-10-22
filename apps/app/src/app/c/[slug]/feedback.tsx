"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * The portal's one polite status region (plan Part F8: "a polite status
 * region for saves"): every save on Settings and Knowledge is announced once,
 * here, as a toast naming its consequence. A confirmation goes after a few
 * seconds; a problem stays until it is closed or replaced, and links to the
 * step-up when that is what it needs.
 */

export type Toast = {
  text: string;
  tone: "ok" | "problem";
  stepUpHref?: string;
  /** Where the confirmation's next step is done, e.g. a new location's details. */
  link?: { href: string; label: string };
} | null;

export const AnnounceContext = createContext<(toast: Toast) => void>(() => undefined);

/** How long a confirmation stays on screen. A problem stays until it is closed or replaced. */
const TOAST_MS = 8000;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => {
    // A confirmation with a next step to take stays, like a problem, so its
    // link is not gone before it can be followed.
    if (!toast || toast.tone !== "ok" || toast.link) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <AnnounceContext.Provider value={setToast}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4"
      >
        {toast ? (
          <div
            className={`pointer-events-auto flex max-w-xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-lg ${
              toast.tone === "ok"
                ? "border-line bg-ink text-white"
                : "border-red-200 bg-white text-red-800"
            }`}
          >
            <p>
              {toast.text}
              {toast.stepUpHref ? (
                <>
                  {" "}
                  <a href={toast.stepUpHref} className="font-semibold underline">
                    Confirm it&rsquo;s you
                  </a>
                </>
              ) : null}
              {toast.link ? (
                <>
                  {" "}
                  <a href={toast.link.href} className="font-semibold underline">
                    {toast.link.label}
                  </a>
                </>
              ) : null}
            </p>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="-my-2 -mr-2 min-h-11 min-w-11 shrink-0 text-lg leading-none"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
    </AnnounceContext.Provider>
  );
}

/** Announce a result: "ok" or "problem", with the step-up link when one is needed. */
export function useAnnounce(): (toast: Toast) => void {
  return useContext(AnnounceContext);
}

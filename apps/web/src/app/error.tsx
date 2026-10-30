"use client";

import { useEffect } from "react";

import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { track } from "@/lib/analytics";
import { site } from "@/lib/site";

/**
 * The error boundary for every route below the root layout.
 *
 * ## What lands here
 *
 * Mostly the chat demo. It is the most fragile thing on the site: it talks to
 * a model through /api/chat, renders a streamed reply, and a thrown error in
 * that client tree used to fall through to Next's unstyled default screen, in
 * front of a prospect who had just been told the product never fails. The
 * boundary keeps the navbar and footer around the failure so it reads as a
 * hiccup inside a working site rather than a dead site.
 *
 * ## Retry, not reset
 *
 * This Next exposes both. `reset()` clears the boundary and re-renders its
 * children from whatever state they had; `retry()` re-fetches the segment
 * first. The failures we expect here are transient, a dropped stream, a
 * model timeout, so re-fetching is the version of "try again" that can
 * actually succeed. `reset` stays in the props type so the older convention
 * still type-checks if a caller relies on it.
 *
 * ## What the visitor is told
 *
 * Nothing about the error. In production Next replaces a server error's
 * message with a digest so nothing sensitive leaks, and a client error's
 * message is developer prose that means nothing to a clinic owner. The digest
 * is logged so support can match it, and the page offers the two exits that
 * matter: try again, or talk to a person.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // The digest is the only thing worth sending: it is what support matches
    // against the server log, and it carries nothing a visitor typed. `track`
    // is a no-op until the visitor has accepted analytics, which is the same
    // rule every other event on the site follows.
    track("client_error", { digest: error.digest ?? "none" });
  }, [error]);

  return (
    <>
      <Nav />

      <main className="mx-auto max-w-page px-5 pt-16 pb-24 sm:px-8 sm:pt-24 lg:px-14">
        <div className="max-w-[52ch]">
          <p className="eyebrow-tag">
            Something went wrong
          </p>
          <h1 className="font-display mt-3 text-[clamp(var(--text-4xl),6vw,var(--text-6xl))] leading-[1.03] font-medium tracking-[-0.028em]">
            {site.agent} dropped this one. She&rsquo;ll pick it straight back up.
          </h1>
          <p className="text-muted mt-5 text-lg font-medium">
            This part of the page hit an error on our side, not yours. Trying
            again usually fixes it. If it doesn&rsquo;t, a person will.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => retry()}
              className="bg-brand-gradient shadow-sm inline-flex items-center justify-center rounded-full px-7 py-3.5 text-lg font-bold text-white transition-transform duration-fast hover:-translate-y-0.5"
            >
              Try again
            </button>
            <a
              href="/contact"
              className="border-line text-ink hover:border-orange inline-flex items-center justify-center rounded-full border bg-white px-7 py-3.5 text-lg font-bold transition-transform duration-fast hover:-translate-y-px"
            >
              Contact us
            </a>
          </div>

          {error.digest ? (
            <p className="text-muted mt-8 text-xs">
              Reference <code className="font-mono">{error.digest}</code>, in
              case you write in.
            </p>
          ) : null}
        </div>
      </main>

      <Footer />
    </>
  );
}

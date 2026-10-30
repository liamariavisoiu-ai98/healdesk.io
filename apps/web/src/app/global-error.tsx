"use client";

import { useEffect } from "react";

import { site } from "@/lib/site";

import "./globals.css";

/**
 * The last line. This replaces the root layout when the layout itself throws,
 * which error.tsx cannot catch because it renders inside that layout.
 *
 * ## Why it is plainer than error.tsx
 *
 * It has no layout above it, so it must render its own <html> and <body>, and
 * it cannot assume anything the layout provides: no font variables, no
 * providers, no metadata export (React's <title> stands in). globals.css is
 * imported directly for the palette and the gradient utility, and the copy
 * sets in the system stack because loading next/font here would mean the
 * page that exists to survive a broken layout depends on the layout's most
 * failure-prone piece. It does not mount Nav or Footer for the same reason:
 * both import client modules that, if they are what broke, would break again.
 *
 * The wordmark image and the two links are plain anchors on purpose. A full
 * reload is the right recovery when the shell itself has failed, and `retry`
 * is offered alongside for the transient case.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <title>{`Something went wrong, ${site.name}`}</title>

        <main className="mx-auto flex min-h-screen max-w-page flex-col px-5 py-10 sm:px-8 lg:px-14">
          <a href="/" aria-label={`${site.name} home`} className="inline-block">
            <img
              src="/brand/healdesk-logo.webp"
              alt=""
              width={154}
              height={28}
              className="block h-[28px] w-auto select-none"
            />
          </a>

          <div className="mt-16 max-w-[52ch] sm:mt-24">
            <p className="eyebrow-tag">
              Something went wrong
            </p>
            <h1 className="mt-3 text-[clamp(var(--text-3xl),5.5vw,var(--text-6xl))] leading-[1.05] font-semibold tracking-[-0.025em]">
              The page didn&rsquo;t load. {site.agent} is still answering the
              phone.
            </h1>
            <p className="text-muted mt-5 text-lg font-medium">
              An error on our side stopped this page from rendering. Reload to
              try again, or write to a person and we&rsquo;ll sort it out.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => retry()}
                className="bg-brand-gradient inline-flex items-center justify-center rounded-full px-7 py-3.5 text-lg font-bold text-white"
              >
                Try again
              </button>
              <a
                href="/"
                className="border-line text-ink inline-flex items-center justify-center rounded-full border bg-white px-7 py-3.5 text-lg font-bold"
              >
                Back to the homepage
              </a>
              <a
                href={`mailto:${site.email}`}
                className="text-muted text-lg font-semibold underline underline-offset-2"
              >
                {site.email}
              </a>
            </div>

            {error.digest ? (
              <p className="text-muted mt-8 text-xs">
                Reference <code>{error.digest}</code>, in case you write in.
              </p>
            ) : null}
          </div>
        </main>
      </body>
    </html>
  );
}

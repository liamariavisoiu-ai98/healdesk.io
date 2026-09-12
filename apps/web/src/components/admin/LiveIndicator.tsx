"use client";

import { useEffect, useState } from "react";

import type { ChangeSource } from "@/lib/admin/types";

/**
 * The one line on the admin page that says where the numbers came from, how old
 * they are, and what went wrong getting them.
 *
 * ## Why the source is spelled out instead of implied
 *
 * The changes payload has two possible origins and they do not agree with each
 * other. GitHub knows what has been pushed. The local checkout knows what has
 * been *written*, including commits that exist only on this laptop. A dashboard
 * that shows one and lets you assume the other is worse than no dashboard: you
 * look at a quiet feed and conclude nothing happened, when in fact the reader
 * is pointed somewhere else. So the source gets a full sentence, not an icon.
 *
 * ## Why warnings are rendered here and not logged
 *
 * `ChangesPayload.warnings` carries the non-fatal failures, a rate-limited API
 * call, a missing token, a file list the server had to truncate. Every one of
 * them makes some number on the page smaller than the truth. Swallowing them
 * turns an honest "we could not read all of it" into a silent, confident, wrong
 * chart. They render, always, in the place people are already looking.
 *
 * ## Why the clock starts null
 *
 * "8s ago" cannot be computed on the server: the server does not have the
 * reader's clock, and rendering one during SSR guarantees a hydration mismatch
 * on the very first paint. `useTickingNow` returns null until the component has
 * mounted in a browser, and until then every caller renders `formatUtc`, a
 * real timestamp, in a timezone it names, that both runtimes agree on. An
 * elapsed time we do not yet know is never guessed at.
 *
 * ## Why the time helpers live in this file
 *
 * `ChangeFeed` needs the same clock and the same phrasing, and two hand-copied
 * implementations of "how long ago" is exactly how two parts of one screen
 * start disagreeing. So there is one implementation and `ChangeFeed` imports
 * it from here.
 *
 * Here rather than in a shared `lib/admin/time.ts` because this is the file
 * that uses them most and there are only two callers. If a third appears, that
 * is the moment to hoist them, a file move and an import rewrite, nothing
 * more. What must not happen is a second copy.
 */

/* --------------------------------------------------------------- the clock -- */

/**
 * A `Date.now()` that re-renders on an interval, and is `null` until mounted.
 *
 * Null is not a placeholder for zero. It means "this browser has not told us
 * the time yet", and callers are expected to say so rather than guess.
 */
export function useTickingNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return now;
}

/** Parse an ISO string from the payload. Null when it is not a real date. */
export function parseIso(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Intl objects are expensive to build and these are called once per commit per
// tick, so they are created lazily and kept.
let relativeFormat: Intl.RelativeTimeFormat | null = null;
let absoluteFormat: Intl.DateTimeFormat | null = null;

function relativeFormatter(): Intl.RelativeTimeFormat {
  const existing = relativeFormat;
  if (existing !== null) return existing;
  const created = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  relativeFormat = created;
  return created;
}

function absoluteFormatter(): Intl.DateTimeFormat {
  const existing = absoluteFormat;
  if (existing !== null) return existing;
  const created = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  absoluteFormat = created;
  return created;
}

const UNITS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

/** "4 minutes ago", "yesterday". The phrasing the commit feed uses. */
export function formatRelativeLong(atMs: number, nowMs: number): string {
  const formatter = relativeFormatter();
  const delta = atMs - nowMs; // negative in the past, which is what Intl wants
  const magnitude = Math.abs(delta);

  for (const step of UNITS) {
    if (magnitude >= step.ms) {
      return formatter.format(Math.round(delta / step.ms), step.unit);
    }
  }
  return formatter.format(0, "second");
}

/** "8s ago". The compact phrasing the status line uses, because it ticks. */
export function formatRelativeShort(atMs: number, nowMs: number): string {
  // A future timestamp means clock skew between the server and this browser,
  // not a commit from the future. Clamp rather than print "-3s ago".
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Deterministic, timezone-explicit, identical on the server and in the browser.
 *
 * This is what gets rendered before `useTickingNow` has a clock. `formatAbsolute`
 * cannot be used there: it resolves the *runtime's* locale and timezone, which
 * differ between the server that rendered the HTML and the browser that hydrates
 * it, and the result is a hydration mismatch on the very text that is supposed
 * to be the trustworthy one.
 */
export function formatUtc(atMs: number): string {
  return `${new Date(atMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The full timestamp, for `title` attributes. Browser locale and timezone. */
export function formatAbsolute(atMs: number): string {
  return absoluteFormatter().format(new Date(atMs));
}

/* ---------------------------------------------------------------- the line -- */

export type LiveIndicatorProps = {
  source: ChangeSource;
  /**
   * From `ChangesPayload.ok`. False means nothing was read, and this line must
   * not then describe a source as though it had been: "Reading github.com,
   * pushed history only" is a confident sentence about a request that failed.
   */
  ok: boolean;
  /**
   * From `ChangesPayload.totals.complete`. Whether the figures below account
   * for the whole window.
   *
   * The closing line of the warning box used to be chosen from
   * `warnings.length > 0` alone, and so said "the repository figures below may
   * be lower than the truth" over every warning there is. Most of them do not
   * mean that: the default local read is clean, complete, and still carries a
   * note that the *feed* lists forty of fifty commits. Hedging a complete total
   * is the same fault as printing a partial one confidently, pointed the other
   * way. It apologises for a number that is right.
   *
   * Defaults to true, so a caller that says nothing claims no shortfall.
   */
  complete?: boolean;
  /** ISO 8601, from `ChangesPayload.fetchedAt`. */
  fetchedAt: string;
  isRefreshing: boolean;
  warnings: string[];
  /**
   * Optional "owner/repo", so the GitHub sentence can name the repository it is
   * reading.
   *
   * Nothing passes it today, and that is a gap rather than a decision:
   * `ChangesPayload` carries no repo field, so the only place that knows the
   * slug is `repoSlug()` inside the loader and it does not put it in the
   * payload. Adding it is a contract change, which is why this stayed optional
   * instead of being faked from `HEALDESK_REPO` in the browser. That variable
   * is server-side and a client guess at it would be exactly the invented fact
   * this component exists to refuse. Without it the sentence still
   * distinguishes GitHub from the local checkout, which is the part that must
   * never be ambiguous.
   */
  repo?: string | null;
};

export function LiveIndicator({
  source,
  ok,
  complete = true,
  fetchedAt,
  isRefreshing,
  warnings,
  repo = null,
}: LiveIndicatorProps) {
  const now = useTickingNow(1000);
  const fetchedMs = parseIso(fetchedAt);

  // Three sentences, not two. A failed read still has to fill `source`, and
  // describing where we would have read from as though we had read from it is
  // the exact guess-as-fact this line exists to avoid. "unknown" is the loader
  // saying it never got far enough to know.
  const headline = !ok
    ? "Could not read this repository"
    : source === "github"
      ? `Reading github.com${repo ? `/${repo}` : ""}`
      : "Reading your local checkout";

  const qualifier = !ok
    ? source === "unknown"
      ? ": the read failed before it reached GitHub or a checkout. Nothing below was measured."
      : source === "github"
        ? ": GitHub did not answer. Nothing below was measured."
        : ": no local checkout could be read. Nothing below was measured."
    : source === "github"
      ? ": pushed history only, so anything still on a laptop is not here."
      : ": includes unpushed work, so this is ahead of what GitHub can see.";

  return (
    <div className="border-line rounded-2xl border bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          aria-hidden
          className="relative grid size-2.5 shrink-0 place-items-center"
        >
          {isRefreshing ? (
            <span className="bg-orange absolute inset-0 animate-ping rounded-full opacity-70" />
          ) : null}
          <span
            className={[
              "relative size-2.5 rounded-full",
              // Brand colours read as "healthy" at a glance, so a read that
              // measured nothing does not get them.
              !ok ? "bg-red" : source === "github" ? "bg-brand-gradient" : "bg-ink",
            ].join(" ")}
          />
        </span>

        <p className="min-w-0 text-[15.6px] leading-snug">
          {/* No separator between them: every `qualifier` above opens with the
              colon that joins it to the headline, so a space here would render
              "Reading your local checkout : includes unpushed work". */}
          <span className="font-bold">{headline}</span>
          <span className="text-muted font-medium">{qualifier}</span>
        </p>

        <span className="text-muted ml-auto shrink-0 text-[15.6px] font-semibold tabular-nums">
          {fetchedMs === null ? (
            // The server stamped something we cannot parse. Say that; do not
            // silently substitute the current time.
            <span title={fetchedAt}>update time unreadable</span>
          ) : now === null ? (
            // Pre-hydration: no browser clock yet, so no "8s ago" to compute.
            <span title={fetchedAt}>updated {formatUtc(fetchedMs)}</span>
          ) : (
            <span title={formatAbsolute(fetchedMs)}>
              updated {formatRelativeShort(fetchedMs, now)}
            </span>
          )}
        </span>

        {isRefreshing ? (
          <span className="text-muted shrink-0 text-[12px] font-bold tracking-[0.14em] uppercase">
            refreshing
          </span>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div
          role="status"
          className="border-line-strong bg-paper-2 mt-3 rounded-xl border px-3 py-2.5"
        >
          <p className="text-[13.2px] font-bold tracking-[0.12em] uppercase">
            {warnings.length === 1
              ? "1 thing did not read cleanly"
              : `${warnings.length} things did not read cleanly`}
          </p>
          <ul className="mt-1.5 space-y-1">
            {warnings.map((warning, index) => (
              <li
                key={`${index}-${warning}`}
                className="flex gap-2 text-[15.6px] leading-relaxed font-medium"
              >
                <span aria-hidden className="text-red-deep shrink-0 font-bold">
                  !
                </span>
                <span className="min-w-0">{warning}</span>
              </li>
            ))}
          </ul>
          <p className="text-muted mt-2 text-[14.4px] font-medium">
            {/* Scoped to the repository figures, because `ok` is only
                `ChangesPayload.ok`. The roadmap board below has its own `ok`
                and is frequently fine while this one is not, a blanket
                "nothing below was measured" over a fully populated board of
                102 tasks is the same kind of overreach this line exists to
                stop. */}
            {!ok
              ? "The repository figures below were not measured, so they are blank rather than zero."
              : complete
                ? // The read reached the whole window. Whatever these notes are
                  // about, a capped list, a roadmap file, a refresh this
                  // browser could not make, none of them shortened the
                  // totals, and saying they might have would be an apology for
                  // a number that is right.
                  "The repository figures below still account for the whole window; each note above says what it does affect."
                : "The repository figures below may be lower than the truth."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

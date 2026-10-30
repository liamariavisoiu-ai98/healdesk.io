"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Change, ChangedFile } from "@/lib/admin/types";

import {
  formatAbsolute,
  formatRelativeLong,
  formatUtc,
  parseIso,
  useTickingNow,
} from "./LiveIndicator";

/**
 * The commit timeline. This is the thing the owner actually asked to watch.
 *
 * ## How a new commit announces itself, and why it is not only motion
 *
 * The feed is polled, so a new commit arrives as a new entry silently appended
 * to the top of a list you were already looking at. Nothing about that draws
 * the eye. So the component keeps the set of shas it saw on the previous
 * payload, and the authored time of the newest of them, and treats a commit as
 * new when it is absent from the first *and* later than the second.
 *
 * Three rules shape the treatment:
 *
 *   1. Nothing is new on the first payload. Highlighting all fifty commits on
 *      page load would teach the reader to ignore the highlight, which costs
 *      the one moment it exists for.
 *   2. Unseen is not the same as new, and the difference is the window buttons.
 *      Widening 7 → 90 backfills the list with commits this browser has not
 *      seen and the repository landed weeks ago; "absent from the last payload"
 *      alone badges every one of them NEW and flashes the whole feed orange,
 *      rule 1's failure, arriving through a control instead of a page load. So
 *      arrival is measured against a watermark: the newest authored time
 *      already absorbed. Only a commit later than that landed while you were
 *      watching.
 *
 *      The cost, named: a commit that arrives with an author date *older* than
 *      the watermark, a cherry-pick, a `--date` override, a long-lived branch
 *      merged in, appears without a badge. That is a missed announcement
 *      rather than a false one, which is the direction this page errs in
 *      everywhere else.
 *   3. The highlight fades, but the word "new" does not depend on it. Under
 *      `prefers-reduced-motion` the fade is switched off entirely, and the
 *      badge is still there, because a reader who has asked for no animation
 *      must not thereby lose the information the animation was carrying.
 *
 * Freshness expires against the ticking clock rather than a `setTimeout` per
 * commit. Timers here would be created and cancelled on every poll, the
 * dependency that starts them is the `changes` array, whose identity changes
 * each fetch, and the badge would simply never clear. Comparing "when did we
 * first see this sha" to "what time is it now" cannot get stuck that way.
 *
 * ## Why the keyframes are inline
 *
 * The fade needs an `@keyframes`, and `app/globals.css` is the token file for
 * the whole site, a one-off animation for one panel behind a password does not
 * belong in the sheet every marketing page downloads. One `<style>` element,
 * rendered once by the list, keeps it where it is used. It is not a pattern to
 * copy elsewhere: a second component doing this is the point at which the rule
 * belongs in the stylesheet after all.
 *
 * ## What is deliberately not colour-coded
 *
 * Area pills are one colour. There are nine areas, and nine hues on a warm
 * paper ground is noise pretending to be information, the pill already says
 * "packages/connectors" in words. Colour is spent where it distinguishes
 * something you cannot read: additions from deletions, new from settled.
 */

/**
 * Digit grouping, pinned to en-US for the same reason `AdminDashboard` pins its
 * formatter: this list is server-rendered first, and a server that groups with
 * "." against a browser that groups with "," is a hydration mismatch. Without
 * it a 116275-line commit prints as a wall of digits beside a stat strip that
 * says 116,275, and the two stop looking like the same number.
 */
const NUMBER = new Intl.NumberFormat("en-US");

/** How long a commit keeps its "new" badge after we first see it. */
const FRESH_MS = 45_000;

/** Relative times only need to be roughly right; a slow tick is cheaper. */
const TICK_MS = 10_000;

/** Files shown per commit before the list is capped. */
const MAX_VISIBLE_FILES = 8;

const EMPTY_FRESH: ReadonlySet<string> = new Set<string>();
const EMPTY_ANNOUNCED: ReadonlyMap<string, number> = new Map<string, number>();

const FRESH_KEYFRAMES = `
@keyframes hd-change-fresh {
  from {
    background-color: rgb(244 123 31 / 0.16);
    border-color: rgb(244 123 31 / 0.5);
  }
  to {
    background-color: transparent;
    border-color: transparent;
  }
}
.hd-change-fresh {
  animation: hd-change-fresh 2600ms cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
}
@media (prefers-reduced-motion: reduce) {
  .hd-change-fresh {
    animation: none;
  }
}
`;

const FILE_STATUS: Record<ChangedFile["status"], { mark: string; label: string }> =
  {
    added: { mark: "A", label: "added" },
    modified: { mark: "M", label: "modified" },
    removed: { mark: "D", label: "removed" },
    renamed: { mark: "R", label: "renamed" },
  };

export type ChangeFeedProps = {
  /** Newest first, straight from `ChangesPayload.changes`. */
  changes: Change[];
  /**
   * `ChangesPayload.ok`. The only thing that tells "nothing has landed" apart
   * from "we could not read the history", the two are the same empty array and
   * must never render as the same sentence.
   *
   * This used to be inferred from `warnings.length > 0`, which was wrong in a
   * quiet way: a healthy read warns about benign things (a window clamped from
   * 500 days to 365), so an empty-but-clean window could be reported as a read
   * that had failed. `ok` answers the question the empty state is actually
   * asking.
   */
  ok: boolean;
  /**
   * `ChangesPayload.warnings`. Optional, and used only to add "and some of it
   * did not read cleanly" to an otherwise-empty window.
   */
  warnings?: string[];
  /**
   * `ChangesPayload.totals.commits`, how many commits the read actually
   * counted, which on the local backend can be more than it lists.
   *
   * The feed is capped at the loader's `limit` while the chart, totals and area
   * figures count every commit in the window, so the default view lists forty
   * of fifty and the list simply stops. The cap was stated only in the warnings
   * box at the top of the page, which is the one place a reader who has scrolled
   * to the bottom of the feed is not looking, and a truncated list that says
   * nothing is a list claiming to be the whole of it. This is what lets the feed
   * disclose its own cap, at the end, where it happens.
   *
   * Optional: a caller that does not pass it claims nothing, and the note is
   * only drawn when this exceeds the number of entries actually handed over.
   */
  counted?: number;
};

export function ChangeFeed({
  changes,
  ok,
  warnings,
  counted,
}: ChangeFeedProps) {
  const now = useTickingNow(TICK_MS);

  // Every sha this browser has seen, so each one is judged once, on the
  // payload that first carries it.
  const seenRef = useRef<Set<string>>(new Set());
  // False until a first *non-empty* payload has been absorbed, so page load is
  // not "new". Emptiness matters: a parent that renders `[]` while the first
  // fetch is in flight would otherwise make the entire real payload announce
  // itself, which is the noise this whole mechanism exists to avoid.
  const primedRef = useRef(false);
  // The newest authored time this browser has already absorbed, in epoch ms.
  // See rule 2: this is what separates "landed while you were watching" from
  // "the window got wider", which are the same unseen sha.
  const newestSeenRef = useRef<number | null>(null);
  // Announced shas, each with the wall-clock moment this browser first saw it.
  // State, not a ref, because arrival has to force a paint. The moment travels
  // with the sha rather than being looked up in a ref because render reads it
  // to expire the badge, and React does not re-render for a ref.
  const [announced, setAnnounced] = useState<ReadonlyMap<string, number>>(EMPTY_ANNOUNCED);

  useEffect(() => {
    const seen = seenRef.current;
    const stamp = Date.now();
    const arrived: Array<[string, number]> = [];

    // Read once, before anything in this payload moves it, otherwise the first
    // commit of a batch raises the bar the rest of the batch is judged against.
    const watermark = newestSeenRef.current;
    let newest = watermark;

    for (const change of changes) {
      // An unreadable date cannot be shown to be later than the watermark, and
      // this page does not badge what it cannot demonstrate.
      const authoredMs = parseIso(change.authoredAt);
      if (authoredMs !== null && (newest === null || authoredMs > newest)) {
        newest = authoredMs;
      }

      if (seen.has(change.sha)) continue;
      seen.add(change.sha);

      if (
        primedRef.current &&
        watermark !== null &&
        authoredMs !== null &&
        authoredMs > watermark
      ) {
        arrived.push([change.sha, stamp]);
      }
    }

    newestSeenRef.current = newest;
    if (changes.length > 0) primedRef.current = true;

    if (arrived.length > 0) {
      // Set here, after commit, rather than during render from the previous
      // payload kept in state, the usual cure for the rule disabled below. The
      // badge lasts `FRESH_MS` from the moment the payload was absorbed, that
      // moment is a reading of the wall clock, and render must not take one.
      // The cost is an extra render and commit on the rare poll that brings a
      // commit: it is painted for one frame before its badge appears.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- stamped off the wall clock
      setAnnounced((previous) => new Map([...previous, ...arrived]));
    }
  }, [changes]);

  const fresh = useMemo(() => {
    if (now === null || announced.size === 0) return EMPTY_FRESH;
    const live = new Set<string>();
    for (const [sha, seenAt] of announced) {
      if (now - seenAt < FRESH_MS) live.add(sha);
    }
    return live;
  }, [now, announced]);

  if (changes.length === 0) {
    return <EmptyFeed ok={ok} warnings={warnings} />;
  }

  const undisclosed =
    counted === undefined ? 0 : Math.max(0, counted - changes.length);

  return (
    <div>
      <style>{FRESH_KEYFRAMES}</style>

      <ol className="relative">
        {changes.map((change, index) => (
          <ChangeEntry
            key={change.sha}
            change={change}
            now={now}
            isFresh={fresh.has(change.sha)}
            isLast={index === changes.length - 1}
          />
        ))}
      </ol>

      {undisclosed > 0 ? (
        <TruncationNote listed={changes.length} counted={counted ?? 0} />
      ) : null}
    </div>
  );
}

/**
 * The end of a list that is not the end of the window.
 *
 * Sat at the foot of the feed rather than in the warnings box, because the cap
 * is a fact about *this list* and the foot of the list is where a reader meets
 * it. It names both numbers so the strip above, which counts every commit,
 * does not read as disagreeing with what can be counted on screen.
 */
function TruncationNote({
  listed,
  counted,
}: {
  listed: number;
  counted: number;
}) {
  return (
    <p className="border-line text-muted mt-1 ml-7 rounded-md border border-dashed px-4 py-3 text-sm leading-snug font-medium">
      Listing the newest {NUMBER.format(listed)} of {NUMBER.format(counted)}{" "}
      commits in this window. The older {NUMBER.format(counted - listed)} are
      not listed here, but they are counted in the totals and the chart above.
    </p>
  );
}

/* ---------------------------------------------------------------- an entry -- */

function ChangeEntry({
  change,
  now,
  isFresh,
  isLast,
}: {
  change: Change;
  now: number | null;
  isFresh: boolean;
  isLast: boolean;
}) {
  const authoredMs = parseIso(change.authoredAt);

  const hasBody = change.body.trim().length > 0;
  const hasFileDetail = change.files.length > 0;
  const visibleFiles = change.files.slice(0, MAX_VISIBLE_FILES);
  // `files` is already capped server-side; `filesChanged` is the true count, so
  // the remainder is measured against that and not against the array length.
  const undisclosedFiles = Math.max(0, change.filesChanged - visibleFiles.length);

  return (
    <li className="relative flex gap-4">
      {/* The rail. Purely decorative, the ordering is carried by the list. */}
      <div aria-hidden className="relative flex w-3 shrink-0 justify-center">
        <span
          className={[
            "z-10 mt-[15px] size-2.5 rounded-full",
            isFresh ? "bg-brand-gradient" : "bg-line-strong",
          ].join(" ")}
        />
        {isLast ? null : (
          <span className="bg-line absolute top-[25px] bottom-0 left-1/2 w-px -translate-x-1/2" />
        )}
      </div>

      <article
        className={[
          "mb-2 min-w-0 flex-1 rounded-md border px-3.5 py-3",
          isFresh ? "hd-change-fresh" : "border-transparent",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          <Sha change={change} />

          <span className="text-muted font-semibold">{change.authorName}</span>

          <span className="text-muted font-medium">
            {authoredMs === null ? (
              // The payload gave us something Date.parse could not read. Show
              // the raw value rather than inventing a plausible timestamp.
              <span title={change.authoredAt}>time unreadable</span>
            ) : now === null ? (
              // Pre-hydration. UTC, because a locale-formatted time here would
              // differ between the server render and this browser.
              <span title={change.authoredAt}>{formatUtc(authoredMs)}</span>
            ) : (
              <span title={formatAbsolute(authoredMs)}>
                {formatRelativeLong(authoredMs, now)}
              </span>
            )}
          </span>

          {isFresh ? (
            <span className="bg-brand-gradient rounded-full px-2 py-[2px] text-xs font-bold tracking-[0.1em] text-white uppercase">
              new
            </span>
          ) : null}

          <span className="ml-auto shrink-0 font-mono text-xs tabular-nums">
            <span className="text-ink font-semibold">
              +{NUMBER.format(change.additions)}
            </span>
            <span className="text-muted px-1">/</span>
            <span className="text-red-deep font-semibold">
              {"−"}
              {NUMBER.format(change.deletions)}
            </span>
          </span>
        </div>

        <h3 className="font-display mt-1.5 text-lg leading-snug font-medium tracking-[-0.012em]">
          {change.subject}
        </h3>

        {change.areas.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {change.areas.map((area) => (
              <li
                key={area}
                className="bg-paper-2 text-ink rounded-full px-2 py-[3px] text-xs font-semibold"
              >
                {area}
              </li>
            ))}
          </ul>
        ) : null}

        {hasBody || hasFileDetail || change.filesChanged > 0 ? (
          <details className="group mt-2.5">
            <summary className="text-muted hover:text-ink flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-bold transition-colors [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden
                className="inline-block transition-transform group-open:rotate-90"
              >
                {"›"}
              </span>
              {disclosureLabel(hasBody, change.filesChanged)}
            </summary>

            <div className="mt-3 space-y-4">
              {hasBody ? (
                // Preformatted, so the paragraph breaks and lists the commit
                // message was written with survive. Never truncated: the whole
                // point of the disclosure is that the reasoning is readable.
                <pre className="border-line text-ink font-sans text-sm leading-relaxed font-medium break-words whitespace-pre-wrap border-l-2 pl-3.5">
                  {change.body.trim()}
                </pre>
              ) : null}

              {hasFileDetail ? (
                <div>
                  <ul className="space-y-1">
                    {visibleFiles.map((file) => (
                      <FileRow key={`${file.status}:${file.path}`} file={file} />
                    ))}
                  </ul>
                  {undisclosedFiles > 0 ? (
                    <p className="text-muted mt-1.5 text-xs font-semibold">
                      {NUMBER.format(undisclosedFiles)} more{" "}
                      {undisclosedFiles === 1 ? "file" : "files"} in this commit,
                      not listed.
                    </p>
                  ) : null}
                </div>
              ) : change.filesChanged > 0 ? (
                <p className="text-muted text-sm font-medium">
                  {NUMBER.format(change.filesChanged)}{" "}
                  {change.filesChanged === 1 ? "file" : "files"} changed. The
                  per-file breakdown was not in this payload.
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </article>
    </li>
  );
}

function disclosureLabel(hasBody: boolean, filesChanged: number): string {
  const files =
    filesChanged > 0
      ? `${NUMBER.format(filesChanged)} ${filesChanged === 1 ? "file" : "files"}`
      : null;

  if (hasBody && files) return `Why, and ${files}`;
  if (hasBody) return "Why";
  return files ?? "Details";
}

function Sha({ change }: { change: Change }) {
  const className =
    "font-mono text-xs font-semibold tracking-[0.02em] tabular-nums";

  // A local checkout has no web URL. An anchor with nowhere to go is a promise
  // the page cannot keep, so it renders as text and says why on hover.
  if (change.url === null) {
    return (
      <span
        className={`${className} text-muted`}
        title="Read from the local checkout. This commit has no web URL."
      >
        {change.shortSha}
      </span>
    );
  }

  return (
    <a
      href={change.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} decoration-line-strong hover:text-red-deep underline decoration-1 underline-offset-4 transition-colors`}
    >
      {change.shortSha}
    </a>
  );
}

function FileRow({ file }: { file: ChangedFile }) {
  const status = FILE_STATUS[file.status];

  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span
        className="bg-paper-2 text-ink grid size-[18px] shrink-0 place-items-center rounded-sm font-mono text-xs font-bold"
        title={status.label}
      >
        <span aria-hidden>{status.mark}</span>
        <span className="sr-only">{status.label}</span>
      </span>

      <span className="text-ink min-w-0 flex-1 font-mono break-all">
        {file.path}
      </span>

      <span className="text-muted shrink-0 font-mono tabular-nums">
        <span className="text-ink">+{NUMBER.format(file.additions)}</span>
        <span className="px-0.5">/</span>
        <span className="text-red-deep">
          {"−"}
          {NUMBER.format(file.deletions)}
        </span>
      </span>
    </li>
  );
}

/* ------------------------------------------------------------ empty states -- */

/**
 * "Nothing happened" and "we could not find out what happened" are the same
 * empty list and completely different facts. `ok` is what separates them, so
 * this never has to hedge between the two.
 */
function EmptyFeed({ ok, warnings }: { ok: boolean; warnings?: string[] }) {
  const troubled = warnings !== undefined && warnings.length > 0;

  const heading = !ok
    ? "The history could not be read"
    : "No commits to show";

  const body = !ok
    ? "This is blank because the read failed, not because the window was quiet. The status line above says what went wrong."
    : troubled
      ? "No commits landed in this window. Some of the read did not come back cleanly (the problems are listed above), so treat this as the floor rather than the whole picture."
      : "No commits landed in this window. The history read cleanly, so there is genuinely nothing here.";

  return (
    <div className="border-line rounded-md border border-dashed px-5 py-8 text-center">
      <p className="font-display text-xl font-medium">{heading}</p>
      <p className="text-muted mx-auto mt-2 max-w-[46ch] text-sm font-medium">
        {body}
      </p>
    </div>
  );
}

"use client";

import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActivityChart } from "@/components/admin/ActivityChart";
import { AreaBreakdown } from "@/components/admin/AreaBreakdown";
import { ChangeFeed } from "@/components/admin/ChangeFeed";
import { LiveIndicator } from "@/components/admin/LiveIndicator";
import { RoadmapBoard } from "@/components/admin/RoadmapBoard";
import type {
  ChangeCoverage,
  ChangesPayload,
  RoadmapPayload,
} from "@/lib/admin/types";

/**
 * The dashboard, and the only thing on /admin that ships as JavaScript.
 *
 * The server already rendered a correct first frame (see `app/admin/page.tsx`),
 * so this component never starts empty and never shows a skeleton. Its entire
 * job from that point on is to keep the frame current *without ever making it
 * worse*, and almost every decision below follows from that second clause.
 *
 * ## Polling, and why not a socket
 *
 * Server-sent events or a WebSocket would be lower latency and are the obvious
 * upgrade. Both need a connection held open for the length of the session,
 * which on the serverless host this app deploys to means a function pinned for
 * hours per viewer, and neither source underneath is push-capable: the GitHub
 * API is a poll and `git log` is a poll. A socket would be a long-lived pipe
 * wrapped around a timer, paying the cost of streaming for none of the benefit.
 * Fifteen seconds is well inside "as it happens" for a repository one person
 * commits to, and the roadmap changes on the order of days, so it gets sixty.
 *
 * ## A failed poll changes the warning line and nothing else
 *
 * This is the rule the whole component is arranged around. A refresh that fails
 * the network dropped, a proxy returned HTML, GitHub rate-limited us, leaves
 * `changes` and `roadmap` exactly as they were and appends a sentence to the
 * warnings that `LiveIndicator` renders. It does not clear state, it does not
 * substitute zeros, and it does not swap the page for an error card. Data that
 * is thirty seconds stale and labelled stale is worth far more than a blank
 * screen, and a dashboard that erases itself on a flaky connection is one the
 * owner stops trusting after the second time it happens.
 *
 * The corollary is that the response is shape-checked before it is accepted. A
 * captive portal or a misconfigured proxy answers 200 with an HTML login page,
 * and `as ChangesPayload` over that would put `undefined.map` into the render
 * path, a blank screen by a longer route.
 *
 * ## A hidden tab stops polling
 *
 * Left alone, a tab parked overnight makes ~5,700 requests, each one a GitHub
 * API call against an hourly quota, so that nobody can look at the result. The
 * page is not more current for it; it is less, because the quota it burned is
 * the quota the morning's first real refresh needed. So the timers stop on
 * `visibilitychange` and restart on return, with an immediate refresh first,
 * coming back to a stale frame and waiting fifteen seconds for it to correct
 * itself is the exact moment the reader concludes the page is broken.
 *
 * ## The window buttons say what was asked for; the labels say what was measured
 *
 * These are not the same fact and the page must not conflate them. A click on
 * "90" sets a request in flight; until it lands, the numbers on screen still
 * cover the old window. Every heading and total is therefore labelled from
 * `ChangesPayload.windowDays`, what the payload actually covers, and the
 * buttons only ever show what was requested. When `ChangesPayload.ok` is false
 * the payload measured nothing at all, and the totals render as em-dashes
 * rather than zeros, because zero commits and no reading are different claims.
 *
 * There is a third state between those two, and it is the common one when
 * deployed: `ok: true` with `totals.complete: false`. The read worked and the
 * numbers are real, but they count only the commits the backend could expand,
 * the newest forty of a busier window, so they are floors, not totals. The
 * strip says so in the value itself (`40+`), drops the brand gradient that
 * would present a floor as an achievement, and the chart hatches the days the
 * read never reached rather than drawing them as zero-commit days.
 *
 * On the first paint no button has been pressed, so the selection is read off
 * the opening payload: whichever button matches `windowDays` is lit, and if
 * none does, the loader's default is free to be a number that is not 7, 30 or
 * 90, then none is lit. That is a fact the server stated about the data on
 * screen, not a guess made to keep a control looking tidy.
 *
 * ## Roadmap warnings are folded into the live indicator
 *
 * `RoadmapBoard` has nowhere to put `RoadmapPayload.warnings`, so they are
 * prefixed and passed to the one warning surface on the page rather than
 * dropped, two warning boxes on one screen is worse than one. What the board
 * does get is `ok`, which is the part it cannot do without: it decides whether
 * an empty board reads as a clear runway or as a read that failed, and that is
 * a question no amount of warning prose above it can answer for it.
 *
 * ## What is deliberately not here
 *
 *   - No exponential backoff. A failing poll retries on the same fifteen-second
 *     cadence. The quota concern is a hidden tab, which is already solved by
 *     stopping outright; a visible tab that is failing is one the owner is
 *     watching, and slowing its recovery to a minute would be the wrong trade.
 *   - No optimistic merging of a partial response into the last good one. A
 *     payload is taken whole or not at all, because a feed spliced from two
 *     reads at different times is a picture of a repository that never existed.
 *   - No diff or "3 new commits" chime. The feed reorders under the reader.
 */

/* ------------------------------------------------------------- the polling -- */

/** Fast enough to feel live for one committer; slow enough not to be rude. */
const CHANGES_INTERVAL_MS = 15_000;
/** The roadmap tracks a checked-in file. Sixty seconds is generous already. */
const ROADMAP_INTERVAL_MS = 60_000;

/* -------------------------------------------------------------- the window -- */

type WindowChoice = 7 | 30 | 90;

const WINDOW_CHOICES: readonly WindowChoice[] = [7, 30, 90];

const WINDOW_STORAGE_KEY = "healdesk:admin:window-days";

function isWindowChoice(value: number): value is WindowChoice {
  return WINDOW_CHOICES.some((choice) => choice === value);
}

/**
 * Read the remembered window, or null.
 *
 * Wrapped because `localStorage` is not merely empty in a locked-down browser.
 * Safari with cookies blocked, and Chrome with site data disabled, *throw* on
 * the property access itself, before any key is read. An unguarded read there
 * takes the whole dashboard down over a preference.
 */
function readStoredWindow(): WindowChoice | null {
  try {
    const raw = window.localStorage.getItem(WINDOW_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && isWindowChoice(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistWindow(choice: WindowChoice): void {
  try {
    window.localStorage.setItem(WINDOW_STORAGE_KEY, String(choice));
  } catch {
    // Quota, private mode, or site data blocked. The choice still applies to
    // this session; it just will not survive a reload. Not worth a warning.
  }
}

/* -------------------------------------------------------------- validation -- */

/**
 * Enough of a shape check to know we were handed the thing we asked for.
 *
 * Not a full validator. It does not walk every commit, because the producer
 * is our own route handler and the failure this defends against is categorical,
 * not per-field: an HTML error page, a JSON error body, a truncated response.
 * Any of those fails on the first array check, which is all that is needed to
 * keep the last good frame instead of rendering over it.
 */
function isChangesPayload(value: unknown): value is ChangesPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChangesPayload>;
  const totals: unknown = candidate.totals;
  return (
    typeof candidate.source === "string" &&
    // `ok` decides between a number and an em-dash on every tile, so a response
    // that omits it is not one we know how to draw honestly.
    typeof candidate.ok === "boolean" &&
    Array.isArray(candidate.changes) &&
    Array.isArray(candidate.activity) &&
    Array.isArray(candidate.areas) &&
    Array.isArray(candidate.warnings) &&
    typeof candidate.windowDays === "number" &&
    typeof candidate.fetchedAt === "string" &&
    typeof totals === "object" &&
    totals !== null &&
    // Checked for the same reason as `ok`, one level down: `complete` decides
    // between "40" and "40+", and a payload that omits it would default to the
    // confident version of a number that may be a floor. Rejecting it keeps the
    // last good frame, which is the safe direction, during a deploy this is
    // an old server answering, and the frame it replaces was true.
    typeof (totals as { complete?: unknown }).complete === "boolean"
  );
}

function isRoadmapPayload(value: unknown): value is RoadmapPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RoadmapPayload>;
  return (
    typeof candidate.ok === "boolean" &&
    Array.isArray(candidate.groups) &&
    Array.isArray(candidate.warnings) &&
    typeof candidate.fetchedAt === "string" &&
    typeof candidate.totals === "object" &&
    candidate.totals !== null
  );
}

/** An abort is us cancelling us. It is never a failure worth telling anyone. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/* ----------------------------------------------------------------- display -- */

// Pinned to en-US rather than the reader's locale on purpose: this component is
// server-rendered first, and a server whose locale groups with "." against a
// browser that groups with "," is a hydration mismatch on the largest number on
// the page. One fixed format renders the same in both places.
const COUNT = new Intl.NumberFormat("en-US");

/** U+2212, the real minus sign, a hyphen next to tabular figures reads wrong. */
const MINUS = "−";
/** Shown wherever a number could not be measured. Never a zero. */
const ABSENT = "—";

function describeWindow(days: number): string {
  if (days <= 0) return "over a window that could not be read";
  if (days === 1) return "in the last day";
  return `in the last ${COUNT.format(days)} days`;
}

/* =========================================================================== */

export type AdminDashboardProps = {
  initialChanges: ChangesPayload;
  initialRoadmap: RoadmapPayload;
};

export function AdminDashboard({
  initialChanges,
  initialRoadmap,
}: AdminDashboardProps) {
  const [changes, setChanges] = useState<ChangesPayload>(initialChanges);
  const [roadmap, setRoadmap] = useState<RoadmapPayload>(initialRoadmap);

  const [changesError, setChangesError] = useState<string | null>(null);
  const [roadmapError, setRoadmapError] = useState<string | null>(null);

  const [refreshingChanges, setRefreshingChanges] = useState(false);
  const [refreshingRoadmap, setRefreshingRoadmap] = useState(false);

  /**
   * A 401 mid-session. The twelve-hour cookie will expire under a tab that has
   * been open since morning, and the honest response is to stop rather than
   * retry a request that cannot start succeeding again on its own.
   */
  const [sessionExpired, setSessionExpired] = useState(false);

  /**
   * Seeded from what the opening payload says it covers, so the button that
   * matches it is lit without anyone having pressed it. Null when the loader's
   * default window is not one of the three, which is legitimate and is drawn as
   * three unpressed buttons rather than a lie about which one is active.
   *
   * Derived from a prop, so the server and the browser compute it identically
   * and the first paint hydrates cleanly.
   */
  const [selected, setSelected] = useState<WindowChoice | null>(() =>
    initialChanges.ok && isWindowChoice(initialChanges.windowDays)
      ? initialChanges.windowDays
      : null,
  );

  // The selection is mirrored into a ref so the fetchers can read it without
  // being rebuilt when it changes, a `refreshChanges` whose identity changed
  // per selection would tear down and re-arm both interval timers with it.
  const selectedRef = useRef<WindowChoice | null>(selected);

  // One controller per endpoint rather than one between them: with a single
  // shared controller, the sixty-second roadmap tick would cancel whatever
  // changes request happened to be in flight underneath it.
  const changesAbort = useRef<AbortController | null>(null);
  const roadmapAbort = useRef<AbortController | null>(null);

  const refreshChanges = useCallback(async (): Promise<void> => {
    // Cancel the previous one first. Without this a request stalled behind a
    // slow GitHub call can resolve after a newer one and overwrite fresh data
    // with older data, the bug that looks like the page going backwards.
    changesAbort.current?.abort();
    const controller = new AbortController();
    changesAbort.current = controller;
    setRefreshingChanges(true);

    const days = selectedRef.current;
    const url =
      days === null
        ? "/api/admin/changes"
        : `/api/admin/changes?days=${String(days)}`;

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (response.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!response.ok) {
        setChangesError(
          `Could not refresh the repository (the server answered ${String(response.status)}). Showing the last good read.`,
        );
        return;
      }

      const payload: unknown = await response.json();
      if (!isChangesPayload(payload)) {
        setChangesError(
          "The repository response was not in the expected shape, so it was ignored. Showing the last good read.",
        );
        return;
      }

      setChanges(payload);
      setChangesError(null);
    } catch (error) {
      if (isAbort(error)) return;
      setChangesError(
        "Could not reach the server to refresh the repository. Showing the last good read.",
      );
    } finally {
      // Only the request that still owns the slot may clear the spinner; an
      // aborted predecessor reaching this line must not report the live one done.
      if (changesAbort.current === controller) {
        changesAbort.current = null;
        setRefreshingChanges(false);
      }
    }
  }, []);

  const refreshRoadmap = useCallback(async (): Promise<void> => {
    roadmapAbort.current?.abort();
    const controller = new AbortController();
    roadmapAbort.current = controller;
    setRefreshingRoadmap(true);

    try {
      const response = await fetch("/api/admin/roadmap", {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });

      if (response.status === 401) {
        setSessionExpired(true);
        return;
      }
      if (!response.ok) {
        setRoadmapError(
          `Could not refresh the roadmap (the server answered ${String(response.status)}). Showing the last good read.`,
        );
        return;
      }

      const payload: unknown = await response.json();
      if (!isRoadmapPayload(payload)) {
        setRoadmapError(
          "The roadmap response was not in the expected shape, so it was ignored. Showing the last good read.",
        );
        return;
      }

      setRoadmap(payload);
      setRoadmapError(null);
    } catch (error) {
      if (isAbort(error)) return;
      setRoadmapError(
        "Could not reach the server to refresh the roadmap. Showing the last good read.",
      );
    } finally {
      if (roadmapAbort.current === controller) {
        roadmapAbort.current = null;
        setRefreshingRoadmap(false);
      }
    }
  }, []);

  /** Change the window: remember it, then go and get it. */
  const chooseWindow = useCallback(
    (next: WindowChoice): void => {
      if (selectedRef.current === next) return;
      selectedRef.current = next;
      setSelected(next);
      persistWindow(next);
      void refreshChanges();
    },
    [refreshChanges],
  );

  /**
   * Restore the remembered window, once, after mount.
   *
   * It cannot be read during render: the server has no `localStorage`, so a
   * first paint that used it would disagree with the HTML the server sent and
   * React would throw out the tree. The server's default window is shown, then
   * corrected, visibly, through the refreshing state, rather than silently.
   */
  useEffect(() => {
    const stored = readStoredWindow();
    if (stored !== null) chooseWindow(stored);
  }, [chooseWindow]);

  /**
   * The timers, and the visibility rule that governs them.
   *
   * Both live in one effect because they share a lifecycle: the same hide stops
   * both, the same return restarts both, and splitting them into two effects
   * means two subscriptions to `visibilitychange` that can drift apart.
   */
  useEffect(() => {
    if (sessionExpired) return;

    let changesTimer: number | null = null;
    let roadmapTimer: number | null = null;

    const stop = (): void => {
      if (changesTimer !== null) window.clearInterval(changesTimer);
      if (roadmapTimer !== null) window.clearInterval(roadmapTimer);
      changesTimer = null;
      roadmapTimer = null;
    };

    const start = (): void => {
      stop();
      changesTimer = window.setInterval(() => {
        void refreshChanges();
      }, CHANGES_INTERVAL_MS);
      roadmapTimer = window.setInterval(() => {
        void refreshRoadmap();
      }, ROADMAP_INTERVAL_MS);
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        stop();
        return;
      }
      // Catch up first, then resume the cadence. In-flight requests from before
      // the tab was hidden are left to finish; they are already paid for.
      void refreshChanges();
      void refreshRoadmap();
      start();
    };

    // A tab restored from the back/forward cache, or opened in the background,
    // starts hidden. Arming the timers regardless is how a background tab ends
    // up polling anyway.
    if (document.visibilityState === "visible") start();

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [refreshChanges, refreshRoadmap, sessionExpired]);

  /** Nothing should still be in flight for a component that is gone. */
  useEffect(() => {
    return () => {
      changesAbort.current?.abort();
      roadmapAbort.current?.abort();
    };
  }, []);

  /**
   * One warnings list, in the order of how much it should worry the reader:
   * what the server could not read, what the roadmap could not read, then what
   * this browser could not fetch.
   */
  const warnings = useMemo(() => {
    const all: string[] = [...changes.warnings];
    for (const warning of roadmap.warnings) all.push(`Roadmap: ${warning}`);
    if (changesError !== null) all.push(changesError);
    if (roadmapError !== null) all.push(roadmapError);
    return all;
  }, [changes.warnings, roadmap.warnings, changesError, roadmapError]);

  // Whether the numbers on screen are a measurement at all. This is the
  // payload's own word for it, not something inferred from a zero: `loadChanges`
  // returns its failure payload with the *requested* window intact, so
  // `windowDays > 0` was true for reads that had measured nothing and the strip
  // drew four confident zeros over a repository it could not open.
  const measured = changes.ok;
  // What the payload covers, not what the buttons requested.
  const windowLabel = measured
    ? describeWindow(changes.windowDays)
    : "over a window that could not be read";

  return (
    <main className="mx-auto w-full max-w-[1240px] flex-1 px-5 pt-8 pb-24 sm:px-8 sm:pt-10 lg:px-14">
      <LiveIndicator
        source={changes.source}
        ok={changes.ok}
        // Not every warning means the figures are short. The default local read
        // is clean and still carries one. That the feed lists 40 of 50, and
        // the box was closing on "the repository figures below may be lower
        // than the truth" over totals that account for the whole window.
        complete={changes.totals.complete}
        fetchedAt={changes.fetchedAt}
        isRefreshing={refreshingChanges || refreshingRoadmap}
        warnings={warnings}
      />

      {sessionExpired ? <SessionExpiredNotice /> : null}

      <div className="mt-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(36px,5.52vw,52.8px)] leading-[1.04] font-medium tracking-[-0.028em]">
            What is changing.
          </h1>
          <p className="text-muted mt-3 max-w-[54ch] text-[18px] font-medium">
            Every commit to this repository as it lands, where the work is
            concentrated, and what is still queued behind it.
          </p>
        </div>

        <WindowControl
          selected={selected}
          onChoose={chooseWindow}
          disabled={sessionExpired}
        />
      </div>

      <StatStrip
        totals={changes.totals}
        coverage={changes.coverage}
        windowDays={changes.windowDays}
        measured={measured}
        windowLabel={windowLabel}
      />

      {/* No heading of ours above the chart or the breakdown: both are figures
          that caption themselves, and a second title over the top would be the
          same sentence twice in two sizes. The two panels that arrive untitled
          the feed and the board, get one, set to the same 19px Fraunces the
          figures use, so all four panel titles read as one row of the same
          hierarchy under the h1. */}
      <div className="mt-14">
        {/* The chart is handed the oldest day the numbers actually reach back
            to. Without it, a window the read could only cover half of draws the
            older half as zero-commit days, a flat line that says the work
            stopped, over days nobody looked at.

            `ok` for the same reason one level up: a failed read sends no days
            at all, and an empty `activity` is the same array a window with
            nothing in it would send. Without it the chart's empty state says
            "no day-by-day activity was reported", which reads as quiet rather
            than as unread. */}
        <ActivityChart
          activity={changes.activity}
          ok={changes.ok}
          coveredFrom={changes.coverage?.from ?? null}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:items-start lg:gap-8">
        {/* `minmax(0, …)` on both tracks rather than plain fr: a grid child's
            default minimum is its content, so one unbreakable file path in the
            feed would push the column wider than the viewport and take the page
            body sideways with it. `min-w-0` says the same thing again at the
            child, because it is the pair of them that actually holds.

            The breakdown comes first in the document so that on a phone the
            summary is read before the feed rather than after several screens of
            it; on a wide screen the order swaps and the feed takes the left. */}
        <div className="min-w-0 lg:order-2">
          <AreaBreakdown
            ok={changes.ok}
            complete={changes.totals.complete}
            areas={changes.areas}
          />
        </div>

        <section aria-labelledby="feed-heading" className="min-w-0 lg:order-1">
          <PanelHeading
            id="feed-heading"
            title="The commits"
            blurb="Newest first. The subject is the headline; the reasoning is inside."
          />
          {/* The feed gets the payload's own warnings, not the merged list
              above, which also carries roadmap and network trouble that says
              nothing about the commit history. It uses them for one thing:
              telling an empty feed that read cleanly apart from one that could
              not be read at all. */}
          <div className="mt-5">
            <ChangeFeed
              changes={changes.changes}
              ok={changes.ok}
              warnings={changes.warnings}
              // The local backend counts every commit in the window and lists
              // only the newest `limit` of them, so the strip can read 50 over
              // a list of 40. The feed states its own cap at the foot of the
              // list rather than leaving it to a sentence at the top of the
              // page that nobody who reached the end of the list is looking at.
              counted={changes.totals.commits}
            />
          </div>
        </section>
      </div>

      <section aria-labelledby="roadmap-heading" className="mt-16">
        <PanelHeading
          id="roadmap-heading"
          title="What is still coming"
          blurb="Read from the one task list in the repository, so it cannot drift from it."
        />
        <div className="mt-5">
          {/* `ok` is the difference between "nothing left to do" and "the
              task list could not be read", which are the same empty array. */}
          <RoadmapBoard
            ok={roadmap.ok}
            groups={roadmap.groups}
            totals={roadmap.totals}
          />
        </div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ pieces -- */

/**
 * A title for a panel that does not title itself.
 *
 * Deliberately the same 19px Fraunces as the `figcaption` headings inside
 * `ActivityChart` and `AreaBreakdown`. Those two are cards and their titles sit
 * inside the border; these two sit on the page. Matching the type is what keeps
 * them reading as four peers rather than two different kinds of thing.
 */
function PanelHeading({
  id,
  title,
  blurb,
}: {
  id: string;
  title: string;
  blurb: string;
}) {
  return (
    <div>
      <h2
        id={id}
        className="font-display text-[22.8px] leading-tight font-medium tracking-[-0.015em]"
      >
        {title}
      </h2>
      <p className="text-muted mt-1 text-[15.6px] font-medium">{blurb}</p>
    </div>
  );
}

/**
 * A day as `YYYY-MM-DD`, written the way the chart writes it.
 *
 * Pinned to UTC as well as to en-US: the payload's days are UTC days, an ISO
 * date string parses as UTC midnight, and formatting it in the reader's zone
 * would print the 1st for a day the chart labels the 2nd. Fixing both ends also
 * makes the server and the browser render the same string, which is what keeps
 * hydration quiet.
 */
const DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDay(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DAY.format(parsed);
}

/**
 * How much of the window the numbers actually account for, in words.
 *
 * Only ever called for a partial read. "Counted 40 of 50" is the whole point:
 * the reader has asked for thirty days and is being shown a number that covers
 * less than that, and the only dishonest version is the one that does not say
 * how much less.
 */
function describeCoverage(
  counted: number,
  coverage: ChangeCoverage,
  windowLabel: string,
): string {
  if (coverage.inWindow === null) {
    return `Counted ${COUNT.format(counted)} of more ${windowLabel}`;
  }
  const total = `${coverage.inWindowAtLeast ? "at least " : ""}${COUNT.format(
    coverage.inWindow,
  )}`;
  return `Counted ${COUNT.format(counted)} of ${total} ${windowLabel}`;
}

/**
 * The four numbers, four honest absences, or four floors.
 *
 * Three states, not two, and conflating the last two is the bug this component
 * was carrying. `measured` is the payload's own `ok`: false means nothing was
 * read, every tile shows an em-dash, and a line underneath says why, because
 * "0 commits" and "we could not read the repository" look identical as numbers.
 *
 * `totals.complete` is the third state. On the GitHub backend, the only one
 * that runs when deployed, the aggregates are computed from the newest `limit`
 * commits that could be expanded, not from the commits in the window. That read
 * is a success and its numbers are real; they are simply a floor. So the
 * commits tile prints `40+`, no tile wears the brand gradient (a gradient over
 * a floor reads as a record, and the number underneath it can only go up), and
 * the line under the strip says exactly what was counted and how far back it
 * reaches. The old version printed a bare `40` in brand colours and let a
 * sentence in the warnings list carry the qualification, which is a sentence no
 * tile can read and most readers never open.
 */
function StatStrip({
  totals,
  coverage,
  windowDays,
  measured,
  windowLabel,
}: {
  totals: ChangesPayload["totals"];
  coverage: ChangeCoverage | null;
  windowDays: number;
  measured: boolean;
  windowLabel: string;
}) {
  // A read that worked but did not reach the whole window. `coverage` is the
  // detail; `complete` is the fact, and the fact is what decides the rendering,
  // so a payload that somehow arrives partial without detail still hedges.
  const partial = measured && !totals.complete;
  const commits = COUNT.format(totals.commits);

  return (
    <div className="mt-10">
      <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat
          label="Commits"
          // The `+` is the honest form of a floor and costs one character.
          value={measured ? (partial ? `${commits}+` : commits) : ABSENT}
          hint={
            partial && coverage
              ? describeCoverage(totals.commits, coverage, windowLabel)
              : windowLabel
          }
          emphasis={measured && !partial}
        />
        <Stat
          label="Lines added"
          value={measured ? `+${COUNT.format(totals.additions)}` : ABSENT}
          // The two line counts explain themselves across the pair, because the
          // thing worth knowing about them. That a rewritten line is counted
          // once on each side, is why they move together and is not obvious.
          hint={
            partial
              ? "Across the commits counted, not the window"
              : "Git counts a rewritten line as one of each"
          }
        />
        <Stat
          label="Lines removed"
          value={
            measured ? `${MINUS}${COUNT.format(totals.deletions)}` : ABSENT
          }
          hint={
            partial
              ? "…so both of these are floors, not totals"
              : "…so these two tend to move together"
          }
        />
        <Stat
          label="Active days"
          value={
            measured
              ? `${COUNT.format(totals.activeDays)}/${COUNT.format(windowDays)}`
              : ABSENT
          }
          hint={
            partial
              ? "Days with a commit among those counted"
              : "Days with at least one commit"
          }
        />
      </dl>

      {measured ? null : (
        <p className="text-muted mt-3 text-[15.6px] font-medium">
          These are blank rather than zero because the repository could not be
          read. Nothing here says the work stopped.
        </p>
      )}

      {partial ? (
        <p className="text-muted mt-3 text-[15.6px] font-medium">
          {coverage?.from
            ? `These count the ${commits} commits this read could measure, which reach back to ${formatDay(coverage.from)}, not the whole window. Every number above can only go up.`
            : `These count the ${commits} commits this read could measure, not the whole window. Every number above can only go up.`}
        </p>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div className="border-line rounded-md border bg-white p-5">
      <dt className="text-muted text-[12.6px] leading-none font-bold tracking-[0.16em] uppercase">
        {label}
      </dt>
      <dd
        className={[
          // Comfortably below the h1 and comfortably above the panel titles,
          // the three sizes on this page are 44 / 34 / 19, and they are meant
          // to be read in that order.
          "font-figure mt-3 text-[clamp(31.2px,3.84vw,40.8px)] leading-none font-semibold tracking-[-0.024em] tabular-nums",
          // The gradient is for a number that was actually measured. An absence
          // rendered in brand colours would look like an achievement.
          emphasis ? "text-brand-gradient" : "",
        ].join(" ")}
      >
        {value}
      </dd>
      <p className="text-muted mt-2.5 text-[14.4px] leading-snug font-medium">
        {hint}
      </p>
    </div>
  );
}

/**
 * 7 / 30 / 90.
 *
 * `aria-pressed` rather than a radio group or a `<select>`: these are toggles
 * over one setting, they are all visible at once, and nothing is submitted.
 *
 * All three unpressed is a legitimate state, not a bug to design away. It means
 * the window on screen is the loader's own default and that default is not one
 * of these three, so there is no button that honestly describes it. Lighting
 * the nearest one would be labelling the data with a number it does not have.
 */
function WindowControl({
  selected,
  onChoose,
  disabled,
}: {
  selected: WindowChoice | null;
  onChoose: (choice: WindowChoice) => void;
  disabled: boolean;
}) {
  return (
    <div className="shrink-0">
      <div
        role="group"
        aria-label="How far back to look"
        className="border-line inline-flex items-center gap-1 rounded-full border bg-white p-1"
      >
        {WINDOW_CHOICES.map((choice) => {
          const isSelected = selected === choice;
          return (
            <button
              key={choice}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onChoose(choice)}
              className={[
                "rounded-full px-4 py-2 text-[15.6px] font-bold transition-all duration-fast disabled:opacity-40",
                isSelected
                  ? "bg-brand-gradient shadow-sm text-white"
                  : "text-muted hover:text-ink",
              ].join(" ")}
            >
              {choice}d
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Shown when a poll comes back 401.
 *
 * Polling has already stopped by the time this renders. The last good frame
 * stays on screen underneath it. It was true when it was read, but it is now
 * labelled as the last one, because a page that keeps looking live after its
 * session ended is a page quietly showing yesterday.
 */
function SessionExpiredNotice() {
  return (
    <div
      role="alert"
      className="border-red/40 bg-paper-2 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border px-4 py-3"
    >
      <p className="min-w-0 text-[15.6px] leading-snug font-medium">
        <span className="font-bold">This session has ended.</span>{" "}
        <span className="text-muted">
          Updates have stopped. Everything below is the last read before it
          expired, not the current state of the repository.
        </span>
      </p>
      <a
        href="/admin/sign-in"
        className="bg-brand-gradient shadow-sm ml-auto shrink-0 rounded-full px-4 py-2 text-[15.6px] font-bold text-white transition-transform duration-fast hover:-translate-y-0.5"
      >
        Sign in again
      </a>
    </div>
  );
}

/* ------------------------------------------------------------ header chrome -- */

/**
 * The route segment of the sign-in page, as it appears under `app/admin/`.
 *
 * A string compared against the router rather than a path compared against
 * `usePathname()`, because it is the directory name that decides the segment,
 * and a rename of that directory is a compile-time-invisible change either way,
 * but at least this constant sits next to the reason it exists.
 */
const DOOR_SEGMENT = "sign-in";

/**
 * Draws the admin header everywhere under /admin except the sign-in door.
 *
 * The whole reasoning, why this asks the router which route is active instead
 * of asking whether there is a session, is in `app/admin/layout.tsx`, which is
 * the only thing that renders it. The short version: a layout is shared between
 * its children and the router may reuse the copy it already has, so a header
 * whose existence depends on the session can survive a sign-in or a sign-out
 * that should have changed it. The active segment cannot go stale that way.
 *
 * The header itself is passed in as children, so it stays server-rendered
 * markup; the only thing that ships here is the decision.
 */
export function AdminChrome({ children }: { children: React.ReactNode }) {
  const segment = useSelectedLayoutSegment();
  if (segment === DOOR_SEGMENT) return null;
  return <>{children}</>;
}

/**
 * The sign-out control in the admin header.
 *
 * It lives in this file rather than in `components/admin/SignOutButton.tsx`
 * only because it is small and `app/admin/layout.tsx` is the one thing that
 * renders it, see the note there. Nothing depends on it staying here.
 *
 * DELETE, not a form post, because that is what `/api/admin/session` exposes
 * and an HTML form can only send GET or POST. The route clears the cookie with
 * the same flags it was set with, which is the whole reason to call it instead
 * of clearing anything here: a cookie deleted with a mismatched path or
 * `sameSite` is a cookie the browser keeps.
 *
 * A failure says so rather than navigating anyway. Sending someone to the
 * sign-in page while their session cookie is still live would look like it
 * worked and would leave them signed in on a shared machine.
 */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch("/api/admin/session", {
        method: "DELETE",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      setFailed(true);
      setBusy(false);
      return;
    }

    // `replace` so the back button does not return to a dashboard that can no
    // longer load, and `refresh` so the destination, and this layout, are
    // re-rendered on the server without the cookie rather than replayed from
    // the router cache. `busy` stays true; the navigation is what happens next.
    router.replace("/admin/sign-in");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <span role="status" className="text-red-deep text-[14.4px] font-semibold">
          Sign-out failed. You are still signed in.
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={busy}
        className="border-line hover:border-line-strong text-muted hover:text-ink rounded-full border px-4 py-2 text-[15.6px] font-semibold transition-colors disabled:opacity-40"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

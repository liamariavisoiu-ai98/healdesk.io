"use client";

import { useMemo, useState } from "react";

import { REPO_AREAS } from "@/lib/admin/types";
import type { AreaVolume } from "@/lib/admin/types";

/**
 * How much change each part of the repo absorbed.
 *
 * ## Why one hue and not nine
 *
 * The question this answers is *how much*, not *which one*, the areas are
 * already identified by name at the head of every bar. Giving nine areas nine
 * colours would spend the whole categorical palette restating a label that is
 * right there in words, and would invite the reader to look for meaning in the
 * difference between "docs blue" and "scripts green" where there is none. So:
 * one hue, the brand orange, and length carries the magnitude.
 *
 * Nor does the fill get lighter as the bars get shorter. Shading a bar by its
 * rank double-encodes length as lightness. It says the same thing twice and
 * spends the only free channel left saying it. Every row is painted
 * identically; the two tones *inside* a bar separate lines added from lines
 * removed, which is a real second dimension, and those two get the only key on
 * the chart.
 *
 * ## Why this is HTML and not SVG
 *
 * A horizontal bar chart is a list of rows with proportional widths, which is
 * what a flex row already is. Percentage widths and a `gap` give exact geometry
 * and an exact 2px separator between the two fills, and the labels stay real
 * text at a real size at every viewport, an inline SVG scaled with the
 * container would shrink its own type on a phone.
 *
 * ## Why this needs `complete` as well
 *
 * The ranking is computed from whatever commits the read managed to account
 * for, which on the GitHub backend is the newest `limit` of them rather than
 * the window. "Lines changed per area of the repo" over a partial read is a
 * true sentence about the wrong set: an area that only saw work early in the
 * month can be missing from the ranking entirely. So the blurb names the set it
 * describes, and stops claiming the window when it does not have it.
 *
 * ## Why this needs `ok` and not just the array
 *
 * `areas: []` has two causes that produce identical data: a window the server
 * read cleanly and found nothing in, and a read that never happened. Saying
 * "no breakdown was reported" over the first is the same fault as saying "0"
 * over the second, pointed the other way. It turns a clean measurement into an
 * apology. The payload's own `ok` is the only thing that separates them, and it
 * is the same field `ChangeFeed` and `RoadmapBoard` take for the same reason.
 *
 * ## Why an area with no churn is a sentence and not a zero-length bar
 *
 * A bar of length zero looks like a rendering bug, and an area we know nothing
 * changed in is a fact worth stating plainly. Areas with no lines changed drop
 * out of the ranking and are named underneath instead, and an area that has
 * commits but no line counts is reported separately from one that was genuinely
 * untouched, because those are different things and collapsing them would put a
 * guess on the screen.
 *
 * Only the first of those two actually arrives today, and it is worth writing
 * down which: `buildAreas` in `lib/admin/changes.ts` emits an area only when a
 * file put it there, so every `AreaVolume` in the payload has at least one
 * commit. "Changed, but no line counts were reported" is a real state, a
 * commit of nothing but binaries, and "Untouched in this window" is a guard
 * for a payload that zero-fills the nine areas, which the loader deliberately
 * does not do. It is kept because the alternative, if that ever changes, is
 * nine areas silently vanishing from the footnote rather than being named.
 */

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * Two steps of one hue. Removed is the *darker* step, not a paler wash.
 *
 * A pale tint was the first choice and it was measured and rejected: orange at
 * 40% over the card sits at 1.45:1 against the surface, and the window in which
 * a lighter step is both visible against a warm-white page and distinct from
 * full-strength orange turns out to be about five percentage points wide, too
 * narrow to be robust to the row's hover wash. Going darker instead gives both
 * fills 2.5:1 or better on every surface they sit on, a comfortable step
 * between them, and a hue spread of 1°.
 */
const FILL_ADDED = "var(--color-orange)";
/** Resolves to #D16724. Re-measured against #FFFFFF and #FDFDFD. */
const FILL_REMOVED =
  "color-mix(in srgb, var(--color-orange) 80%, var(--color-ink))";

const churnOf = (volume: AreaVolume) => volume.additions + volume.deletions;

type Model = {
  rows: AreaVolume[];
  maxChurn: number;
  /** Commits landed, but the source reported no per-file line counts. */
  unmeasured: AreaVolume[];
  /** Nothing happened here at all. */
  untouched: AreaVolume[];
};

function buildModel(areas: AreaVolume[]): Model {
  const rows = areas
    .filter((area) => churnOf(area) > 0)
    .sort((a, b) => {
      const byChurn = churnOf(b) - churnOf(a);
      if (byChurn !== 0) return byChurn;
      const byCommits = b.commits - a.commits;
      if (byCommits !== 0) return byCommits;
      // Last resort is the declared area order, so the sort is never arbitrary.
      return REPO_AREAS.indexOf(a.area) - REPO_AREAS.indexOf(b.area);
    });

  const first = rows[0];
  const silent = areas.filter((area) => churnOf(area) === 0);

  return {
    rows,
    maxChurn: first ? churnOf(first) : 0,
    unmeasured: silent.filter((area) => area.commits > 0),
    untouched: silent.filter((area) => area.commits === 0),
  };
}

/* ------------------------------------------------------------- component -- */

export type AreaBreakdownProps = {
  /**
   * `ChangesPayload.ok`. Whether the window was measured at all, see the note
   * above. Without it an empty array has to be described with a hedge that is
   * wrong half the time.
   */
  ok: boolean;
  /**
   * `ChangesPayload.totals.complete`. Whether these volumes account for the
   * whole window or only the commits the read could expand. Defaults to true
   * so a caller that says nothing claims nothing beyond what it passed.
   */
  complete?: boolean;
  areas: AreaVolume[];
};

export function AreaBreakdown({
  ok,
  complete = true,
  areas,
}: AreaBreakdownProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const model = useMemo(() => buildModel(areas), [areas]);

  return (
    <figure className="border-line rounded-[20px] border bg-white p-5 sm:p-6">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
        <div>
          <h3 className="font-display text-[22.8px] leading-tight font-medium">
            Where the change landed
          </h3>
          <p className="text-muted mt-1 text-[15.6px] font-medium">
            {complete
              ? "Lines changed per area of the repo, biggest first."
              : "Lines changed per area, biggest first, across the commits this read counted rather than the whole window."}
          </p>
        </div>
        {model.rows.length > 0 ? (
          <div className="flex items-center gap-4">
            <KeyItem fill={FILL_ADDED} label="Added" />
            <KeyItem fill={FILL_REMOVED} label="Removed" />
          </div>
        ) : null}
      </figcaption>

      {model.rows.length === 0 ? (
        <p className="border-line text-muted mt-5 rounded-2xl border border-dashed px-4 py-10 text-center text-[16.8px] font-semibold">
          {!ok
            ? "This is blank because the repository could not be read, not because nothing was touched"
            : areas.length === 0
              ? "No files were changed in this window. The read came back clean, so there is genuinely nothing to break down"
              : "No lines were added or removed in this window"}
        </p>
      ) : (
        <ol
          className="mt-5 space-y-1"
          onPointerLeave={() => setActiveIndex(null)}
        >
          {model.rows.map((row, index) => {
            const churn = churnOf(row);
            const widthPct = (churn / model.maxChurn) * 100;
            const isActive = index === activeIndex;
            return (
              <li
                key={row.area}
                tabIndex={0}
                onPointerEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
                className={[
                  "-mx-2 rounded-xl px-2 py-2 transition-colors",
                  isActive ? "bg-paper" : "bg-transparent",
                ].join(" ")}
              >
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-[16.8px] font-semibold">{row.area}</span>
                  <span className="text-[16.8px] font-semibold tabular-nums">
                    {NUMBER.format(churn)}
                  </span>
                </div>

                <span className="sr-only">
                  {` lines changed, from ${NUMBER.format(row.commits)} ${
                    row.commits === 1 ? "commit" : "commits"
                  }, ${NUMBER.format(row.additions)} added, ${NUMBER.format(
                    row.deletions,
                  )} removed.`}
                </span>

                <div className="relative mt-1.5 h-3.5">
                  {/* Widths are proportional and the 2px gap is the separator,
                      so the two fills never blend into one block. The 6px floor
                      keeps a real four-line change from rendering as nothing:
                      it overstates the shortest bars by a few pixels, and an
                      invisible bar would understate them to zero, of the two
                      errors, that is the one that reads as a bug. */}
                  <div
                    className="flex h-full"
                    style={{ width: `max(${widthPct}%, 6px)`, gap: "2px" }}
                    aria-hidden="true"
                  >
                    {row.additions > 0 ? (
                      <div
                        className={
                          row.deletions > 0 ? undefined : "rounded-r-[4px]"
                        }
                        style={{
                          flexGrow: row.additions,
                          flexBasis: 0,
                          minWidth: "2px",
                          backgroundColor: FILL_ADDED,
                        }}
                      />
                    ) : null}
                    {row.deletions > 0 ? (
                      <div
                        className="rounded-r-[4px]"
                        style={{
                          flexGrow: row.deletions,
                          flexBasis: 0,
                          minWidth: "2px",
                          backgroundColor: FILL_REMOVED,
                        }}
                      />
                    ) : null}
                  </div>

                  {isActive ? (
                    <Tooltip
                      volume={row}
                      leftPct={widthPct}
                      below={index === 0}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {model.unmeasured.length > 0 ? (
        <Footnote
          lead="Changed, but no line counts were reported:"
          areas={model.unmeasured}
        />
      ) : null}

      {model.untouched.length > 0 ? (
        <Footnote lead="Untouched in this window:" areas={model.untouched} />
      ) : null}
    </figure>
  );
}

/* ----------------------------------------------------------------- parts -- */

function KeyItem({ fill, label }: { fill: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="block h-2.5 w-2.5 rounded-[2px]"
        style={{ backgroundColor: fill }}
      />
      <span className="text-muted text-[13.2px] font-bold tracking-[0.08em] uppercase">
        {label}
      </span>
    </span>
  );
}

function Tooltip({
  volume,
  leftPct,
  below,
}: {
  volume: AreaVolume;
  leftPct: number;
  below: boolean;
}) {
  return (
    <div
      className="bg-ink text-paper pointer-events-none absolute z-10 rounded-xl px-3 py-2 shadow-[0_12px_28px_-14px_rgb(36_22_15_/_0.7)]"
      style={{
        left: `${leftPct}%`,
        // Anchored by its near side at the edges rather than nudged inward, so
        // the readout always sits at the end of the bar it belongs to.
        ...(below ? { top: "100%" } : { bottom: "100%" }),
        transform: `${
          leftPct > 88
            ? "translateX(-100%)"
            : leftPct < 12
              ? "translateX(0)"
              : "translateX(-50%)"
        } ${below ? "translateY(8px)" : "translateY(-8px)"}`,
      }}
    >
      <p className="text-[13.2px] font-semibold whitespace-nowrap opacity-70">
        {volume.area}
      </p>
      <p className="text-[18px] leading-tight font-semibold whitespace-nowrap tabular-nums">
        {NUMBER.format(volume.commits)}{" "}
        <span className="text-[14.4px] font-medium opacity-70">
          {volume.commits === 1 ? "commit" : "commits"}
        </span>
      </p>
      <p className="mt-0.5 text-[14.4px] font-semibold whitespace-nowrap tabular-nums">
        +{NUMBER.format(volume.additions)}
        <span className="mx-1 opacity-40">/</span>
        <span className="opacity-70">−{NUMBER.format(volume.deletions)}</span>
      </p>
    </div>
  );
}

function Footnote({ lead, areas }: { lead: string; areas: AreaVolume[] }) {
  return (
    <p className="text-muted mt-4 text-[15px] font-medium">
      {lead}{" "}
      <span className="text-ink font-semibold">
        {areas.map((area) => area.area).join(", ")}
      </span>
    </p>
  );
}

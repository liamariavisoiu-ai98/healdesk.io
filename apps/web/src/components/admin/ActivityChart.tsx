"use client";

import { useId, useMemo, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import type { ActivityDay } from "@/lib/admin/types";

/**
 * Commits per day across the window.
 *
 * ## Why this is hand-authored SVG
 *
 * A chart library would ship 40kB to draw ninety rectangles, and every one of
 * them would arrive with its own opinions about type, colour and hover chrome
 * that then have to be fought back out. The geometry here is a dozen lines of
 * arithmetic. The cost of writing it is lower than the cost of overriding it.
 *
 * ## Why the marks are SVG and every character of type is HTML
 *
 * The SVG scales with `width:100%; height:auto`, which is what makes it
 * responsive, but that scaling applies to text too, so an 11px axis label
 * inside the viewBox renders at ~5px on a phone. So the SVG carries only
 * geometry (gridlines and bars) and every label, tick and tooltip is HTML
 * positioned over the same box in percentages. Percentages of the wrapper are
 * percentages of the viewBox, so they line up exactly, and the type stays at a
 * real CSS size at every width.
 *
 * ## Why a day with no commits is drawn as nothing
 *
 * A zero-height bar is invisible anyway, and a 2px stub in its place would read
 * as "a little bit of work happened", a guess rendered as a fact. The day
 * still exists: its slice of the plot is still hoverable and the tooltip says
 * "No commits". Likewise, when every day in the window is zero we say so in
 * words rather than drawing a flat line along the baseline, because a flat line
 * is indistinguishable from a broken data source.
 *
 * ## Why some days are hatched instead
 *
 * "No commits" and "not counted" are the same empty bar and completely
 * different facts, and the payload knows which is which. The GitHub backend
 * aggregates the newest `limit` commits it could expand, not the whole window,
 * so on a busy month the older end of this chart describes days the read never
 * reached. Drawn as zeros they say the work stopped; that is the single most
 * misleading thing this chart could draw, because it is a flat line at exactly
 * the place a reader looks to see whether momentum held.
 *
 * So `coveredFrom`, the oldest day the numbers reach back to, hatches
 * everything before it, the tooltip there says "not counted" rather than "no
 * commits", the accessible table says the same in words, and a line under the
 * chart names the date. The day at the boundary is left unhatched and is
 * mentioned in that line as possibly partial: the oldest counted commit can be
 * the third of five that landed that day, and hatching a day that does have
 * counted commits would be an error pointed the other way.
 *
 * ## What this component does not do
 *
 * It does not fetch, poll, or reconcile. It renders the array it is handed. It
 * deliberately shows no window total either: `ChangesPayload.totals` is computed
 * server-side and is the number the page should print, and a second total
 * re-derived here could quietly disagree with it.
 */

/* ------------------------------------------------------------- geometry -- */

/** viewBox units. Roughly 1:1 with CSS pixels at a typical dashboard width. */
const VIEW_W = 720;
const VIEW_H = 180;
/** Left gutter for the y-axis tick labels. */
const PAD_L = 38;
const PAD_R = 8;
/** Headroom above the tallest bar for the two direct labels. */
const PAD_T = 30;
const BASELINE = 178;

const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = BASELINE - PAD_T;

/** Bars never fill their slot; the leftover band is the air between them. */
const MAX_BAR_W = 24;
/** Guarantees the 2px surface gap between neighbours even at 90 days. */
const BAR_GAP = 3;
/** So a one-commit day on a busy scale is still a visible mark. */
const MIN_BAR_H = 2;
const CORNER = 4;

/** Minimum horizontal separation, in viewBox units, before two labels collide. */
const MIN_LABEL_GAP = 104;

/* ---------------------------------------------------------------- colour -- */

/**
 * Two steps of one hue, and the emphasis step is the *darker* one.
 *
 * The obvious way to pick a bar out is to wash the others back, draw them at
 * 72% and the chosen one at full strength. Measured, that fails: orange at 72%
 * over the paper ground lands under the 2:1 floor at which a mark is still
 * reliably visible against its surface. The brand orange is not light enough to
 * leave room for a paler step between itself and a near-white page.
 *
 * So every bar wears the brand orange, and the two labelled bars plus whichever
 * one the pointer is on go a step *darker*. Both fills clear the floor on white
 * and on paper (3.64:1 and 2.63:1), the step between them is a comfortable ΔL,
 * and the hue spread is 1°, still one colour, which is the point.
 */
const FILL_BASE = "var(--color-orange)";
/** Resolves to #D16724. Re-measured against #FFFFFF and #FDFDFD. */
const FILL_EMPHASIS =
  "color-mix(in srgb, var(--color-orange) 80%, var(--color-ink))";

/* ------------------------------------------------------------ formatting -- */

const NUMBER = new Intl.NumberFormat("en-US");
const SHORT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * `new Date("2026-09-07")` is parsed as UTC midnight, which renders as the 6th
 * for anyone west of Greenwich. Building the date from its parts keeps it local,
 * so the label under a bar is the day the reader means.
 */
function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, year, month, day] = match;
  if (!year || !month || !day) return null;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Falls back to the raw string rather than inventing a date we cannot parse. */
function formatDate(iso: string, format: Intl.DateTimeFormat): string {
  const date = parseIsoDate(iso);
  return date ? format.format(date) : iso;
}

/** "1 day" / "12 days". Used in prose that a screen reader also reads aloud. */
function countDays(count: number): string {
  return `${NUMBER.format(count)} ${count === 1 ? "day" : "days"}`;
}

/**
 * Rounds an axis top up to a number a person would have chosen, and no
 * further. A ladder of 1/2/5 alone sends a 12-commit day to a top of 20, which
 * leaves the busiest bar at 60% of the plot and makes a busy fortnight look
 * flat. The 1.2 and 1.5 rungs keep the tallest bar near the top of the frame.
 * Non-integer candidates are skipped because commits are counted, not measured.
 */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.5, 2, 3, 4, 5, 6, 8, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value - 1e-9 && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return 10 * magnitude;
}

/** Whole-number gridlines only, half a commit is not a thing. */
function gridTicks(top: number): number[] {
  // Four bands preferred; five is the fallback that saves a top of 5 from
  // becoming a two-line grid.
  for (const divisions of [4, 3, 2, 5]) {
    const step = top / divisions;
    if (Number.isInteger(step)) {
      return Array.from({ length: divisions + 1 }, (_, index) => index * step);
    }
  }
  return [0, top];
}

/** Rounded at the data end, square on the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(CORNER, width / 2, height);
  const bottom = y + height;
  return [
    `M${x} ${bottom}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `L${x + width - r} ${y}`,
    `Q${x + width} ${y} ${x + width} ${y + r}`,
    `L${x + width} ${bottom}`,
    "Z",
  ].join(" ");
}

const xPct = (value: number) => (value / VIEW_W) * 100;
const yPct = (value: number) => (value / VIEW_H) * 100;

/**
 * Labels near an edge are anchored by their near side instead of their centre.
 * Nudging them inward would be quicker, but a label that no longer sits over
 * its own bar is pointing at the wrong day, and being detached is a worse fault
 * than being flush with the edge.
 */
function anchorX(leftPct: number, edge: number): string {
  if (leftPct > 100 - edge) return "translateX(-100%)";
  if (leftPct < edge) return "translateX(0)";
  return "translateX(-50%)";
}

/* ----------------------------------------------------------------- model -- */

type Bar = {
  day: ActivityDay;
  x: number;
  y: number;
  height: number;
  centre: number;
  /**
   * Whether the read this chart is drawing actually counted this day. A false
   * here means the zero on it is an absence of measurement, not of work.
   */
  covered: boolean;
};

type Model = {
  bars: Bar[];
  /** Width of one day's slice of the plot, also the hover hit target. */
  band: number;
  barWidth: number;
  ticks: number[];
  busiest: Bar | null;
  busiestIndex: number;
  latest: Bar | null;
  showLatestLabel: boolean;
  hasCommits: boolean;
  axisTicks: Bar[];
  rangeLabel: string | null;
  /**
   * Index of the first covered day, which is also how many days precede it,
   * the width of the hatch and the number the note prints, one value so the
   * drawing and the sentence cannot disagree. 0 when the window was counted
   * whole.
   */
  firstCoveredIndex: number;
  /** The boundary day, formatted, or null when there is nothing to hatch. */
  coveredFromLabel: string | null;
};

function buildModel(activity: ActivityDay[], coveredFrom: string | null): Model {
  // Defensive: the contract says gapless and ordered, but a scrambled chart is
  // a worse failure than a cheap sort. ISO dates sort lexicographically.
  const days = [...activity].sort((a, b) => a.date.localeCompare(b.date));

  const empty: Model = {
    bars: [],
    band: PLOT_W,
    barWidth: MAX_BAR_W,
    ticks: [0],
    busiest: null,
    busiestIndex: -1,
    latest: null,
    showLatestLabel: false,
    hasCommits: false,
    axisTicks: [],
    rangeLabel: null,
    firstCoveredIndex: 0,
    coveredFromLabel: null,
  };
  if (days.length === 0) return empty;

  // ISO days compare lexicographically, so this needs no date parsing. A
  // boundary at or before the first day covers everything and hatches nothing,
  // which is what a complete read sends. A boundary past the last day, which
  // should not happen, hatches the lot rather than silently covering it.
  const foundCovered =
    coveredFrom === null
      ? 0
      : days.findIndex((day) => day.date >= coveredFrom);
  const firstCoveredIndex = foundCovered === -1 ? days.length : foundCovered;

  const max = days.reduce((peak, day) => Math.max(peak, day.commits), 0);
  const top = Math.max(1, niceCeil(max));
  const band = PLOT_W / days.length;
  const barWidth = Math.max(1.5, Math.min(MAX_BAR_W, band - BAR_GAP));

  const bars: Bar[] = days.map((day, index) => {
    const height =
      day.commits > 0 ? Math.max(MIN_BAR_H, (day.commits / top) * PLOT_H) : 0;
    const x = PAD_L + index * band + (band - barWidth) / 2;
    return {
      day,
      x,
      y: BASELINE - height,
      height,
      centre: x + barWidth / 2,
      covered: index >= firstCoveredIndex,
    };
  });

  // Ties go to the most recent day: on a live feed, recency is what is being
  // watched, and pointing at a fortnight-old tie would be misleading emphasis.
  let busiestIndex = -1;
  if (max > 0) {
    for (let index = 0; index < days.length; index += 1) {
      const day = days[index];
      if (day && day.commits >= max) busiestIndex = index;
    }
  }

  const busiest = busiestIndex >= 0 ? (bars[busiestIndex] ?? null) : null;
  const latest = bars[bars.length - 1] ?? null;

  // Six-ish ticks, anchored so the most recent day always carries one.
  const stride = Math.max(1, Math.ceil(days.length / 6));
  const axisTicks: Bar[] = [];
  for (let index = days.length - 1; index >= 0; index -= stride) {
    const bar = bars[index];
    if (bar) axisTicks.unshift(bar);
  }

  const first = days[0];
  const last = days[days.length - 1];

  return {
    bars,
    band,
    barWidth,
    ticks: gridTicks(top),
    busiest,
    busiestIndex,
    latest,
    showLatestLabel:
      busiest !== null &&
      latest !== null &&
      Math.abs(latest.centre - busiest.centre) >= MIN_LABEL_GAP,
    hasCommits: max > 0,
    axisTicks,
    rangeLabel:
      first && last
        ? first.date === last.date
          ? formatDate(first.date, SHORT_DATE)
          : `${formatDate(first.date, SHORT_DATE)} – ${formatDate(last.date, SHORT_DATE)}`
        : null,
    firstCoveredIndex,
    coveredFromLabel:
      firstCoveredIndex > 0 && coveredFrom !== null
        ? formatDate(coveredFrom, SHORT_DATE)
        : null,
    // `top` is not returned: the tick list already carries the scale.
  };
}

/* ------------------------------------------------------------- component -- */

export type ActivityChartProps = {
  activity: ActivityDay[];
  /**
   * `ChangesPayload.ok`, whether the read behind `activity` happened at all.
   *
   * A failed read sends an empty `activity` for the reason the loader states:
   * thirty zeroed days draw a flat line that says the work stopped. But an empty
   * array is *also* what a window with no days in it would send, and the empty
   * state was describing both with one sentence, "no day-by-day activity was
   * reported", which reads as an absence of work rather than an absence of
   * measurement. `ChangeFeed`, `AreaBreakdown` and `RoadmapBoard` all take this
   * field for exactly this reason; this chart is the fourth panel and needs it
   * for the same one.
   *
   * Defaults to true: a caller that says nothing is not claiming a failure.
   */
  ok?: boolean;
  /**
   * `ChangesPayload.coverage.from`, the oldest day the payload's numbers
   * actually reach back to, or null when they cover the whole window.
   *
   * Optional, and null is the honest default: a caller that does not know is
   * saying nothing about coverage, and this chart then draws what it is given.
   * A caller that *does* know and omits it is asking for a flat line over days
   * nobody looked at, which is the one drawing this component must never make.
   */
  coveredFrom?: string | null;
};

export function ActivityChart({
  activity,
  ok = true,
  coveredFrom = null,
}: ActivityChartProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Only the keyboard path announces the readout. A live region that fires on
  // every pointer move floods a screen reader for anyone using both.
  const [viaKeyboard, setViaKeyboard] = useState(false);
  const model = useMemo(
    () => buildModel(activity, coveredFrom),
    [activity, coveredFrom],
  );
  // Colons out: React's generated ids carry them, and `url(#:r0:)` is not a
  // reference every SVG implementation resolves.
  const hatchId = `activity-hatch-${useId().replace(/:/g, "")}`;

  const active =
    activeIndex === null ? null : (model.bars[activeIndex] ?? null);
  const scaleTop = Math.max(1, model.ticks[model.ticks.length - 1] ?? 1);

  function pickFromPointer(event: ReactPointerEvent<SVGSVGElement>) {
    if (model.bars.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    // The hit target is the whole band, full height, always wider than the bar.
    const x = ((event.clientX - box.left) / box.width) * VIEW_W;
    const index = Math.floor((x - PAD_L) / model.band);
    setViaKeyboard(false);
    setActiveIndex(index >= 0 && index < model.bars.length ? index : null);
  }

  function handleKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (model.bars.length === 0) return;
    const last = model.bars.length - 1;
    const current = activeIndex ?? last;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = Math.min(last, current + 1);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = Math.max(0, current - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Escape":
        setActiveIndex(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    setViaKeyboard(true);
    setActiveIndex(next);
  }

  return (
    <figure className="border-line rounded-md border bg-white p-5 sm:p-6">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-xl leading-tight font-medium">
          Commits per day
        </h3>
        {model.rangeLabel ? (
          <p className="text-muted text-sm font-semibold tabular-nums">
            {model.rangeLabel}
          </p>
        ) : null}
      </figcaption>

      {!model.hasCommits ? (
        <EmptyState
          ok={ok}
          hasDays={model.bars.length > 0}
          uncoveredDays={model.firstCoveredIndex}
          coveredFromLabel={model.coveredFromLabel}
        />
      ) : (
        <>
          <div
            className="relative mt-5"
            onPointerLeave={() => setActiveIndex(null)}
          >
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              role="img"
              aria-label={`Commits per day across ${model.bars.length} days${
                model.busiest
                  ? `. Busiest day ${formatDate(model.busiest.day.date, LONG_DATE)} with ${model.busiest.day.commits} commits`
                  : ""
              }${
                model.coveredFromLabel
                  ? `. ${countDays(model.firstCoveredIndex)} at the start of this window ${model.firstCoveredIndex === 1 ? "was" : "were"} not counted by this read, which reaches back only to ${model.coveredFromLabel}`
                  : ""
              }. Use the arrow keys to read each day; the same figures are in the table below.`}
              tabIndex={0}
              onPointerMove={pickFromPointer}
              onKeyDown={handleKeyDown}
              onBlur={() => setActiveIndex(null)}
              style={{ width: "100%", height: "auto" }}
              className="block"
            >
              {/*
                Horizontal grid only. No vertical rules, no axis spine.

                Paint goes in `style`, not in `fill`/`stroke` attributes: a
                custom property is not substituted inside an SVG presentation
                attribute, so `stroke="var(--color-line)"` silently paints
                nothing. As a CSS declaration it resolves normally.
              */}
              {/* The days this read never reached. Hatched, not blank and not
                  zero: blank would read as a rendering gap and a zero-height
                  bar would read as a day with no work, which is the claim the
                  payload explicitly cannot make. Drawn first so the gridlines
                  and every bar sit over it. */}
              {model.firstCoveredIndex > 0 ? (
                <>
                  <defs>
                    <pattern
                      id={hatchId}
                      width={7}
                      height={7}
                      patternUnits="userSpaceOnUse"
                      patternTransform="rotate(45)"
                    >
                      <line
                        x1={0}
                        y1={0}
                        x2={0}
                        y2={7}
                        strokeWidth={1}
                        style={{ stroke: "var(--color-line-strong)" }}
                      />
                    </pattern>
                  </defs>
                  <rect
                    x={PAD_L}
                    y={PAD_T}
                    width={Math.min(
                      model.firstCoveredIndex * model.band,
                      PLOT_W,
                    )}
                    height={BASELINE - PAD_T}
                    fill={`url(#${hatchId})`}
                    opacity={0.5}
                  />
                </>
              ) : null}

              <g>
                {model.ticks.map((tick) => {
                  const y = BASELINE - (tick / scaleTop) * PLOT_H;
                  return (
                    <line
                      key={tick}
                      x1={PAD_L}
                      x2={VIEW_W - PAD_R}
                      y1={y}
                      y2={y}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      style={{
                        stroke:
                          tick === 0
                            ? "var(--color-line-strong)"
                            : "var(--color-line)",
                      }}
                    />
                  );
                })}
              </g>

              <g>
                {model.bars.map((bar, index) => {
                  if (bar.height <= 0) return null;
                  // The darker step is an encoding with no key on the chart,
                  // so it only ever marks a bar the reader can also read: the
                  // two direct labels, and whichever one the pointer or the
                  // arrow keys are on. The latest bar was being darkened
                  // unconditionally, which on a window whose busiest day is
                  // near the end left a second emphasised bar carrying no label
                  // and no explanation of why it looked different.
                  const emphasised =
                    index === activeIndex ||
                    index === model.busiestIndex ||
                    (model.showLatestLabel && index === model.bars.length - 1);
                  return (
                    <path
                      key={bar.day.date}
                      d={barPath(bar.x, bar.y, model.barWidth, bar.height)}
                      style={{ fill: emphasised ? FILL_EMPHASIS : FILL_BASE }}
                    />
                  );
                })}
              </g>
            </svg>

            {/* Type layer: never scaled by the viewBox. */}
            <div className="pointer-events-none absolute inset-0">
              {model.ticks.map((tick) => (
                <span
                  key={tick}
                  className="text-muted absolute text-xs font-semibold tabular-nums"
                  style={{
                    top: `${yPct(BASELINE - (tick / scaleTop) * PLOT_H)}%`,
                    left: 0,
                    width: `${xPct(PAD_L)}%`,
                    transform: "translateY(-50%)",
                    textAlign: "right",
                    paddingRight: "8px",
                  }}
                >
                  {NUMBER.format(tick)}
                </span>
              ))}

              {model.busiest ? (
                <DirectLabel
                  caption="Busiest"
                  value={model.busiest.day.commits}
                  leftPct={xPct(model.busiest.centre)}
                  topPct={yPct(model.busiest.y)}
                />
              ) : null}

              {model.latest && model.showLatestLabel ? (
                <DirectLabel
                  caption="Latest"
                  value={model.latest.day.commits}
                  leftPct={xPct(model.latest.centre)}
                  topPct={yPct(model.latest.y)}
                />
              ) : null}

              {active ? <Tooltip bar={active} announce={viaKeyboard} /> : null}
            </div>
          </div>

          <div className="relative mt-2 h-4">
            {model.axisTicks.map((bar) => {
              const left = xPct(bar.centre);
              return (
                <span
                  key={bar.day.date}
                  className="text-muted absolute top-0 text-xs font-semibold whitespace-nowrap tabular-nums"
                  style={{ left: `${left}%`, transform: anchorX(left, 8) }}
                >
                  {formatDate(bar.day.date, SHORT_DATE)}
                </span>
              );
            })}
          </div>

          {model.coveredFromLabel ? <CoverageNote model={model} /> : null}
        </>
      )}

      {/* The value of every bar, without a pointer. Tooltips enhance, never gate. */}
      {model.bars.length > 0 ? (
        <table className="sr-only">
          <caption>Commits per day</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Commits</th>
              <th scope="col">Lines added</th>
              <th scope="col">Lines removed</th>
            </tr>
          </thead>
          <tbody>
            {model.bars.map((bar) =>
              bar.covered ? (
                <tr key={bar.day.date}>
                  <th scope="row">{formatDate(bar.day.date, LONG_DATE)}</th>
                  <td>{NUMBER.format(bar.day.commits)}</td>
                  <td>{NUMBER.format(bar.day.additions)}</td>
                  <td>{NUMBER.format(bar.day.deletions)}</td>
                </tr>
              ) : (
                // Words, not zeros. This table is the whole chart for anyone
                // reading it, and three zeros here would be the flat line the
                // hatching exists to prevent.
                <tr key={bar.day.date}>
                  <th scope="row">{formatDate(bar.day.date, LONG_DATE)}</th>
                  <td colSpan={3}>Not counted by this read</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : null}
    </figure>
  );
}

/* ----------------------------------------------------------------- parts -- */

function DirectLabel({
  caption,
  value,
  leftPct,
  topPct,
}: {
  caption: string;
  value: number;
  leftPct: number;
  topPct: number;
}) {
  return (
    <span
      className="absolute flex items-baseline gap-1.5 whitespace-nowrap"
      style={{
        left: `${leftPct}%`,
        top: `${topPct}%`,
        transform: `${anchorX(leftPct, 8)} translateY(calc(-100% - 6px))`,
      }}
    >
      <span className="text-muted text-xs font-bold tracking-[0.1em] uppercase">
        {caption}
      </span>
      <span className="text-ink text-sm leading-none font-semibold tabular-nums">
        {NUMBER.format(value)}
      </span>
    </span>
  );
}

function Tooltip({ bar, announce }: { bar: Bar; announce: boolean }) {
  const top = yPct(bar.y);
  // A tall bar has no room above it, so the readout drops inside the plot
  // instead of being clipped by the top of the card.
  const below = top < 42;
  const left = xPct(bar.centre);
  return (
    <div
      aria-live={announce ? "polite" : "off"}
      className="bg-ink text-paper absolute z-10 rounded-sm px-3 py-2 shadow-md"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        transform: `${anchorX(left, 12)} ${
          below ? "translateY(10px)" : "translateY(calc(-100% - 10px))"
        }`,
      }}
    >
      <p className="text-xs font-semibold whitespace-nowrap opacity-70">
        {formatDate(bar.day.date, LONG_DATE)}
      </p>
      {!bar.covered ? (
        // The one case where the tooltip is the only thing that can tell the
        // reader why a day is empty. "No commits" here would be a claim the
        // payload never made.
        <p className="max-w-[22ch] text-sm leading-snug font-semibold">
          Not counted: this read did not reach back this far
        </p>
      ) : bar.day.commits > 0 ? (
        <>
          <p className="text-base leading-tight font-semibold whitespace-nowrap tabular-nums">
            {NUMBER.format(bar.day.commits)}{" "}
            <span className="text-xs font-medium opacity-70">
              {bar.day.commits === 1 ? "commit" : "commits"}
            </span>
          </p>
          <p className="mt-0.5 text-xs font-semibold whitespace-nowrap tabular-nums">
            +{NUMBER.format(bar.day.additions)}
            <span className="mx-1 opacity-40">/</span>
            <span className="opacity-70">
              −{NUMBER.format(bar.day.deletions)}
            </span>
          </p>
        </>
      ) : (
        <p className="text-sm leading-tight font-semibold whitespace-nowrap">
          No commits
        </p>
      )}
    </div>
  );
}

/**
 * The hatch legend, in words.
 *
 * The pattern alone says "something is different here"; only the sentence says
 * what, and only the date says how much of the chart to discount. The boundary
 * day is called out as possibly partial because it is: the oldest counted
 * commit may be the third of five that landed that day.
 */
function CoverageNote({ model }: { model: Model }) {
  return (
    <p className="text-muted mt-3 text-sm leading-snug font-medium">
      <span
        aria-hidden="true"
        className="mr-2 inline-block h-2.5 w-2.5 translate-y-[1px] rounded-sm border"
        style={{
          borderColor: "var(--color-line-strong)",
          backgroundImage:
            "repeating-linear-gradient(45deg, var(--color-line-strong) 0 1px, transparent 1px 5px)",
        }}
      />
      {`${countDays(model.firstCoveredIndex)} hatched: this read reaches back only to ${model.coveredFromLabel ?? ""}, so ${model.firstCoveredIndex === 1 ? "that day is" : "those days are"} empty because nobody looked, not because nothing landed. ${model.coveredFromLabel ?? "That day"} itself may be partial.`}
    </p>
  );
}

function EmptyState({
  ok,
  hasDays,
  uncoveredDays,
  coveredFromLabel,
}: {
  ok: boolean;
  hasDays: boolean;
  uncoveredDays: number;
  coveredFromLabel: string | null;
}) {
  return (
    <p className="border-line text-muted mt-5 rounded-md border border-dashed px-4 py-10 text-center text-base font-semibold">
      {!ok
        ? // A failed read sends no days at all, which is the same empty array a
          // window with nothing in it would send. Only `ok` tells them apart,
          // and "no activity was reported" over a read that never happened is
          // the flat-line claim in words instead of in pixels.
          "This is blank because the repository could not be read, not because nothing was committed"
        : !hasDays
          ? "No day-by-day activity was reported for this window"
          : uncoveredDays > 0
            ? // "No commits in this window" would be false here: most of the
              // window was never counted, so the chart cannot speak for it.
              `No commits since ${coveredFromLabel ?? "the start of what this read covered"}, so the earlier days in this window were not counted`
            : "No commits in this window"}
    </p>
  );
}

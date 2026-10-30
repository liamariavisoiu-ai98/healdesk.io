"use client";

import { useEffect, useRef, useState } from "react";

import { ClinicMark, useDemoClose } from "@/components/demo/DemoClose";
import {
  clockLabel,
  COVERAGE_MODES,
  type CoverageModeId,
  coverageExamples,
  openHoursOf,
} from "@/lib/demo/close";
import { HOURS_IN_A_WEEK, type WeekSchedule } from "@/lib/demo/opening-hours";
import { site } from "@/lib/site";

/**
 * The clinic's week under each of the three voice coverage modes (v1 spec,
 * "Voice coverage"): after hours only, overflow and after hours (the
 * default), and all calls. Chat answers every hour in all three.
 *
 * The clinic's open hours are drawn as its own time, in a warm neutral that
 * stays distinct from AYA's green whatever the clinic's colour (a green
 * clinic's own colour read as hers); the hours AYA covers glow softly
 * around them. In overflow, calls land inside
 * the open hours and resolve to "Booked"; in all calls, the open hours carry
 * the glow too. The example cards are labelled "Example" and are placed by
 * the clinic's real hours (lib/demo/close.ts `coverageExamples`).
 *
 * While in view it moves through the modes every four seconds, and stops for
 * good the first time the visitor chooses one. With reduced motion it stays
 * on the default and the overflow calls sit still. Below 640px each day is a row, so the
 * week fits a phone without scrolling sideways.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const CYCLE_MS = 4_000;
const GLOW = "rgba(135, 214, 141, 0.22)";
const GLOW_EDGE = "rgba(135, 214, 141, 0.55)";
/** The clinic's own open hours: a warm neutral, distinct from AYA's green whatever the clinic's colour. */
const OPEN_FILL = "#ece4d9";

const MODE_LINE: Record<CoverageModeId, (agent: string) => string> = {
  "after-hours": (agent) => `Your team answers while you're open. ${agent} answers every hour you're closed.`,
  overflow: (agent) => `Your team answers first. When they're busy or on another line, ${agent} picks up, and she answers every hour you're closed.`,
  all: (agent) => `${agent} picks up all of your calls, day and night, open or closed.`,
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the media query, read as the effect subscribes to it
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function CoverageModes({
  schedule,
  source,
}: {
  schedule: WeekSchedule;
  /** Where the schedule came from; null means the 9-to-5 assumption. */
  source: { kind: "google"; place: string | null } | { kind: "website" } | null;
}) {
  const { clinicName, track, audience } = useDemoClose();
  const [mode, setMode] = useState<CoverageModeId>("overflow");
  const [touched, setTouched] = useState(false);
  const [inView, setInView] = useState(false);
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: 0.35 });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (touched || reduced || !inView) return;
    const id = window.setInterval(() => {
      setMode((m) => COVERAGE_MODES[(COVERAGE_MODES.findIndex((x) => x.id === m) + 1) % COVERAGE_MODES.length]!.id);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [touched, reduced, inView]);

  const choose = (next: CoverageModeId) => {
    setTouched(true);
    setMode(next);
    track("coverage_mode_changed", next);
  };

  const open = openHoursOf(schedule);
  const closed = Math.round((HOURS_IN_A_WEEK - open) * 10) / 10;
  const examples = coverageExamples(schedule, mode, audience);
  const legend =
    source?.kind === "google"
      ? `Open, per ${source.place ?? clinicName}'s Google hours`
      : source?.kind === "website"
        ? "Open, per your website"
        : "Open (assumed 9 to 5, Mon–Fri)";
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  return (
    <section
      ref={ref}
      aria-labelledby="coverage-heading"
      className="mt-14 overflow-hidden rounded-lg border border-white/[0.08] bg-[#0B1520] px-4 py-10 text-white sm:px-10 sm:py-14"
      // The soft inner glow: light from above, not a fourth shadow (lib/design-tokens.test.ts).
      style={{ backgroundImage: "radial-gradient(120% 60% at 50% 0%, rgba(255,255,255,0.06), transparent 70%)" }}
    >
      <p className="text-center text-xs font-bold tracking-[0.12em] text-white/55 uppercase">Coverage</p>
      <h2 id="coverage-heading" className="heading-section mx-auto mt-3 max-w-[22ch] text-center">
        {clinicName} is closed {fmt(closed)} hours a week.
      </h2>
      <p className="mx-auto mt-4 max-w-[46ch] text-center text-base leading-[1.5] text-white/70">
        For those hours, no one at {clinicName} can pick up. {site.agent} can. Choose how she covers your phone:
      </p>

      {/* The three modes. */}
      <div role="radiogroup" aria-label="Voice coverage" className="mx-auto mt-8 grid max-w-[640px] grid-cols-3 gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] p-1">
        {COVERAGE_MODES.map((m) => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(m.id)}
              className={`duration-slow relative min-h-12 rounded-full px-2 text-xs leading-tight font-bold transition-colors ease-out sm:text-sm ${
                on ? "bg-white text-[#0B1520]" : "text-white/70 hover:text-white"
              }`}
            >
              {m.label}
              {"note" in m ? (
                <span className={`block text-xs font-semibold ${on ? "text-[#0B1520]/60" : "text-white/45"}`}>{m.note}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mx-auto mt-4 max-w-[52ch] text-center text-sm leading-[1.5] text-white/80" aria-live="polite">
        {MODE_LINE[mode](site.agent)}
      </p>
      <p className="mt-1 text-center text-xs font-semibold text-[#87d68d]">Chat answers 24/7 in every mode.</p>

      {/* The week. */}
      <figure className="mx-auto mt-8 max-w-[860px] rounded-lg border border-white/[0.08] bg-white/[0.03] p-4 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <ClinicMark size={32} />
          <p className="min-w-0 truncate text-sm font-bold">{clinicName}&rsquo;s week</p>
        </div>

        {/* Columns from 640px. */}
        <div className="hidden gap-2 sm:flex">
          <div className="relative mt-7 h-[280px] w-11 shrink-0 text-right text-xs text-white/40" aria-hidden>
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h} className="absolute right-0 -translate-y-1/2" style={{ top: `${(h / 24) * 100}%` }}>
                {clockLabel((h % 24) * 60)}
              </span>
            ))}
          </div>
          {DAYS.map((day, i) => (
            <div key={day} className="flex min-w-0 flex-1 flex-col items-center">
              <span className="mb-2 h-5 text-xs font-bold text-white/75">{day}</span>
              <DayTrack schedule={schedule} day={i} mode={mode} axis="y" label={dayLabel(schedule, i, mode, clinicName)} />
            </div>
          ))}
        </div>

        {/* Rows below 640px: a compact day strip. */}
        <div className="space-y-1.5 sm:hidden">
          <div className="ml-10 flex justify-between text-xs text-white/40" aria-hidden>
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h}>{h === 24 ? "" : clockLabel(h * 60)}</span>
            ))}
          </div>
          {DAYS.map((day, i) => (
            <div key={day} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-xs font-bold text-white/75">{day}</span>
              <DayTrack schedule={schedule} day={i} mode={mode} axis="x" label={dayLabel(schedule, i, mode, clinicName)} />
            </div>
          ))}
        </div>

        <figcaption className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-semibold text-white/70">
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm" style={{ background: OPEN_FILL }} />
            {legend}
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-sm" style={{ background: GLOW, boxShadow: `inset 0 0 0 1px ${GLOW_EDGE}` }} />
            {site.agent} answers
          </span>
        </figcaption>
      </figure>

      {/* Examples, never real calls. */}
      <ul className="mx-auto mt-5 grid max-w-[860px] gap-2 sm:grid-cols-3">
        {examples.map((e) => (
          <li
            key={`${mode}-${e.label}`}
            className="hd-example rounded-md border border-white/[0.08] bg-white/[0.05] px-4 py-3 text-xs leading-snug"
          >
            <span className="mb-1 block text-xs font-bold tracking-[0.1em] text-white/45 uppercase">Example</span>
            {e.label}
            <span className="mt-1 block font-semibold text-[#87d68d]">{e.result} ✓</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function dayLabel(schedule: WeekSchedule, day: number, mode: CoverageModeId, clinicName: string): string {
  const spans = schedule.days[day] ?? [];
  const name = DAYS[day];
  if (spans.length === 0) return `${name}: ${clinicName} is closed; ${site.agent} answers all day`;
  const hours = spans.map(([a, b]) => `${clockLabel(a)} to ${clockLabel(b)}`).join(" and ");
  const during =
    mode === "after-hours" ? "your team answers" : mode === "overflow" ? `your team answers and ${site.agent} takes the overflow` : `${site.agent} answers`;
  return `${name}: open ${hours}, ${during}; ${site.agent} answers the hours you are closed`;
}

/** One day: 24 hours along `axis`, AYA's glow behind, the open hours in the clinic's colour on top. */
function DayTrack({
  schedule,
  day,
  mode,
  axis,
  label,
}: {
  schedule: WeekSchedule;
  day: number;
  mode: CoverageModeId;
  axis: "x" | "y";
  label: string;
}) {
  const spans = schedule.days[day] ?? [];
  const vertical = axis === "y";
  const pos = (start: number, length: number) =>
    vertical
      ? { top: `${(start / 1440) * 100}%`, height: `${(length / 1440) * 100}%` }
      : { left: `${(start / 1440) * 100}%`, width: `${(length / 1440) * 100}%` };

  return (
    <div
      role="img"
      aria-label={label}
      className={`relative overflow-hidden rounded-md ${vertical ? "h-[280px] w-full" : "h-7 min-w-0 flex-1 rounded-sm"}`}
      style={{ background: GLOW, boxShadow: `inset 0 0 0 1px ${GLOW_EDGE}` }}
    >
      {spans.map(([a, b]) => (
        <span
          key={`${a}-${b}`}
          className="duration-slow absolute grid place-items-center transition-[box-shadow,opacity] ease-out"
          style={{
            ...pos(a, b - a),
            ...(vertical ? { left: 0, right: 0 } : { top: 0, bottom: 0 }),
            background: OPEN_FILL,
            // All calls: AYA answers the open hours too, so they carry her glow.
            boxShadow: mode === "all" ? `inset 0 0 0 2px ${GLOW_EDGE}, inset 0 0 18px rgba(135,214,141,0.45)` : "none",
          }}
        >
          {vertical ? (
            <span className="hidden px-1 text-center text-xs leading-tight font-semibold text-[#0B1520]/75 md:block">
              {clockLabel(a)}
              <br />–{clockLabel(b)}
            </span>
          ) : null}
          {/* Overflow: a call that lands while the desk is busy, answered and booked. */}
          {mode === "overflow" ? (
            <span aria-hidden className="hd-overflow-pulse absolute" style={vertical ? { top: "18%", left: "50%" } : { left: "55%", top: "50%" }}>
              <span className="hd-overflow-dot" />
              {vertical ? <span className="hd-overflow-tag">Booked ✓</span> : null}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

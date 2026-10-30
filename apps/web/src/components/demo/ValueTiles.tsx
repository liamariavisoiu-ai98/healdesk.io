"use client";

import { useEffect, useRef, useState } from "react";

import { useDemoClose, useSeenOnce } from "@/components/demo/DemoClose";
import { enquiriesPerMonth, openHoursOf } from "@/lib/demo/close";
import { HOURS_IN_A_WEEK, type WeekSchedule } from "@/lib/demo/opening-hours";
import { usd } from "@/lib/pricing";
import { site } from "@/lib/site";

/**
 * What answering every call is worth to this clinic, in three tiles:
 *
 *   1. hours someone answers, now and with AYA, from its real hours;
 *   2. the calls and messages AYA would pick up in a month, an estimate from
 *      the owner's own weekly figures (no call has been measured, so it is
 *      never derived from the hours);
 *   3. booked value, the one money figure v1 may claim: those enquiries ×
 *      the booking rate × the show rate × one visit at the clinic's price
 *      (lib/demo/roi.ts `estimate`, the arithmetic checkout used to show).
 *
 * The two estimates say "Estimate" and show their formula on a tap. The
 * inputs sit closed under "Adjust to your clinic"; moving one moves the
 * steps, so the price beside tile 3 and on every button moves too. No ROI
 * multiple is printed: the two figures side by side are the comparison.
 */

const COUNT_MS = 700;

/**
 * Counts up to `target` once, the first time `run` turns true; the real
 * figure otherwise (on the server, without script, with reduced motion, and
 * after the first count, when a figure follows its inputs directly). The
 * frames set the state from their callbacks, never from the effect itself.
 */
function useCountUp(target: number, run: boolean): number {
  const [progress, setProgress] = useState<number | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!run || started.current) return;
    started.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / COUNT_MS);
      setProgress(p < 1 ? p : null);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run]);
  return progress === null ? target : Math.round(target * (1 - Math.pow(1 - progress, 3)));
}

export function ValueTiles({ schedule }: { schedule: WeekSchedule }) {
  const { clinicName, inputs, setInputs, rec, track } = useDemoClose();
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const used = useRef(false);
  useSeenOnce(ref, () => setSeen(true), 0.35);

  const open = openHoursOf(schedule);
  const closed = Math.round((HOURS_IN_A_WEEK - open) * 10) / 10;
  const enquiries = enquiriesPerMonth(inputs);
  const value = rec.estimate.bookedValueUsd;

  const shownOpen = useCountUp(Math.round(open), seen);
  const shownEnquiries = useCountUp(enquiries, seen);
  const shownValue = useCountUp(value, seen);

  const change = (patch: Partial<typeof inputs>) => {
    if (!used.current) {
      used.current = true;
      track("value_inputs_used");
    }
    setInputs({ ...inputs, ...patch });
  };

  const priceMin = Math.min(150, inputs.priceUsd);

  return (
    <section ref={ref} aria-labelledby="value-heading" className="mt-14">
      <h2 id="value-heading" className="heading-section mx-auto max-w-[24ch] text-center">
        What answering every call is worth to {clinicName}
      </h2>

      <div className="mx-auto mt-8 grid max-w-[980px] gap-3 sm:grid-cols-3">
        <Tile label="Hours someone answers">
          <p className="font-display text-4xl leading-none font-medium tabular-nums">
            {shownOpen}
            <span className="text-muted mx-1.5 text-2xl">→</span>
            {HOURS_IN_A_WEEK}
          </p>
          <p className="text-muted mt-1 text-xs font-semibold">hours a week</p>
          <p className="mt-3 text-sm leading-snug font-semibold">
            Today, for {Number.isInteger(closed) ? closed : closed.toFixed(1)} hours a week, no one at {clinicName} can pick up.
          </p>
        </Tile>

        <Tile label="Calls and messages answered" estimate>
          <p className="font-display text-4xl leading-none font-medium tabular-nums">≈ {shownEnquiries}</p>
          <p className="text-muted mt-1 text-xs font-semibold">a month</p>
          <Formula>
            {inputs.missedCallsPerWeek} missed calls + {inputs.missedMessagesPerWeek} unanswered messages a week, × 4.33 weeks. Your
            figures, not ours: change them below.
          </Formula>
        </Tile>

        <Tile label="Booked value" estimate highlight>
          <p className="font-display text-4xl leading-none font-medium tabular-nums">≈ {usd.format(shownValue)}</p>
          <p className="mt-1 text-xs font-semibold opacity-75">a month, first visits only</p>
          <p className="mt-3 rounded-sm bg-white/70 px-3 py-2 text-sm font-bold tabular-nums">
            {site.agent}: {usd.format(rec.monthlyUsd)}/month
          </p>
          <Formula>
            {enquiries} enquiries × {Math.round(inputs.bookingRate * 100)}% that book × {Math.round(inputs.showRate * 100)}% that turn up
            (an assumption) × {usd.format(inputs.priceUsd)} a visit ({inputs.priceSource}). Booked value is bookings times your own prices.
          </Formula>
        </Tile>
      </div>

      <details className="group border-line mx-auto mt-4 max-w-[980px] rounded-md border bg-white">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-5 text-sm font-bold">
          Adjust to your clinic
          <span aria-hidden className="text-muted transition-transform group-open:rotate-45">+</span>
        </summary>
        <div className="grid gap-5 px-5 pt-1 pb-5 sm:grid-cols-2">
          <Slider
            label="Calls you miss a week"
            value={inputs.missedCallsPerWeek}
            min={0}
            max={60}
            step={1}
            format={(n) => String(n)}
            onChange={(n) => change({ missedCallsPerWeek: n })}
          />
          <Slider
            label="Messages left unanswered a week"
            value={inputs.missedMessagesPerWeek}
            min={0}
            max={60}
            step={1}
            format={(n) => String(n)}
            onChange={(n) => change({ missedMessagesPerWeek: n })}
          />
          <Slider
            label="Average appointment value"
            value={inputs.priceUsd}
            min={priceMin}
            max={1500}
            step={10}
            format={(n) => usd.format(n)}
            onChange={(n) => change({ priceUsd: n, priceSource: "your figure" })}
          />
          <Slider
            label="Enquiries that book"
            value={Math.round(inputs.bookingRate * 100)}
            min={5}
            max={80}
            step={1}
            format={(n) => `${n}%`}
            onChange={(n) => change({ bookingRate: n / 100 })}
          />
          <p className="text-muted text-xs sm:col-span-2">
            The volume you set here also sets the plan&rsquo;s steps: {rec.plan.name.split(", ")[1] ?? rec.plan.name}, at{" "}
            {usd.format(rec.monthlyUsd)} a month.
          </p>
        </div>
      </details>
    </section>
  );
}

function Tile({
  label,
  estimate = false,
  highlight = false,
  children,
}: {
  label: string;
  estimate?: boolean;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-md px-5 py-6 ${highlight ? "bg-[#e5f6dc] text-[#172a3a]" : "border-line border bg-white"}`}>
      <p className="flex items-center gap-2 text-xs font-bold tracking-[0.1em] uppercase opacity-70">
        {label}
        {estimate ? (
          <span className="border-current/30 rounded-full border px-1.5 py-px text-xs tracking-[0.06em]">Estimate</span>
        ) : null}
      </p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-semibold underline underline-offset-2 opacity-75">How this is worked out</summary>
      <p className="mt-1.5 leading-snug opacity-80">{children}</p>
    </details>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs font-semibold">
        {label}
        <span className="font-display text-base tabular-nums">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-11 w-full cursor-pointer"
        style={{ accentColor: "var(--clinic)" }}
      />
    </label>
  );
}

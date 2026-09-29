"use client";

import { useMemo, useState } from "react";

import { specialties } from "@/lib/specialties";

const WEEKS_PER_MONTH = 4.33;
/**
 * The default for the recovery slider. It is the VISITOR'S assumption, not a
 * healdesk claim: no independent figure exists for what share of missed
 * clinic calls a 24/7 AI agent converts, and this product has not yet
 * answered a real one. So the number is adjustable, labelled as theirs, and
 * the sentence beside it is conditional. The 70% an earlier draft hard-coded
 * was the single largest unsupported number on the site.
 */
const DEFAULT_RECOVERY_PERCENT = 50;

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * "What your missed calls cost you."
 *
 * The ROI formula from docs/icp-niches.md, made touchable:
 *   revenue at risk = call volume × leakage × booking rate × value per booking
 *
 * Every assumption is on screen and adjustable, because a calculator that hides
 * its inputs reads as a sales trick to exactly the operator we're selling to.
 */
export function LeakCalculator() {
  const [specialtyId, setSpecialtyId] = useState(specialties[0]!.id);
  const [callsPerWeek, setCallsPerWeek] = useState(80);
  const [missedPercent, setMissedPercent] = useState(28);
  const [recoveryPercent, setRecoveryPercent] = useState(DEFAULT_RECOVERY_PERCENT);

  const specialty =
    specialties.find((s) => s.id === specialtyId) ?? specialties[0]!;

  const result = useMemo(() => {
    const callsPerMonth = callsPerWeek * WEEKS_PER_MONTH;
    const missedPerMonth = callsPerMonth * (missedPercent / 100);
    const lostBookings = missedPerMonth * specialty.economics.bookingRate;
    const monthlyAtRisk = lostBookings * specialty.economics.valuePerBooking;

    return {
      missedPerMonth,
      lostBookings,
      monthlyAtRisk,
      annualAtRisk: monthlyAtRisk * 12,
      monthlyRecovered: monthlyAtRisk * (recoveryPercent / 100),
    };
  }, [callsPerWeek, missedPercent, recoveryPercent, specialty]);

  return (
    <section id="leak" className="scroll-mt-24 py-20 sm:py-28">
      <div className="max-w-[52ch]">
        <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
          The leak
        </p>
        <h2 className="font-display mt-3 text-[clamp(36px,5.28vw,62.4px)] leading-[1.04] font-medium tracking-[-0.026em]">
          Every unanswered call is{" "}
          <span className="text-brand-gradient">someone else&apos;s patient</span>.
        </h2>
        <p className="text-muted mt-4 text-[20.4px] font-medium">
          Not a lost call, a lost case. Move the sliders to your numbers.
        </p>
      </div>

      <div className="border-line mt-10 grid gap-0 overflow-hidden rounded-[20px] border bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Inputs */}
        <div className="border-line flex flex-col gap-7 border-b p-7 sm:p-9 lg:border-r lg:border-b-0">
          <Field label="Specialty">
            <select
              value={specialtyId}
              onChange={(event) => setSpecialtyId(event.target.value)}
              className="border-line focus:border-orange w-full rounded-xl border bg-white px-3.5 py-3 text-[18px] font-semibold outline-none transition-colors"
            >
              {specialties.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </Field>

          <Slider
            label="Inbound calls & messages a week"
            value={callsPerWeek}
            min={20}
            max={400}
            step={5}
            display={String(callsPerWeek)}
            onChange={setCallsPerWeek}
          />

          <Slider
            label="Share that go unanswered"
            value={missedPercent}
            min={5}
            max={60}
            step={1}
            display={`${missedPercent}%`}
            onChange={setMissedPercent}
            hint="Industry surveys put medspa and dental miss rates in the 20-40% band once you count after-hours."
          />

          <Slider
            label="Share you think an answered call recovers"
            value={recoveryPercent}
            min={10}
            max={90}
            step={5}
            display={`${recoveryPercent}%`}
            onChange={setRecoveryPercent}
            hint="Your assumption, not our promise. There is no independent figure for this, so set it to what you believe about your own callers."
          />

          <dl className="border-line text-muted space-y-1.5 border-t pt-5 text-[15.6px]">
            <div className="flex justify-between gap-4">
              <dt>Booking rate assumed</dt>
              <dd className="text-ink font-semibold">
                {Math.round(specialty.economics.bookingRate * 100)}%
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Value per booking</dt>
              <dd className="text-ink font-semibold">
                {currency.format(specialty.economics.valuePerBooking)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Basis</dt>
              <dd className="text-ink text-right font-semibold">
                {specialty.economics.basis}
              </dd>
            </div>
          </dl>
        </div>

        {/* Outputs */}
        <div className="bg-paper-2/60 flex flex-col justify-between gap-8 p-7 sm:p-9">
          <div>
            <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
              Revenue at risk
            </p>
            <p className="font-figure text-brand-gradient mt-2 text-[clamp(48px,7.2vw,76.8px)] leading-none font-semibold tracking-[-0.03em] tabular-nums">
              {currency.format(result.annualAtRisk)}
            </p>
            <p className="text-muted mt-2 text-sm font-semibold">
              a year · {currency.format(result.monthlyAtRisk)} a month
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Stat
              value={Math.round(result.missedPerMonth).toLocaleString()}
              label="Missed inquiries a month"
            />
            <Stat
              value={result.lostBookings.toFixed(1)}
              label="Bookings never made"
            />
          </div>

          <div>
            <p className="text-muted text-xs">
              Estimates from industry ranges and your own sliders, not a quote and
              not a promise of results.
            </p>
            <div
              className="bg-line/40 mt-3 flex h-2.5 overflow-hidden rounded-full"
              role="img"
              aria-label={`If ${recoveryPercent} percent of those calls were recovered, the share of revenue at risk recovered`}
            >
              <span
                className="bg-brand-gradient h-full"
                style={{ width: `${recoveryPercent}%` }}
              />
            </div>
            <p className="mt-3 text-[18px] font-semibold">
              If the agent recovered {recoveryPercent}% of those calls, that would be{" "}
              <span className="text-red-deep">
                {currency.format(result.monthlyRecovered)}
              </span>{" "}
              a month.
            </p>
            <p className="text-muted mt-2 text-xs">
              healdesk answers 24/7 and calls missed numbers back automatically;
              the closed-loop report then shows you which recovered calls actually
              collected, so after the first month this number is yours, not a slider.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-[15.6px] font-bold tracking-[0.04em] uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[15.6px] font-bold tracking-[0.04em] uppercase">
          {label}
        </span>
        <span className="font-figure text-red-deep text-xl font-semibold tabular-nums">
          {display}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-red h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[color:var(--color-line)]"
      />
      {hint ? <span className="text-muted mt-2 block text-xs">{hint}</span> : null}
    </label>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-line rounded-2xl border bg-white px-4 py-4">
      <p className="font-figure text-[31.2px] leading-none font-semibold tabular-nums">
        {value}
      </p>
      <p className="text-muted mt-1.5 text-xs font-semibold">{label}</p>
    </div>
  );
}

"use client";

import { useId, useMemo, useState } from "react";

import { site } from "@/lib/site";
import { specialties, type Specialty } from "@/lib/specialties";

const WEEKS_PER_MONTH = 4.33;

/**
 * The starting point for the fourth dial: what share of a missed call an
 * answered one recovers. The VISITOR'S assumption, adjustable and labelled as
 * theirs. No independent figure exists and the product has not yet answered
 * a real call, so nothing here claims one — the earlier hard-coded 70% was
 * the largest unsupported number on the site.
 */
const DEFAULT_RECOVERY_PERCENT = 50;

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * "Why go smart?", the revenue question, asked the way AYA would ask it.
 *
 * ## The register, which is the whole point of the rewrite
 *
 * The previous version of this was a loss-framed dashboard: a section titled
 * "The leak", a headline about someone else's patient, and a large red number
 * for money already gone. That is the standard B2B fear appeal, and it is the
 * wrong instrument for this audience, the people running these clinics are
 * overwhelmingly women who built the practice themselves, and being told they
 * are bleeding money reads as a stranger scolding them about their own
 * business.
 *
 * So the same arithmetic, in a different voice. AYA asks the questions rather
 * than a form demanding them; the answer is gain-framed (what stays in the
 * practice, not what escaped); the output is set editorially, one large
 * Fraunces figure and a soft ring, rather than as a finance readout.
 *
 * ## What did NOT change, and must not
 *
 * Every assumption stays on screen and adjustable: the booking rate, the value
 * per booking, and the basis for both. A calculator that hides its inputs reads
 * as a sales trick to exactly the operator we are selling to, and softening the
 * tone is not a licence to soften the evidence. The figures are approximate
 * industry ranges from docs/icp-niches.md and the footnote says so.
 *
 *   revenue in play = call volume × leakage × booking rate × value per booking
 */
export function WhyGoSmart({
  specialty,
  onSelectSpecialty,
  callsPerWeek,
  onCallsPerWeek,
  missedPercent,
  onMissedPercent,
}: {
  specialty: Specialty;
  onSelectSpecialty: (id: string) => void;
  callsPerWeek: number;
  onCallsPerWeek: (value: number) => void;
  missedPercent: number;
  onMissedPercent: (value: number) => void;
}) {
  const [recoveryPercent, setRecoveryPercent] = useState(DEFAULT_RECOVERY_PERCENT);
  const recoveryShare = recoveryPercent / 100;

  const result = useMemo(() => {
    const callsPerMonth = callsPerWeek * WEEKS_PER_MONTH;
    const missedPerMonth = callsPerMonth * (missedPercent / 100);
    const lostBookings = missedPerMonth * specialty.economics.bookingRate;
    const monthlyInPlay = lostBookings * specialty.economics.valuePerBooking;

    return {
      missedPerMonth,
      lostBookings,
      monthlyInPlay,
      annualInPlay: monthlyInPlay * 12,
      monthlyRecovered: monthlyInPlay * recoveryShare,
      annualRecovered: monthlyInPlay * recoveryShare * 12,
    };
  }, [callsPerWeek, missedPercent, recoveryShare, specialty]);

  return (
    <section id="why" className="scroll-mt-24 py-20 sm:py-28">
      <div className="max-w-[54ch]">
        <p className="eyebrow-tag">Why go smart?</p>
        <h2 className="font-display mt-3 text-[clamp(36px,5.28vw,62.4px)] leading-[1.04] font-medium tracking-[-0.026em]">
          The calls you never hear about are the ones{" "}
          <span className="text-brand-gradient">worth the most</span>.
        </h2>
        <p className="text-muted mt-4 text-[20.4px] font-medium">
          Not a lost call, a lost case. Answer {site.agent}&apos;s four
          questions and see what a full front desk could be worth to you.
        </p>
      </div>

      <div className="border-line mt-11 grid gap-0 overflow-hidden rounded-[24px] border bg-white lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        {/* ── The conversation ─────────────────────────────────────────── */}
        <div className="border-line flex flex-col gap-8 border-b p-7 sm:p-10 lg:border-r lg:border-b-0">
          <p className="text-muted flex items-center gap-2 text-xs font-bold tracking-[0.14em] uppercase">
            <span aria-hidden className="bg-brand-gradient size-2 rounded-full" />
            {site.agent} asks
          </p>

          <Ask question="What kind of practice are you running?">
            <div className="flex flex-wrap gap-2">
              {specialties.map((option) => {
                const active = option.id === specialty.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelectSpecialty(option.id)}
                    className={[
                      "rounded-full border px-3.5 py-2 text-[15.6px] font-semibold transition-colors",
                      active
                        ? "border-orange/60 bg-orange/[0.10] text-ink"
                        : "border-line text-muted hover:border-orange/40 hover:text-ink",
                    ].join(" ")}
                  >
                    {option.name}
                  </button>
                );
              })}
            </div>
          </Ask>

          <Ask question="How many people reach out in a week?">
            <Dial
              value={callsPerWeek}
              min={20}
              max={400}
              step={5}
              display={String(callsPerWeek)}
              unit="calls, texts & DMs"
              onChange={onCallsPerWeek}
              label="Inbound a week"
            />
          </Ask>

          <Ask question="And roughly how many never get through?">
            <Dial
              value={missedPercent}
              min={5}
              max={60}
              step={1}
              display={`${missedPercent}%`}
              unit="after hours, or mid-treatment"
              onChange={onMissedPercent}
              label="Share unanswered"
            />
            <p className="text-muted mt-3 text-xs">
              Industry surveys put med spa and dental miss rates in the 20–40%
              band once you count after-hours.
            </p>
          </Ask>

          <Ask question="If I answered every one of those, what share would you keep?">
            <Dial
              value={recoveryPercent}
              min={10}
              max={90}
              step={5}
              display={`${recoveryPercent}%`}
              unit="your guess, not my promise"
              onChange={setRecoveryPercent}
              label="Share recovered"
            />
            <p className="text-muted mt-3 text-xs">
              There is no independent figure for this and we will not invent
              one. After your first month the report replaces this dial with
              your real number.
            </p>
          </Ask>

          {/* The assumptions. Quiet, but never hidden, see the note above. */}
          <dl className="border-line text-muted space-y-2 border-t pt-6 text-[15.6px]">
            <Assumption label="Booking rate assumed">
              {Math.round(specialty.economics.bookingRate * 100)}%
            </Assumption>
            <Assumption label="Value per booking">
              {currency.format(specialty.economics.valuePerBooking)}
            </Assumption>
            <Assumption label="Basis">{specialty.economics.basis}</Assumption>
            <Assumption label="Share recovered (yours)">{recoveryPercent}%</Assumption>
          </dl>
        </div>

        {/* ── The answer ───────────────────────────────────────────────── */}
        <div className="bg-paper-2/50 flex flex-col items-center justify-center gap-8 p-8 text-center sm:p-12">
          <Ring share={recoveryShare} />

          <div>
            <p className="text-muted text-xs font-bold tracking-[0.14em] uppercase">
              Would stay in the practice, at your {recoveryPercent}%
            </p>
            <p className="font-figure text-brand-gradient mt-3 text-[clamp(50.4px,7.68vw,81.6px)] leading-none font-semibold tracking-[-0.03em] tabular-nums">
              {currency.format(result.annualRecovered)}
            </p>
            <p className="text-muted mt-3 text-sm font-semibold">
              a year · {currency.format(result.monthlyRecovered)} a month
            </p>
          </div>

          {/* AYA's read of the numbers, in her own voice. */}
          <p className="font-display mx-auto max-w-[34ch] text-[20.4px] leading-[1.45] font-medium tracking-[-0.01em] italic">
            &ldquo;About{" "}
            <span className="not-italic">
              {Math.round(result.missedPerMonth).toLocaleString()}
            </span>{" "}
            people a month never hear back from you. That&apos;s{" "}
            <span className="not-italic">{result.lostBookings.toFixed(1)}</span>{" "}
            bookings you never knew you had. If I caught {recoveryPercent}% of
            them, that is what stays with you. Let me try.&rdquo;
          </p>

          <p className="text-muted max-w-[42ch] text-xs leading-relaxed">
            Approximate industry ranges and your own dials, not a quote and not
            a promise of results. {currency.format(result.annualInPlay)} a year
            is in play;{" "}
            {site.agent} answers 24/7 and rings missed numbers back, and the
            closed-loop report tells you which of those recovered calls actually
            collected.
          </p>
        </div>
      </div>
    </section>
  );
}

/** One of AYA's questions, with whatever answers it. */
function Ask({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="font-display mb-3.5 text-[21.6px] leading-snug font-medium tracking-[-0.015em]">
        {question}
      </p>
      {children}
    </div>
  );
}

/**
 * A slider that reads as editorial rather than as a form control: the value is
 * set large in Fraunces above the track, and the track itself is thin and
 * unlabelled. Still a native `input[type=range]`, so keyboard, touch and screen
 * readers all get the behaviour they expect for free.
 */
function Dial({
  value,
  min,
  max,
  step,
  display,
  unit,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  unit: string;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-3">
        <span className="font-figure text-[40.8px] leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {display}
        </span>
        <span className="text-muted text-[15.6px] font-medium">{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-orange mt-4 h-1 w-full cursor-pointer appearance-none rounded-full bg-[color:var(--color-line)]"
      />
    </div>
  );
}

function Assumption({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt>{label}</dt>
      <dd className="text-ink text-right font-semibold">{children}</dd>
    </div>
  );
}

/**
 * The recovered share, as a ring.
 *
 * A ring rather than a progress bar because the bar was reading as a loading
 * indicator, and because the shape is the one piece of the section that is
 * allowed to be purely decorative. `pathLength={1}` normalises the circumference
 * to 1, so the dash array is the share itself and there is no 2πr arithmetic to
 * get wrong when the radius changes.
 */
function Ring({ share }: { share: number }) {
  const gradientId = useId();
  const percent = Math.round(share * 100);

  return (
    <div className="relative">
      <svg
        viewBox="0 0 120 120"
        className="size-[168px] -rotate-90"
        role="img"
        aria-label={`healdesk recovers an estimated ${percent} percent of the revenue in play`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="6%" stopColor="var(--color-red)" />
            <stop offset="94%" stopColor="var(--color-orange)" />
          </linearGradient>
        </defs>
        <circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke="var(--color-paper-2)"
          strokeWidth="11"
        />
        <circle
          cx="60"
          cy="60"
          r="50"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="11"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={`${share} 1`}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div>
          <p className="font-figure text-[36px] leading-none font-semibold tabular-nums">
            {percent}%
          </p>
          <p className="text-muted mt-1.5 text-[13.2px] font-bold tracking-[0.1em] uppercase">
            recovered
          </p>
        </div>
      </div>
    </div>
  );
}

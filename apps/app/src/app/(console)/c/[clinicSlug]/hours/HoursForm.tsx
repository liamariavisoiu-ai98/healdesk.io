"use client";

import { useActionState, useState } from "react";

import {
  COMMON_WEEKDAY_HOURS,
  DAY_KEYS,
  DAY_LABELS,
  type DayKey,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";

import { saveOpeningHours, type HoursState } from "./actions";

/**
 * The opening-hours editor.
 *
 * Two decisions worth naming, both about not guessing on the clinic's behalf:
 *
 *   - **Closed is a tick, not an empty field.** Leaving a day blank is an
 *     error, because "I haven't filled this in" and "we're shut on Sundays"
 *     mean opposite things for what we may claim, and a blank box cannot tell
 *     them apart.
 *   - **The Mon–Fri 9–5 button prefills the form, it does not save.** Offering
 *     a common shape saves typing; applying it silently would put hours on a
 *     clinic that never confirmed them, which is the overstating failure this
 *     whole feature is built to avoid.
 */

type DayState = { closed: boolean; ranges: [string, string][] };

function toDayState(hours: OpeningHours | null): Record<DayKey, DayState> {
  const state = {} as Record<DayKey, DayState>;
  for (const day of DAY_KEYS) {
    const ranges = hours?.[day];
    state[day] = ranges
      ? {
          closed: ranges.length === 0,
          ranges: ranges.map((r) => [r[0], r[1]] as [string, string]),
        }
      : { closed: false, ranges: [] };
  }
  return state;
}

export function HoursForm({
  clinicSlug,
  timezone,
  initial,
}: {
  clinicSlug: string;
  timezone: string;
  initial: OpeningHours | null;
}) {
  const [state, action, pending] = useActionState<HoursState, FormData>(
    saveOpeningHours,
    { status: "idle" },
  );
  const [days, setDays] = useState<Record<DayKey, DayState>>(() =>
    toDayState(initial),
  );

  const update = (day: DayKey, next: Partial<DayState>) =>
    setDays((current) => ({ ...current, [day]: { ...current[day], ...next } }));

  const setRange = (
    day: DayKey,
    slot: number,
    index: 0 | 1,
    value: string,
  ) =>
    setDays((current) => {
      const ranges = current[day].ranges.map(
        (r) => [r[0], r[1]] as [string, string],
      );
      while (ranges.length <= slot) ranges.push(["", ""]);
      ranges[slot]![index] = value;
      return { ...current, [day]: { ...current[day], ranges } };
    });

  return (
    <form action={action} className="mt-6">
      <input type="hidden" name="clinicSlug" value={clinicSlug} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[color:var(--color-muted)]">
          Times are local to <strong>{timezone}</strong>, the timezone on this
          clinic.
        </p>
        <button
          type="button"
          onClick={() => setDays(toDayState(COMMON_WEEKDAY_HOURS))}
          className="rounded-lg border border-[color:var(--color-line)] px-3 py-1.5 text-xs font-semibold hover:border-[color:var(--color-line-strong)]"
        >
          Prefill Mon–Fri, 9–5
        </button>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-[color:var(--color-line)]">
        {DAY_KEYS.map((day) => {
          const value = days[day];
          const invalid = state.status === "error" && state.field === day;

          return (
            <div
              key={day}
              className={[
                "flex flex-wrap items-center gap-3 border-b border-[color:var(--color-line)] px-4 py-3 last:border-b-0",
                invalid ? "bg-[color:var(--color-red)]/[0.04]" : "",
              ].join(" ")}
            >
              <span className="w-24 shrink-0 text-sm font-semibold">
                {DAY_LABELS[day]}
              </span>

              <label className="flex shrink-0 items-center gap-2 text-xs font-semibold text-[color:var(--color-muted)]">
                <input
                  type="checkbox"
                  name={`${day}-closed`}
                  checked={value.closed}
                  onChange={(e) => update(day, { closed: e.target.checked })}
                />
                Closed
              </label>

              {value.closed ? null : (
                <div className="flex flex-wrap items-center gap-2">
                  {[0, 1].map((slot) => (
                    <span key={slot} className="flex items-center gap-1.5">
                      {slot === 1 ? (
                        <span className="mr-1 text-xs text-[color:var(--color-muted)]">
                          and
                        </span>
                      ) : null}
                      <input
                        type="time"
                        name={`${day}-open-${slot}`}
                        value={value.ranges[slot]?.[0] ?? ""}
                        onChange={(e) => setRange(day, slot, 0, e.target.value)}
                        className="rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-sm"
                      />
                      <span className="text-xs text-[color:var(--color-muted)]">
                        to
                      </span>
                      <input
                        type="time"
                        name={`${day}-close-${slot}`}
                        value={value.ranges[slot]?.[1] ?? ""}
                        onChange={(e) => setRange(day, slot, 1, e.target.value)}
                        className="rounded-lg border border-[color:var(--color-line)] px-2 py-1 text-sm"
                      />
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {state.status === "error" ? (
        <p className="mt-4 text-sm font-semibold text-[color:var(--color-red)]">
          {state.message}
        </p>
      ) : null}
      {state.status === "saved" ? (
        <p className="mt-4 text-sm font-semibold text-[color:var(--color-confirm,#3B7A57)]">
          Saved. After-hours calls will now be counted as recovered.
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-6 rounded-xl bg-[color:var(--color-ink)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save opening hours"}
      </button>
    </form>
  );
}

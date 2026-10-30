"use client";

/**
 * The two editors the setup wizard and Knowledge share (plan Part E 1.2 and
 * 1.3, Part F3): a practice's weekly hours with its closed days, and its
 * services with how each is priced. Controlled components: the screen that
 * holds them owns the state and decides when it is saved, so the wizard
 * saves on "Save and continue" and Knowledge on its own Save, through the
 * same server-side validation (lib/setup/practice.ts, lib/setup/knowledge.ts).
 */

export const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;
export type DayKey = (typeof DAYS)[number][0];
export type Range = [string, string];
export type HoursInitial = Record<DayKey, Range[]>;
export type ClosureRow = { closedOn: string; label: string };

/** Weekdays, 9 to 5: where a practice with no hours on file starts. */
export const WEEKDAY_HOURS: HoursInitial = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
  sun: [],
};

export function HoursEditor(props: {
  hours: HoursInitial;
  onHours: (hours: HoursInitial) => void;
  /** The closed days; left out (with onClosures), the editor shows the week alone. */
  closures?: ClosureRow[];
  onClosures?: (closures: ClosureRow[]) => void;
  /** Today on the clinic's calendar: no closed day before it. */
  today?: string;
  /** The closed days' heading: h2 on a wizard screen, h3 inside Knowledge's Hours section. */
  closuresHeading?: "h2" | "h3";
}) {
  const { hours } = props;
  const closures = props.closures ?? [];
  const onClosures = props.onClosures;
  const ClosuresHeading = props.closuresHeading ?? "h2";
  const setDay = (day: DayKey, ranges: Range[]) => props.onHours({ ...hours, [day]: ranges });
  const setClosure = (i: number, patch: Partial<ClosureRow>) =>
    onClosures?.(closures.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <>
      <div className="grid gap-3">
        {DAYS.map(([day, label]) => {
          const ranges = hours[day];
          const open = ranges.length > 0;
          return (
            <fieldset key={day} className="border-line rounded-md border bg-white px-4 py-3">
              <legend className="sr-only">{label}</legend>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-h-11 w-36 items-center gap-2 font-semibold">
                  <input
                    type="checkbox"
                    checked={open}
                    onChange={(event) =>
                      setDay(day, event.target.checked ? [["09:00", "17:00"]] : [])
                    }
                  />
                  {label}
                </label>
                {open ? (
                  ranges.map(([from, to], i) => (
                    <span key={i} className="flex items-center gap-2">
                      <input
                        type="time"
                        aria-label={`${label} opens`}
                        value={from}
                        onChange={(event) =>
                          setDay(
                            day,
                            ranges.map((r, j) =>
                              j === i ? [event.target.value, r[1]] : r,
                            ) as Range[],
                          )
                        }
                        className="border-line min-h-11 rounded-sm border px-2"
                      />
                      <span aria-hidden="true">to</span>
                      <input
                        type="time"
                        aria-label={`${label} closes`}
                        value={to}
                        onChange={(event) =>
                          setDay(
                            day,
                            ranges.map((r, j) =>
                              j === i ? [r[0], event.target.value] : r,
                            ) as Range[],
                          )
                        }
                        className="border-line min-h-11 rounded-sm border px-2"
                      />
                    </span>
                  ))
                ) : (
                  <span className="text-muted text-sm">Closed</span>
                )}
                {open && ranges.length === 1 ? (
                  <button
                    type="button"
                    onClick={() =>
                      setDay(day, [
                        [ranges[0]![0], "12:30"],
                        ["13:30", ranges[0]![1]],
                      ])
                    }
                    className="text-muted min-h-11 text-sm underline"
                  >
                    Add a break
                  </button>
                ) : open && ranges.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setDay(day, [[ranges[0]![0], ranges.at(-1)![1]]])}
                    className="text-muted min-h-11 text-sm underline"
                  >
                    No break
                  </button>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>

      {onClosures ? (
        <div className="grid gap-2">
          <ClosuresHeading className="text-sm font-semibold">
            Days you&rsquo;re closed
          </ClosuresHeading>
          <p className="text-muted text-xs">
            Holidays and training days. AYA tells callers, and phone treats them as after hours.
          </p>
          {closures.map((closure, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                aria-label="Closed on"
                min={props.today}
                value={closure.closedOn}
                onChange={(event) => setClosure(i, { closedOn: event.target.value })}
                className="border-line min-h-11 rounded-sm border bg-white px-2"
              />
              <input
                type="text"
                aria-label="What it's for"
                placeholder="e.g. Thanksgiving"
                maxLength={80}
                value={closure.label}
                onChange={(event) => setClosure(i, { label: event.target.value })}
                className="border-line min-h-11 flex-1 rounded-sm border bg-white px-3"
              />
              <button
                type="button"
                onClick={() => onClosures(closures.filter((_, j) => j !== i))}
                className="text-muted min-h-11 px-2 text-sm underline"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => onClosures([...closures, { closedOn: "", label: "" }])}
            className="border-line min-h-11 w-fit rounded-full border px-4 py-2 text-sm font-semibold"
          >
            Add a closed day
          </button>
        </div>
      ) : null}
    </>
  );
}

// -----------------------------------------------------------------------------
// Services and prices
// -----------------------------------------------------------------------------

export type ServiceRow = {
  name: string;
  priceKind: "exact" | "from" | "range" | "per_unit" | null;
  price: string;
  maxPrice: string;
  unit: string;
  duration: string;
  /** The deposit as typed, in Knowledge's column. The wizard asks on its own screen. */
  deposit?: string;
  /** The deposit as stored, carried through by the wizard; Knowledge sends what is typed. */
  depositUsd: number | null;
};

export const PRICE_KINDS = [
  ["exact", "Exact price"],
  ["from", "From"],
  ["range", "Range"],
  ["per_unit", "Per unit"],
  ["", "No price: offer a consultation"],
] as const;

export function emptyServiceRow(): ServiceRow {
  return {
    name: "",
    priceKind: "exact",
    price: "",
    maxPrice: "",
    unit: "",
    duration: "",
    deposit: "",
    depositUsd: null,
  };
}

function num(value: string): number | null {
  return value.trim() === "" ? null : Number(value.replace(/[$,\s]/g, ""));
}

/**
 * The rows as the server validates them (lib/setup/knowledge.ts
 * validateServices). With `withDeposit`, the typed deposit is sent, and a
 * blank one, which reads "None", is no deposit: 0, which BD27 reads as none
 * even when the clinic has a default, on every row, new ones included, as
 * the wizard's Deposits screen stores it. Knowledge shows a row that follows
 * the clinic default with that amount typed in, so a row left as it was keeps
 * its deposit. Without `withDeposit`, the stored deposit is carried through
 * unchanged.
 */
export function servicesPayload(rows: readonly ServiceRow[], withDeposit: boolean) {
  return rows
    .filter((r) => r.name.trim() !== "")
    .map((r) => ({
      name: r.name,
      priceKind: r.priceKind,
      price: r.priceKind ? num(r.price) : null,
      maxPrice: r.priceKind === "range" ? num(r.maxPrice) : null,
      unit: r.priceKind === "per_unit" ? r.unit : null,
      durationMinutes: r.duration.trim() === "" ? null : Number(r.duration),
      depositUsd: withDeposit ? typedDeposit(r) : r.depositUsd,
    }));
}

function typedDeposit(row: ServiceRow): number {
  return num(row.deposit ?? "") ?? 0;
}

export function ServicesEditor(props: {
  rows: ServiceRow[];
  onRows: (rows: ServiceRow[]) => void;
  /** Knowledge shows a deposit per service; the wizard asks for deposits on their own screen. */
  withDeposit?: boolean;
}) {
  const { rows } = props;
  const update = (i: number, patch: Partial<ServiceRow>) =>
    props.onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="grid gap-3">
      {rows.map((row, i) => (
        <fieldset key={i} className="border-line grid gap-2 rounded-md border bg-white px-4 py-3">
          <legend className="sr-only">Service {i + 1}</legend>
          <input
            aria-label={`Service ${i + 1} name`}
            placeholder="Service name"
            value={row.name}
            maxLength={120}
            onChange={(event) => update(i, { name: event.target.value })}
            className="border-line min-h-11 rounded-sm border px-3 font-semibold"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`How service ${i + 1} is priced`}
              value={row.priceKind ?? ""}
              onChange={(event) =>
                update(i, { priceKind: (event.target.value || null) as ServiceRow["priceKind"] })
              }
              className="border-line min-h-11 rounded-sm border bg-white px-2"
            >
              {PRICE_KINDS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            {row.priceKind ? (
              <span className="flex items-center gap-1">
                <span aria-hidden="true" className="text-muted">
                  $
                </span>
                <input
                  aria-label={`Service ${i + 1} price in dollars`}
                  inputMode="decimal"
                  value={row.price}
                  onChange={(event) => update(i, { price: event.target.value })}
                  className="border-line min-h-11 w-24 rounded-sm border px-2"
                />
              </span>
            ) : null}
            {row.priceKind === "range" ? (
              <span className="flex items-center gap-1">
                <span aria-hidden="true">to $</span>
                <input
                  aria-label={`Service ${i + 1} top of the range in dollars`}
                  inputMode="decimal"
                  value={row.maxPrice}
                  onChange={(event) => update(i, { maxPrice: event.target.value })}
                  className="border-line min-h-11 w-24 rounded-sm border px-2"
                />
              </span>
            ) : null}
            {row.priceKind === "per_unit" ? (
              <span className="flex items-center gap-1">
                <span aria-hidden="true">per</span>
                <input
                  aria-label={`Service ${i + 1} priced per`}
                  placeholder="unit"
                  value={row.unit}
                  maxLength={40}
                  onChange={(event) => update(i, { unit: event.target.value })}
                  className="border-line min-h-11 w-28 rounded-sm border px-2"
                />
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <input
                aria-label={`Service ${i + 1} length in minutes`}
                inputMode="numeric"
                placeholder="Length"
                value={row.duration}
                onChange={(event) => update(i, { duration: event.target.value })}
                className="border-line min-h-11 w-20 rounded-sm border px-2"
              />
              <span aria-hidden="true" className="text-muted text-sm">
                min
              </span>
            </span>
            {props.withDeposit ? (
              <span className="flex items-center gap-1">
                <span aria-hidden="true" className="text-muted text-sm">
                  Deposit $
                </span>
                <input
                  aria-label={`Service ${i + 1} deposit in dollars, empty for none`}
                  inputMode="decimal"
                  placeholder="None"
                  value={row.deposit ?? ""}
                  onChange={(event) => update(i, { deposit: event.target.value })}
                  className="border-line min-h-11 w-24 rounded-sm border px-2"
                />
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => props.onRows(rows.filter((_, j) => j !== i))}
              className="text-muted min-h-11 px-2 text-sm underline"
            >
              Remove
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        onClick={() => props.onRows([...rows, emptyServiceRow()])}
        className="border-line min-h-11 w-fit rounded-full border px-4 py-2 text-sm font-semibold"
      >
        Add a service
      </button>
    </div>
  );
}

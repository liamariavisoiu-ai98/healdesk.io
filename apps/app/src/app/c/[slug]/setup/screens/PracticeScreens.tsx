"use client";

import { useEffect, useId, useState } from "react";

import { Choice, Field, ScreenShell } from "../ScreenShell";

/**
 * Step 1 · Your practice (plan Part E): 1.1 the basics, 1.2 hours and closed
 * days, 1.3 services and prices, 1.4 the most-asked question, and 1.5 the
 * insurance question when the buyer was not sure at checkout. Everything
 * arrives pre-filled from the website read ("never ask twice"): the clinic
 * corrects, it does not type.
 */

type Common = { slug: string; backHref: string | null; skipCost: string };

// -----------------------------------------------------------------------------
// 1.1 Basics
// -----------------------------------------------------------------------------

export type BasicsInitial = {
  name: string;
  address: string;
  phone: string;
  website: string;
  timezone: string;
  timezoneConfirmed: boolean;
};

export function BasicsScreen(
  props: Common & {
    initial: BasicsInitial;
    /** The zone the address says, when it says one. */
    addressZone: string | null;
    zones: readonly { id: string; label: string }[];
    /** The locations the website read lists, when it lists several. */
    locations: readonly { label: string; address: string | null; phone: string | null }[];
  },
) {
  const [name, setName] = useState(props.initial.name);
  const [address, setAddress] = useState(props.initial.address);
  const [phone, setPhone] = useState(props.initial.phone);
  const [website, setWebsite] = useState(props.initial.website);
  const [timezone, setTimezone] = useState(props.initial.timezone);
  const [location, setLocation] = useState<number | null>(props.locations.length > 1 ? 0 : null);
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const [zoneSettled, setZoneSettled] = useState(false);
  const zoneId = useId();

  useEffect(() => {
    try {
      setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? null);
    } catch {
      setBrowserZone(null);
    }
  }, []);

  const options = [...props.zones];
  for (const extra of [props.initial.timezone, browserZone]) {
    if (extra && !options.some((z) => z.id === extra)) options.push({ id: extra, label: extra });
  }
  const labelOf = (id: string) => options.find((z) => z.id === id)?.label ?? id;
  const disagrees =
    !zoneSettled &&
    !props.initial.timezoneConfirmed &&
    browserZone !== null &&
    browserZone !== timezone;

  return (
    <ScreenShell
      slug={props.slug}
      screen="basics"
      title="Your practice"
      intro={
        <p>Check what we have. AYA tells callers these, so correct anything that&rsquo;s off.</p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ name, address, phone, website, timezone, location })}
    >
      {props.locations.length > 1 ? (
        <Choice
          legend="Your website lists more than one location. Which one is this AYA for?"
          value={String(location ?? 0)}
          onChange={(value) => {
            const index = Number(value);
            const chosen = props.locations[index];
            setLocation(index);
            if (chosen?.address) setAddress(chosen.address);
            if (chosen?.phone) setPhone(chosen.phone);
          }}
          options={props.locations.map((l, i) => ({
            id: String(i),
            label: l.label,
            line: l.address ?? undefined,
          }))}
        />
      ) : null}
      <Field
        label="Practice name"
        value={name}
        onChange={setName}
        maxLength={120}
        autoComplete="organization"
      />
      <Field
        label="Address"
        hint="Street, city, state and ZIP. AYA gives it to anyone who asks where you are."
        value={address}
        onChange={setAddress}
        maxLength={300}
        autoComplete="street-address"
      />
      <Field
        label="Main phone number"
        hint="The number patients call today. You keep it: phone forwarding comes later, from this number."
        value={phone}
        onChange={setPhone}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
      />
      <Field
        label="Website"
        hint="Leave it empty if the practice has none."
        value={website}
        onChange={setWebsite}
        type="url"
        maxLength={200}
      />
      <div className="grid gap-1">
        <label htmlFor={zoneId} className="text-sm font-semibold">
          Time zone
        </label>
        <select
          id={zoneId}
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          className="border-line min-h-11 rounded-xl border bg-white px-4 py-2"
        >
          {options.map((zone) => (
            <option key={zone.id} value={zone.id}>
              {zone.label}
            </option>
          ))}
        </select>
        <p className="text-muted text-xs">
          {props.addressZone && props.addressZone === timezone
            ? "From your address. Your hours, closed days and emails use it."
            : "Your hours, closed days and emails use it."}
        </p>
      </div>
      {disagrees ? (
        <div className="rounded-xl border border-line bg-white px-4 py-3 text-sm">
          <p>
            This device&rsquo;s clock says {labelOf(browserZone!)}, but we have {labelOf(timezone)}.
            Which is right for the practice?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setZoneSettled(true)}
              className="border-line min-h-11 rounded-full border px-4 py-2 font-semibold"
            >
              Keep {labelOf(timezone)}
            </button>
            <button
              type="button"
              onClick={() => {
                setTimezone(browserZone!);
                setZoneSettled(true);
              }}
              className="border-line min-h-11 rounded-full border px-4 py-2 font-semibold"
            >
              Use {labelOf(browserZone!)}
            </button>
          </div>
        </div>
      ) : null}
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 1.2 Hours and closed days
// -----------------------------------------------------------------------------

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const;
type DayKey = (typeof DAYS)[number][0];
type Range = [string, string];
export type HoursInitial = Record<DayKey, Range[]>;

export function HoursScreen(
  props: Common & {
    initial: HoursInitial | null;
    closures: readonly { closedOn: string; label: string | null }[];
    readFromSite: boolean;
    today: string;
  },
) {
  const blank: HoursInitial = {
    mon: [["09:00", "17:00"]],
    tue: [["09:00", "17:00"]],
    wed: [["09:00", "17:00"]],
    thu: [["09:00", "17:00"]],
    fri: [["09:00", "17:00"]],
    sat: [],
    sun: [],
  };
  const [hours, setHours] = useState<HoursInitial>(props.initial ?? blank);
  const [closures, setClosures] = useState(
    props.closures.map((c) => ({ closedOn: c.closedOn, label: c.label ?? "" })),
  );

  const setDay = (day: DayKey, ranges: Range[]) => setHours((h) => ({ ...h, [day]: ranges }));

  return (
    <ScreenShell
      slug={props.slug}
      screen="hours"
      title="Your hours"
      intro={
        <p>
          {props.initial && props.readFromSite
            ? "These are the hours your website shows. "
            : props.initial
              ? ""
              : "We start you on weekdays, 9 to 5. "}
          AYA tells callers when you&rsquo;re open, and with phone, these decide when calls reach
          her.
        </p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ hours, closures: closures.filter((c) => c.closedOn) })}
    >
      <div className="grid gap-3">
        {DAYS.map(([day, label]) => {
          const ranges = hours[day];
          const open = ranges.length > 0;
          return (
            <fieldset key={day} className="border-line rounded-xl border bg-white px-4 py-3">
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
                        className="border-line min-h-11 rounded-lg border px-2"
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
                        className="border-line min-h-11 rounded-lg border px-2"
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

      <div className="grid gap-2">
        <h2 className="text-sm font-semibold">Days you&rsquo;re closed</h2>
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
              onChange={(event) =>
                setClosures((list) =>
                  list.map((c, j) => (j === i ? { ...c, closedOn: event.target.value } : c)),
                )
              }
              className="border-line min-h-11 rounded-lg border bg-white px-2"
            />
            <input
              type="text"
              aria-label="What it's for"
              placeholder="e.g. Thanksgiving"
              maxLength={80}
              value={closure.label}
              onChange={(event) =>
                setClosures((list) =>
                  list.map((c, j) => (j === i ? { ...c, label: event.target.value } : c)),
                )
              }
              className="border-line min-h-11 flex-1 rounded-lg border bg-white px-3"
            />
            <button
              type="button"
              onClick={() => setClosures((list) => list.filter((_, j) => j !== i))}
              className="text-muted min-h-11 px-2 text-sm underline"
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setClosures((list) => [...list, { closedOn: "", label: "" }])}
          className="border-line min-h-11 w-fit rounded-full border px-4 py-2 text-sm font-semibold"
        >
          Add a closed day
        </button>
      </div>
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 1.3 Services and prices
// -----------------------------------------------------------------------------

export type ServiceRow = {
  name: string;
  priceKind: "exact" | "from" | "range" | "per_unit" | null;
  price: string;
  maxPrice: string;
  unit: string;
  duration: string;
  depositUsd: number | null;
};

const PRICE_KINDS = [
  ["exact", "Exact price"],
  ["from", "From"],
  ["range", "Range"],
  ["per_unit", "Per unit"],
  ["", "No price: offer a consultation"],
] as const;

export function ServicesScreen(
  props: Common & { initial: ServiceRow[]; dropped: number; readFromSite: boolean },
) {
  const [rows, setRows] = useState<ServiceRow[]>(
    props.initial.length > 0
      ? props.initial
      : [
          {
            name: "",
            priceKind: "exact",
            price: "",
            maxPrice: "",
            unit: "",
            duration: "",
            depositUsd: null,
          },
        ],
  );
  const update = (i: number, patch: Partial<ServiceRow>) =>
    setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const num = (value: string) =>
    value.trim() === "" ? null : Number(value.replace(/[$,\s]/g, ""));

  return (
    <ScreenShell
      slug={props.slug}
      screen="services"
      title="Services and prices"
      intro={
        <>
          <p>
            {props.readFromSite
              ? "These are the services and prices your website lists."
              : "List your most-booked services with their prices."}{" "}
            AYA quotes only these prices; anything else becomes an offer to book a consultation.
          </p>
          {props.dropped > 0 ? (
            <p>
              We left out {props.dropped === 1 ? "1 item" : `${props.dropped} items`} that mention
              doses or recovery; add them back in your own words.
            </p>
          ) : null}
        </>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({
        services: rows
          .filter((r) => r.name.trim() !== "")
          .map((r) => ({
            name: r.name,
            priceKind: r.priceKind,
            price: r.priceKind ? num(r.price) : null,
            maxPrice: r.priceKind === "range" ? num(r.maxPrice) : null,
            unit: r.priceKind === "per_unit" ? r.unit : null,
            durationMinutes: r.duration.trim() === "" ? null : Number(r.duration),
            depositUsd: r.depositUsd,
          })),
      })}
    >
      <div className="grid gap-3">
        {rows.map((row, i) => (
          <fieldset key={i} className="border-line grid gap-2 rounded-xl border bg-white px-4 py-3">
            <legend className="sr-only">Service {i + 1}</legend>
            <input
              aria-label={`Service ${i + 1} name`}
              placeholder="Service name"
              value={row.name}
              maxLength={120}
              onChange={(event) => update(i, { name: event.target.value })}
              className="border-line min-h-11 rounded-lg border px-3 font-semibold"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label={`How service ${i + 1} is priced`}
                value={row.priceKind ?? ""}
                onChange={(event) =>
                  update(i, { priceKind: (event.target.value || null) as ServiceRow["priceKind"] })
                }
                className="border-line min-h-11 rounded-lg border bg-white px-2"
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
                    className="border-line min-h-11 w-24 rounded-lg border px-2"
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
                    className="border-line min-h-11 w-24 rounded-lg border px-2"
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
                    className="border-line min-h-11 w-28 rounded-lg border px-2"
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
                  className="border-line min-h-11 w-20 rounded-lg border px-2"
                />
                <span aria-hidden="true" className="text-muted text-sm">
                  min
                </span>
              </span>
              <button
                type="button"
                onClick={() => setRows((list) => list.filter((_, j) => j !== i))}
                className="text-muted min-h-11 px-2 text-sm underline"
              >
                Remove
              </button>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            setRows((list) => [
              ...list,
              {
                name: "",
                priceKind: "exact",
                price: "",
                maxPrice: "",
                unit: "",
                duration: "",
                depositUsd: null,
              },
            ])
          }
          className="border-line min-h-11 w-fit rounded-full border px-4 py-2 text-sm font-semibold"
        >
          Add a service
        </button>
      </div>
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 1.4 The most-asked question
// -----------------------------------------------------------------------------

export function QuestionScreen(
  props: Common & { question: string; answer: string; fromSite: boolean },
) {
  const [question, setQuestion] = useState(props.question);
  const [answer, setAnswer] = useState(props.answer);
  return (
    <ScreenShell
      slug={props.slug}
      screen="question"
      title="What do people ask you most?"
      intro={
        <p>
          {props.fromSite
            ? "Your website answers this one; change it if something else comes up more."
            : "The one question your front desk answers all day, and your answer to it."}{" "}
          Leave out anything medical: AYA passes those to your team.
        </p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ question, answer })}
    >
      <Field label="The question" value={question} onChange={setQuestion} maxLength={300} />
      <Field label="Your answer" value={answer} onChange={setAnswer} maxLength={300} multiline />
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 1.5 The insurance question
// -----------------------------------------------------------------------------

export function InsuranceScreen(props: Common) {
  const [answer, setAnswer] = useState<"yes" | "no" | "">("");
  return (
    <ScreenShell
      slug={props.slug}
      screen="insurance"
      title="One question you weren't sure about"
      intro={
        <p>
          We record your answer as your practice&rsquo;s notice to us. Your agreement stays exactly
          as you signed it.
        </p>
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => ({ billsInsurance: answer === "" ? null : answer === "yes" })}
    >
      <Choice
        legend="Do you bill any health insurance electronically, yourself or through a clearinghouse?"
        value={answer}
        onChange={setAnswer}
        options={[
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]}
      />
    </ScreenShell>
  );
}

"use client";

import { useEffect, useId, useState } from "react";
import { shortClinicName } from "@healdesk/catalog";

import {
  emptyServiceRow,
  HoursEditor,
  servicesPayload,
  ServicesEditor,
  WEEKDAY_HOURS,
  type ClosureRow,
  type HoursInitial,
  type ServiceRow,
} from "../../editors";
import { Choice, Field, ScreenShell } from "../ScreenShell";

export type { HoursInitial, ServiceRow };

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
  /** What patients call the practice, as saved; "" when it is still the one worked out from the name. */
  shortName: string;
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
    /** Who calls the main number: a vet's clients, everyone else's patients. */
    audience: "patients" | "clients";
  },
) {
  const [name, setName] = useState(props.initial.name);
  // Pre-filled from the name (spec, "never ask twice") and following it as
  // it is corrected, until the clinic writes its own.
  const [shortName, setShortName] = useState(props.initial.shortName);
  const shown = shortName || shortClinicName(name);
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
      payload={() => ({ name, shortName: shown, address, phone, website, timezone, location })}
    >
      {props.locations.length > 1 ? (
        <Choice
          legend="Your website lists more than one location. Which one is your main location? The same AYA answers for all of them: add the others from Billing after setup."
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
        label={`What ${props.audience} call you`}
        hint="AYA says your full name once, at the start, then this, on every channel."
        value={shown}
        onChange={setShortName}
        maxLength={40}
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
        hint={`The number ${props.audience} call today. You keep it: phone forwarding comes later, from this number.`}
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

export function HoursScreen(
  props: Common & {
    initial: HoursInitial | null;
    closures: readonly { closedOn: string; label: string | null }[];
    readFromSite: boolean;
    today: string;
  },
) {
  const [hours, setHours] = useState<HoursInitial>(props.initial ?? WEEKDAY_HOURS);
  const [closures, setClosures] = useState<ClosureRow[]>(
    props.closures.map((c) => ({ closedOn: c.closedOn, label: c.label ?? "" })),
  );

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
      <HoursEditor
        hours={hours}
        onHours={setHours}
        closures={closures}
        onClosures={setClosures}
        today={props.today}
      />
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 1.3 Services and prices
// -----------------------------------------------------------------------------

export function ServicesScreen(
  props: Common & { initial: ServiceRow[]; dropped: number; readFromSite: boolean },
) {
  const [rows, setRows] = useState<ServiceRow[]>(
    props.initial.length > 0 ? props.initial : [emptyServiceRow()],
  );

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
      // The deposits are their own screen (2.4), so each row's stored deposit
      // is carried through unchanged.
      payload={() => ({ services: servicesPayload(rows, false) })}
    >
      <ServicesEditor rows={rows} onRows={setRows} />
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

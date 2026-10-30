"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import { Choice, Field, ScreenShell } from "../ScreenShell";

/**
 * Step 3 · Calendar (plan Part E): 3.1 the calendar and how bookings arrive,
 * and 3.2 whether AYA books against named providers.
 *
 * 3.1's Google panel (Sign in with Google, the connection, Disconnect) is
 * rendered on the server, from lib/setup/calendar.ts, and comes in as
 * `connect`, outside this screen's own form: where Google cannot be reached
 * from here it is absent, and the screen says what is true then, that
 * bookings arrive as requests your team confirms. No button that goes
 * nowhere. Nothing here imports server code: every fact comes as a prop.
 */

type Common = { slug: string; backHref: string | null; skipCost: string };

export type CalendarNoticeView = { tone: "done" | "problem"; text: string };

export function CalendarScreen(
  props: Common & {
    /** No Google from here: bookings arrive as requests. */
    requestsOnly: boolean;
    /** What `?calendar=` said happened, in words. */
    notice: CalendarNoticeView | null;
    /** The Google panel, server-rendered; null when requests only. */
    connect: ReactNode;
    bookingSystem: string | null;
    systems: readonly { id: string; label: string }[];
    /** The manual-booking sentence for a system that does not read Google Calendar, per system. */
    manualNotices: Readonly<Record<string, string | null>>;
    /**
     * Auto-confirm as saved, the "Right now" line from the location's booking
     * mode, and what saving each answer the picker can hold does to the switch.
     */
    autoConfirm: {
      on: boolean;
      rightNow: string;
      onceSaved: Readonly<Record<string, boolean>>;
    };
  },
) {
  const [system, setSystem] = useState(props.bookingSystem ?? "");
  const [changing, setChanging] = useState(props.bookingSystem === null);
  const selectId = useId();
  const label = props.systems.find((s) => s.id === system)?.label;
  // The line may already say it, when the location's terms name the same system.
  const notice = system ? props.manualNotices[system] : null;
  const manual = notice && !props.autoConfirm.rightNow.includes(notice) ? notice : null;
  // Saving another answer can turn Auto-confirm on or off (saveSetupSettings).
  const after =
    system && system !== props.bookingSystem ? props.autoConfirm.onceSaved[system] : undefined;

  // An outcome is said once: the address loses `calendar=`, so a reload or a
  // Back does not say it again, and the step goes on from here.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("calendar")) return;
    url.searchParams.delete("calendar");
    url.searchParams.set("s", "calendar");
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return (
    <ScreenShell
      slug={props.slug}
      screen="calendar"
      title="Your calendar"
      intro={
        props.requestsOnly ? (
          <p>
            Bookings arrive as requests your team confirms. AYA takes the person&rsquo;s details and
            the time they want, and your team books it in.
          </p>
        ) : (
          <p>Connect the Google Calendar where your appointments live.</p>
        )
      }
      lead={
        props.notice || props.connect ? (
          <>
            {props.notice ? (
              <p
                role="status"
                className={`rounded-md border bg-white px-4 py-3 text-sm ${
                  props.notice.tone === "done" ? "border-line text-green" : "border-ink"
                }`}
              >
                {props.notice.text}
              </p>
            ) : null}
            {props.connect}
          </>
        ) : null
      }
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() => (system ? { bookingSystem: system } : {})}
    >
      <div className="rounded-md border border-line bg-white px-4 py-3">
        <p className="text-sm font-semibold">Where your bookings live today</p>
        {changing ? (
          <div className="mt-2 grid gap-1">
            <label htmlFor={selectId} className="sr-only">
              Where your bookings live today
            </label>
            <select
              id={selectId}
              value={system}
              onChange={(event) => setSystem(event.target.value)}
              className="border-line min-h-11 rounded-sm border bg-white px-2"
            >
              <option value="" disabled>
                Choose one
              </option>
              {props.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="mt-1">
            {label}{" "}
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="min-h-11 text-sm font-semibold underline"
            >
              Change
            </button>
          </p>
        )}
        {manual ? <p className="text-muted mt-2 text-sm">{manual}</p> : null}
      </div>
      <div className="rounded-md border border-line bg-white px-4 py-3">
        <p className="flex items-center justify-between gap-3 text-sm font-semibold">
          <span>Auto-confirm bookings</span>
          <span className="shrink-0 rounded-full bg-paper-2 px-3 py-1 text-xs">
            {props.autoConfirm.on ? "On" : "Off"}
          </span>
        </p>
        <p className="text-muted mt-1 text-sm">
          When it&rsquo;s on, AYA books straight into your calendar whenever she can. When
          it&rsquo;s off, every booking is a request your team confirms.
        </p>
        <p className="mt-2 text-sm">{props.autoConfirm.rightNow}</p>
        {after !== undefined && after !== props.autoConfirm.on ? (
          <p className="text-muted mt-2 text-sm">
            Saving {label} turns Auto-confirm {after ? "on" : "off"}.
          </p>
        ) : null}
      </div>
    </ScreenShell>
  );
}

// -----------------------------------------------------------------------------
// 3.2 Named providers
// -----------------------------------------------------------------------------

/** One provider as the form holds them: services by the clinic's own names. */
export type ProviderFormRow = {
  id: string | null;
  displayName: string;
  calendarId: string | null;
  services: string[];
};

type EditableRow = ProviderFormRow & { key: number };

export function ProvidersScreen(
  props: Common & {
    bookingDetail: "generic" | "named_provider";
    /**
     * The calendars a provider may be given and the providers so far, when
     * named providers can be offered; null when the shared calendar is the
     * only answer.
     */
    named: {
      calendars: readonly { id: string; name: string; primary: boolean }[];
      providers: readonly ProviderFormRow[];
    } | null;
    /** Why named providers aren't offered, when they aren't. */
    unavailable: "no_calendar" | "failed" | null;
    /** How many providers the website read named. */
    providersRead: number;
    /** The clinic's services, by name, for the mapping. */
    services: readonly string[];
    maxProviders: number;
  },
) {
  const named = props.named;
  // Named providers are saved, and Google can't list the calendars just now:
  // the screen then asks nothing, so saving it keeps them (saveNamedProviders).
  const keeping =
    !named && props.unavailable === "failed" && props.bookingDetail === "named_provider";
  const [detail, setDetail] = useState<"generic" | "named_provider">(
    named || keeping ? props.bookingDetail : "generic",
  );
  const [rows, setRows] = useState<EditableRow[]>(() =>
    (named?.providers ?? []).map((row, key) => ({ ...row, services: [...row.services], key })),
  );
  const [nextKey, setNextKey] = useState(rows.length);

  const update = (key: number, change: Partial<ProviderFormRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const intro = !named ? (
    keeping ? (
      <p>
        Your named providers are saved. We couldn&rsquo;t read your calendars from Google just now
        to show them, so they stay as they are. Come back to this step to change them.
      </p>
    ) : props.unavailable === "failed" ? (
      <p>
        We couldn&rsquo;t read your calendars from Google just now, so for now AYA books any
        available time. Come back to this step to try again.
      </p>
    ) : props.providersRead > 0 ? (
      <p>
        Your website names{" "}
        {props.providersRead === 1 ? "1 provider" : `${props.providersRead} providers`}. Booking
        against each one&rsquo;s own calendar comes after your calendar is connected.
      </p>
    ) : (
      <p>
        Booking against each provider&rsquo;s own calendar comes after your calendar is connected.
      </p>
    )
  ) : (
    <p>
      Book any available time, or give each provider their own calendar in the Google account you
      connected, and the services they offer.
    </p>
  );

  return (
    <ScreenShell
      slug={props.slug}
      screen="providers"
      title="Book with anyone, or a named provider?"
      intro={intro}
      skipCost={props.skipCost}
      backHref={props.backHref}
      payload={() =>
        detail === "generic"
          ? { bookingDetail: "generic" }
          : named
            ? {
                bookingDetail: "named_provider",
                providers: rows.map((row) => ({
                  id: row.id,
                  displayName: row.displayName,
                  calendarId: row.calendarId ?? "",
                  services: row.services,
                })),
              }
            : {}
      }
    >
      <Choice
        legend="Booking detail"
        value={detail}
        onChange={setDetail}
        options={[
          {
            id: "generic",
            label: "Any available time",
            line: "Your team decides who sees each person.",
          },
          {
            id: "named_provider",
            label: "A named provider",
            line: named
              ? "Each provider's own calendar, for the services they offer."
              : keeping
                ? "Your saved providers stay as they are."
                : "Available once your calendar is connected.",
            disabled: !named,
          },
        ]}
      />
      {named && detail === "named_provider" ? (
        <div className="grid gap-3">
          {rows.map((row, index) => (
            <ProviderRowFields
              key={row.key}
              index={index}
              row={row}
              calendars={named.calendars}
              services={props.services}
              onChange={(change) => update(row.key, change)}
              onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            />
          ))}
          {rows.length < props.maxProviders ? (
            <button
              type="button"
              onClick={() => {
                setRows((current) => [
                  ...current,
                  { id: null, displayName: "", calendarId: null, services: [], key: nextKey },
                ]);
                setNextKey((key) => key + 1);
              }}
              className="border-line min-h-11 justify-self-start rounded-full border px-5 py-2 text-sm font-semibold"
            >
              Add a provider
            </button>
          ) : null}
        </div>
      ) : null}
    </ScreenShell>
  );
}

function ProviderRowFields(props: {
  index: number;
  row: EditableRow;
  calendars: readonly { id: string; name: string; primary: boolean }[];
  services: readonly string[];
  onChange: (change: Partial<ProviderFormRow>) => void;
  onRemove: () => void;
}) {
  const selectId = useId();
  const { row } = props;
  const who = row.displayName.trim() || `Provider ${props.index + 1}`;
  return (
    <fieldset className="border-line grid gap-3 rounded-md border bg-white px-4 py-3">
      <legend className="sr-only">{who}</legend>
      <Field
        label="Name"
        value={row.displayName}
        onChange={(displayName) => props.onChange({ displayName })}
        maxLength={80}
      />
      <div className="grid gap-1">
        <label htmlFor={selectId} className="text-sm font-semibold">
          Their calendar
        </label>
        <select
          id={selectId}
          value={row.calendarId ?? ""}
          onChange={(event) => props.onChange({ calendarId: event.target.value || null })}
          className="border-line min-h-11 rounded-sm border bg-white px-2"
        >
          <option value="" disabled>
            Choose a calendar
          </option>
          {props.calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>
              {calendar.name}
              {calendar.primary ? " (main calendar)" : ""}
            </option>
          ))}
        </select>
      </div>
      {props.services.length > 0 ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm font-semibold">Services they offer</legend>
          {props.services.map((service) => (
            <label key={service} className="flex min-h-11 items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={row.services.includes(service)}
                onChange={(event) =>
                  props.onChange({
                    services: event.target.checked
                      ? [...row.services, service]
                      : row.services.filter((s) => s !== service),
                  })
                }
              />
              {service}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-muted text-sm">
          Add your services in step 1 to choose which each provider offers.
        </p>
      )}
      <button
        type="button"
        onClick={props.onRemove}
        className="text-muted min-h-11 justify-self-start text-sm font-semibold underline"
      >
        Remove {who}
      </button>
    </fieldset>
  );
}

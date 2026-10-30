"use client";

import type { GoogleCalendarDisclosure } from "@healdesk/catalog";
import { useId, useState, type ReactNode } from "react";

import { useAnnounce } from "../feedback";

import {
  chooseCalendarAction,
  connectCalendarAction,
  disconnectCalendarAction,
  listCalendarsAction,
  loadProvidersAction,
  saveProvidersAction,
  setAutoConfirmAction,
  sharedCalendarAction,
  type CalendarActionResult,
  type CalendarChoice,
  type ProviderRow,
} from "./calendar-actions";

/**
 * Settings → Calendar's controls (plan Part F2), each over one server action
 * in ./calendar-actions.ts. Every outcome is announced in the page's one
 * status region; a refusal for want of a step-up links to it. Nothing here
 * is offered unless the card's server side said it could work.
 */

const BUTTON = "bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50";
const SECONDARY =
  "border-line min-h-11 rounded-full border px-5 text-sm font-semibold disabled:opacity-50";
const LINK = "font-semibold underline";

function useResult(): (result: CalendarActionResult) => boolean {
  const announce = useAnnounce();
  return (result) => {
    announce(
      result.ok
        ? { text: result.toast, tone: "ok" }
        : { text: result.message, tone: "problem", stepUpHref: result.stepUpHref },
    );
    return result.ok;
  };
}

const FAILED: CalendarActionResult = {
  ok: false,
  message: "Something went wrong on our side. Try again in a moment.",
};

// -----------------------------------------------------------------------------
// Signing in with Google
// -----------------------------------------------------------------------------

/**
 * Google's data-use notice, then its unticked box and the button, with
 * nothing in between (as the calendar link's page has them). The box must be
 * ticked; the server checks the notice's version again.
 */
export function GoogleSignIn(props: {
  slug: string;
  disclosure: GoogleCalendarDisclosure;
  label: string;
  /** "Use a different Google account": a step-up first. */
  change?: boolean;
}) {
  const report = useResult();
  const [ticked, setTicked] = useState(false);
  const [working, setWorking] = useState(false);
  const boxId = useId();
  const { disclosure } = props;
  const last = disclosure.paragraphs.length - 1;

  async function start() {
    setWorking(true);
    let result: CalendarActionResult;
    try {
      result = await connectCalendarAction(props.slug, {
        disclosureVersion: ticked ? disclosure.version : null,
        change: props.change === true,
      });
    } catch {
      result = FAILED;
    }
    if (result.ok && result.href) {
      window.location.assign(result.href);
      return;
    }
    report(result);
    setWorking(false);
  }

  return (
    <div className="mt-3">
      <section className="border-line rounded-md border px-4 py-3 text-sm">
        <h3 className="font-semibold">{disclosure.heading}</h3>
        {disclosure.paragraphs.map((paragraph, index) =>
          index === last ? (
            <p key={index} className="mt-2">
              {withLimitedUseLink(paragraph, disclosure)}{" "}
              <a href={disclosure.privacyHref} className={LINK}>
                Our privacy notice
              </a>{" "}
              says more.
            </p>
          ) : (
            <p key={index} className="mt-2">
              {paragraph}
            </p>
          ),
        )}
      </section>
      <label htmlFor={boxId} className="mt-3 flex min-h-11 items-start gap-2 text-sm">
        <input
          id={boxId}
          type="checkbox"
          checked={ticked}
          onChange={(event) => setTicked(event.target.checked)}
          className="mt-1 h-5 w-5 shrink-0"
        />
        <span>{disclosure.tickLabel}</span>
      </label>
      <button
        type="button"
        disabled={working || !ticked}
        onClick={() => void start()}
        className={`mt-2 ${BUTTON}`}
      >
        {working ? "Opening Google…" : props.label}
      </button>
    </div>
  );
}

function withLimitedUseLink(paragraph: string, disclosure: GoogleCalendarDisclosure): ReactNode {
  const at = paragraph.indexOf(disclosure.limitedUse.linkText);
  if (at < 0) return paragraph;
  return (
    <>
      {paragraph.slice(0, at)}
      <a href={disclosure.limitedUse.href} className={LINK}>
        {disclosure.limitedUse.linkText}
      </a>
      {paragraph.slice(at + disclosure.limitedUse.linkText.length)}
    </>
  );
}

// -----------------------------------------------------------------------------
// A connected calendar: Change, Reconnect, Disconnect
// -----------------------------------------------------------------------------

type Panel = "none" | "change" | "reconnect" | "disconnect";

export function ConnectedCalendarControls(props: {
  slug: string;
  disclosure: GoogleCalendarDisclosure;
  /** A sign-in with Google could start now: Change and Reconnect are offered only then. */
  canConnect: boolean;
  /** The connection is healthy enough for Google to list its calendars. */
  canList: boolean;
}) {
  const [panel, setPanel] = useState<Panel>("none");
  const toggle = (next: Panel) => setPanel((current) => (current === next ? "none" : next));
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {props.canConnect ? (
          <>
            <button
              type="button"
              aria-expanded={panel === "change"}
              onClick={() => toggle("change")}
              className={SECONDARY}
            >
              Change
            </button>
            <button
              type="button"
              aria-expanded={panel === "reconnect"}
              onClick={() => toggle("reconnect")}
              className={SECONDARY}
            >
              Reconnect
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-expanded={panel === "disconnect"}
          onClick={() => toggle("disconnect")}
          className={SECONDARY}
        >
          Disconnect
        </button>
      </div>
      {panel === "change" ? (
        <div className="mt-3 grid gap-4">
          {props.canList ? <ChooseCalendar slug={props.slug} /> : null}
          <div>
            <p className="text-sm font-semibold">Use a different Google account</p>
            <p className="text-muted mt-1 text-sm">
              Changing the account needs Face ID or your screen lock on a device you&rsquo;ve added.
              The calendar connected now stops when the new one connects.
            </p>
            <GoogleSignIn
              slug={props.slug}
              disclosure={props.disclosure}
              label="Sign in with a different Google account"
              change
            />
          </div>
        </div>
      ) : null}
      {panel === "reconnect" ? (
        <div className="mt-3">
          <p className="text-muted text-sm">
            Sign in again with the same Google account, to mend a connection that stopped or to
            accept an updated notice.
          </p>
          <GoogleSignIn
            slug={props.slug}
            disclosure={props.disclosure}
            label="Reconnect with Google"
          />
        </div>
      ) : null}
      {panel === "disconnect" ? (
        <DisconnectCalendar slug={props.slug} onCancel={() => setPanel("none")} />
      ) : null}
    </div>
  );
}

function DisconnectCalendar(props: { slug: string; onCancel: () => void }) {
  const report = useResult();
  const [working, setWorking] = useState(false);
  async function go() {
    setWorking(true);
    let result: CalendarActionResult;
    try {
      result = await disconnectCalendarAction(props.slug);
    } catch {
      result = FAILED;
    }
    if (report(result)) {
      window.location.reload();
      return;
    }
    setWorking(false);
  }
  return (
    <div className="border-line mt-3 rounded-md border px-4 py-3 text-sm">
      <p>
        AYA stops booking into your calendar at once, and every booking becomes a request your team
        confirms. Disconnecting needs Face ID or your screen lock on a device you&rsquo;ve added.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={working} onClick={() => void go()} className={BUTTON}>
          {working ? "Disconnecting…" : "Disconnect the calendar"}
        </button>
        <button type="button" disabled={working} onClick={props.onCancel} className={SECONDARY}>
          Keep it connected
        </button>
      </div>
    </div>
  );
}

function ChooseCalendar({ slug }: { slug: string }) {
  const report = useResult();
  const announce = useAnnounce();
  const [calendars, setCalendars] = useState<CalendarChoice[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [working, setWorking] = useState(false);
  const selectId = useId();

  async function load() {
    setWorking(true);
    try {
      const listed = await listCalendarsAction(slug);
      if (listed.ok) {
        setCalendars(listed.calendars);
        setChosen(listed.calendars.find((c) => c.current)?.id ?? "");
      } else {
        announce({ text: listed.message, tone: "problem" });
      }
    } catch {
      report(FAILED);
    }
    setWorking(false);
  }

  async function save() {
    setWorking(true);
    let result: CalendarActionResult;
    try {
      result = await chooseCalendarAction(slug, chosen);
    } catch {
      result = FAILED;
    }
    if (report(result)) {
      window.location.reload();
      return;
    }
    setWorking(false);
  }

  if (!calendars) {
    return (
      <div>
        <p className="text-sm font-semibold">Book into another calendar on this account</p>
        <button
          type="button"
          disabled={working}
          onClick={() => void load()}
          className={`mt-2 ${SECONDARY}`}
        >
          {working ? "Asking Google…" : "Show my calendars"}
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <label htmlFor={selectId} className="text-sm font-semibold">
        Book into another calendar on this account
      </label>
      <select
        id={selectId}
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
        className="border-line min-h-11 rounded-sm border bg-white px-2"
      >
        {calendars.map((calendar) => (
          <option key={calendar.id} value={calendar.id}>
            {calendar.name}
            {calendar.current ? " · now" : ""}
          </option>
        ))}
      </select>
      <p className="text-muted text-sm">
        Changing it needs Face ID or your screen lock on a device you&rsquo;ve added.
      </p>
      <button
        type="button"
        disabled={working || !chosen}
        onClick={() => void save()}
        className={`w-fit ${BUTTON}`}
      >
        Use this calendar
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Auto-confirm
// -----------------------------------------------------------------------------

export function AutoConfirmSwitch(props: { slug: string; initial: boolean; rightNow: string }) {
  const report = useResult();
  const [on, setOn] = useState(props.initial);
  const [rightNow, setRightNow] = useState(props.rightNow);
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const lineId = useId();

  async function toggle() {
    const next = !on;
    setBusy(true);
    let result: CalendarActionResult;
    try {
      result = await setAutoConfirmAction(props.slug, next);
    } catch {
      result = FAILED;
    }
    if (report(result) && result.ok) {
      setOn(next);
      if (result.rightNow) setRightNow(result.rightNow);
    }
    setBusy(false);
  }

  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <p id={labelId} className="font-semibold">
          Auto-confirm bookings
        </p>
        <p id={lineId} className="text-muted mt-1 text-sm">
          On, a booking AYA takes goes straight into your calendar; off, every booking is a request
          your team confirms. Changing it needs Face ID or your screen lock. {rightNow}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={labelId}
        aria-describedby={lineId}
        disabled={busy}
        onClick={() => void toggle()}
        className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
      >
        <span className="w-7 text-right text-sm font-semibold">{on ? "On" : "Off"}</span>
        <span
          aria-hidden="true"
          className={`flex h-7 w-12 items-center rounded-full p-0.5 transition-colors ${
            on ? "bg-green justify-end" : "bg-line-strong justify-start"
          }`}
        >
          <span className="block h-6 w-6 rounded-full bg-white shadow" />
        </span>
      </button>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Booking detail
// -----------------------------------------------------------------------------

type EditRow = ProviderRow & { key: number };

export function BookingDetailControls(props: {
  slug: string;
  detail: "generic" | "named_provider";
  /** A healthy connection Google can be asked about: named providers can be set up. */
  providersPossible: boolean;
}) {
  const report = useResult();
  const announce = useAnnounce();
  const [loaded, setLoaded] = useState<Extract<
    Awaited<ReturnType<typeof loadProvidersAction>>,
    { ok: true }
  > | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [working, setWorking] = useState(false);

  async function open() {
    setWorking(true);
    try {
      const result = await loadProvidersAction(props.slug);
      if (result.ok) {
        setLoaded(result);
        const start = result.providers.length > 0 ? result.providers : [blank()];
        setRows(start.map((row, i) => ({ ...row, key: i + 1 })));
        setNextKey(start.length + 1);
      } else {
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      report(FAILED);
    }
    setWorking(false);
  }

  async function run(action: () => Promise<CalendarActionResult>) {
    setWorking(true);
    let result: CalendarActionResult;
    try {
      result = await action();
    } catch {
      result = FAILED;
    }
    if (report(result)) {
      window.location.reload();
      return;
    }
    setWorking(false);
  }

  const update = (key: number, patch: Partial<ProviderRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="py-3">
      <p className="font-semibold">
        Booking detail:{" "}
        {props.detail === "named_provider" ? "named providers" : "one shared calendar"}
      </p>
      <p className="text-muted mt-1 text-sm">
        Takes effect on the next booking. Today&rsquo;s bookings stay as they are.
      </p>
      <p className="text-muted mt-1 text-sm">
        {props.detail === "named_provider"
          ? "AYA books each service with a provider who offers it, on that provider's own calendar."
          : "AYA books any free time in your calendar, and your team decides who sees each person."}
        {props.providersPossible
          ? ""
          : props.detail === "named_provider"
            ? " Their calendars can be changed once your Google Calendar is connected and working."
            : " Named providers need your Google Calendar connected."}
      </p>
      {(props.providersPossible || props.detail === "named_provider") && !loaded ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {props.providersPossible ? (
            <button
              type="button"
              disabled={working}
              onClick={() => void open()}
              className={SECONDARY}
            >
              {working
                ? "Asking Google…"
                : props.detail === "named_provider"
                  ? "Edit named providers"
                  : "Set up named providers"}
            </button>
          ) : null}
          {props.detail === "named_provider" ? (
            <button
              type="button"
              disabled={working}
              onClick={() => void run(() => sharedCalendarAction(props.slug))}
              className={SECONDARY}
            >
              Use one shared calendar
            </button>
          ) : null}
        </div>
      ) : null}
      {loaded ? (
        <div className="mt-3 grid gap-3">
          {rows.map((row, index) => (
            <ProviderFields
              key={row.key}
              index={index}
              row={row}
              calendars={loaded.calendars}
              services={loaded.services}
              onChange={(patch) => update(row.key, patch)}
              onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setRows((current) => [...current, { ...blank(), key: nextKey }]);
                setNextKey((k) => k + 1);
              }}
              className={SECONDARY}
            >
              Add a provider
            </button>
            <button
              type="button"
              disabled={working || rows.length === 0}
              onClick={() =>
                void run(() =>
                  saveProvidersAction(
                    props.slug,
                    rows.map(({ key: _key, ...row }) => {
                      void _key;
                      return row;
                    }),
                  ),
                )
              }
              className={BUTTON}
            >
              Save named providers
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function blank(): ProviderRow {
  return { id: null, displayName: "", calendarId: "", services: [] };
}

function ProviderFields(props: {
  index: number;
  row: ProviderRow;
  calendars: CalendarChoice[];
  services: string[];
  onChange: (patch: Partial<ProviderRow>) => void;
  onRemove: () => void;
}) {
  const nameId = useId();
  const calendarId = useId();
  const n = props.index + 1;
  return (
    <fieldset className="border-line grid gap-2 rounded-md border px-4 py-3">
      <legend className="sr-only">Provider {n}</legend>
      <label htmlFor={nameId} className="text-sm font-semibold">
        Provider {n}&rsquo;s name
      </label>
      <input
        id={nameId}
        value={props.row.displayName}
        maxLength={80}
        placeholder="e.g. Dr Chen"
        onChange={(event) => props.onChange({ displayName: event.target.value })}
        className="border-line min-h-11 rounded-sm border px-3"
      />
      <label htmlFor={calendarId} className="text-sm font-semibold">
        Their calendar
      </label>
      <select
        id={calendarId}
        value={props.row.calendarId}
        onChange={(event) => props.onChange({ calendarId: event.target.value })}
        className="border-line min-h-11 rounded-sm border bg-white px-2"
      >
        <option value="" disabled>
          Choose their calendar
        </option>
        {props.calendars.map((calendar) => (
          <option key={calendar.id} value={calendar.id}>
            {calendar.name}
          </option>
        ))}
      </select>
      {props.services.length > 0 ? (
        <div className="grid gap-1">
          <p className="text-sm font-semibold">What they offer</p>
          {props.services.map((service) => (
            <label key={service} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={props.row.services.includes(service)}
                onChange={(event) =>
                  props.onChange({
                    services: event.target.checked
                      ? [...props.row.services, service]
                      : props.row.services.filter((s) => s !== service),
                  })
                }
                className="h-5 w-5"
              />
              {service}
            </label>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={props.onRemove}
        className="text-muted min-h-11 w-fit text-sm underline"
      >
        Remove provider {n}
      </button>
    </fieldset>
  );
}

"use client";

import { useId, useState } from "react";

import { HoursEditor, WEEKDAY_HOURS, type HoursInitial } from "../../../editors";
import { useAnnounce } from "../../../feedback";
import {
  confirmLocationDetailsAction,
  saveLocationDetailAction,
  type LocationActionResult,
} from "../../location-actions";

/**
 * A later location's details (Settings, one level down): its address, its
 * hours and its numbers, each saved on its own Save, then "Confirm these
 * details". Every save is announced once through the page's status region;
 * a refusal that needs a step-up links to it. The server validates every
 * field again whatever this sends (lib/portal/location-details.ts).
 */

const SOMETHING_WRONG = "Something went wrong on our side. Try again in a moment.";

function useLocationSave(slug: string, locationId: string) {
  const announce = useAnnounce();
  return async (key: string, value: unknown): Promise<LocationActionResult> => {
    let result: LocationActionResult;
    try {
      result = await saveLocationDetailAction(slug, locationId, key, value);
    } catch {
      result = { ok: false, message: SOMETHING_WRONG };
    }
    announce(
      result.ok
        ? { text: result.toast, tone: "ok" }
        : { text: result.message, tone: "problem", stepUpHref: result.stepUpHref },
    );
    return result;
  };
}

function DetailField(props: {
  slug: string;
  locationId: string;
  detailKey: string;
  label: string;
  hint: string;
  initial: string;
  type?: "text" | "tel";
  autoComplete?: string;
  maxLength?: number;
  onSaved: (value: string) => void;
}) {
  const save = useLocationSave(props.slug, props.locationId);
  const [value, setValue] = useState(props.initial);
  const [saved, setSaved] = useState(props.initial);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const hintId = useId();

  return (
    <form
      noValidate
      className="grid gap-2 py-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await save(props.detailKey, value);
        if (result.ok) {
          setSaved(value);
          props.onSaved(value);
        }
        setBusy(false);
      }}
    >
      <label htmlFor={id} className="font-semibold">
        {props.label}
      </label>
      <input
        id={id}
        type={props.type ?? "text"}
        inputMode={props.type === "tel" ? "tel" : undefined}
        autoComplete={props.autoComplete ?? "off"}
        maxLength={props.maxLength}
        value={value}
        aria-describedby={hintId}
        onChange={(event) => setValue(event.target.value)}
        className="border-line w-full rounded-xl border bg-white px-4 py-3 text-base"
      />
      <p id={hintId} className="text-muted text-sm">
        {props.hint}
      </p>
      <div>
        <button
          type="submit"
          disabled={busy || value === saved}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

export function LocationDetailsForm(props: {
  slug: string;
  locationId: string;
  name: string;
  address: string;
  hours: HoursInitial | null;
  publishedPhone: string;
  directLine: string;
  transfer: string;
  needsDirectLine: boolean;
  confirmed: boolean;
}) {
  const announce = useAnnounce();
  const save = useLocationSave(props.slug, props.locationId);
  const [hours, setHours] = useState<HoursInitial>(props.hours ?? WEEKDAY_HOURS);
  const [hoursSaved, setHoursSaved] = useState(props.hours !== null);
  const [hoursBusy, setHoursBusy] = useState(false);
  const [filled, setFilled] = useState({
    address: props.address !== "",
    phone: props.publishedPhone !== "",
    direct: props.directLine !== "",
  });
  const [confirmed, setConfirmed] = useState(props.confirmed);
  const [confirming, setConfirming] = useState(false);

  const ready =
    filled.address && hoursSaved && filled.phone && (!props.needsDirectLine || filled.direct);

  async function confirm() {
    setConfirming(true);
    let result: LocationActionResult;
    try {
      result = await confirmLocationDetailsAction(props.slug, props.locationId);
    } catch {
      result = { ok: false, message: SOMETHING_WRONG };
    }
    announce(
      result.ok ? { text: result.toast, tone: "ok" } : { text: result.message, tone: "problem" },
    );
    if (result.ok) setConfirmed(true);
    setConfirming(false);
  }

  const common = { slug: props.slug, locationId: props.locationId };
  return (
    <div className="mt-6 grid gap-6">
      <section
        aria-labelledby="where-heading"
        className="border-line rounded-2xl border bg-white px-5 py-4"
      >
        <h2 id="where-heading" className="text-lg font-semibold">
          Where it is
        </h2>
        <DetailField
          {...common}
          detailKey="address"
          label="Street address"
          hint="As on a letter, on one line. Changing it needs Face ID or your screen lock."
          initial={props.address}
          autoComplete="street-address"
          maxLength={300}
          onSaved={(v) => setFilled((f) => ({ ...f, address: v.trim() !== "" }))}
        />
      </section>

      <section
        aria-labelledby="hours-heading"
        className="border-line rounded-2xl border bg-white px-5 py-4"
      >
        <h2 id="hours-heading" className="text-lg font-semibold">
          Opening hours
        </h2>
        <p className="text-muted mt-1 text-sm">
          {props.hours ? "" : "We start you on weekdays, 9 to 5. "}In your account&rsquo;s time
          zone.
        </p>
        <div className="mt-3 grid gap-3">
          <HoursEditor hours={hours} onHours={setHours} />
          <div>
            <button
              type="button"
              disabled={hoursBusy}
              onClick={async () => {
                setHoursBusy(true);
                const result = await save("opening_hours", hours);
                if (result.ok) setHoursSaved(true);
                setHoursBusy(false);
              }}
              className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
            >
              {hoursBusy ? "Saving…" : "Save hours"}
            </button>
          </div>
        </div>
      </section>

      <section
        aria-labelledby="numbers-heading"
        className="border-line rounded-2xl border bg-white px-5 py-4"
      >
        <h2 id="numbers-heading" className="text-lg font-semibold">
          Phone numbers
        </h2>
        <DetailField
          {...common}
          detailKey="published_phone"
          label="The location's phone number"
          hint="The number people call to reach this location."
          initial={props.publishedPhone}
          type="tel"
          autoComplete="tel"
          onSaved={(v) => setFilled((f) => ({ ...f, phone: v.trim() !== "" }))}
        />
        <DetailField
          {...common}
          detailKey="direct_line"
          label={props.needsDirectLine ? "Direct line" : "Direct line (optional)"}
          hint="A line that reaches the team at this location, for calls AYA can't take. Changing it once set needs Face ID or your screen lock."
          initial={props.directLine}
          type="tel"
          onSaved={(v) => setFilled((f) => ({ ...f, direct: v.trim() !== "" }))}
        />
        <DetailField
          {...common}
          detailKey="transfer_number"
          label="Transfer number (optional)"
          hint="Where live transfers for this location go, if not its direct line. Changing it once set needs Face ID or your screen lock."
          initial={props.transfer}
          type="tel"
          onSaved={() => undefined}
        />
      </section>

      <section
        aria-labelledby="confirm-heading"
        className="border-line rounded-2xl border bg-white px-5 py-4"
      >
        <h2 id="confirm-heading" className="text-lg font-semibold">
          {confirmed ? "Confirmed" : "Confirm these details"}
        </h2>
        <p className="text-muted mt-1 text-sm">
          {confirmed
            ? `${props.name}'s details are confirmed. Any change you save here applies as you make it.`
            : ready
              ? `Check ${props.name}'s address, hours and phone numbers above, then confirm them.`
              : `Save ${props.name}'s address, hours and phone number${props.needsDirectLine ? " and direct line" : ""} first.`}
        </p>
        {confirmed ? null : (
          <button
            type="button"
            disabled={confirming || !ready}
            onClick={() => void confirm()}
            className="bg-ink mt-3 min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
          >
            {confirming ? "Confirming…" : "Confirm these details"}
          </button>
        )}
      </section>
    </div>
  );
}

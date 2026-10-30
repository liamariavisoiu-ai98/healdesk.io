"use client";

import { COVERAGE_MODE_OPTIONS, type Carrier, type PhoneSystemType } from "@healdesk/catalog";
import { useId, useState } from "react";

import type { ForwardingView } from "@/lib/setup/forwarding";
import { PHONE_SYSTEM_OPTIONS, stepsFor } from "@/lib/setup/forwarding-steps";

import { savePhoneLineAction } from "./forwarding-actions";

/**
 * The forwarding steps with their two pickers (plan Part E step 4: "a
 * carrier and phone-system picker whose codes match the coverage mode"),
 * shared by the wizard's forwarding screen and Settings → Channels: what
 * runs the main line, then, on a phone company's line, who provides it; the
 * steps for that choice and the coverage mode; how to undo them; and the
 * carrier's notes. Each pick is saved as it is made (savePhoneLineAction),
 * so the steps emailed on to the office manager are these.
 *
 * `previous` is the coverage mode the clinic has just moved from, in
 * Settings: its undo comes first, so a line forwarded for the old mode is
 * not left forwarding beside the new one.
 */
export function ForwardingStepsPanel({
  slug,
  view,
  previous = null,
}: {
  slug: string;
  view: ForwardingView;
  previous?: ForwardingView | null;
}) {
  const systemId = useId();
  const carrierId = useId();
  const savedId = useId();
  const [phoneSystem, setPhoneSystem] = useState<PhoneSystemType>(view.phoneSystem);
  const [carrier, setCarrier] = useState<Carrier>(view.carrier);
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(null);
  const shown = stepsFor(view, phoneSystem, carrier);
  const before = previous ? stepsFor(previous, phoneSystem, carrier) : null;
  const modeName = (id: string) => COVERAGE_MODE_OPTIONS.find((o) => o.id === id)?.label ?? id;

  async function save(next: { phoneSystem: PhoneSystemType; carrier: Carrier }) {
    setSaved(null);
    try {
      const result = await savePhoneLineAction(slug, next);
      setSaved(result.ok ? { ok: true, message: "Saved" } : { ok: false, message: result.message });
    } catch {
      setSaved({ ok: false, message: "That didn't save. Try again in a moment." });
    }
  }

  return (
    <div className="grid gap-3 text-sm">
      <div className="grid gap-1">
        <label htmlFor={systemId} className="font-semibold">
          What runs your main line
        </label>
        <select
          id={systemId}
          value={phoneSystem}
          aria-describedby={savedId}
          onChange={(event) => {
            const next = event.target.value as PhoneSystemType;
            setPhoneSystem(next);
            void save({ phoneSystem: next, carrier });
          }}
          className="border-line min-h-11 rounded-md border bg-white px-3"
        >
          {PHONE_SYSTEM_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      {phoneSystem === "voip" ? null : (
        <div className="grid gap-1">
          <label htmlFor={carrierId} className="font-semibold">
            Who provides your main line
          </label>
          <select
            id={carrierId}
            value={carrier}
            aria-describedby={savedId}
            onChange={(event) => {
              const next = event.target.value as Carrier;
              setCarrier(next);
              void save({ phoneSystem, carrier: next });
            }}
            className="border-line min-h-11 rounded-md border bg-white px-3"
          >
            {view.carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <p
        id={savedId}
        role="status"
        aria-live="polite"
        className={saved ? (saved.ok ? "text-muted" : "text-problem") : "sr-only"}
      >
        {saved?.message ?? ""}
      </p>
      {before ? (
        <div>
          <p className="font-semibold">
            First, undo what you set for {modeName(previous!.coverageMode)}
          </p>
          <ul className="mt-1 grid gap-1">
            {before.undo.map((step) => (
              <li key={`${step.label}${step.dial}`}>
                {step.label}
                {step.dial ? <strong className="ml-1 font-mono">{step.dial}</strong> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <p className="font-semibold">
          {before ? `Then set it up for ${modeName(view.coverageMode)}` : "The steps"}
        </p>
        <ol className="mt-1 grid list-decimal gap-1 pl-5">
          {shown.steps.map((step) => (
            <li key={`${step.label}${step.dial}`}>
              {step.label}
              {step.dial ? <strong className="ml-1 font-mono">{step.dial}</strong> : null}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="font-semibold">To undo it at any time</p>
        <ul className="mt-1 grid gap-1">
          {shown.undo.map((step) => (
            <li key={`${step.label}${step.dial}`}>
              {step.label}
              {step.dial ? <strong className="ml-1 font-mono">{step.dial}</strong> : null}
            </li>
          ))}
        </ul>
      </div>
      {shown.notes.length > 0 ? (
        <ul className="text-muted grid list-disc gap-1 pl-5">
          {shown.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

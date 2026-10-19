"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { AnsweringControl } from "@/lib/portal/header";

import { pauseAyaAction, resumeAyaAction, type PauseActionResult } from "./pause-actions";

/**
 * The header's **AYA is answering** switch (plan Part F0; spec, "Admin
 * portal principles": the one dangerous action, clearly marked, and used
 * from a phone at the desk).
 *
 * On, the switch offers the three ways off before anything changes: for 1
 * hour, until tomorrow 8 am, or until it is turned back on, under one line
 * per live channel saying what that channel does meanwhile. No undo steps
 * here; those are in Settings, Safety net. Off, one press turns AYA back on,
 * and the banner says from which device and when she was paused, and until
 * when.
 *
 * Accessibility, as Settings' switches (settings/controls.tsx): a button with
 * `role="switch"` and `aria-checked`, "On" or "Off" in words beside the track,
 * targets at least 44px, and every outcome announced once in this switch's
 * own polite status region, since the header sits outside any screen's.
 * Opening the choices moves focus to the first, and Escape or "Keep AYA
 * answering" closes them and returns it to the switch.
 */
export function PauseSwitch(props: { slug: string; control: AnsweringControl }) {
  const { control } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const labelId = useId();
  const bannerId = useId();
  const panelId = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstChoiceRef.current?.focus();
  }, [open]);

  // The page was read again (a refresh after a save): whatever was open is over.
  useEffect(() => {
    setOpen(false);
  }, [control.paused]);

  async function run(action: () => Promise<PauseActionResult>) {
    setBusy(true);
    let result: PauseActionResult;
    try {
      result = await action();
    } catch {
      result = { ok: false, message: "Something went wrong on our side. Try again in a moment." };
    }
    setMessage({ text: result.message, problem: !result.ok });
    if (result.ok) setOpen(false);
    setBusy(false);
  }

  function close() {
    setOpen(false);
    switchRef.current?.focus();
  }

  function press() {
    if (control.paused) {
      void run(() => resumeAyaAction(props.slug));
    } else if (open) {
      close();
    } else {
      setMessage({ text: "Choose how long to pause AYA.", problem: false });
      setOpen(true);
    }
  }

  return (
    <div
      className={`mt-4 rounded-xl border px-4 py-3 text-sm ${
        control.paused ? "border-amber-300 bg-amber-50" : "border-line bg-white"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p id={labelId} className="font-semibold">
          AYA is answering
        </p>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          aria-checked={!control.paused}
          aria-labelledby={labelId}
          aria-describedby={control.banner ? bannerId : undefined}
          aria-controls={control.paused ? undefined : panelId}
          disabled={busy}
          onClick={press}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-full px-1 disabled:opacity-50"
        >
          <span className="w-7 text-right text-sm font-semibold">
            {control.paused ? "Off" : "On"}
          </span>
          <span
            aria-hidden="true"
            className={`flex h-7 w-12 items-center rounded-full p-0.5 transition-colors ${
              control.paused ? "bg-line-strong justify-start" : "bg-green justify-end"
            }`}
          >
            <span className="block h-6 w-6 rounded-full bg-white shadow" />
          </span>
        </button>
      </div>

      {control.paused && control.banner ? (
        <p id={bannerId} className="mt-1 font-semibold">
          {control.banner}
        </p>
      ) : null}

      {control.paused ? (
        <ul className="text-muted mt-2 grid gap-1">
          {control.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <div
          id={panelId}
          hidden={!open}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          className="mt-3"
        >
          <p className="font-semibold">Pause AYA on every channel. While she&rsquo;s paused:</p>
          <ul className="text-muted mt-1 grid gap-1">
            {control.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div
            role="group"
            aria-label="How long to pause AYA"
            className="mt-3 grid gap-2 sm:grid-cols-3"
          >
            {control.choices.map((choice, i) => (
              <button
                key={choice.id}
                ref={i === 0 ? firstChoiceRef : undefined}
                type="button"
                disabled={busy}
                onClick={() => void run(() => pauseAyaAction(props.slug, choice.id))}
                className="border-ink min-h-11 rounded-full border px-4 font-semibold disabled:opacity-50"
              >
                {choice.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={close}
            className="mt-2 min-h-11 rounded-full px-4 font-semibold underline underline-offset-2"
          >
            Keep AYA answering
          </button>
        </div>
      )}

      <p
        role="status"
        aria-live="polite"
        className={message?.problem ? "mt-2 text-red-800" : message ? "mt-2" : "sr-only"}
      >
        {message?.text ?? ""}
      </p>
    </div>
  );
}

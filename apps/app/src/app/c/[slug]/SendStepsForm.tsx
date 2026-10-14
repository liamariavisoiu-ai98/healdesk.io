"use client";

import { useId, useState } from "react";

import { sendPhoneStepsAction } from "./steps-actions";

/**
 * "Email these steps to my office manager": one address, one button, and the
 * outcome said right under it in a polite status line, so it works on
 * Settings (whose toasts are elsewhere) and on the wizard's channel screen
 * alike. The steps are ours; nothing typed here but the address is sent.
 */
export function SendStepsForm(props: { slug: string; numberLabel: string }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const id = useId();
  const statusId = useId();

  async function submit() {
    setBusy(true);
    try {
      const outcome = await sendPhoneStepsAction(props.slug, to);
      setResult(outcome);
      if (outcome.ok) setTo("");
    } catch {
      setResult({ ok: false, message: "That didn't send. Try again in a minute." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      noValidate
      className="grid gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm">
        Forward your main line to AYA at <span className="font-semibold">{props.numberLabel}</span>.
        If someone else looks after your phone line, send them the steps for your carrier.
      </p>
      <label htmlFor={id} className="font-semibold">
        Email these steps to
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="office@yourpractice.com"
          aria-describedby={statusId}
          className="border-line min-h-11 min-w-0 flex-1 rounded-xl border bg-white px-4 py-2 text-base"
        />
        <button
          type="submit"
          disabled={busy || !to.trim()}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send the steps"}
        </button>
      </div>
      <p id={statusId} role="status" aria-live="polite" className="text-sm">
        {result ? <span className={result.ok ? "" : "text-red-800"}>{result.message}</span> : null}
      </p>
    </form>
  );
}

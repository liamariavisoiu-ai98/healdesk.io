"use client";

import { useActionState, useEffect, useState } from "react";

import { decideRequest, type DecideFormState } from "./actions";

/**
 * Three ways to answer, two optional fields. Progressively enhanced: with
 * JavaScript off the browser POSTs to this URL and the action's redirect
 * lands on the same page showing the outcome (the confirm time is then read
 * without a zone offset, i.e. as UTC; the enhanced form supplies the offset).
 *
 * `mode` is "decide" for a fresh request (confirm / call back / decline) and
 * "confirm" for one already accepted with a call-back, where the only step
 * left is to pin the slot.
 */
export function DecideForm({ token, treatment, mode }: { token: string; treatment: string | null; mode: "decide" | "confirm" }) {
  const [state, action, pending] = useActionState<DecideFormState, FormData>(decideRequest, { status: "idle" });
  const [offset, setOffset] = useState("0");
  useEffect(() => {
    setOffset(String(new Date().getTimezoneOffset()));
  }, []);
  const field = "rounded-xl border border-[color:var(--color-line)] px-3 py-2";
  const label = "text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase";
  return (
    <form action={action} className="mt-6 grid gap-4 text-[15px]">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="tzOffsetMinutes" value={offset} />

      <fieldset className="grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-4">
        <legend className="px-1 font-semibold">Confirm a time</legend>
        <label className="grid gap-1">
          <span className={label}>Date and time</span>
          <input type="datetime-local" name="confirmedFor" className={field} />
        </label>
        <label className="grid gap-1">
          <span className={label}>Service (optional)</span>
          <input name="treatment" maxLength={120} defaultValue={treatment ?? ""} className={field} />
        </label>
        <button
          type="submit"
          name="decision"
          value="confirmed"
          disabled={pending}
          className="justify-self-start rounded-xl bg-[color:var(--color-fg,#111)] px-5 py-2.5 font-semibold text-white disabled:opacity-60"
        >
          {pending ? "Saving…" : "Confirm this time"}
        </button>
        <p className="text-[13px] text-[color:var(--color-muted)]">
          This creates the appointment in your healdesk record. The patient is not sent the time: call them to confirm it.
        </p>
      </fieldset>

      <label className="grid gap-1">
        <span className={label}>Your name (optional)</span>
        <input name="name" maxLength={80} autoComplete="name" className={field} />
      </label>
      <label className="grid gap-1">
        <span className={label}>Note for yourselves (optional, never sent to the patient)</span>
        <textarea name="note" maxLength={500} rows={2} className={field} />
      </label>
      {state.status === "failed" ? (
        <p role="alert" className="rounded-xl border border-[color:var(--color-red)]/30 bg-[color:var(--color-red)]/[0.06] px-4 py-3 font-medium">
          {state.message}
        </p>
      ) : null}
      {mode === "decide" ? (
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            name="decision"
            value="accepted"
            disabled={pending}
            className="rounded-xl border border-[color:var(--color-line)] px-5 py-2.5 font-semibold disabled:opacity-60"
          >
            Accept — we'll call to arrange a time
          </button>
          <button
            type="submit"
            name="decision"
            value="declined"
            disabled={pending}
            className="rounded-xl border border-[color:var(--color-line)] px-5 py-2.5 font-semibold disabled:opacity-60"
          >
            Decline — we'll call to find another time
          </button>
        </div>
      ) : null}
    </form>
  );
}

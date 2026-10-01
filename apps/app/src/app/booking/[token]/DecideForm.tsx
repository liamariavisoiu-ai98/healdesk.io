"use client";

import { useActionState, useEffect, useState } from "react";

import { decideRequest, type DecideFormState } from "./actions";

/**
 * Four ways to answer, two optional fields. Progressively enhanced: with
 * JavaScript off the browser POSTs to this URL and the action's redirect
 * lands on the same page showing the outcome (a typed time is then read
 * without a zone offset, i.e. as UTC; the enhanced form supplies the offset;
 * a calendar slot is an instant and needs neither).
 *
 * `mode` is "decide" for a fresh request (confirm / accept / propose /
 * decline), "confirm" for one already accepted, where the desk calls and the
 * only step left is to pin the slot, and "rescheduling" for one whose
 * alternatives the desk is going through with the person by phone (confirm
 * the one they chose, propose different times, or decline).
 *
 * `calendar` is the clinic's free slots when it connected a writable
 * calendar (design of 23 September 2026, §B.3): radios named `slotAt`, the
 * person's own times shown above them, and the typed time kept as "another
 * time". Without one — every clinic in v1 until the Google Calendar adapter
 * exists — the form is the typed time alone. healdesk places no calls, so
 * the desk always confirms with the person itself.
 */
export type Slot = { at: string; label: string };

export function DecideForm({
  token,
  treatment,
  mode,
  calendar,
  preferred,
  proposedSlots,
}: {
  token: string;
  treatment: string | null;
  mode: "decide" | "confirm" | "rescheduling";
  calendar: { writable: boolean; slots: Slot[] } | null;
  preferred: { primary: string; alternatives: string[] };
  proposedSlots: Slot[];
}) {
  const [state, action, pending] = useActionState<DecideFormState, FormData>(decideRequest, { status: "idle" });
  const [offset, setOffset] = useState("0");
  useEffect(() => {
    setOffset(String(new Date().getTimezoneOffset()));
  }, []);
  const field = "rounded-xl border border-[color:var(--color-line)] px-3 py-2";
  const label = "text-[13px] font-bold tracking-[0.06em] text-[color:var(--color-muted)] uppercase";
  const option = "flex items-baseline gap-2 text-[15px]";
  const writable = calendar?.writable === true;
  const slots = calendar?.slots ?? [];
  const ringOrCall = "Call them to confirm it; healdesk does not call them.";

  return (
    <form action={action} className="mt-6 grid gap-4 text-[15px]">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="tzOffsetMinutes" value={offset} />

      <fieldset className="grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-4">
        <legend className="px-1 font-semibold">Confirm a time</legend>
        <p className="text-[13px] text-[color:var(--color-muted)]">
          They asked for <span className="font-medium text-[color:var(--color-fg,inherit)]">{preferred.primary}</span>
          {preferred.alternatives.length ? (
            <>
              {" "}
              — or <span className="font-medium text-[color:var(--color-fg,inherit)]">{preferred.alternatives.join(", or ")}</span>
            </>
          ) : null}
          .
        </p>
        {mode === "rescheduling" && proposedSlots.length ? (
          <div className="grid gap-1">
            <span className={label}>The times you proposed</span>
            {proposedSlots.map((s) => (
              <label key={s.at} className={option}>
                <input type="radio" name="slotAt" value={s.at} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
        ) : null}
        {writable ? (
          <div className="grid gap-1">
            <span className={label}>Free in your calendar</span>
            {slots.length === 0 ? (
              <p className="text-[13px] text-[color:var(--color-muted)]">Your calendar did not return any free times just now; type one below.</p>
            ) : (
              <div className="grid max-h-64 gap-1 overflow-y-auto rounded-xl border border-[color:var(--color-line)] p-2">
                {slots.map((s) => (
                  <label key={s.at} className={option}>
                    <input type="radio" name="slotAt" value={s.at} />
                    <span>{s.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : null}
        <label className="grid gap-1">
          <span className={label}>{writable || (mode === "rescheduling" && proposedSlots.length) ? "Another time (not from the calendar)" : "Date and time"}</span>
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
          {writable
            ? `This records the appointment in healdesk and, because your calendar is connected, adds it to your calendar. ${ringOrCall}`
            : `This records the appointment in healdesk only; add it to your own calendar or booking system. ${ringOrCall}`}
        </p>
      </fieldset>

      {mode === "decide" || mode === "rescheduling" ? (
        <fieldset className="grid gap-3 rounded-2xl border border-[color:var(--color-line)] p-4">
          <legend className="px-1 font-semibold">{mode === "rescheduling" ? "Propose different times" : "Can't do that — propose other times"}</legend>
          <p className="text-[13px] text-[color:var(--color-muted)]">Up to three. Leave the ones you don't need blank.</p>
          {[0, 1, 2].map((i) =>
            writable && slots.length ? (
              <label key={i} className="grid gap-1">
                <span className={label}>Time {i + 1}</span>
                <select name="proposedSlot" defaultValue="" className={field}>
                  <option value="">—</option>
                  {slots.map((s) => (
                    <option key={s.at} value={s.at}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={i} className="grid gap-1">
                <span className={label}>Time {i + 1}</span>
                <input type="datetime-local" name="proposedAt" className={field} />
              </label>
            ),
          )}
          <button
            type="submit"
            name="decision"
            value="rescheduling"
            disabled={pending}
            className="justify-self-start rounded-xl border border-[color:var(--color-line)] px-5 py-2.5 font-semibold disabled:opacity-60"
          >
            {mode === "rescheduling" ? "Propose these instead" : "Propose these times"}
          </button>
          <p className="text-[13px] text-[color:var(--color-muted)]">
            Call them to offer these times, then confirm the one they choose here.
          </p>
        </fieldset>
      ) : null}

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
      {mode === "decide" || mode === "rescheduling" ? (
        <div className="flex flex-wrap gap-3">
          {mode === "decide" ? (
            <button
              type="submit"
              name="decision"
              value="accepted"
              disabled={pending}
              className="rounded-xl border border-[color:var(--color-line)] px-5 py-2.5 font-semibold disabled:opacity-60"
            >
              Accept — we'll call to arrange a time
            </button>
          ) : null}
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

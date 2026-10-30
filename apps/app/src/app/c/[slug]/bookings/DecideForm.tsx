"use client";

import { useActionState, useEffect, useState } from "react";

import { decideBooking, type DecideFormState } from "./actions";

/**
 * Confirm, Propose or Decline one request (plan Part F5), progressively
 * enhanced: with JavaScript off the browser posts the form and the action's
 * redirect lands back on Bookings with the outcome (a typed time is then read
 * without a zone offset, as UTC; the enhanced form supplies the offset; a
 * calendar slot is an instant and needs neither).
 *
 * `mode` is "decide" for a fresh request, "confirm" for one accepted on the
 * old emailed page, where only pinning the time is left, and "rescheduling"
 * for one whose proposed times staff are going through by phone (confirm the
 * one they chose, propose others, or decline). `calendar` is the free times
 * of a writable calendar, read for the request in focus; elsewhere the typed
 * time is the form, and `freeTimesHref` opens the request with them.
 * healdesk places no calls, so staff always confirm with the person.
 */
export type Slot = { at: string; label: string };

export function DecideForm(props: {
  slug: string;
  requestId: string;
  treatment: string | null;
  mode: "decide" | "confirm" | "rescheduling";
  canDecline: boolean;
  calendar: { writable: boolean; slots: Slot[] } | null;
  freeTimesHref: string | null;
  proposedSlots: Slot[];
}) {
  const [state, action, pending] = useActionState<DecideFormState, FormData>(
    decideBooking.bind(null, props.slug),
    { status: "idle" },
  );
  const [offset, setOffset] = useState("0");
  useEffect(() => {
    setOffset(String(new Date().getTimezoneOffset()));
  }, []);
  const field = "border-line min-h-11 rounded-md border bg-white px-3 py-2";
  const label = "text-muted text-xs font-bold tracking-[0.06em] uppercase";
  const option = "flex min-h-11 items-center gap-2";
  const writable = props.calendar?.writable === true;
  const slots = props.calendar?.slots ?? [];
  const id = props.requestId;
  const primary =
    "bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50";
  const secondary =
    "border-line min-h-11 rounded-full border bg-white px-5 text-sm font-semibold disabled:opacity-50";

  return (
    <>
      <form action={action} className="mt-4 grid gap-3 text-sm">
        <input type="hidden" name="requestId" value={id} />
        <input type="hidden" name="tzOffsetMinutes" value={offset} />

        <details className="border-line rounded-md border bg-white p-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            Confirm a time
          </summary>
          <div className="mt-2 grid gap-3">
            {props.mode === "rescheduling" && props.proposedSlots.length ? (
              <fieldset className="grid gap-1">
                <legend className={label}>The times you proposed</legend>
                {props.proposedSlots.map((s) => (
                  <label key={s.at} className={option}>
                    <input type="radio" name="slotAt" value={s.at} />
                    <span>{s.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {writable ? (
              <fieldset className="grid gap-1">
                <legend className={label}>Free in your calendar</legend>
                {slots.length === 0 ? (
                  <p className="text-muted">
                    Your calendar didn&rsquo;t return any free times just now. Type one below.
                  </p>
                ) : (
                  <div className="border-line grid max-h-64 gap-1 overflow-y-auto rounded-md border p-2">
                    {slots.map((s) => (
                      <label key={s.at} className={option}>
                        <input type="radio" name="slotAt" value={s.at} />
                        <span>{s.label}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            ) : props.freeTimesHref ? (
              <p>
                <a
                  href={props.freeTimesHref}
                  className="font-semibold underline underline-offset-2"
                >
                  Show free times from your calendar
                </a>
              </p>
            ) : null}
            <label className="grid gap-1">
              <span className={label}>
                {writable || (props.mode === "rescheduling" && props.proposedSlots.length)
                  ? "Another time"
                  : "Date and time"}
              </span>
              <input type="datetime-local" name="confirmedFor" className={field} />
            </label>
            <label className="grid gap-1">
              <span className={label}>Service (optional)</span>
              <input
                name="treatment"
                maxLength={120}
                defaultValue={props.treatment ?? ""}
                className={field}
              />
            </label>
            <button
              type="submit"
              name="decision"
              value="confirmed"
              disabled={pending}
              className={`${primary} justify-self-start`}
            >
              {pending ? "Saving…" : "Confirm this time"}
            </button>
            <p className="text-muted">
              {writable
                ? "This books it, and adds it to your calendar. Call them to tell them the time."
                : "This books it in healdesk. Add it to your own calendar or booking system, and call them to tell them the time."}
            </p>
          </div>
        </details>

        <details className="border-line rounded-md border bg-white p-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
            {props.mode === "rescheduling" ? "Propose different times" : "Propose other times"}
          </summary>
          <div className="mt-2 grid gap-3">
            <p className="text-muted">Up to three. Leave the ones you don&rsquo;t need blank.</p>
            {[0, 1, 2].map((i) =>
              writable && slots.length ? (
                <label key={i} className="grid gap-1">
                  <span className={label}>Time {i + 1}</span>
                  <select name="proposedSlot" defaultValue="" className={field}>
                    <option value="">None</option>
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
              className={`${secondary} justify-self-start`}
            >
              {props.mode === "rescheduling" ? "Propose these instead" : "Propose these times"}
            </button>
            <p className="text-muted">
              Call them to offer these times, then confirm the one they choose here.
            </p>
          </div>
        </details>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1">
            <span className={label}>Your name (optional)</span>
            <input name="name" maxLength={80} autoComplete="name" className={field} />
          </label>
          <label className="grid gap-1">
            <span className={label}>Note for your team (optional)</span>
            <input name="note" maxLength={500} className={field} />
          </label>
        </div>
        <p className="text-muted">The note stays here and is never sent to them.</p>

        {props.canDecline ? (
          <div>
            <button
              type="submit"
              name="decision"
              value="declined"
              disabled={pending}
              className={secondary}
            >
              Decline
            </button>
            <p className="text-muted mt-1">
              For when you can&rsquo;t offer anything. Call them to find another time.
            </p>
          </div>
        ) : null}
        <div aria-live="polite">
          {state.status === "failed" ? (
            <p
              role="alert"
              className="rounded-md border border-problem-line bg-tint-problem px-4 py-3 font-medium"
            >
              {state.message}
            </p>
          ) : null}
        </div>
      </form>
      {state.status === "busy" ? (
        // A form of its own, so "Confirm anyway" can only ever confirm the
        // exact time Google showed busy, never a time typed afterwards.
        <form
          action={action}
          className="border-line mt-3 grid gap-3 rounded-md border bg-white p-3 text-sm"
        >
          <input type="hidden" name="requestId" value={id} />
          <input type="hidden" name="tzOffsetMinutes" value={offset} />
          <input type="hidden" name="slotAt" value={state.slotAt} />
          <input type="hidden" name="treatment" value={state.treatment ?? ""} />
          <input type="hidden" name="name" value={state.name ?? ""} />
          <input type="hidden" name="note" value={state.note ?? ""} />
          <input type="hidden" name="addAnyway" value="1" />
          <p role="alert" className="font-medium">
            {state.message}
          </p>
          <button
            type="submit"
            name="decision"
            value="confirmed"
            disabled={pending}
            className={`${secondary} justify-self-start`}
          >
            Confirm anyway
          </button>
        </form>
      ) : null}
    </>
  );
}

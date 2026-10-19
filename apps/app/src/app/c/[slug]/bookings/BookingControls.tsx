"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { DecideResult } from "@/lib/portal/bookings";

import { useAnnounce } from "../feedback";
import { decideAction, depositPaidAction, freeTimesAction, outcomeAction } from "./actions";

/**
 * Bookings' controls (plan Part F5): the decision on a request, "Deposit
 * paid", and a booking's outcome. Every one runs behind the step-up on the
 * server and writes the access log (lib/portal/bookings.ts); these only ask,
 * say what happened in the portal's status region, and read the page again
 * so the row shows where things now stand. None of them contacts the
 * patient: staff call them, and the lines say so.
 */

export type Slot = { at: string; label: string };

const field = "border-line min-h-11 rounded-xl border bg-white px-3";
const label = "text-sm font-semibold";
const primary = "bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50";
const secondary = "border-line min-h-11 rounded-full border bg-white px-5 text-sm font-semibold disabled:opacity-50";

/**
 * Confirm a time, accept and call, propose up to three other times, or
 * decline. `mode` is "decide" for a fresh request, "confirm" for one
 * accepted (only the time is left to pin), and "rescheduling" for one whose
 * proposed times staff are going through by phone.
 *
 * The practice's free times are asked for on demand ("Show free times"),
 * not on every open of the page, because each ask goes to Google. Without
 * them, or without a calendar healdesk may write to, staff type the time.
 * Google is asked again, for exactly the time chosen, when it is confirmed;
 * if it shows that time busy, "Confirm anyway" confirms that exact time and
 * nothing typed afterwards.
 */
export function RequestDecision(props: {
  slug: string;
  requestId: string;
  mode: "decide" | "confirm" | "rescheduling";
  service: string | null;
  proposedSlots: Slot[];
}) {
  const announce = useAnnounce();
  const router = useRouter();
  const [working, setWorking] = useState(false);
  const [free, setFree] = useState<Slot[] | null>(null);
  const [freeNote, setFreeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<Extract<DecideResult, { status: "busy" }> | null>(null);
  const id = (name: string) => `${name}-${props.requestId}`;

  async function decide(decision: string, form: FormData): Promise<void> {
    setWorking(true);
    try {
      form.set("decision", decision);
      form.set("tzOffsetMinutes", String(new Date().getTimezoneOffset()));
      const result = await decideAction(props.slug, props.requestId, form);
      if (result.status === "busy") {
        setBusy(result);
        announce({ text: result.message, tone: "problem" });
        return;
      }
      setBusy(null);
      announce({ text: result.message, tone: result.status === "done" ? "ok" : "problem" });
      router.refresh();
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  async function showFree(): Promise<void> {
    setWorking(true);
    try {
      const result = await freeTimesAction(props.slug, props.requestId);
      if (result.status === "ok") {
        setFree(result.slots);
        setFreeNote(
          result.slots.length === 0
            ? "Your calendar didn't return any free times just now. Type a time instead."
            : null,
        );
      } else if (result.status === "no_calendar") {
        setFree([]);
        setFreeNote("healdesk can't read free times from your calendar, so type the time instead.");
      } else {
        announce({ text: "That request has been answered or has lapsed. Reload the page.", tone: "problem" });
        router.refresh();
      }
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  const slots = free ?? [];
  const deciding = props.mode === "decide" || props.mode === "rescheduling";

  return (
    <div className="mt-4">
      <form className="grid gap-4">
        <fieldset className="border-line grid gap-3 rounded-xl border px-4 py-3">
          <legend className="px-1 font-semibold">Confirm a time</legend>
          {props.mode === "rescheduling" && props.proposedSlots.length > 0 ? (
            <div className="grid gap-1" role="radiogroup" aria-label="The times you proposed">
              <span className={label}>The times you proposed</span>
              {props.proposedSlots.map((s) => (
                <label key={s.at} className="flex min-h-11 items-center gap-2">
                  <input type="radio" name="slotAt" value={s.at} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          ) : null}
          {free === null ? (
            <button type="button" onClick={() => void showFree()} disabled={working} className={`${secondary} justify-self-start`}>
              Show free times in your calendar
            </button>
          ) : slots.length > 0 ? (
            <div className="grid gap-1" role="radiogroup" aria-label="Free in your calendar">
              <span className={label}>Free in your calendar</span>
              <div className="border-line grid max-h-64 gap-1 overflow-y-auto rounded-xl border px-3 py-2">
                {slots.map((s) => (
                  <label key={s.at} className="flex min-h-11 items-center gap-2">
                    <input type="radio" name="slotAt" value={s.at} />
                    <span>{s.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
          {freeNote ? <p className="text-muted text-sm">{freeNote}</p> : null}
          <label htmlFor={id("confirmed-for")} className={label}>
            {slots.length > 0 || props.proposedSlots.length > 0 ? "Or another date and time" : "Date and time"}
          </label>
          <input id={id("confirmed-for")} type="datetime-local" name="confirmedFor" className={field} />
          <label htmlFor={id("service")} className={label}>
            Service (optional)
          </label>
          <input id={id("service")} name="treatment" maxLength={120} defaultValue={props.service ?? ""} className={field} />
          <button
            type="submit"
            formAction={(form) => decide("confirmed", form)}
            disabled={working}
            className={`${primary} justify-self-start`}
          >
            Confirm this time
          </button>
          <p className="text-muted text-sm">
            This books it in healdesk and adds it to your Google Calendar when healdesk can write to it; the
            page then says which happened. Then call them to tell them the time: healdesk doesn&rsquo;t
            contact them.
          </p>
        </fieldset>

        {deciding ? (
          <fieldset className="border-line grid gap-3 rounded-xl border px-4 py-3">
            <legend className="px-1 font-semibold">
              {props.mode === "rescheduling" ? "Propose different times" : "Can't do that? Propose other times"}
            </legend>
            <p className="text-muted text-sm">Up to three. Leave the ones you don&rsquo;t need blank.</p>
            {[0, 1, 2].map((i) =>
              slots.length > 0 ? (
                <div key={i} className="grid gap-1">
                  <label htmlFor={id(`proposed-${i}`)} className={label}>
                    Time {i + 1}
                  </label>
                  <select id={id(`proposed-${i}`)} name="proposedSlot" defaultValue="" className={field}>
                    <option value="">None</option>
                    {slots.map((s) => (
                      <option key={s.at} value={s.at}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div key={i} className="grid gap-1">
                  <label htmlFor={id(`proposed-${i}`)} className={label}>
                    Time {i + 1}
                  </label>
                  <input id={id(`proposed-${i}`)} type="datetime-local" name="proposedAt" className={field} />
                </div>
              ),
            )}
            <button
              type="submit"
              formAction={(form) => decide("rescheduling", form)}
              disabled={working}
              className={`${secondary} justify-self-start`}
            >
              {props.mode === "rescheduling" ? "Propose these instead" : "Propose these times"}
            </button>
            <p className="text-muted text-sm">Call them to offer these times, then confirm the one they choose here.</p>
          </fieldset>
        ) : null}

        <div className="grid gap-1">
          <label htmlFor={id("name")} className={label}>
            Your name (optional)
          </label>
          <input id={id("name")} name="name" maxLength={80} autoComplete="name" className={field} />
        </div>
        <div className="grid gap-1">
          <label htmlFor={id("note")} className={label}>
            Note for your team (optional, never sent to them)
          </label>
          <textarea id={id("note")} name="note" maxLength={500} rows={2} className="border-line rounded-xl border bg-white px-3 py-2" />
        </div>

        {deciding ? (
          <div className="flex flex-wrap gap-3">
            {props.mode === "decide" ? (
              <button type="submit" formAction={(form) => decide("accepted", form)} disabled={working} className={secondary}>
                Accept: we&rsquo;ll call to arrange a time
              </button>
            ) : null}
            <button type="submit" formAction={(form) => decide("declined", form)} disabled={working} className={secondary}>
              Decline: we&rsquo;ll call to find another time
            </button>
          </div>
        ) : null}
      </form>

      {busy ? (
        // A form of its own, so "Confirm anyway" can only ever confirm the
        // exact time Google showed busy, never a time typed afterwards.
        <form className="mt-3 grid gap-3 rounded-xl border border-red-200 bg-white px-4 py-3">
          <input type="hidden" name="slotAt" value={busy.slotAt} />
          <input type="hidden" name="treatment" value={busy.treatment ?? ""} />
          <input type="hidden" name="name" value={busy.name ?? ""} />
          <input type="hidden" name="note" value={busy.note ?? ""} />
          <input type="hidden" name="addAnyway" value="1" />
          <p role="alert" className="font-medium">
            {busy.message}
          </p>
          <button
            type="submit"
            formAction={(form) => decide("confirmed", form)}
            disabled={working}
            className={`${secondary} justify-self-start`}
          >
            Confirm anyway
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** "Deposit paid": the front desk took it, so it leaves Deposits to collect. */
export function DepositPaid(props: { slug: string; appointmentId: string }) {
  const announce = useAnnounce();
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function mark(): Promise<void> {
    setWorking(true);
    try {
      const result = await depositPaidAction(props.slug, props.appointmentId);
      announce({ text: result.message, tone: result.ok ? "ok" : "problem" });
      router.refresh();
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <button type="button" onClick={() => void mark()} disabled={working} className={`${secondary} mt-3`}>
      Deposit paid
    </button>
  );
}

const OUTCOMES = [
  { value: "showed", label: "Showed" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled", label: "Cancelled" },
] as const;

/** The spec's one outcome control, once the appointment's time has come: one click, changeable. */
export function BookingOutcome(props: { slug: string; appointmentId: string; current: string }) {
  const announce = useAnnounce();
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function mark(outcome: string): Promise<void> {
    setWorking(true);
    try {
      const result = await outcomeAction(props.slug, props.appointmentId, outcome);
      announce({ text: result.message, tone: result.ok ? "ok" : "problem" });
      router.refresh();
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="How did it go?">
      {OUTCOMES.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={props.current === o.value}
          disabled={working}
          onClick={() => void mark(o.value)}
          className={`min-h-11 rounded-full border px-4 text-sm font-semibold disabled:opacity-50 ${
            props.current === o.value ? "border-ink bg-ink text-white" : "border-line bg-white"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

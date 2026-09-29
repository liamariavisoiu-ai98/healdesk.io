"use client";

import { useActionState, useState } from "react";

import { submitRequirements, type SetupFormState } from "./actions";

/**
 * The requirement checkboxes, the "never asked" list, and the optional
 * Direct booking election. Draws failure only; success is a redirect to
 * /setup/done (see actions.ts and the connect form's header for why).
 *
 * Locked fields render checked and disabled, and a disabled checkbox is not
 * submitted — the server adds the locked four regardless, so the form and
 * the record agree whatever the browser sends. Non-Meta fields say "phone
 * only" because a Meta thread never asks for them (§H.1).
 */
export type SetupFieldView = {
  id: string;
  label: string;
  ask: string;
  locked: boolean;
  preselected: boolean;
  phoneOnly: boolean;
};

export function SetupForm({
  token,
  fields,
  neverAsked,
  directBooking,
}: {
  token: string;
  fields: readonly SetupFieldView[];
  neverAsked: readonly string[];
  /** Null when the section is not offered: it is then absent, not disabled. */
  directBooking: { version: string; text: string } | null;
}) {
  const [state, action, pending] = useActionState<SetupFormState, FormData>(submitRequirements, { status: "idle" });
  const [electing, setElecting] = useState(false);

  return (
    <form action={action} autoComplete="off" className="mt-8">
      <input type="hidden" name="token" value={token} />

      <section className="rounded-2xl border border-[color:var(--color-line)] bg-white p-5 sm:p-6">
        <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">The assistant may ask for</h2>
        <ul className="mt-4 grid gap-3">
          {fields.map((field) => (
            <li key={field.id}>
              <label className="flex items-start gap-3 text-[15px]">
                <input
                  type="checkbox"
                  name="fields"
                  value={field.id}
                  defaultChecked={field.locked || field.preselected}
                  disabled={field.locked || pending}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="font-semibold">{field.label}</span>
                  {field.locked ? <span className="ml-2 text-xs text-[color:var(--color-muted)]">always asked</span> : null}
                  {field.phoneOnly ? <span className="ml-2 text-xs text-[color:var(--color-muted)]">phone only</span> : null}
                  <span className="block text-sm text-[color:var(--color-muted)]">Asked as: &ldquo;{field.ask}&rdquo;</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-2xl border border-[color:var(--color-red)]/25 bg-[color:var(--color-red)]/[0.05] p-5 sm:p-6">
        <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">Never asked</h2>
        <p className="mt-2 text-sm text-[color:var(--color-muted)]">
          These are not on the list and cannot be added. Your front desk asks for them, if it needs them, when it calls.
        </p>
        <ul className="mt-3 grid gap-1.5 text-[15px] sm:grid-cols-2">
          {neverAsked.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span aria-hidden className="text-[color:var(--color-red)]">✕</span>
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      </section>

      {directBooking ? (
        <section className="mt-6 rounded-2xl border border-[color:var(--color-line)] bg-white p-5 sm:p-6">
          <h2 className="text-[13px] font-bold tracking-[0.04em] uppercase">Direct booking (optional)</h2>
          <p className="mt-2 text-sm text-[color:var(--color-muted)]">
            By default the assistant hands every booking request to your front desk, who confirm a time. If you would
            rather it booked callers straight into your connected calendar, at a time it read as free, accept the
            addendum below. You can withdraw at any time by telling us.
          </p>
          <pre className="mt-4 max-h-80 overflow-auto rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-2)] p-4 text-[12.5px] leading-relaxed whitespace-pre-wrap">
            {directBooking.text}
          </pre>
          <label className="mt-4 flex items-start gap-3 text-[15px]">
            <input
              type="checkbox"
              name="directBooking"
              disabled={pending}
              onChange={(event) => setElecting(event.target.checked)}
              className="mt-1"
            />
            <span className="font-semibold">I accept the Direct booking addendum ({directBooking.version}) on behalf of the practice.</span>
          </label>
          {electing ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-[15px] font-semibold">Your name</span>
                <input
                  name="signatoryName"
                  required={electing}
                  maxLength={200}
                  autoComplete="off"
                  disabled={pending}
                  aria-invalid={state.status === "failed" && state.field === "signatoryName" ? true : undefined}
                  className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="text-[15px] font-semibold">Your title</span>
                <input
                  name="signatoryTitle"
                  maxLength={200}
                  autoComplete="off"
                  disabled={pending}
                  placeholder="Practice manager"
                  className="mt-2 w-full rounded-xl border border-[color:var(--color-line)] bg-white px-4 py-3 text-[16px] outline-none focus:border-[color:var(--color-orange)] disabled:opacity-60"
                />
              </label>
            </div>
          ) : null}
        </section>
      ) : null}

      {state.status === "failed" ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-[color:var(--color-red)]">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="mt-6 w-full rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white transition-opacity disabled:opacity-50 sm:w-auto"
      >
        {pending ? "Saving…" : "Confirm"}
      </button>
      <p aria-live="polite" className="sr-only">{pending ? "Saving your choices." : ""}</p>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { requestSignInHelp } from "./actions";

/**
 * The "I can't get in" form (plan Part D5): the clinic's address, its name,
 * and one billing detail, the card's last four digits and expiry or an
 * invoice number. Every accepted request gets the same answer.
 */
export function HelpForm() {
  const [state, action, pending] = useActionState(requestSignInHelp, { status: "idle" });
  const [kind, setKind] = useState<"card" | "invoice">("card");

  if (state.status === "received") {
    return (
      <div className="mt-8" role="status" aria-live="polite">
        <p className="text-ink font-semibold">Thanks. We&apos;ve checked what you gave us.</p>
        <p className="text-muted mt-2">
          If the details match, we&apos;ve sent a sign-in link to the clinic&apos;s address. It
          comes from healdesk, hello@healdesk.io, and works once, for 15 minutes. It goes only to
          the address already on the account.
        </p>
        <p className="text-muted mt-4">
          Nothing arrived, or nobody can read that inbox any more? Email{" "}
          <a href="mailto:hello@healdesk.io" className="underline underline-offset-2">
            hello@healdesk.io
          </a>{" "}
          from any address. We&apos;ll call your practice&apos;s published number before we change
          anything.
        </p>
      </div>
    );
  }

  const error = state.status === "invalid" ? state : null;
  const fieldError = (field: string) =>
    error?.field === field ? (
      <p id={`${field}-error`} role="alert" className="text-sm text-problem">
        {error.message}
      </p>
    ) : null;

  return (
    <form
      action={action}
      className="mt-8 space-y-5"
      noValidate
      aria-describedby={state.status === "limited" ? "limited-error" : undefined}
    >
      <div className="space-y-2">
        <label htmlFor="email" className="block text-sm font-semibold">
          Your clinic&apos;s email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={error?.field === "email" ? true : undefined}
          aria-describedby={error?.field === "email" ? "email-error" : undefined}
          className="border-line w-full rounded-md border px-4 py-3 text-base"
        />
        {fieldError("email")}
      </div>
      <div className="space-y-2">
        <label htmlFor="clinic" className="block text-sm font-semibold">
          Your clinic&apos;s name
        </label>
        <input
          id="clinic"
          name="clinic"
          type="text"
          autoComplete="organization"
          required
          aria-invalid={error?.field === "clinic" ? true : undefined}
          aria-describedby={error?.field === "clinic" ? "clinic-error" : undefined}
          className="border-line w-full rounded-md border px-4 py-3 text-base"
        />
        {fieldError("clinic")}
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">
          One billing detail, to check it&apos;s you
        </legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="kind"
              value="card"
              checked={kind === "card"}
              onChange={() => setKind("card")}
            />
            The card we bill
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="radio"
              name="kind"
              value="invoice"
              checked={kind === "invoice"}
              onChange={() => setKind("invoice")}
            />
            An invoice number
          </label>
        </div>
        {kind === "card" ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <label htmlFor="last4" className="block text-sm">
                Last four digits
              </label>
              <input
                id="last4"
                name="last4"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                className="border-line w-full rounded-md border px-4 py-3 text-base"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="expiry" className="block text-sm">
                Expiry (MM/YY)
              </label>
              <input
                id="expiry"
                name="expiry"
                inputMode="numeric"
                autoComplete="off"
                placeholder="04/28"
                className="border-line w-full rounded-md border px-4 py-3 text-base"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <label htmlFor="invoice" className="block text-sm">
              Invoice number, as it appears on the invoice
            </label>
            <input
              id="invoice"
              name="invoice"
              autoComplete="off"
              placeholder="ABCD1234-0001"
              className="border-line w-full rounded-md border px-4 py-3 text-base"
            />
          </div>
        )}
        {fieldError("detail")}
      </fieldset>
      {state.status === "limited" ? (
        <p id="limited-error" role="alert" className="text-sm text-problem">
          That&apos;s a lot of requests from here. Wait a few minutes, then try again.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "Checking…" : "Send a sign-in link to the clinic's address"}
      </button>
    </form>
  );
}

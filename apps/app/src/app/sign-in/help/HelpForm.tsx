"use client";

import { useActionState, useState, type ChangeEvent } from "react";

import { CardBadge, CardLede, CardTitle, PRIMARY_BUTTON, ProblemLine, Spinner, TEXT_LINK } from "../ui";
import { requestSignInHelp } from "./actions";

type Field = "email" | "clinic" | "last4" | "expiry" | "invoice";

const RECEIVED_LINE = "If the details match, we've sent a sign-in link to the clinic's address.";
const RECEIVED_DETAIL =
  "It comes from healdesk, hello@healdesk.io, and works once, for 15 minutes. It goes only to the address already on the account.";

/**
 * The "I can't get in" form (plan Part D5): the clinic's address, its name,
 * and one billing detail, the card's last four digits and expiry or an
 * invoice number. Every accepted request gets the same answer.
 *
 * The fields are held here, so a refused detail is still in its field to
 * correct rather than cleared by the reset React gives a form after its
 * action. The answer is announced from its own region, in the markup from the
 * first render, as on /sign-in (SignInForm.tsx says why).
 */
export function HelpForm() {
  const [state, action, pending] = useActionState(requestSignInHelp, { status: "idle" });
  const [kind, setKind] = useState<"card" | "invoice">("card");
  const [values, setValues] = useState<Record<Field, string>>({
    email: "",
    clinic: "",
    last4: "",
    expiry: "",
    invoice: "",
  });
  const bind = (field: Field) => ({
    id: field,
    name: field,
    value: values[field],
    onChange: (event: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [field]: event.target.value })),
  });

  const received = state.status === "received";
  const error = state.status === "invalid" ? state : null;
  const fieldError = (field: string) =>
    error?.field === field ? <ProblemLine id={`${field}-error`}>{error.message}</ProblemLine> : null;

  return (
    <>
      <p role="status" className="sr-only">
        {received ? `Thanks. We've checked what you gave us. ${RECEIVED_LINE} ${RECEIVED_DETAIL}` : ""}
      </p>
      {received ? (
        <div className="si-fade">
          <CardBadge icon="mail" />
          <div className="mt-5">
            <CardTitle small>Thanks. We&apos;ve checked what you gave us.</CardTitle>
          </div>
          <CardLede balance>{RECEIVED_LINE}</CardLede>
          <p className="text-muted mt-3 text-center text-sm text-pretty">{RECEIVED_DETAIL}</p>
          <p className="border-line text-muted mt-8 border-t pt-6 text-center text-sm text-pretty">
            Nothing arrived, or nobody can read that inbox any more? Email{" "}
            <a href="mailto:hello@healdesk.io" className={TEXT_LINK}>
              hello@healdesk.io
            </a>{" "}
            from any address. We&apos;ll call your practice&apos;s published number before we change anything.
          </p>
        </div>
      ) : (
        <>
          <CardTitle>Can&apos;t get in?</CardTitle>
          <CardLede>
            Tell us your clinic&apos;s address and one billing detail. If they match, we&apos;ll email a sign-in link
            to the clinic&apos;s address. It never goes anywhere else.
          </CardLede>
          <form
            action={action}
            className="mt-8 space-y-5"
            noValidate
            aria-describedby={state.status === "limited" ? "limited-error" : undefined}
          >
            <div>
              <label htmlFor="email" className="mb-2 block px-1 text-sm font-semibold">
                Your clinic&apos;s email address
              </label>
              <input
                {...bind("email")}
                type="email"
                autoComplete="email"
                required
                aria-invalid={error?.field === "email" ? true : undefined}
                aria-describedby={error?.field === "email" ? "email-error" : undefined}
                className="si-input"
              />
              {fieldError("email")}
            </div>
            <div>
              <label htmlFor="clinic" className="mb-2 block px-1 text-sm font-semibold">
                Your clinic&apos;s name
              </label>
              <input
                {...bind("clinic")}
                type="text"
                autoComplete="organization"
                required
                aria-invalid={error?.field === "clinic" ? true : undefined}
                aria-describedby={error?.field === "clinic" ? "clinic-error" : undefined}
                className="si-input"
              />
              {fieldError("clinic")}
            </div>
            <fieldset>
              <legend className="mb-2 px-1 text-sm font-semibold">One billing detail, to check it&apos;s you</legend>
              <div className="si-segments">
                <label className="relative">
                  <input
                    type="radio"
                    name="kind"
                    value="card"
                    checked={kind === "card"}
                    onChange={() => setKind("card")}
                    className="sr-only"
                  />
                  <span>The card we bill</span>
                </label>
                <label className="relative">
                  <input
                    type="radio"
                    name="kind"
                    value="invoice"
                    checked={kind === "invoice"}
                    onChange={() => setKind("invoice")}
                    className="sr-only"
                  />
                  <span>An invoice number</span>
                </label>
              </div>
              {kind === "card" ? (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="last4" className="mb-2 block px-1 text-sm">
                      Last four digits
                    </label>
                    <input {...bind("last4")} inputMode="numeric" autoComplete="off" maxLength={4} className="si-input" />
                  </div>
                  <div>
                    <label htmlFor="expiry" className="mb-2 block px-1 text-sm">
                      Expiry (MM/YY)
                    </label>
                    <input
                      {...bind("expiry")}
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="04/28"
                      className="si-input"
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-4">
                  <label htmlFor="invoice" className="mb-2 block px-1 text-sm">
                    Invoice number, as it appears on the invoice
                  </label>
                  <input {...bind("invoice")} autoComplete="off" placeholder="ABCD1234-0001" className="si-input" />
                </div>
              )}
              {fieldError("detail")}
            </fieldset>
            {state.status === "limited" ? (
              <ProblemLine id="limited-error">
                That&apos;s a lot of requests from here. Wait a few minutes, then try again.
              </ProblemLine>
            ) : null}
            {/* A long label: 16px with less padding keeps it on one line from a
                tablet up, and a phone breaks it into two even lines. */}
            <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} px-5 text-base text-balance`}>
              {pending ? (
                <>
                  <Spinner />
                  Checking…
                </>
              ) : (
                "Send a sign-in link to the clinic's address"
              )}
            </button>
          </form>
        </>
      )}
    </>
  );
}

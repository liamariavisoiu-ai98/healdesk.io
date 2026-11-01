"use client";

import { useActionState, useEffect, useState } from "react";

import { requestSignIn, type SignInFormState } from "./actions";
import {
  BreakableEmail,
  CardBadge,
  CardLede,
  CardTitle,
  PRIMARY_BUTTON,
  ProblemLine,
  SECONDARY_BUTTON,
  Spinner,
  TEXT_LINK,
} from "./ui";

/** "Send again" waits this long after a send (plan Part D1). */
const RESEND_AFTER_MS = 60_000;

const FIELD_ERRORS: Partial<Record<SignInFormState["status"], string>> = {
  invalid: "Enter the email address your clinic uses with healdesk.",
  limited: "That's a lot of requests from here. Wait a few minutes, then try again.",
};

/**
 * What the card says once a link is on its way, in two sentences the card
 * sets apart: what happens, then the detail. Conditional on purpose: every
 * well-formed request gets this same answer (actions.ts), so it must never
 * say whether the address has an account.
 */
const SENT_LINE = "If it's the address on a healdesk account, a sign-in link is on its way.";
function sentDetail(linkMinutes: number): string {
  return `It comes from healdesk, hello@healdesk.io, and works once, for ${linkMinutes} minutes.`;
}

/**
 * The sign-in card's contents: the heading, the one field and its button, or,
 * once the request has gone, the "check your inbox" state in its place.
 *
 * The announcement for a screen reader is its own region, in the markup from
 * the first render and filled when the link is sent. A region that arrives
 * already filled is not reliably read out, and one wrapped round the "Send
 * again" button would read its countdown out every second.
 */
export function SignInForm({ next, linkMinutes }: { next: string | null; linkMinutes: number }) {
  const [state, action, pending] = useActionState(requestSignIn, { status: "idle" });

  return (
    <>
      <p role="status" className="sr-only">
        {state.status === "sent"
          ? `Check your inbox, ${state.email}. ${SENT_LINE} ${sentDetail(linkMinutes)}`
          : ""}
      </p>
      {state.status === "sent" ? (
        <Sent state={state} next={next} linkMinutes={linkMinutes} action={action} pending={pending} />
      ) : (
        <Ask error={FIELD_ERRORS[state.status]} next={next} action={action} pending={pending} />
      )}
    </>
  );
}

function Ask({
  error,
  next,
  action,
  pending,
}: {
  error: string | undefined;
  next: string | null;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  // Held here so a refused address is still in the field to correct, rather
  // than cleared by the reset React gives a form after its action.
  const [email, setEmail] = useState("");
  return (
    <>
      <CardTitle>Sign in to healdesk</CardTitle>
      <CardLede>We&apos;ll email you a link that signs you in. There&apos;s no password to remember.</CardLede>
      <form action={action} className="mt-8" noValidate>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        {/* The placeholder is a single space: the floating label reads it to
            know the field is empty (globals.css, .si-float). */}
        <div className="si-float">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder=" "
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "email-error" : "email-hint"}
            className="si-input"
          />
          <label htmlFor="email">Your clinic&apos;s email address</label>
        </div>
        {error ? (
          <ProblemLine id="email-error">{error}</ProblemLine>
        ) : (
          <p id="email-hint" className="text-muted mt-2 px-1 text-sm">
            The one your clinic signed up with. A shared inbox such as info@ is fine.
          </p>
        )}
        <button type="submit" disabled={pending} className={`${PRIMARY_BUTTON} mt-6`}>
          {pending ? (
            <>
              <Spinner />
              Sending…
            </>
          ) : (
            "Email me a sign-in link"
          )}
        </button>
      </form>
    </>
  );
}

function Sent({
  state,
  next,
  linkMinutes,
  action,
  pending,
}: {
  state: Extract<SignInFormState, { status: "sent" }>;
  next: string | null;
  linkMinutes: number;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const waitMs = state.sentAt + RESEND_AFTER_MS - now;
  const waiting = waitMs > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  return (
    <div className="si-fade">
      <CardBadge icon="mail" />
      <div className="mt-5">
        <CardTitle>Check your inbox</CardTitle>
      </div>
      <p className="mt-2 text-center text-[17px] font-semibold [overflow-wrap:anywhere]">
        <BreakableEmail email={state.email} />
      </p>
      <CardLede>{SENT_LINE}</CardLede>
      <p className="text-muted mt-3 text-center text-sm text-pretty">{sentDetail(linkMinutes)}</p>
      <form action={action} className="mt-8">
        <input type="hidden" name="email" value={state.email} />
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <button type="submit" disabled={pending || waiting} className={SECONDARY_BUTTON}>
          {waiting ? `Send again in ${Math.ceil(waitMs / 1000)} s` : "Send again"}
        </button>
      </form>
      <p className="mt-5 text-center text-sm">
        <a href="/sign-in" className={TEXT_LINK}>
          Use a different address
        </a>
      </p>
    </div>
  );
}

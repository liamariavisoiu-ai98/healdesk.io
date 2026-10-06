"use client";

import { useActionState, useEffect, useState } from "react";

import { requestSignIn, type SignInFormState } from "./actions";

/** "Send again" waits this long after a send (plan Part D1). */
const RESEND_AFTER_MS = 60_000;

const FIELD_ERRORS: Partial<Record<SignInFormState["status"], string>> = {
  invalid: "Enter the email address your clinic uses with healdesk.",
  limited: "That's a lot of requests from here. Wait a few minutes, then try again.",
};

export function SignInForm({ next, linkMinutes }: { next: string | null; linkMinutes: number }) {
  const [state, action, pending] = useActionState(requestSignIn, { status: "idle" });

  if (state.status === "sent") {
    return (
      <Sent state={state} next={next} linkMinutes={linkMinutes} action={action} pending={pending} />
    );
  }

  const error = FIELD_ERRORS[state.status];
  return (
    <form action={action} className="mt-8 space-y-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label htmlFor="email" className="block text-sm font-semibold">
        Your clinic&apos;s email address
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "email-error" : "email-hint"}
        className="border-line w-full rounded-xl border px-4 py-3 text-base"
      />
      {error ? (
        <p id="email-error" role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : (
        <p id="email-hint" className="text-muted text-sm">
          The one your clinic signed up with. A shared inbox such as info@ is fine.
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="bg-ink rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-60"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
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
    <div className="mt-8" role="status" aria-live="polite">
      <p className="text-ink font-semibold">Check {state.email}.</p>
      <p className="text-muted mt-2">
        If it&apos;s the address on a healdesk account, a sign-in link is on its way. It comes from
        healdesk, hello@healdesk.io, and works once, for {linkMinutes} minutes.
      </p>
      <form action={action} className="mt-6">
        <input type="hidden" name="email" value={state.email} />
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <button
          type="submit"
          disabled={pending || waiting}
          className="border-line rounded-full border px-6 py-3 text-sm font-bold disabled:opacity-60"
        >
          {waiting ? `Send again in ${Math.ceil(waitMs / 1000)} s` : "Send again"}
        </button>
      </form>
      <p className="text-muted mt-6 text-sm">
        <a href="/sign-in" className="underline underline-offset-2">
          Use a different address
        </a>
      </p>
    </div>
  );
}

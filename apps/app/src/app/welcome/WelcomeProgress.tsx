"use client";

import { useEffect, useRef, useState } from "react";

type State =
  | { status: "pending"; email: string }
  | { status: "ready"; url: string }
  | { status: "failed"; email: string }
  | { status: "use_email"; email: string }
  | { status: "unknown" }
  | { status: "timeout"; email: string | null };

const POLL_MS = 1500;
const GIVE_UP_MS = 90_000;

/**
 * Polls /welcome/state until the account exists, then goes to the one-time
 * sign-in link, which signs this browser in by itself. The ref and session id
 * live in memory only: the address bar is cleaned on arrival, so the success
 * URL is not left in history, a bookmark or a screenshot.
 */
export function WelcomeProgress({
  intentRef,
  sessionId,
  replyBy,
}: {
  intentRef: string;
  sessionId: string;
  replyBy: string;
}) {
  const [state, setState] = useState<State>({ status: "pending", email: "" });
  const started = useRef(Date.now());

  useEffect(() => {
    window.history.replaceState(null, "", "/welcome");
  }, []);

  useEffect(() => {
    let stopped = false;
    let lastEmail: string | null = null;
    async function poll(): Promise<void> {
      if (stopped) return;
      try {
        const response = await fetch(
          `/welcome/state?h=${encodeURIComponent(intentRef)}&cs=${encodeURIComponent(sessionId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        const next = (await response.json()) as State;
        if ("email" in next && next.email) lastEmail = next.email;
        if (next.status === "ready") {
          window.location.replace(next.url);
          return;
        }
        if (next.status !== "pending") {
          setState(next);
          return;
        }
        setState(next);
      } catch {
        // A dropped request is retried on the next tick.
      }
      if (Date.now() - started.current > GIVE_UP_MS) {
        setState({ status: "timeout", email: lastEmail });
        return;
      }
      window.setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
    };
  }, [intentRef, sessionId]);

  const email = "email" in state && state.email ? state.email : "the clinic's address";

  if (state.status === "failed") {
    return (
      <Message title="Payment received, and your payment is safe.">
        Setting up your account needs one step on our side. We'll email {email} by {replyBy}.
      </Message>
    );
  }
  if (state.status === "timeout") {
    return (
      <Message title="Your account is almost ready.">
        We'll email your sign-in link to {email} the moment it is.
      </Message>
    );
  }
  if (state.status === "use_email") {
    return (
      <Message title="Your account is ready.">
        Sign in from the welcome email we sent to {email}, or{" "}
        <a href="/sign-in" className="underline">
          get a new sign-in link
        </a>
        .
      </Message>
    );
  }
  if (state.status === "unknown") {
    return (
      <Message title="This page belongs to the browser that paid.">
        If that was you, sign in from the email we sent to the clinic's address, or{" "}
        <a href="/sign-in" className="underline">
          get a new sign-in link
        </a>
        .
      </Message>
    );
  }
  return (
    <Message title="Payment received. Setting up AYA…" busy>
      This takes a few seconds. Keep this page open.
    </Message>
  );
}

function Message({ title, children, busy }: { title: string; children: React.ReactNode; busy?: boolean }) {
  return (
    <div role="status" aria-live="polite" aria-busy={busy || undefined}>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted mt-3">{children}</p>
    </div>
  );
}

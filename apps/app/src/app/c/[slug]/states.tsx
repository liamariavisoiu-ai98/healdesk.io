import type { ReactNode } from "react";

/**
 * Empty, loading and error states for the portal's screens (lane STATES).
 *
 * One sentence says what is empty and why; one action follows when there is
 * one. Plain markup with no state or hooks, so it renders on the server and
 * inside a client boundary alike. It uses only the portal's tokens (the app
 * has no dark theme; when it gets one, these follow the tokens), animates
 * nothing but the loading placeholder's pulse, and that stops under
 * `prefers-reduced-motion` (`motion-safe:`), leaving a still block beside
 * words that say the same thing.
 *
 * Never put a patient's words, name, number or time in `children`/`action`,
 * and never a thrown message: an error says what failed in our words
 * (`ErrorState` takes no error object on purpose).
 */

const BOX = "border-line rounded-xl border bg-white px-4 py-4";

/** Something that has nothing in it yet, and why, with at most one next step. */
export function EmptyState(props: {
  /** One sentence: what is empty and why. */
  children: ReactNode;
  /** The one next step, usually a link or button. */
  action?: ReactNode;
  /** Announce it politely, for a list that empties after a search or filter. */
  live?: boolean;
}) {
  return (
    <div
      className={BOX}
      data-state="empty"
      {...(props.live ? { role: "status", "aria-live": "polite" as const } : {})}
    >
      <p className="text-muted text-sm">{props.children}</p>
      {props.action ? <div className="mt-3">{props.action}</div> : null}
    </div>
  );
}

/**
 * Something failed. The heading says what in plain words; the reason is ours,
 * never the error's own text. `reference` is an opaque id (Next's error
 * digest) so the team can find the log line; it is not shown as a message.
 */
export function ErrorState(props: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  reference?: string | null;
  /** The heading's level: h1 where the state is the whole screen, else h2. */
  as?: "h1" | "h2";
}) {
  const Heading = props.as ?? "h2";
  return (
    <div className={BOX} role="alert" data-state="error">
      <Heading className="text-lg font-semibold">{props.title ?? "This page didn’t load"}</Heading>
      <p className="text-muted mt-1 text-sm">
        {props.children ??
          "Something went wrong on our side. Nothing you entered was lost. Try again in a moment."}
      </p>
      {props.action ? <div className="mt-3">{props.action}</div> : null}
      {props.reference ? (
        <p className="text-muted mt-3 text-xs">Reference: {props.reference}</p>
      ) : null}
    </div>
  );
}

/** A still-or-pulsing placeholder with a spoken "Loading". */
export function LoadingState(props: { label?: string; rows?: number }) {
  const rows = Math.min(Math.max(props.rows ?? 3, 1), 6);
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-state="loading">
      <span className="sr-only">{props.label ?? "Loading"}</span>
      <div aria-hidden="true" className="grid gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="bg-paper-2 h-14 rounded-xl motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}

/** The button/link style the portal uses for a single next step. */
export const STATE_ACTION_CLASS =
  "border-line text-ink inline-flex min-h-11 items-center rounded-full border bg-white px-5 text-sm font-semibold";

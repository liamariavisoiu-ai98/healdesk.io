"use client";

import { useFormStatus } from "react-dom";

import { PRIMARY_BUTTON } from "./ui";

/**
 * "Continue" on the pages an emailed link opens, /link/<token> and
 * /recover/<token>: while the link is being spent and the session started,
 * it says so and cannot be pressed twice. The checkout link presses it by
 * itself (link/[token]/AutoSubmit.tsx), so this is also what the browser
 * that has just paid sees for that moment.
 */
export function ContinueButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
      {pending ? "Signing you in…" : "Continue"}
    </button>
  );
}

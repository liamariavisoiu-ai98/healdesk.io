"use client";

import { useFormStatus } from "react-dom";

import { PRIMARY_BUTTON, Spinner } from "@/app/sign-in/ui";

/**
 * The link page's "Continue": while the link is being spent and the session
 * started, it says so and cannot be pressed twice. The checkout link presses
 * it by itself (AutoSubmit.tsx), so this is also what the browser that has
 * just paid sees for that moment.
 */
export function ContinueButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={PRIMARY_BUTTON}>
      {pending ? (
        <>
          <Spinner />
          Signing you in…
        </>
      ) : (
        "Continue"
      )}
    </button>
  );
}

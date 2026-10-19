import type { Metadata } from "next";

import { HelpForm } from "./HelpForm";

export const metadata: Metadata = { title: "Can't get in? · healdesk" };

export const dynamic = "force-dynamic";

/**
 * /sign-in/help: "I can't get in" (plan Part D5; spec, "Losing access").
 *
 * A link that expired, a person who left, an inbox nobody checks: the form
 * checks one billing detail against the account's and, if it matches, sends
 * a sign-in link to the clinic's address, never anywhere else, and never
 * adds a device. Losing the address itself goes to a person: we call the
 * practice's published number, and a change of address takes effect after
 * 72 hours, with notice to the old address and the new one.
 */
export default function SignInHelpPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold">Can&apos;t get in?</h1>
      <p className="text-muted mt-3">
        Tell us your clinic&apos;s address and one billing detail. If they match, we&apos;ll email a
        sign-in link to the clinic&apos;s address. It never goes anywhere else.
      </p>
      <HelpForm />
      <p className="text-muted mt-10 text-sm">
        Lost the address itself, because an inbox closed or the person who had it left? Email{" "}
        <a href="mailto:hello@healdesk.io" className="underline underline-offset-2">
          hello@healdesk.io
        </a>{" "}
        from any address. We&apos;ll call your practice&apos;s published number, and a change of
        address takes effect 72 hours later, with notice to the old address and the new one.
      </p>
      <p className="text-muted mt-4 text-sm">
        <a href="/sign-in" className="underline underline-offset-2">
          Back to sign in
        </a>
      </p>
    </main>
  );
}

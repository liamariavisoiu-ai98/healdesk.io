import type { Metadata } from "next";

import { SignInShell } from "../shell";
import { TEXT_LINK } from "../ui";
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
 *
 * In the sign-in pages' frame (../shell.tsx); the heading is the form's, so
 * the card becomes the answer once the details are sent.
 */
export default function SignInHelpPage() {
  return (
    <SignInShell
      below={
        <>
          <p>
            Lost the address itself, because an inbox closed or the person who had it left? Email{" "}
            <a href="mailto:hello@healdesk.io" className={TEXT_LINK}>
              hello@healdesk.io
            </a>{" "}
            from any address. We&apos;ll call your practice&apos;s published number, and a change of address takes
            effect 72 hours later, with notice to the old address and the new one.
          </p>
          <p className="mt-4">
            <a href="/sign-in" className={TEXT_LINK}>
              Back to sign in
            </a>
          </p>
        </>
      }
    >
      <HelpForm />
    </SignInShell>
  );
}

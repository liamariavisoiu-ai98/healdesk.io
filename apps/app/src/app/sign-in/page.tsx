import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentUserId, portalGrants } from "@/lib/portal/access";
import { isSafeRedirect, SIGN_IN_LINK_TTL_MS } from "@/lib/sign-in/links";

import { SignInShell } from "./shell";
import { SignInForm } from "./SignInForm";
import { TEXT_LINK } from "./ui";

export const metadata: Metadata = { title: "Sign in to healdesk" };

export const dynamic = "force-dynamic";

/**
 * /sign-in (plan Part D1). There is no password anywhere: the only way in is
 * a single-use link, emailed to a clinic's address. The page asks for the
 * address and answers every request the same way (actions.ts says why).
 *
 * `next` is where the link lands after sign-in: requirePortal sends people
 * here with the page they were trying to open. Only a path on this app is
 * kept; anything else is dropped rather than refused, so a mangled link
 * still gets someone signed in.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = typeof rawNext === "string" && isSafeRedirect(rawNext) ? rawNext : null;

  // Already in: a person who opens /sign-in from a bookmark while signed in
  // is going to their clinic, not asking for an email.
  const userId = await currentUserId();
  if (userId && (await portalGrants(userId)).length > 0) redirect(next ?? "/");

  // The heading and the lede are the form's (SignInForm.tsx): once the link
  // is on its way, the whole card becomes the "check your inbox" state.
  return (
    <SignInShell
      below={
        <p>
          Link expired, or nobody checks that inbox any more?{" "}
          <a href="/sign-in/help" className={`${TEXT_LINK} whitespace-nowrap`}>
            Get help signing in
          </a>
          .
        </p>
      }
    >
      <SignInForm next={next} linkMinutes={Math.round(SIGN_IN_LINK_TTL_MS.sign_in / 60_000)} />
    </SignInShell>
  );
}

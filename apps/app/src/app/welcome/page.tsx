import type { Metadata } from "next";

import { SignInShell } from "@/app/sign-in/shell";
import { replyByDate } from "@/lib/reply-by";

import { WelcomeProgress } from "./WelcomeProgress";

export const metadata: Metadata = {
  title: "Welcome to healdesk",
  // The success URL carries the purchase's ref: no referrer leaves this page.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /welcome: where Stripe sends the browser that has just paid (plan Part C3).
 * It waits for the account, then signs this browser in with a one-time link
 * that only the paying browser can receive (lib/checkout/welcome.ts). In the
 * sign-in pages' frame (app/sign-in/shell.tsx): it is the first healdesk page
 * a clinic sees after paying.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string; cs?: string }>;
}) {
  const { h, cs } = await searchParams;
  return (
    <SignInShell>
      <WelcomeProgress intentRef={h ?? ""} sessionId={cs ?? ""} replyBy={replyByDate()} />
    </SignInShell>
  );
}

import type { Metadata } from "next";

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
 * that only the paying browser can receive (lib/checkout/welcome.ts).
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string; cs?: string }>;
}) {
  const { h, cs } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <WelcomeProgress intentRef={h ?? ""} sessionId={cs ?? ""} replyBy={replyByDate()} />
    </main>
  );
}

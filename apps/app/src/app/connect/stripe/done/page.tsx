import type { Metadata } from "next";

/**
 * Where an operator's Stripe Connect link, and any state we do not recognise,
 * sends the browser after Stripe (BD28). Portal-started connects go back to
 * the portal instead; this page is the neutral one, and it is never `/admin`.
 *
 * It loads nothing. It names no clinic: the URL is public and final, anyone
 * can open it, and the callback never puts a clinic in it. It is told only
 * the result, a closed word, and prints nothing else from its query, the
 * connected account's name included: anyone can hand someone a link to this
 * page on our real origin, and a name read from the URL would print whatever
 * that link said ("Payment failed. Pay at …"), which no filter that still
 * passes a real business name can stop. The ops panel and the portal show
 * the account's name, read from Stripe on the server.
 */

export const metadata: Metadata = {
  title: "Stripe connection",
  description: "The result of connecting a Stripe account to healdesk.",
  robots: { index: false, follow: false },
};

type Result = "ok" | "declined" | "already_connected" | "expired" | "failed";

const COPY: Record<Result, { title: string; body: string }> = {
  ok: {
    title: "Your Stripe account is connected",
    body: "Once deposits are switched on, they are paid straight into your own Stripe account. healdesk never holds the money. If the account you connected is not your practice’s own, tell us straight away and we will disconnect it.",
  },
  declined: {
    title: "Nothing was connected",
    body: "You chose not to connect on Stripe’s page, so nothing has changed. When you are ready, ask us for a new link.",
  },
  already_connected: {
    title: "A Stripe account is already connected",
    body: "Your practice already has a Stripe account connected, so we left it as it is. To use a different account, ask us to disconnect the current one first.",
  },
  expired: {
    title: "This link is no longer valid",
    body: "Connect links work once, and for 15 minutes. Ask us for a new one; it takes a minute.",
  },
  failed: {
    title: "We couldn’t connect your Stripe account",
    body: "Nothing was changed. Start again from Settings in your portal, or ask us for a new link.",
  },
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConnectStripeDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = first(params.result);
  // Own keys only: `in` would also accept "constructor" and friends.
  const result: Result = raw && Object.hasOwn(COPY, raw) ? (raw as Result) : "failed";
  const copy = COPY[result];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-5 py-16 sm:px-6">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        healdesk
      </p>

      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight text-balance sm:text-3xl">
        {copy.title}
      </h1>

      <p className="mt-4 text-[15px] text-[color:var(--color-muted)]">{copy.body}</p>

      <p className="mt-8 border-t border-[color:var(--color-line)] pt-6 text-sm text-[color:var(--color-muted)]">
        Reply to the email that brought you here, or write to{" "}
        <a
          href="mailto:hello@healdesk.io"
          className="font-semibold text-[color:var(--color-ink)] underline underline-offset-2"
        >
          hello@healdesk.io
        </a>
        .
      </p>
    </main>
  );
}

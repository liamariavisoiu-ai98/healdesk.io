import type { Metadata } from "next";

import { readUnsubscribeToken, type StopScope } from "@/lib/email/unsubscribe";

export const metadata: Metadata = {
  title: "Stop these emails · healdesk",
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * The stop link's confirmation (Annex X1.10): what the link stops, and one
 * button that posts to /email/stop/<token>, which does it. Opening this page
 * changes nothing, so a link scanner that follows every URL in an inbox
 * stops nobody's email. No sign-in: the signed token is the authority, and it
 * stops one optional email for one clinic and nothing else.
 *
 * It names the email, never the clinic: anyone holding the link can open
 * this page, and it has no reason to say whose link it is.
 */

const WHAT: Partial<Record<StopScope, { name: string; where: string | null }>> = {
  usage_alerts: {
    name: "usage alert emails (at 80% and 100% of your allowance)",
    where: "Billing",
  },
  daily_summary: { name: "the daily summary email", where: "Settings → Alerts" },
  // O11: steps a practice sent on to this address. Not a switch anyone here
  // can turn back on: the practice can only send them to another address.
  steps: { name: "the setup steps a practice sends on to this address", where: null },
};

export default async function StopConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string | string[] }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const read = readUnsubscribeToken(token);
  const what = read ? WHAT[read.scope] : undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      {!what ? (
        <>
          <h1 className="text-2xl font-semibold">This link isn&rsquo;t one of ours</h1>
          <p className="text-muted mt-3">
            Nothing was changed. If an email from healdesk brought you here, reply to it and
            we&rsquo;ll sort it out.
          </p>
        </>
      ) : done === "1" ? (
        <>
          <h1 className="text-2xl font-semibold">Stopped</h1>
          <p className="text-muted mt-3">
            We won&rsquo;t send {what.name} any more.
            {what.where ? ` You can turn them back on in ${what.where}.` : ""}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Stop these emails?</h1>
          <p className="text-muted mt-3">
            This stops {what.name}.
            {what.where
              ? " Everything else healdesk sends, alerts and billing included, keeps arriving."
              : ""}
          </p>
          <form method="post" action={`/email/stop/${encodeURIComponent(token)}`} className="mt-8">
            <button
              type="submit"
              className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white"
            >
              Stop these emails
            </button>
          </form>
        </>
      )}
    </main>
  );
}

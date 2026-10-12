import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveConnectionLink } from "@/lib/connections/links";
import { env } from "@/lib/env";

import { connectRequestContext } from "../../../connect/[token]/request-context";
import { ChannelFrame, Notice, Throttled } from "../../shared";

/**
 * Connect a clinic's Facebook Page and its Instagram account (launch plan 1.6).
 *
 * One button. Meta's own dialog does the choosing — which Page, which
 * Instagram account — and grants the permissions on the configuration
 * registered on the app (docs/meta-app-review.md). Nothing is typed or pasted:
 * the spec's onboarding rule 2, "every connection is a login button".
 *
 * This is also the screen App Review watches. Recordings 1 and 2 in the pack
 * start here, logged out.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Facebook and Instagram",
  description: "Let healdesk's assistant answer your Facebook Page and Instagram messages.",
  robots: { index: false, follow: false },
};

/** What each problem the callback can send back means to the person reading it. */
const PROBLEMS: Record<string, string> = {
  cancelled: "Facebook's sign-in was closed before it finished, so nothing was connected. Your link still works.",
  no_page:
    "No Facebook Page was chosen. When Facebook asks which Pages to share, choose your clinic's Page. If none is listed, the account you signed in with is not an admin of the Page: ask whoever is to open this link instead.",
  several_pages:
    "More than one Page was chosen. Each location answers on one Page, so sign in again and choose only this location's Page.",
  meta_error: "Facebook didn't finish connecting the Page. Nothing was saved, and your link still works. Try again in a minute.",
  page_taken:
    "That Facebook Page is already connected to another practice on healdesk, so it can't be connected here too. Nothing was saved. Disconnect it there first, or reply to your setup email and we'll sort it out.",
  instagram_taken:
    "That Instagram account is already connected to another practice on healdesk, so it can't be connected here too. Nothing was saved. Disconnect it there first, or reply to your setup email and we'll sort it out.",
  not_configured: "Connecting Facebook and Instagram isn't switched on yet. Nothing is wrong on your side; we'll let you know when it is.",
  throttled: "That was tried several times in a short space of time. Wait a few minutes and try again.",
};

export default async function MetaChannelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ problem?: string }>;
}) {
  const { token } = await params;
  const { problem } = await searchParams;
  const request = await connectRequestContext();

  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) return <Throttled />;

  const link = await resolveConnectionLink(token, request, "meta");
  if (!link) redirect("/channels/invalid");

  const available = Boolean(env.metaAppId() && env.metaAppSecret() && env.metaLoginConfigId());
  const problemText = problem ? PROBLEMS[problem] : undefined;

  return (
    <ChannelFrame clinicName={link.clinicName} title="Let your assistant answer Facebook and Instagram messages">
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Sign in with Facebook and choose your clinic&apos;s Page. If an Instagram professional account is linked to that
        Page, it connects at the same time. It takes about a minute.
      </p>

      {problemText ? <Notice tone="problem">{problemText}</Notice> : null}

      <h2 className="mt-8 text-base font-semibold">What the assistant will do</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] text-[color:var(--color-muted)]">
        <li>Reply to people who message your Page or your Instagram account, about your services, prices, hours and booking.</li>
        <li>Reply only to someone who messaged you, and only within 24 hours of their message. It never messages anyone first.</li>
        <li>Not discuss medical conditions. Anyone who describes one is asked to call the clinic, and that message is not kept.</li>
      </ul>

      <h2 className="mt-8 text-base font-semibold">Before you start, for Instagram</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] text-[color:var(--color-muted)]">
        <li>Your Instagram account must be a professional account, linked to your Facebook Page.</li>
        <li>
          In the Instagram app, turn on <span className="font-semibold text-[color:var(--color-ink)]">Settings → Messages and story replies → Message controls → Connected tools → Allow access to messages</span>.
          Without it, messages cannot reach your assistant.
        </li>
      </ul>

      {available ? (
        <form method="post" action="/api/meta/login" className="mt-8">
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="w-full rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white sm:w-auto"
          >
            Log in with Facebook
          </button>
        </form>
      ) : (
        <Notice tone="info">{PROBLEMS.not_configured}</Notice>
      )}
    </ChannelFrame>
  );
}

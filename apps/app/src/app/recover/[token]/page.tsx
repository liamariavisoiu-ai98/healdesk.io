import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import {
  abandonSession,
  claimDeviceRecovery,
  lookUpDeviceRecovery,
  type DeviceRecoveryProblem,
} from "@/lib/factors/recovery";

export const metadata: Metadata = {
  title: "Add a device to healdesk",
  // The token is in the URL: no referrer leaves this page.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /recover/<token>: where the human route's link lands (plan Part D3, "Lost
 * every device"; lib/factors/recovery.ts). The operator sent it to the
 * clinic's address after calling the practice back.
 *
 * The GET only looks, as /link/<token> does, so the scanners mail providers
 * run over every link in an inbox spend nothing. The POST starts a session
 * for the clinic's sign-in and claims the link for that session, once, and
 * then goes to the clinic's Protect page, where that session may add one
 * device. A claim that loses (a second tab, the window closing in between)
 * ends the session it started and comes back here to say why.
 */

const PROBLEMS: Record<DeviceRecoveryProblem, { title: string; body: string }> = {
  used: {
    title: "This link has already been used.",
    body: "It works once. If no device was added with it, email hello@healdesk.io: we'll call your clinic back and send another.",
  },
  expired: {
    title: "This link has expired.",
    body: "It works for 24 hours. Email hello@healdesk.io: we'll call your clinic back and send another.",
  },
  ended: {
    title: "This link was stopped.",
    body: "healdesk ended it, or a newer one was sent to the same address. Use the newest, or email hello@healdesk.io.",
  },
  unknown: {
    title: "This link isn't valid.",
    body: "It may have been copied incompletely. Open it again from the email, or email hello@healdesk.io.",
  },
};

async function continueWithRecovery(formData: FormData): Promise<void> {
  "use server";
  const token = formData.get("token");
  const back = `/recover/${encodeURIComponent(String(token ?? ""))}`;
  const found = await lookUpDeviceRecovery(token);
  // Back to the GET, which says what went wrong. Outside any try: redirect()
  // works by throwing, and a catch-all would swallow it.
  if (!found.ok) redirect(back);

  const h = await headers();
  const started = await auth.api.startLinkSession({ body: { userId: found.userId }, headers: h });
  const claimed = await claimDeviceRecovery({
    token,
    sessionId: started.sessionId,
    request: {
      // The address our load balancer saw, not the chain's first entry
      // (lib/client-ip.ts).
      ipAddress: clientIp(h) ?? null,
      userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
    },
  });
  if (!claimed.ok) {
    await abandonSession(started.sessionId);
    redirect(back);
  }
  redirect(claimed.landing);
}

export default async function RecoverPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await lookUpDeviceRecovery(token);

  if (!link.ok) {
    const problem = PROBLEMS[link.reason];
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold">{problem.title}</h1>
        <p className="text-muted mt-3">{problem.body}</p>
        <a
          href="/sign-in"
          className="bg-ink mt-8 inline-flex w-fit rounded-full px-6 py-3 text-sm font-bold text-white"
        >
          Go to sign-in
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold">Add a device to healdesk</h1>
      <p className="text-muted mt-3">
        Continue as <strong className="text-ink">{link.emailMasked}</strong>, on the phone or
        computer you want to add. This link adds one device, once.
      </p>
      <form action={continueWithRecovery} className="mt-8">
        <input type="hidden" name="token" value={token} />
        <button
          type="submit"
          className="bg-ink rounded-full px-6 py-3 text-sm font-bold text-white"
        >
          Continue
        </button>
      </form>
    </main>
  );
}

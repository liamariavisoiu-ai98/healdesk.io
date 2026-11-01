import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { SignInShell } from "@/app/sign-in/shell";
import { CardBadge, CardLede, CardTitle, PRIMARY_BUTTON } from "@/app/sign-in/ui";
import { auth } from "@/lib/auth";
import { clientIp } from "@/lib/client-ip";
import { currentUserId } from "@/lib/portal/access";
import {
  consumeSignInLink,
  isSafeRedirect,
  lookUpSignInLink,
  maskEmail,
  type SignInLinkProblem,
} from "@/lib/sign-in/links";
import { markPayingBrowser } from "@/lib/sign-in/paying-browser";

import { AutoSubmit } from "./AutoSubmit";
import { ContinueButton } from "./ContinueButton";

export const metadata: Metadata = {
  title: "Sign in to healdesk",
  // The token is in the URL: no referrer leaves this page.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /link/<token>: where every sign-in link lands (plan Part D1, design D4).
 *
 * The GET only looks: it shows whose sign-in this is and a "Continue" button,
 * and spends nothing, so the scanners mail providers run over every link in
 * an inbox sign nobody in. The POST spends the link and starts the session in
 * one request, then leaves for where the link was meant to land.
 */

const PROBLEMS: Record<SignInLinkProblem, { title: string; body: string }> = {
  used: {
    title: "This link has already been used.",
    body: "Each sign-in link works once. Ask for a new one and we'll email it to the clinic's address.",
  },
  expired: {
    title: "This link has expired.",
    body: "Sign-in links work for a short time. Ask for a new one and we'll email it to the clinic's address.",
  },
  unknown: {
    title: "This link isn't valid.",
    body: "It may have been copied incompletely. Ask for a new one and we'll email it to the clinic's address.",
  },
};

async function continueWithLink(formData: FormData): Promise<void> {
  "use server";
  const token = formData.get("token");
  const h = await headers();
  // The address our load balancer saw, not the chain's first entry, which
  // the browser writes (lib/client-ip.ts).
  const consumed = await consumeSignInLink(token, clientIp(h) ?? null);
  // Back to the GET, which says what went wrong. Outside any try: redirect()
  // works by throwing, and a catch-all would swallow it.
  if (!consumed.ok) redirect(`/link/${encodeURIComponent(String(token ?? ""))}`);
  await auth.api.startLinkSession({ body: { userId: consumed.userId }, headers: h });
  // The checkout link is spent only in the browser that paid (/welcome):
  // mark it, so its first passkey sends no device email (O3) and every other
  // browser's does (lib/sign-in/paying-browser.ts).
  markPayingBrowser(consumed, await cookies());
  redirect(isSafeRedirect(consumed.redirectTo) ? consumed.redirectTo : "/");
}

export default async function LinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await lookUpSignInLink(token);

  if (!link.ok) {
    // A link already spent, opened again in the browser it signed in: that is
    // someone coming back, not a problem.
    if (link.reason === "used" && (await currentUserId())) redirect("/");
    const problem = PROBLEMS[link.reason];
    return (
      <SignInShell>
        <CardBadge icon="link" />
        <div className="mt-5">
          <CardTitle small>{problem.title}</CardTitle>
        </div>
        <CardLede>{problem.body}</CardLede>
        <a href="/sign-in" className={`${PRIMARY_BUTTON} mt-8`}>
          Get a new sign-in link
        </a>
      </SignInShell>
    );
  }

  const formId = "continue-with-link";
  return (
    <SignInShell>
      <CardTitle>Sign in to healdesk</CardTitle>
      <CardLede>
        Continue as <strong className="text-ink font-semibold [overflow-wrap:anywhere]">{maskEmail(link.email)}</strong>.
      </CardLede>
      <form id={formId} action={continueWithLink} className="mt-8">
        <input type="hidden" name="token" value={token} />
        <ContinueButton />
      </form>
      {link.purpose === "checkout" ? <AutoSubmit formId={formId} /> : null}
    </SignInShell>
  );
}

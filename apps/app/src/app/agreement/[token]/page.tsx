import type { Metadata } from "next";

import { lookUpResignLink, type ResignClosedReason } from "@/lib/agreements/resign";

import { ResignStep } from "./ResignStep";

export const metadata: Metadata = {
  title: "Sign your updated agreement · healdesk",
  // The token is in the URL: no referrer leaves this page, and no index keeps it.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * /agreement/<token>: where L22's link lands (plan Part L; lib/agreements/
 * resign.ts). A practice under the Data Protection Agreement that now bills
 * insurance electronically, or is not sure, signs the Business Associate
 * Agreement here, with its own answers; so does a practice under an older
 * version of the Business Associate Agreement, the current version (wave 2
 * R11). That one never pauses AYA (owner, 19 October 2026), and the screen
 * says she keeps answering, as L22 does.
 *
 * On apps/app, not beside the funnel's signing on apps/web: the practice
 * exists, so this host is running, and everything the screen reads and writes
 * is here (the practice's answers, the open re-sign, the BAA register and the
 * supersede). Its link is composed from BETTER_AUTH_URL like every other
 * clinic-facing link.
 *
 * The GET only looks, so a mail scanner that follows every link signs
 * nothing; signing is the screen's action, once. No session is needed: the
 * link, mailed to the clinic's one address, is the proof, as a sign-in link
 * is.
 */

const PROBLEMS: Record<ResignClosedReason, { title: string; body: string }> = {
  signed: {
    title: "This agreement is signed.",
    body: "Your business associate agreement is in force. A copy is in Billing, under Your agreement.",
  },
  withdrawn: {
    title: "There's nothing to sign.",
    body: "Your data protection agreement stays in force, so this link isn't needed any more.",
  },
  expired: {
    title: "This link has expired.",
    body: "Sign in to healdesk and sign your updated agreement from Billing, under Your agreement.",
  },
  not_open: {
    title: "This agreement isn't open for signing yet.",
    body: "The agreement your practice signed stays in force, and AYA keeps answering under it. Nothing has been recorded.",
  },
  unknown: {
    title: "This link isn't valid.",
    body: "It may have been copied incompletely. Open it again from the email, or sign in to healdesk and sign it from Billing, under Your agreement.",
  },
};

export default async function ResignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await lookUpResignLink(token);

  if (!link.ok) {
    const problem = PROBLEMS[link.reason];
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold">{problem.title}</h1>
        <p className="text-muted mt-3">{problem.body}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-muted text-sm font-semibold">{link.clinicName}</p>
      <h1 className="mt-1 text-2xl font-semibold">Sign your updated agreement</h1>
      <p className="text-muted mt-3">
        {link.reason === "baa_version"
          ? `There's a newer version of your business associate agreement: version ${link.document.templateVersion}, in place of version ${link.replaces.version}, which your practice signed. An agreement only changes when you sign it.`
          : link.document.isCoveredEntity === true
            ? "Your practice bills health insurance electronically, so the business associate agreement covers it now, in place of the data protection agreement it signed."
            : "Your practice isn't sure whether it bills health insurance electronically, so the business associate agreement covers it now, in place of the data protection agreement it signed."}{" "}
        {link.holdsPause
          ? "AYA stays paused until it\u2019s signed."
          : "AYA keeps answering while you read it and sign it."}
      </p>
      <div className="mt-8">
        <ResignStep
          token={token}
          clinicName={link.clinicName}
          document={link.document}
          replaces={link.replaces}
          holdsPause={link.holdsPause}
        />
      </div>
      <p className="text-muted mt-10 text-center text-xs">
        No payment on this page · Your plan and your settings stay as they are
      </p>
    </main>
  );
}

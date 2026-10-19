import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { unsafeDb } from "@/db";
import { passkeyEnrolDecision } from "@/lib/factors/authority";
import { deviceKindFrom } from "@/lib/factors/device";
import { requirePortal } from "@/lib/portal/access";
import { portalNext, sessionBinding, stepUpPath } from "@/lib/portal/step-up";
import { isPayingBrowser, PAYING_BROWSER_COOKIE } from "@/lib/sign-in/paying-browser";

import { protectMode } from "./copy";
import { ProtectDevice } from "./ProtectDevice";

export const metadata: Metadata = {
  title: "Protect patient details",
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /c/<slug>/protect: "Protect patient details: use Face ID", the first screen
 * after /welcome (plan Part D3), and "Add this device" from anywhere else.
 *
 * Whether this session may add a passkey is decided by lib/factors
 * (authority.ts) and decided again when the passkey comes back; this page
 * only chooses what to show. The sign-in's first passkey, before go-live,
 * needs nothing more than the session, and so does the paying browser's
 * first ever, for its seven days. Any later one needs a step-up from a
 * device that has one (the step-up page offers the phone's QR flow), a code
 * from the authenticator app, or the human route's link, which lands here.
 * With no device to step up with, the page never sends the browser to the
 * step-up page, which would only send it back here.
 *
 * Skippable, with the plan's line: Conversations and Bookings stay shut until
 * a device is added.
 */
export default async function ProtectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const { next: rawNext } = await searchParams;
  const next = portalNext(portal.clinicSlug, typeof rawNext === "string" ? rawNext : null);
  const session = await sessionBinding(portal);
  if (!session) redirect(`/sign-in?next=${encodeURIComponent(`/c/${portal.clinicSlug}`)}`);

  const payingBrowser = isPayingBrowser(
    portal.userId,
    (await cookies()).get(PAYING_BROWSER_COOKIE)?.value,
  );
  const decision = await passkeyEnrolDecision(portal.userId, session.sessionTokenHash, unsafeDb, {
    payingBrowser,
  });
  const here = `/c/${portal.clinicSlug}/protect?next=${encodeURIComponent(next)}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <ProtectDevice
        slug={portal.clinicSlug}
        next={next}
        mode={protectMode(decision)}
        firstDevice={
          decision.allowed &&
          (decision.basis === "first_passkey" || decision.basis === "paying_browser")
        }
        recovery={decision.allowed && decision.basis === "recovery"}
        codeRoute={!decision.allowed && decision.codeRoute}
        initialDevice={deviceKindFrom({ userAgent: (await headers()).get("user-agent") })}
        stepUpHref={stepUpPath(portal.clinicSlug, here)}
      />
    </main>
  );
}

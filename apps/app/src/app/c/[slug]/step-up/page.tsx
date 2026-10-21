import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { unsafeDb } from "@/db";
import { activeFactors } from "@/lib/factors/authority";
import { deviceKindFrom } from "@/lib/factors/device";
import { findLiveStepUp } from "@/lib/factors/step-ups";
import { requirePortal } from "@/lib/portal/access";
import { portalAudience } from "@/lib/portal/audience";
import { portalNext, sessionBinding } from "@/lib/portal/step-up";

import { StepUpPrompt } from "./StepUpPrompt";

export const metadata: Metadata = {
  title: "Confirm it's you",
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * /c/<slug>/step-up?next=: where requireStepUp sends a page that needs a
 * passkey (plan Part D2). One button runs the passkey, and the browser offers
 * the phone's QR flow beside this device's own unlock. On success the step-up
 * is recorded for this session and the browser goes back to `next`, which
 * must be a path on this clinic's portal (portalNext).
 *
 * Arriving with a live step-up already (a second tab, a back button) goes
 * straight on; a sign-in with no passkey yet is sent to add one.
 */
export default async function StepUpPage({
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
  if (await findLiveStepUp(unsafeDb, session, { touch: false })) redirect(next);

  const { passkeys } = await activeFactors(portal.userId);
  const protectHref = `/c/${portal.clinicSlug}/protect?next=${encodeURIComponent(next)}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <StepUpPrompt
        slug={portal.clinicSlug}
        next={next}
        hasPasskey={passkeys > 0}
        protectHref={protectHref}
        initialDevice={deviceKindFrom({ userAgent: (await headers()).get("user-agent") })}
        audience={await portalAudience(portal)}
      />
    </main>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { WhatsAppConnect } from "@/app/channels/whatsapp/[token]/WhatsAppConnect";
import { env } from "@/lib/env";
import { GRAPH_VERSION } from "@/lib/meta/graph";
import { portalReturnUrl, surfaceOf } from "@/lib/meta/portal-return";
import { requirePortal } from "@/lib/portal/access";
import { loadPortalPage, shellProps } from "@/lib/portal/page";

import { PortalShell } from "../PortalShell";

export const metadata: Metadata = {
  title: "Connect WhatsApp · healdesk",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Connect (or reconnect) WhatsApp from inside the portal: Meta's Embedded
 * Signup, the same component the mailed link's page runs
 * (app/channels/whatsapp/[token]), told the clinic by its signed-in session
 * instead of a link. Set-up's channels step and Settings → Channels send the
 * clinic here with `?from=`, and the sign-up returns to whichever it was.
 *
 * The page says what Meta will ask for before the window opens, because the
 * step that stops clinics, adding a payment method to their WhatsApp account,
 * is better known beforehand (v1 spec, "Meta bot onboarding"). It shows no
 * patient. A first connect and a reconnect of the same number ask for no
 * step-up; swapping in a different number does (api/meta/whatsapp/route.ts).
 */
export default async function PortalWhatsAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { slug } = await params;
  const { from } = await searchParams;
  const portal = await requirePortal(slug);
  const page = await loadPortalPage(portal, new Date());
  if (!page) notFound();
  const shell = shellProps(portal, page, "settings");
  const surface = surfaceOf(Array.isArray(from) ? from[0] : from);
  const back = surface === "settings" ? `/c/${portal.clinicSlug}/settings#channels` : `/c/${portal.clinicSlug}/setup?s=channels`;

  const bought = page.state.channels.some((c) => c.channel === "meta");
  const appId = env.metaAppId();
  const configId = env.metaWhatsAppConfigId();
  const available = Boolean(bought && !page.state.clinic.offboardingStartedAt && appId && configId && env.metaAppSecret());

  return (
    <PortalShell {...shell}>
      <h1 className="text-2xl font-semibold">Connect WhatsApp</h1>
      <p className="text-muted mt-2 max-w-[58ch]">
        WhatsApp is set up in a window from Meta. Have these to hand:
      </p>
      <ul className="text-muted mt-3 list-disc space-y-1 pl-5">
        <li>The Facebook account that manages your business on Meta.</li>
        <li>The phone number you want patients to message, and that phone, to receive a verification code by text or call.</li>
        <li>
          A card to add to your WhatsApp account in Meta. <span className="text-ink font-semibold">Meta bills you directly</span>{" "}
          for WhatsApp messages, healdesk does not resell them, and your number cannot send a reply until a card is added.
        </li>
      </ul>
      <p className="text-muted mt-3 max-w-[58ch]">
        Use a number that is not already on the WhatsApp Business app on a phone. A number can only be on one WhatsApp
        platform at a time. Already connected? Signing up again replaces the old connection, and a different number asks
        for your passkey first.
      </p>

      <h2 className="mt-8 text-base font-semibold">What AYA is designed to do</h2>
      <ul className="text-muted mt-2 list-disc space-y-1 pl-5">
        <li>Reply to people who message your number, about your services, prices, hours and booking.</li>
        <li>Reply only within 24 hours of their message, and never message anyone first.</li>
        <li>Not discuss medical conditions: anyone who describes one is moved to a call, and that message is designed not to be kept.</li>
      </ul>

      {available && appId && configId ? (
        <WhatsAppConnect
          clinic={portal.clinicSlug}
          from={surface}
          returnTo={portalReturnUrl(portal.clinicSlug, surface, "whatsapp_connected")}
          appId={appId}
          configId={configId}
          graphVersion={GRAPH_VERSION}
        />
      ) : (
        <p className="border-line mt-8 rounded-xl border bg-white px-4 py-3 text-sm">
          Connecting WhatsApp isn&rsquo;t available here yet. Email hello@healdesk.io and we&rsquo;ll connect it with
          you.
        </p>
      )}
      <p className="mt-6 text-sm">
        <a href={back} className="font-semibold underline">
          {surface === "settings" ? "Back to Settings" : "Back to set-up"}
        </a>
      </p>
    </PortalShell>
  );
}

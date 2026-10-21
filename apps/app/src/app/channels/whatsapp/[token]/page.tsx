import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { resolveConnectionLink } from "@/lib/connections/links";
import { env } from "@/lib/env";
import { GRAPH_VERSION } from "@/lib/meta/graph";
import { clinicAudience } from "@/lib/portal/audience";

import { connectRequestContext } from "../../../connect/[token]/request-context";
import { ChannelFrame, Notice, Throttled } from "../../shared";
import { WhatsAppConnect } from "./WhatsAppConnect";

/**
 * Connect a clinic's WhatsApp number through Meta's Embedded Signup v4
 * (launch plan 2.5). The signup itself runs in Meta's window, opened by the
 * JavaScript SDK; this page explains what it will ask for before it starts,
 * because the step that stops clinics — attaching their own payment method in
 * Meta — is better known before the window opens than discovered inside it
 * (v1 spec, "Meta bot onboarding").
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect WhatsApp",
  description: "Let healdesk's assistant answer your WhatsApp messages.",
  robots: { index: false, follow: false },
};

export default async function WhatsAppChannelPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await connectRequestContext();

  if (!withinConnectAttemptLimit("open", token, request.ipAddress ?? null)) return <Throttled />;

  const link = await resolveConnectionLink(token, request, "whatsapp");
  if (!link) redirect("/channels/invalid");

  const appId = env.metaAppId();
  const configId = env.metaWhatsAppConfigId();
  const available = Boolean(appId && configId && env.metaAppSecret());
  // Who messages the number, in the clinic's word: a vet's are its clients.
  const audience = await clinicAudience(link.clinicId, {
    type: "service",
    serviceName: "whatsapp-link",
  });

  return (
    <ChannelFrame clinicName={link.clinicName} title="Let your assistant answer WhatsApp messages">
      <p className="mt-4 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        WhatsApp is set up in a window from Meta. Have these to hand:
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-[15px] text-[color:var(--color-muted)]">
        <li>The Facebook account that manages your business on Meta.</li>
        <li>The phone number you want {audience} to message, and that phone, to receive a verification code by text or call.</li>
        <li>
          A card to add to your WhatsApp account in Meta. <span className="font-semibold text-[color:var(--color-ink)]">Meta bills you directly</span>{" "}
          for WhatsApp messages, healdesk does not resell them, and your number cannot send a reply until a card is added.
        </li>
      </ul>
      <p className="mt-3 max-w-[58ch] text-[15px] text-[color:var(--color-muted)]">
        Use a number that is not already on the WhatsApp Business app on a phone. A number can only be on one WhatsApp
        platform at a time.
      </p>

      <h2 className="mt-8 text-base font-semibold">What the assistant will do</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[15px] text-[color:var(--color-muted)]">
        <li>Reply to people who message your number, about your services, prices, hours and booking.</li>
        <li>Reply only within 24 hours of their message. It sends no templates and never messages anyone first.</li>
        <li>Not discuss medical conditions. Anyone who describes one is asked to call the clinic, and that message is not kept.</li>
      </ul>

      {available && appId && configId ? (
        <WhatsAppConnect token={token} appId={appId} configId={configId} graphVersion={GRAPH_VERSION} />
      ) : (
        <Notice tone="info">
          Connecting WhatsApp isn&apos;t switched on yet. Nothing is wrong on your side; we&apos;ll let you know when it is.
        </Notice>
      )}
    </ChannelFrame>
  );
}

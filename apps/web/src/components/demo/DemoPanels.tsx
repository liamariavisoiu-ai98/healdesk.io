"use client";

import { useCallback, useRef } from "react";

import { AgentPanel } from "@/components/agent-panel/AgentPanel";
import { VoiceCard } from "@/components/agent-panel/VoiceCard";
import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { CloseCard, MobileActivateBar, useDemoClose } from "@/components/demo/DemoClose";
import { site } from "@/lib/site";

/**
 * The two demo cards of the redesigned close (lib/demo/close.ts): the same
 * voice agent and website chat as before, each with the close card under it
 * once a conversation there ends, and the mobile bar that appears once both
 * have scrolled away. The cards themselves are unchanged.
 */
export function DemoPanels({
  slug,
  logoUrl,
  avatarLogoUrl,
  greeting,
  chips,
  demoLine,
  prefillPhone,
  ringNote,
}: {
  slug: string;
  logoUrl: string | null;
  /** The logo for a 28-pixel chat avatar, or null for the initial (app/demo/[slug] `avatarLogo`). */
  avatarLogoUrl: string | null;
  greeting: string;
  chips: string[];
  demoLine: string | null;
  prefillPhone: string | null;
  /** Under "Have it ring your phone", in the clinic's own word for its people. */
  ringNote: string;
}) {
  const { clinicName, markEnded } = useDemoClose();
  // Stable, so the chat's quiet timer is not restarted by a render of the page.
  const voiceEnded = useCallback(() => markEnded("voice"), [markEnded]);
  const chatEnded = useCallback(() => markEnded("chat"), [markEnded]);

  return (
    <>
      <div className="mt-8 grid items-start gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          <AgentPanel label={`${site.agent} voice agent`} title="Your phone line" name={clinicName} logoUrl={logoUrl}>
            <VoiceCard
              name={clinicName}
              portraitLabel={`${site.agent} · ${clinicName}’s AI assistant`}
              callRoute={`/api/demo/${slug}/retell`}
              callerRoute={`/api/demo/${slug}/caller`}
              demoLine={demoLine}
              ringNote={ringNote}
              callbackExtra={{ demoSlug: slug }}
              prefillPhone={prefillPhone}
              // A call here starts with "What's your name?" so AYA can greet the owner by it.
              askName
              onCallEnded={voiceEnded}
            />
          </AgentPanel>
          <CloseCard channel="voice" />
        </div>
        <div className="min-w-0">
          <AgentPanel
            label={`${site.agent} chat`}
            title="Your website, WhatsApp, Instagram and Messenger"
            name={clinicName}
            logoUrl={logoUrl}
          >
            <ClinicChatPanel
              slug={slug}
              clinicName={clinicName}
              logoUrl={avatarLogoUrl}
              greeting={greeting}
              chips={chips}
              locked={false}
              onConversationEnded={chatEnded}
            />
          </AgentPanel>
          <CloseCard channel="chat" />
        </div>
      </div>
      <MobileBarAfterHere />
    </>
  );
}

/** The mobile bar, waiting for the visitor to scroll past this point. */
export function MobileBarAfterHere() {
  const end = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={end} aria-hidden className="h-px" />
      <MobileActivateBar after={end} />
    </>
  );
}

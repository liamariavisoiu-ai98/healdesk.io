"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { ClinicChatPanel } from "@/components/demo/ClinicChatPanel";
import { PhoneCallCard } from "@/components/demo/PhoneCallCard";
import { CHAT_SLOT_ID, SCRIPT_ID, VOICE_SLOT_ID } from "@/lib/demo/v2/slots";

/**
 * The real voice and chat cards, inside the owner's demo page
 * (lib/demo/v2): the file says "keep the repo's existing voice and chat cards
 * unchanged. This markup is a visual stand-in only", so its two stand-in card
 * bodies are slots (lib/demo/v2/render.ts) and these fill them. The voice
 * slot holds one way to talk, "Call Aya" in the browser (PhoneCallCard.tsx;
 * owner, 30 October 2026), not VoiceCard's three. The page's
 * markup is the server's and React does not own it, so the cards arrive
 * through portals once the slots are in the document.
 *
 * It also runs the page's own script (lib/demo/v2/render.ts), once, after
 * hydration: the script changes the page's markup, which React must have read
 * first.
 */
export function DemoV2Islands({
  slug,
  name,
  clinic,
  locked,
  logoUrl,
  greeting,
  chips,
}: {
  slug: string;
  name: string;
  /** The clinic's short name, as Aya's contact on the call screen. */
  clinic: string;
  locked: boolean;
  logoUrl: string | null;
  greeting: string;
  chips: string[];
}) {
  const [slots, setSlots] = useState<{ voice: HTMLElement; chat: HTMLElement } | null>(null);

  useEffect(() => {
    // Once per page load, even when React runs effects twice in development.
    const page = window as Window & { __HD_DEMO_RAN__?: boolean };
    const source = document.getElementById(SCRIPT_ID)?.textContent;
    if (page.__HD_DEMO_RAN__ || !source) return;
    page.__HD_DEMO_RAN__ = true;
    const run = document.createElement("script");
    run.textContent = source;
    document.body.appendChild(run);
  }, []);

  useEffect(() => {
    const voice = document.getElementById(VOICE_SLOT_ID);
    const chat = document.getElementById(CHAT_SLOT_ID);
    // The slots are in the server's markup, so they exist by the time this runs.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the portal targets are found once, at mount
    if (voice && chat) setSlots({ voice, chat });
  }, []);

  if (!slots) return null;
  return (
    <>
      {createPortal(
        <PhoneCallCard clinic={clinic} callRoute={`/api/demo/${slug}/retell`} locked={locked} />,
        slots.voice,
      )}
      {createPortal(
        <ClinicChatPanel slug={slug} clinicName={name} logoUrl={logoUrl} greeting={greeting} chips={chips} locked={locked} />,
        slots.chat,
      )}
    </>
  );
}

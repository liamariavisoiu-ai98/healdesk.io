"use client";

import { VoiceCard } from "@/components/agent-panel/VoiceCard";
import { site } from "@/lib/site";

/**
 * The phone half of the demo: talk to AYA from the browser, call her demo
 * line, or have her ring your phone.
 *
 * ## What it replaced
 *
 * Until 9 October 2026 this panel played a scripted example call, line by
 * line, beside the "call me" form. The owner asked for the homepage's cards
 * to look and work exactly like the personalised demo's ("Peachy"), so it is
 * now that page's voice card (components/agent-panel/VoiceCard.tsx) in AYA's
 * name: a live browser call to her (api/voice-demo/retell, her inbound agent,
 * the one on the demo line), the demo line itself, and the call-me form. Her
 * face is where a phone icon would be, and tells the call as it goes.
 *
 * ## What it may say
 *
 * That one consented demo call to a clinic owner is the only call anything
 * on healdesk ever places. The product is inbound only and never dials a
 * patient, so the card says so beside the form. The call runs on Retell, to
 * AYA's demo agent (lib/retell-demo-call.ts); the product's voice agent is a
 * separate Retell agent that only ever answers. The consent rules for the
 * form are in VoiceCard and lib/consent.ts.
 */
export function VoiceDemo() {
  return (
    <VoiceCard
      name={site.agent}
      idleTitle={false}
      aura="soul"
      callRoute="/api/voice-demo/retell"
      demoLine={site.demoLine.e164}
      ringNote="One demo call, because you asked. For your clinic she only answers: she never dials a patient."
    />
  );
}

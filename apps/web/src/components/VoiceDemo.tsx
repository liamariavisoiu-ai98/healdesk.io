"use client";

import { VoicePanel } from "@/components/agent-panel/VoicePanel";
import { site } from "@/lib/site";

/**
 * The phone half of the demo: talk to AYA from the browser, or have her ring
 * your phone.
 *
 * ## What it replaced
 *
 * Until 9 October 2026 this panel played a scripted example call, line by
 * line, beside the "call me" form. The owner asked for the homepage's cards
 * to look and work exactly like the personalised demo's, so it is now that
 * page's voice card (components/agent-panel/VoicePanel.tsx) in AYA's name: a
 * live browser call to her (api/voice-demo/retell, her inbound agent, the one
 * on the demo line), and the call-me form. The demo line itself is in the
 * line under the button.
 *
 * ## What it may say
 *
 * That one consented demo call to a clinic owner is the only call anything
 * on healdesk ever places. The product is inbound only and never dials a
 * patient, so the card says so beside the form. The call runs on Retell, to
 * AYA's demo agent (lib/retell-demo-call.ts); the product's voice agent is a
 * separate Retell agent that only ever answers. The consent rules for the
 * form are in VoicePanel and lib/consent.ts.
 */
export function VoiceDemo() {
  return (
    <VoicePanel
      name={site.agent}
      callRoute="/api/voice-demo/retell"
      intro={
        <>
          Talk to {site.agent} from your browser, the way a patient would, or call her on{" "}
          <a href={`tel:${site.demoLine.e164}`} className="text-ink font-semibold whitespace-nowrap underline underline-offset-2">
            {site.demoLine.display}
          </a>
          .
        </>
      }
      ringHeading="Or have her ring your phone."
      ringNote="One demo call, because you asked. For your clinic she only answers: she never dials a patient."
    />
  );
}

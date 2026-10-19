import { disclosureFor } from "@/lib/compliance/disclosure";

import type { AssistantChannel, AssistantFacts } from "./facts";

/**
 * The line a call or a web chat opens with: the locked AI line
 * (lib/compliance/disclosure.ts), which no greeting can replace or remove,
 * then the clinic's own greeting. One function for both adapters
 * (lib/voice/retell.ts says it first on every call, lib/chat/web-chat.ts
 * shows it first in every chat) and for the practice questions, which check
 * the line each channel actually opens with.
 */
export function openingLine(
  facts: Pick<AssistantFacts, "clinicName" | "greeting">,
  channel: AssistantChannel,
): string {
  return channel === "voice"
    ? `${disclosureFor({ clinicName: facts.clinicName, channel: "voice" })} ${facts.greeting.phone}`
    : `${disclosureFor({ clinicName: facts.clinicName, channel: "web_chat" })} ${facts.greeting.chat}`;
}

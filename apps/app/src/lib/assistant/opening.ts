import { disclosureFor } from "@/lib/compliance/disclosure";
import { log } from "@/lib/log";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";

import type { AssistantChannel, AssistantFacts } from "./facts";
import { guardGreeting } from "./guard";

/**
 * The line a call or a web chat opens with: the locked AI line
 * (lib/compliance/disclosure.ts), which no greeting can replace or remove,
 * then the clinic's own greeting. One function for both adapters
 * (lib/voice/retell.ts says it first on every call, lib/chat/web-chat.ts
 * shows it first in every chat) and for the practice questions, which check
 * the line each channel actually opens with.
 *
 * The greeting goes through the same guard as any reply (guard.ts,
 * guardGreeting): one the guard refuses is never said, and the default
 * greeting is said in its place. The clinic was told when it saved it; this
 * holds for one that a later change to its menu or never-say list has
 * made wrong, or one saved before the guard read greetings.
 */
export function openingLine(facts: GreetingFacts, channel: AssistantChannel): string {
  return channel === "voice"
    ? `${disclosureFor({ clinicName: facts.clinicName, channel: "voice" })} ${spokenGreeting(facts, channel)}`
    : `${disclosureFor({ clinicName: facts.clinicName, channel: "web_chat" })} ${spokenGreeting(facts, channel)}`;
}

type GreetingFacts = Pick<AssistantFacts, "clinicName" | "greeting" | "neverSay" | "services"> &
  Partial<Pick<AssistantFacts, "clinicId" | "address" | "requirements" | "providerNames">>;

/** The greeting the channel says after the AI line: the clinic's, or the default where the guard refuses it. */
export function spokenGreeting(facts: GreetingFacts, channel: AssistantChannel): string {
  const own = channel === "voice" ? facts.greeting.phone : facts.greeting.chat;
  const verdict = guardGreeting(own, facts);
  if (verdict.ok) return own;
  // The reason only: the greeting is the clinic's words, and the log is not the place for them.
  log.warn("clinic greeting refused by the guard; the default is said", {
    clinicId: facts.clinicId,
    channel,
    reason: verdict.reason,
  });
  return channel === "voice" ? defaultPhoneGreeting(facts.clinicName) : defaultChatGreeting();
}

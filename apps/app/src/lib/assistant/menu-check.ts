import { notifyOps } from "@/lib/ops/notify";

import type { AssistantChannel, AssistantFacts } from "./facts";

/**
 * Tell ops when a call or a website chat is answered while AYA knows no
 * service (facts.menu): she can then only offer a consultation, and a caller
 * asking what the practice does hears that she cannot say (the demo clinic's
 * test calls of 23 October 2026, whose clinic had never had its website
 * read). notifyOps keeps it to one email an hour per clinic and channel, so
 * a busy line is one alert, and it never throws or holds the conversation:
 * not awaited by the adapters.
 */
export function checkMenu(facts: Pick<AssistantFacts, "clinicId" | "services" | "menu">, channel: AssistantChannel): void {
  if (facts.services.length > 0) return;
  const code = facts.menu === "awaiting_approval" ? "awaiting_approval" : "none";
  void notifyOps("assistant_knows_no_services", { clinicId: facts.clinicId, channel, code });
}

import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "setup-and-support" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  setup_request_reply_past_due: {
    title: "A setup request is still waiting for our reply",
    whatHappened:
      "A clinic asked us to set up AYA[: {business}]. We promised to reply[ by {promisedOn}], and that day has passed. Nobody has sent a setup link or declined the request yet.",
    whyItMatters:
      "The clinic is waiting on a promise we made in writing. Every extra day without an answer makes it less likely to buy.",
    steps: [
      "Open the Setup requests list on the Queues page and find the request[ from {business}].",
      "Press Send setup link if the clinic is a fit for AYA. The clinic gets the link by email straight away.",
      "Press Decline if it is not a fit. Decline sends no email, so write to the clinic yourself from hello@ the same day.",
      "Check the request on the Queues page again. You are done when it shows Link sent or Declined.",
    ],
  },
  // Raised by the ops watch once per purchase: B3's day has passed in New
  // York and the order still has no account.
  provisioning_follow_up_past_due: legacy(
    "An order follow-up is past due",
    "We told a buyer we would email their sign-in link by a day that has now passed, and their account still does not exist. Email them today, then finish the order. The request id is the purchase's ref.",
  ),
  // Raised by the ops watch once per request: L25's day has passed in New
  // York with no reply marked in the console.
  support_reply_past_due: legacy(
    "A support reply is past due",
    "A support escalation from the portal is past the reply day we gave the practice, and no reply is marked. Reply to it from hello@ today, then mark it replied on the console's Support page. If you already replied, mark it there so this stops.",
  ),
  // lib/assistant/menu-check.ts, hourly per clinic and channel while it lasts.
  assistant_knows_no_services: legacy(
    "AYA is answering a clinic with no services",
    "A call or a website chat was just answered for this clinic while AYA knew no service or price, so she can only offer a consultation and cannot say what the practice does. Code none means Knowledge has no services: check the clinic has a website and ask for a site read from the console (or fill Knowledge in the portal). Code awaiting_approval means services are in Knowledge but the practice questions have not passed this version: check the practice-questions job is switched on and look at the clinic's latest run.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "provisioning_follow_up_past_due",
  "support_reply_past_due",
  "assistant_knows_no_services",
]);

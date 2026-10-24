import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

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
      "Press Send setup link if the clinic is a fit for AYA, and the clinic is emailed the link; once a link has gone the button reads Send a new link. If it is greyed out, setup links are not open yet or the requester unsubscribed: write to the clinic from hello@ instead.",
      "Press Decline if it is not a fit. Decline sends no email, so write to the clinic yourself from hello@ the same day.",
      "Check the request on the Queues page again. If the page says the email didn't send, check Resend, then send a new link. You are done when it shows Link sent, Declined, or you have written from hello@.",
    ],
  },
  // Raised by the ops watch once per purchase (lib/ops/watch.ts): B3's day
  // has passed in New York and the order still has no account. The purchase
  // ref is the only field, and it is not printed; the Home row "Paid orders
  // without an account" counts the order, and nothing in the console replays
  // the payment.
  provisioning_follow_up_past_due: {
    title: "An order's sign-in link is past the day we promised",
    whatHappened:
      "A clinic paid for AYA, but its account could not be created, so we emailed the buyer that their sign-in link would come by the next business day. That day has passed and the account still does not exist.",
    whyItMatters:
      "The buyer has paid and has heard nothing since the day we named in writing. Until the account exists nothing can be set up, and AYA cannot answer for them.",
    steps: [
      "Open the Home page and find the row that counts paid orders without an account: this order is one of them.",
      "Write to the buyer today from hello@, at the address on their payment in Stripe: say the account is still being set up and name the new day you will have it done by. Do not refund anything: the payment is safe and the order stands, and nothing on the Home page can undo it.",
      "Ask whoever maintains the engine to fix the cause named in the earlier alert about this order, the refused or parked payment, and to replay it. The Home page has no button for that step.",
      "Check the Home page again afterwards. You are done when the row no longer counts this order and the buyer has been emailed their sign-in link.",
    ],
  },
  // Raised by the ops watch once per request (lib/ops/watch.ts): L25's day
  // has passed in New York with no reply marked on Queues › Support.
  support_reply_past_due: {
    title: "A support request is still waiting for our reply",
    whatHappened:
      "{clinicName} asked for help through its portal's support chat. We told it a person would reply by the next business day, and that day has passed with no reply marked.",
    whyItMatters:
      "The clinic is waiting on a written promise. If the reply went out already, it only needs marking; if not, the clinic has been without help for a day or more.",
    steps: [
      "Open the Queues page, go to Support and find the request under Waiting for a reply: rows show the clinic's id, not its name, with the topic and the day we promised.",
      "Reply from hello@ to the escalation email that reached it, if nobody has. The Support list shows only the topic, never the chat's words, so ask the clinic to say again what it needs. Never ask for patient details.",
      "Press Mark replied beside the request on the Queues page once the reply has gone. It cannot be undone, so press it only for a reply that was sent.",
      "Check the request has left Waiting for a reply on the Queues page. You are done when it has.",
    ],
  },
  // lib/assistant/menu-check.ts, at most once an hour per clinic and channel
  // while it lasts. The services AYA knows are the Agent script card's
  // (agent_configs.services, read by readKnowledge), used only once the
  // practice questions have approved the script.
  assistant_knows_no_services: {
    title: "AYA is answering a clinic with no services to offer",
    whatHappened:
      "A call or website chat was just answered for {clinicName} while AYA knew no service or price. She can only offer a consultation, and a caller asking what the practice does hears that she cannot say.",
    whyItMatters:
      "Every answer until this is fixed sends people to a consultation instead of the services the clinic sells. You hear this at most once an hour, per channel, while the gap lasts.",
    steps: [
      "Open the clinic's Setup tab and read the Agent script card: it lists the services AYA may name, and its title says whether the script is approved.",
      "Open the Queues page and go to Site reads if the card lists no services: press Read it again for this clinic if it is listed there, and a successful read fills its setup from its website, services included. If it is not listed, the clinic adds its services on the Knowledge page of its portal, or you add them on the Agent script card and press Save script.",
      "Press Ask the practice questions again on the Channels card if services are listed but the script is not approved, and check the practice-questions row is on under the Jobs page. A run they flag waits for your decision under Reviews on the Queues page.",
      "Check the Setup tab again later. You are done when the Agent script card lists services and says approved, and this alert stops coming.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

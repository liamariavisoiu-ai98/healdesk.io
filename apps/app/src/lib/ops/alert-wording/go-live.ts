import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "go-live" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  practice_question_failed: legacy(
    "Practice questions failed",
    "The practice questions failed on a clinic's own data. Review the result before AYA answers that clinic's callers.",
  ),
  practice_question_review_past_due: legacy(
    "A practice-question review is past due",
    "A practice-question review is past the date we gave the clinic. Finish it today.",
  ),
  // The internal health flags (lib/ops/health-flags.ts): never shown to
  // the clinic. Once per clinic.
  no_interactions_48_hours: legacy(
    "A live clinic has been quiet for 48 hours",
    "No interactions on any channel for 48 hours after go-live. Something is wrong with the deployment, not with the clinic: check the clinic's forwarding and channels.",
  ),
  // Once per quiet stretch: conversationId, when present, is the last call
  // before it, so a later stretch raises again.
  no_inbound_calls_14_days: legacy(
    "No inbound calls for 14 days",
    "A live phone channel has had no inbound calls for 14 days. That is almost always forwarding that was set up, then removed or broken: check the clinic's call forwarding.",
  ),
  // Raised by the connect flow when Google's token endpoint refuses
  // healdesk's own client, and by the calendar watch, once per run, when its
  // checks meet the same refusal (code oauth_client, also when apps/app has
  // no client set) or Google says the Calendar API is disabled for the
  // project (code api_disabled): every clinic is affected until it is fixed.
  // Raised by the nightly retention purge for each clinic whose purge threw
  // (`phase` clinic, its id), and once when a run could not purge at all
  // (`phase` run). Ids and the step only; the error is in the worker's log.
  first_answer_not_recorded: legacy(
    "A channel's first answer was not recorded",
    "AYA answered a patient on the live channel below, but its first answer, and the plan start or price step-up that goes with it, could not be recorded, so billing for that channel has not begun. The conversation itself is recorded. The next answered conversation on the channel tries again; if this repeats, read the error lines for the first answer in apps/app's log and check the channel on the clinic's billing page in the console.",
  ),
  go_live_held: legacy(
    "A clinic is held back from going live",
    "The clinic below cannot go live, so AYA answers no one there yet, and nothing has been taken offline. The code is the first thing go-live waits on: platform means an attestation is missing on /admin/compliance; no_agreement, agreement_version, agreement_kind_mismatch or agreement_insufficient mean the practice's agreement has to be signed again or moved to a business associate agreement, so call the practice; gate_b means a channel still waits on its own attestations; gate_b_not_built means Gate B asks of the code what is not built yet (the routed/answered counter, its miss notice or a live email), which holds every clinic until it ships; database means the database refused what the console allowed, so read the error lines for go-live in apps/app's log. The clinic's onboarding page in the console lists everything go-live waits on; it goes live by itself once nothing is left.",
  ),
  web_widget_to_confirm: legacy(
    "Confirm a clinic's website chat is on its site",
    "The clinic below has website chat waiting on its line, and the chat was opened from what claims to be its website. A claim is not proof, so website chat stays off until you look: open the clinic's website and check the chat bubble is there (until you confirm, it tells visitors to call the practice), then press \"The line is on their website\" on the clinic's onboarding page in the console.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "practice_question_failed",
  "practice_question_review_past_due",
  "no_interactions_48_hours",
  "no_inbound_calls_14_days",
  "first_answer_not_recorded",
  "go_live_held",
  "web_widget_to_confirm",
]);

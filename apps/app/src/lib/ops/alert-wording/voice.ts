import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "voice" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  voice_fallback_no_direct_line: legacy(
    "A call had no direct line to pass through to",
    "AYA could not pass a call through because the clinic has no direct line set, so she answered it with the fixed safe script. Ask the clinic for a direct line that does not forward back to us.",
  ),
  voice_call_start_failed: legacy(
    "A call started while the database could not be read",
    "The voice endpoint could not read the clinic's settings when a call came in. The code says where the call went: transferred_gate, transferred_database, transferred_memory or transferred_retell sent it to the clinic's direct line (named by the answer gate before the failure, read on its own from a database that failed one query rather than hung, remembered from the clinic's last call, or read back from Retell), closed means no direct line was known and the caller heard the closing line, and hung_up that the call ended (the caller hung up, or the voice process shut down) before either. Check the database first; if it stays down, put Retell in outage mode (docs/on-call.md).",
  ),
  retell_fallback_unsynced: legacy(
    "A Retell fallback is not the direct line",
    "The hourly sync could not set the fallback number of the clinic's AYA number in Retell to its direct line. The code says why: duplicate (two clinics name the same AYA number, whose fallback is cleared; fix the wrong one in Ops), missing (Retell has no such number), not_kept (Retell answered but did not keep it, or failed while setting it), rejected, unreachable or database; key_refused (Retell refused HEALDESK_RETELL_API_KEY) and retell_unreachable (three numbers in a row timed out) stop the run for every clinic. Until it is fixed, outage mode and a voice task started during a database outage cannot send that clinic's calls to its direct line. Check the number in Retell's dashboard and HEALDESK_RETELL_API_KEY.",
  ),
  voice_provision_failed: legacy(
    "A clinic's Retell set-up stopped",
    "Setting up the clinic's Retell agent and AYA number stopped, and the code says why: not_implemented (the clinic is set to Retell's own engine, which is not built), no_voice (HEALDESK_RETELL_VOICE_ID is not set), config (the public origin or the line password is not usable), number_missing (the clinic's AYA number is not in this Retell workspace), unsupported_country (Retell sells US and Canadian numbers only), not_kept (Retell answered but did not keep a setting) or rejected (Retell refused the request). Phase sync means a settings change was not written to Retell. Fix the cause, then run retryVoiceAgent from Ops.",
  ),
  voice_provision_cap_reached: legacy(
    "The day's cap on AYA numbers is reached",
    "Provisioning has ordered as many AYA numbers from Retell today as HEALDESK_VOICE_PROVISION_DAILY_CAP allows, so the next clinics wait until midnight UTC, when they are set up on their own. If that many clinics really paid for voice today, raise the cap; if not, find out what ordered the numbers before anything else spends.",
  ),
  voice_agent_drift: legacy(
    "A clinic's Retell agent drifted",
    "The nightly read-back found the clinic's Retell agent or number different from what our code wrote, and the code names the first difference (storage, engine, webhook, voice, language, number_agent, number_outbound, fallback, agent_missing or number_missing). Status repaired means it was written again; flagged means it drifted again after three repairs, or the agent or number is gone, and is left for you: check who changes it in Retell's dashboard.",
  ),
  voice_deprovision_failed: legacy(
    "A departed clinic's Retell number was not released",
    "The clinic's service and its forwarding pass-through have ended, but releasing its AYA number or deleting its agent at Retell failed. Retell bills the number until it goes. The sweep tries again every hour; if it keeps failing, release the number and delete the agent in Retell's dashboard.",
  ),
  voice_direct_line_loops: legacy(
    "A clinic's direct line forwards back to AYA",
    "The clinic's direct line is the same as its published number or its AYA number, so a call put through to it would come straight back to AYA and never reach a person. Until it changes, AYA treats the clinic as having no direct line: a call she would pass through is answered with the fixed safe script, or closed where the Services have ended, and no call is transferred. The code is the answer gate's decision on the call that found it. Ask the clinic for a direct line that reaches a person and does not forward back to us, and check its published number.",
  ),
  voice_test_mode_refused: legacy(
    "A call was refused in voice test mode",
    "Real calls are off (HEALDESK_VOICE_REAL_CALLS), so the voice endpoint answers only the demo clinic, and it refused a call for the clinic below. Phase not_made_up means the clinic is not the demo clinic: its Retell agent or its call forwarding already points at the endpoint, which must not happen before every agreement in the chain is signed, so find out why and point it back. Phase check_failed means the endpoint could not tell within its start deadline whether the clinic is made up, usually because the database could not be read. The code says where the call went: transferred to the clinic's direct line, or closed with the closing line. Nothing of the call was kept.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "voice_fallback_no_direct_line",
  "voice_call_start_failed",
  "retell_fallback_unsynced",
  "voice_provision_failed",
  "voice_provision_cap_reached",
  "voice_agent_drift",
  "voice_deprovision_failed",
  "voice_direct_line_loops",
  "voice_test_mode_refused",
]);

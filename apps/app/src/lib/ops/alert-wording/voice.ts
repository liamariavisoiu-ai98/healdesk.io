import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "voice" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The answer gate (lib/billing/answering.ts voiceAnswerDecision), at most
  // once an hour per clinic and reason: a pass-through (paused, outside
  // coverage, over the allowance, not live, the service ended) with no
  // direct line. The runtime answers with the safe script, or closes the
  // call with the fixed line where the Services have ended.
  voice_fallback_no_direct_line: {
    title: "A call had no direct line to pass through to",
    headline: "A call to {clinicName} had nowhere to go: the clinic has no direct line",
    whatHappened:
      "A call to {clinicName} had nowhere to go, because the clinic has no direct line set. AYA was not meant to answer it: the assistant is paused, the call is outside the clinic's coverage, its allowance is used up, the subscription is unpaid or suspended, the phone channel is not live or is switched off, or no agreement covers the practice.",
    whyItMatters:
      "The caller heard AYA's safe script instead, which takes a message for the front desk and books nothing. Where the service has ended, the agreement no longer covers the practice, or a vendor's or our host's agreement has lapsed, the call was closed with a fixed line instead. Every such call misses a person until a direct line is set.",
    steps: [
      "Open the clinic's Billing tab and read Pause AI and the direct line: it shows whether AYA is paused and that no direct line is on file.",
      "Phone the clinic during its opening hours on its published number, shown under Phone line on its Setup tab, and ask for a line that reaches a person and does not forward back to AYA. Its published number will not do: it forwards to us. If AYA answers you, the clinic forwards every call: email it from hello@ instead.",
      "Press Save the direct line on the Billing tab after typing the number the clinic gave. From then on every call AYA does not answer goes there.",
      "Press Resume on the same Billing tab only if the clinic asks for AYA back on; a pause is the clinic's choice. You are done when the direct line is saved and this alert stops.",
    ],
  },
  // lib/voice/retell.ts, for a call whose start could not read the clinic's
  // settings: the code says where it went (transferred_gate,
  // transferred_database, transferred_memory, transferred_retell, closed,
  // hung_up). It is written to the ops log before it emails, so while the
  // database hangs it waits with it.
  voice_call_start_failed: {
    title: "A call came before AYA could read its settings",
    whatHappened:
      "A call came in for {clinicName} and the voice process could not read the clinic's settings in time. The caller was sent to the clinic's direct line where one was known, heard a closing line, or had hung up before either.",
    whyItMatters:
      "A patient calling the clinic has to reach someone. If the database stays down, every call to every clinic ends this way until it is back, or until Retell's outage mode sends calls to each clinic's direct line.",
    steps: [
      "Open the Jobs page under System. If it cannot load, or every recent run shows failed, the database is down and this is every clinic, not one.",
      "Check the clinic's direct line under Pause AI and the direct line on its Billing tab: with a line on file, a call that cannot start is sent there wherever the line can still be found.",
      "Turn outage mode on in Retell's dashboard, under its reliability settings, if the Jobs page still cannot load. By Retell's support material every call then goes to its number's fallback, the clinic's direct line, for every clinic until you turn it off; this has never been tested here, so ring one live clinic's published number and check you reach its direct line. Turn it off and make a test call once the database is back.",
      "Check the Jobs page shows runs passing again. You are done when calls start normally and outage mode is off.",
    ],
  },
  // The hourly sync (lib/voice/retell-fallback-sync.ts): a clinic's number
  // whose fallback could not be set (duplicate, missing, not_kept, rejected,
  // unreachable, database), or, with no clinic, a refused key (key_refused)
  // or three numbers in a row timing out (retell_unreachable), which stop
  // the run for every clinic. It has no row on the Jobs page.
  retell_fallback_unsynced: {
    title: "A Retell fallback number is not the direct line",
    whatHappened:
      "Every hour we set the fallback of each clinic's AYA number in Retell to the clinic's direct line. This hour that could not be done[ for {clinicName}]. Either Retell did not accept the change or did not answer, the number is not in Retell, two clinics name the same AYA number, or Retell refused our key.",
    whyItMatters:
      "Until it is fixed, Retell's outage mode and a call that cannot read the database cannot send that clinic's callers to its direct line. Those callers would hear a closing line instead.",
    steps: [
      "Open the clinic's Setup tab and check the assistant number under Phone line is the clinic's AYA number in Retell. If two clinics show the same number, correct the wrong one and press Save phone settings.",
      "Open Retell's dashboard and find that number: check it is in the workspace and that its fallback can be set to the direct line shown under Pause AI and the direct line on the clinic's Billing tab.",
      "Check Retell's status page first if the alert names no clinic: either Retell refused our key or three numbers in a row timed out, and nothing was set for any clinic this hour. Then open the Map page under System and press Missing or broken: the Retell key must be in place.",
      "Check the alert does not come again next hour. You are done when it stops, or when you have set the fallback in Retell's dashboard by hand to the direct line shown on the clinic's Billing tab.",
    ],
  },
  // lib/voice/provision.ts: a provisioning run that stopped with our reason
  // (not_implemented, no_voice, config, number_missing, unsupported_country,
  // not_kept, rejected), once a day per clinic and reason, or a changed
  // setting not written to Retell (phase sync). A failed run is retried only
  // by the ops operation retryVoiceAgent, which the console does not offer
  // yet.
  voice_provision_failed: {
    title: "A clinic's AYA phone set-up stopped",
    whatHappened:
      "Setting up the Retell agent and AYA number for {clinicName} stopped[ on {windowStart}][, at attempt {count}], or a changed setting could not be written to Retell. The usual causes: the clinic's own number is not a US or Canadian number, its AYA number is not in our Retell workspace, Retell refused or did not keep a setting, or a voice setting on our side is missing.",
    whyItMatters:
      "Until the set-up finishes, the clinic's phone channel cannot be switched on and no call reaches AYA. A failed set-up waits for a person: nothing retries it by itself. A changed setting that did not reach Retell is tried again every hour by itself.",
    steps: [
      "Open the Clinics page and read the Voice agent column for the clinic. If it shows ok, the set-up is done and only a changed setting failed to reach Retell: the hourly check retries it, so wait an hour and stop here unless the alert keeps coming. If it shows failed, the set-up stopped: go on.",
      "Check in Retell's dashboard that the clinic's AYA number is in the workspace and on its agent, and that the published number under Phone line on the Setup tab is a US or Canadian number.",
      "Open the Map page under System and press Missing or broken: the Retell key and the voice settings must all be in place.",
      "Ask whoever maintains the engine to run the set-up again once the cause is fixed; it runs from the engine by clinic id. The Setup tab has no retry button for it yet.",
      "Check the Voice agent column on the Clinics page afterwards. You are done when it shows ok and the alert has stopped.",
    ],
  },
  // lib/voice/provision.ts reserveOrder, once a day: as many numbers were
  // ordered today as HEALDESK_VOICE_PROVISION_DAILY_CAP allows; `count` is
  // the cap. The next clinics wait until midnight UTC.
  voice_provision_cap_reached: {
    title: "Today's cap on new AYA numbers is reached",
    whatHappened:
      "We have ordered as many AYA numbers from Retell[ on {windowStart}] as the daily cap allows[: {count:number}]. Clinics that still need one wait until midnight UTC, when their set-up runs again by itself.",
    whyItMatters:
      "If that many clinics really paid for voice today, the waiting clinics lose up to a day before their phone channel can be set up. If not, something ordered numbers it should not have, and Retell bills each one.",
    steps: [
      "Open the Clinics page and read the Voice agent column: count the clinics shown as not provisioned that bought voice today.",
      "Check the numbers bought today in Retell's dashboard against the count from the Clinics page. If Retell shows more numbers than clinics, stop and tell the owner before anything else is ordered.",
      "Ask the owner to raise the cap only if every number has a paying clinic: the cap is a deployment setting, not a switch on the Jobs page or anywhere else in the console.",
      "Check the Clinics page tomorrow. You are done when every clinic that bought voice shows ok in the Voice agent column.",
    ],
  },
  // The nightly read-back (lib/voice/provision.ts checkVoiceAgentDrift): the
  // first difference as a code (storage, engine, webhook, voice, language,
  // number_agent, number_outbound, fallback, agent_missing, number_missing);
  // status repaired, with the repair count, or flagged after three repairs
  // or a missing agent or number, when the clinic is left for a person and
  // the Clinics page shows drift.
  voice_agent_drift: {
    title: "A clinic's Retell agent differs from what we set",
    whatHappened:
      "The nightly read-back found the Retell agent or AYA number of {clinicName} different from what our code wrote: its voice, its language, where calls are sent, the fallback number, or the agent or number itself missing. Where it could, the code wrote the right settings again.[ Repairs so far: {count}.]",
    whyItMatters:
      "Settings changed in Retell by hand undo what the clinic chose, and a missing agent or number means its calls go nowhere. After three repairs, or when the agent or number is gone, the code stops repairing, leaves the clinic to you and skips it on later nights.",
    steps: [
      "Open the Clinics page and read the Voice agent column for the clinic: ok means the repair held; drift means it is flagged for a person, and the nightly check skips it from now on.",
      "Open Retell's dashboard and compare the clinic's agent and number with the settings under Phone line on its Setup tab: the assistant number must be on that agent, and nobody should change them in Retell by hand.",
      "Ask whoever has Retell access who changed it, and stop the change at its source. If the agent or number is gone from Retell, nothing recreates it by itself: tell the owner before a new number is bought, and note it in the Touch log on the clinic's Care tab.",
      "Ask whoever maintains the engine to clear the flag once Retell matches our settings again: nothing in the console clears it, and the Voice agent column shows drift until then. You are done when the column shows ok, or Retell matches again and the flag has been handed to whoever maintains the engine.",
    ],
  },
  // lib/voice/provision.ts deprovisionVoiceAgent, once a day per clinic: the
  // service and the pass-through have ended, and releasing the number or
  // deleting the agent at Retell failed. The hourly sweep tries again.
  voice_deprovision_failed: {
    title: "A departed clinic's AYA number was not released",
    whatHappened:
      "{clinicName} has left, and its forwarding pass-through has ended, so its AYA number should be released and its Retell agent deleted. That failed[ on {windowStart}]: Retell refused or did not answer.",
    whyItMatters:
      "Retell bills the number until it is released. The hourly check tries again by itself, so this alert matters when it keeps coming.",
    steps: [
      "Open the clinic's Care tab and read the Offboarding card: it shows the Retell step still outstanding and when the pass-through ended.",
      "Wait a few hours: the hourly check retries the release by itself, and a Retell outage clears without you. Even when it succeeds, the Retell step on the Offboarding card stays outstanding: recording it is yours, once the calls below are deleted too.",
      "Release the number and delete the agent in Retell's dashboard yourself if the alert comes again the next day, or check there that the retry has done it. Then delete every call Retell still holds for the clinic since its calls were first deleted, as the Offboarding card asks, and press Record Retell agent release there, saying how it was done.",
      "Check the Offboarding card shows the Retell step recorded. You are done when it does; the clinic's account closes only once this is recorded.",
    ],
  },
  // The answer gate, on any call that finds the clinic's direct line equal
  // to its published number or its AYA number (lib/billing/answering.ts),
  // at most once an hour per clinic and decision.
  voice_direct_line_loops: {
    title: "A clinic's direct line forwards back to AYA",
    whatHappened:
      "The direct line on file for {clinicName} is its own published number or its AYA number. A call passed through to it would come straight back to AYA and never reach a person. A call just came in that found this.",
    whyItMatters:
      "Until it changes, AYA treats the clinic as having no direct line: a call she cannot answer gets her safe script, or is closed with a fixed line where the service has ended, the agreement no longer covers the practice, or a vendor's or our host's agreement has lapsed. No call is transferred to a person.",
    steps: [
      "Open the clinic's Billing tab and read Pause AI and the direct line: the direct line shown is the one that loops.",
      "Open the clinic's Setup tab and compare it with the numbers under Phone line: the clinic's own published number and its assistant number. The direct line must be neither.",
      "Phone the clinic during its opening hours on its published number and ask for a line that reaches a person without forwarding to AYA, such as a back-office line or a mobile. If AYA answers you, the clinic forwards every call: email it from hello@ instead. Then press Save the direct line on the Billing tab with that number.",
      "Check Pause AI and the direct line shows the new number. You are done when it does and this alert stops coming.",
    ],
  },
  // lib/voice/retell.ts madeUpClinic, at most once an hour per clinic: real
  // calls are off (HEALDESK_VOICE_REAL_CALLS), the clinic is not the demo
  // clinic (phase not_made_up) or the check could not be read in time
  // (phase check_failed), and the caller was transferred or the call closed
  // (code). Nothing of the call was kept.
  voice_test_mode_refused: {
    title: "A call reached AYA while real calls are off",
    whatHappened:
      "Real calls are switched off, so the voice line answers only our demo clinic. A call for {clinicName} reached it anyway and was refused before AYA said a word: the caller heard one fixed line and was put through to the clinic's direct line, or heard the closing line and the call ended. Nothing of the call was kept.",
    whyItMatters:
      "A real clinic's calls must not reach the voice line before every agreement in the chain is signed and the owner switches real calls on. Either the check could not read the database in time, or this clinic's number or forwarding already points at us.",
    steps: [
      "Open the Jobs page under System and check it loads. If it cannot, the database was the problem and the clinic may be fine: the alert stops once the database is back, and the steps below can wait for the next call.",
      "Open the clinic's Setup tab and read Phone line: if an assistant number is set and the clinic has set up call forwarding, its calls are arriving at AYA before they should.",
      "Phone the clinic on its published number and ask it to remove the forwarding for now, using the codes under To undo on the Phone line card. Tell it we will say when its phone channel starts.",
      "Check in Retell's dashboard which agent the number shown under Phone line points at, and that nobody pointed it at the voice line by hand.",
      "Press Record in the Touch log on the clinic's Care tab to note what you found. You are done when the alert stops and the clinic has removed the forwarding.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

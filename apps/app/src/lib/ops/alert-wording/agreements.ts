import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "agreements" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The hourly re-sign job (lib/agreements/resign.ts), once per open re-sign
  // on its seventh day, for a re-sign whose old version is not below the
  // floor. Every re-sign but a version update pauses AYA (resignHoldsPause).
  agreement_unsigned_7_days: {
    title: "A clinic has not signed its updated agreement in 7 days",
    whatHappened:
      "{clinicName} was sent an updated agreement to sign seven days ago, with reminders since. Nobody at the clinic has signed it yet.",
    whyItMatters:
      "A version update never pauses AYA: she keeps answering under the version the clinic signed. A new agreement that came from a change in the practice's covered-entity answer does pause her until it is signed. Either way, email has not moved the clinic, so a person should phone.",
    steps: [
      "Open the Agreements register under Compliance and search for the clinic: its row shows the agreement in force and its version.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask it to sign from the email we sent or from the Billing page of its portal. The link is the clinic's own: never sign for it.",
      "Check Pause AI and the direct line on the clinic's Billing tab: if AYA is paused by the re-sign, tell the clinic she answers again the moment it signs. Do not press Resume for it.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the Agreements register shows the new version in force for the clinic.",
    ],
  },
  // openBaaVersionResign (lib/agreements/resign.ts), once per agreement: the
  // agreement in force is missing something the current version renders
  // from (clinicSignIn or baaResignDocument returned nothing), so no signing
  // link could be made. The hourly job asks again every hour.
  agreement_resign_unrenderable: {
    title: "An updated agreement could not be prepared for signing",
    whatHappened:
      "{clinicName} is on an older version of the business associate agreement and should be sent the current one to sign. Its agreement on record is missing something the new one is built from, such as the legal name, the booking system or the Google account, so no signing link could be prepared.",
    whyItMatters:
      "AYA keeps answering under the version the clinic signed, so nothing stops. But the clinic cannot move to the current version until the record is complete; the hourly check then sends the link by itself.",
    steps: [
      "Open the Agreements register under Compliance, search for the clinic and press Manage on its row to see the signed details and version.",
      "Find which detail is missing by comparing that row with what the current agreement needs: the practice's legal name, its booking system and the kind of Google account. There is no field in the Agreements register to correct it: ask whoever maintains the engine to fix the record.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and tell it an updated agreement will follow once our record is complete. Nothing changes for its patients meanwhile.",
      "Check the Agreements register the day after the fix. You are done when the clinic has signed the current version, or this alert has not come again and the clinic has its signing email.",
    ],
  },
  // The same hourly job, on the seventh day of a re-sign whose old version
  // go-live no longer accepts (fromVersionBelowFloor). AYA keeps answering
  // (owner, 19 October 2026); Home counts these clinics.
  agreement_below_floor_unsigned: {
    title: "A clinic is answering under a superseded agreement",
    whatHappened:
      "{clinicName} signed a version of the business associate agreement that go-live no longer accepts. We sent it the current version seven days ago, with reminders since, and it is still unsigned.",
    whyItMatters:
      "AYA keeps answering under the version the clinic signed, by the owner's decision, so nothing stops. The clinic must still move to the current version, and email has not moved it.",
    steps: [
      "Open the Agreements register under Compliance and search for the clinic to see which version it is on.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, and ask it to sign from the email or from the Billing page of its portal. Do not pause AYA for this: the signed version still covers the calls.",
      "Open the Home page: the row about accounts answering under a superseded agreement counts this clinic until it signs.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the Agreements register shows the current version in force for the clinic.",
    ],
  },
  // Raised by a recorded termination (lib/agreements/termination.ts) for each
  // location it could not start offboarding (phase offboarding), each
  // billing clinic it could not record a cancellation for (phase billing),
  // each billing clinic whose cancellation is recorded while the
  // billing-requests job is off (phase billing_job_off), and each location
  // whose billing pointer leads outside its practice (phase billing_pointer).
  // The termination itself is recorded, and the assistant has stopped. The
  // phase is not printed, so the steps cover each.
  agreement_termination_incomplete: {
    title: "A terminated practice's service did not fully end",
    whatHappened:
      "The agreement of the practice that includes {clinicName} was recorded as terminated, and AYA has stopped answering for it. One of the steps that follow did not finish for this clinic: starting its offboarding, or cancelling its subscription.",
    whyItMatters:
      "Until offboarding starts, the clinic's data has no destruction date. Until the subscription is cancelled, Stripe keeps billing a practice whose agreement has ended, and every ending must stop the fees on the day.",
    steps: [
      "Open the clinic's Care tab and read the Offboarding card. If it says the clinic is not offboarding, press Start offboarding and give the agreement's end as the reason.",
      "Open the clinic's Billing tab and read the Plan card. If the plan is not cancelled, cancel the subscription in Stripe's dashboard at once, without proration; do not wait for the hourly check.",
      "Open the Jobs page under System and check the billing requests row is on. If it is off, a recorded cancellation never reaches Stripe: press Turn on, or cancel in Stripe yourself.",
      "Check the Billing tab for a line saying this location is billed on another clinic. If that clinic is outside the practice, nothing was cancelled for it: find the subscription in Stripe by the practice's name and cancel it there, then ask whoever maintains the engine to correct the location's billing clinic. The Billing tab has no field for it.",
      "Check the Offboarding card shows offboarding started and Stripe shows the subscription cancelled. You are done when both are true.",
    ],
  },
  // Raised by the hourly reconcile per practice and step it finished: phase
  // offboarding, for the locations whose offboarding it started; phase
  // billing, for the billing clinics whose cancellation it recorded. It
  // names the organisation, not a clinic, so the alert has no link.
  agreement_termination_finished_late: {
    title: "A termination's last steps were finished late",
    whatHappened:
      "A practice's agreement was recorded as terminated, but one step never ran at the time. The hourly check has now finished it[ for {count:clinic}]: it started the offboarding that was owed, or recorded the subscription cancellation that was owed.",
    whyItMatters:
      "Between the termination and now, the practice may have been billed for days after its agreement ended, and its data kept with no destruction date. A period billed after the end is owed back.",
    steps: [
      "Open the Agreements register under Compliance, set Status to Terminated, inside the floor, and press Search: the practice whose agreement ended most recently is the one.",
      "Open the practice's clinic from the Clinics page and read the Plan card on its Billing tab for the day it was paid through.",
      "Check in Stripe, against the dates on the Billing tab, whether an invoice was paid for days after the termination date. If one was, the owner decides the refund: do not refund without the owner's word.",
      "Open the clinic's Care tab and read the Offboarding card: it should now show the service ended and the destruction date. You are done when it does and any refund has been decided.",
    ],
  },
  // apps/web held back a signer's copy at the checkout and told apps/app
  // (opAgreementCopyWithheld, lib/ops/api.ts): already_sent_today,
  // unsafe_text, daily_cap, send_failed or transport_unavailable. Before the
  // first paid invoice the agreement is only in the checkout records; the
  // register lists it once provisioning imports it.
  agreement_copy_withheld: {
    title: "A signer's copy of the agreement is still owed",
    whatHappened:
      "Someone signed the agreement at the checkout, and the copy we email the signer was held back. That happens when a copy already went to that address today, the names typed carry something we do not mail to an unconfirmed address, the day's limit on such copies is spent, or the email itself failed.",
    whyItMatters:
      "The signature stands, and the buyer was told the copy would follow. Until it does, only we hold the signed document, and an agreement binds two parties.",
    steps: [
      "Open the Agreements register under Compliance, set Copy sent to Never delivered and press Search. The row appears once the order is paid and the account created; until then the agreement sits in the checkout records only.",
      "Press Manage on the row, then Send copy: the copy goes to the address the signer gave, and the row then shows the day it was emailed.",
      "Write to the signer from hello@ if Send copy fails again, attaching the PDF from the row's PDF button on the Agreements register. Check the signer is genuine first: a copy to a stranger's address is why some are held back.",
      "Check the Copy sent column on the Agreements register. You are done when the row shows a date instead of Never.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

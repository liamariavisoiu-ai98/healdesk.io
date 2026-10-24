import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "vendors" section of docs/on-call.md's alert runbook. Since lane N3
 * the vendor (`code`, from the closed list in ./words.ts) and the expiry day
 * (`expiresOn`) print in the sentence when the alert carries them; the steps
 * still send the reader to the Compliance page, whose "Business associate
 * agreements in the chain" rows name the vendor, its standing and the day it
 * lapses (apps/web CompliancePanel.tsx). Attesting is
 * the owner's legal act (compliance/page.tsx), and so is opening an incident,
 * which starts a legal clock: the operator asks, never presses.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The vendors' agreements (lib/compliance/vendor-coverage.ts): `code` is the
  // vendor, `phase` 30_days or 7_days, `expiresOn` the recorded expiry.
  vendor_agreement_expiring: {
    title: "A vendor's business associate agreement expires soon",
    whatHappened:
      "Our business associate agreement with {code} has a recorded expiry[ of {expiresOn}], within 30 days, or within 7 days for the second warning. The Compliance page shows it under Business associate agreements in the chain.",
    whyItMatters:
      "When it lapses, AYA stops answering on every production clinic wherever that vendor serves: every channel for the model provider, the host and the database host; phone only for the voice provider. Calls go to each clinic's direct line until a renewal is recorded.",
    steps: [
      "Open the Compliance page and read Business associate agreements in the chain: the vendor whose row says until a day within the next 30 days is the one.",
      "Ask the owner for the renewed agreement: the document is the owner's, and the console only records it. Do not press Withdraw: that stops AYA at once wherever the vendor serves.",
      "Ask the owner to press Attest again on that vendor's row once the renewal is in hand, with where the document is kept, the day it took effect, the new day under Lapses on, and a fresh code from the authenticator. Do not attest it yourself.",
      "Check Business associate agreements in the chain. You are done when the row says Attested with the new expiry, before the old one passes.",
    ],
  },
  // `phase` withdrawn (recorded on /admin/compliance) or expired (`expiresOn`
  // passed with no renewal). The effects by vendor: lib/compliance/
  // vendor-coverage.ts and lib/billing/answering.ts (patientDataRefused,
  // assistantFallbackRefused).
  vendor_agreement_lapsed: {
    title: "A vendor's agreement lapsed: AYA has stopped there",
    whatHappened:
      "Our business associate agreement with {code} was withdrawn or passed its recorded expiry[ of {expiresOn}] with no renewal, so AYA has stopped answering wherever that vendor serves. The Compliance page marks it Lapsed or Withdrawn.",
    whyItMatters:
      "On every production clinic, calls go to its direct line wherever the vendor serves: every channel for the model provider, the host or the database host, and phone only for the voice provider. While the model provider is out, website chat is a contact form and Meta messages wait unanswered. While the host or database host is out, the contact form takes no message either. AYA answers again the moment a renewal is recorded.",
    steps: [
      "Open the Compliance page and read Business associate agreements in the chain: the vendor marked Lapsed or Withdrawn is the one, with its last recorded entry.",
      "Tell the owner at once, naming the vendor shown: every production clinic is affected until a renewal is recorded, and the renewal is the owner's document. Do not press Attest yourself.",
      "Ask the owner to press Attest on the vendor's row with where the renewal is kept, its effective day, its expiry under Lapses on, and a fresh code from the authenticator. AYA answers again as soon as it is recorded.",
      "Tell the owner that patient data may have gone to the vendor between the agreement's real end and this stop. The owner decides whether to open an incident with Open incident and start the clock on each affected production clinic's Care tab. Do not open one yourself.",
      "Check Business associate agreements in the chain. You are done when the vendor's row says Attested and the owner has decided about the incident.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

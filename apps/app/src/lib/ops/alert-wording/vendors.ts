import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "vendors" section of docs/on-call.md's alert runbook. Neither the vendor
 * (`code`) nor the expiry day (`expiresOn`) is printable in an alert under
 * the allow-list, so each step sends the reader to the Compliance page, whose
 * "Business associate agreements in the chain" rows name the vendor, its
 * standing and the day it lapses (apps/web CompliancePanel.tsx).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The vendors' agreements (lib/compliance/vendor-coverage.ts): `code` is the
  // vendor, `phase` 30_days or 7_days, `expiresOn` the recorded expiry.
  vendor_agreement_expiring: {
    title: "A vendor's business associate agreement expires soon",
    whatHappened:
      "One of the vendors in our chain has a business associate agreement whose recorded expiry is within 30 days, or within 7 days for the second warning. The Compliance page shows which vendor, under Business associate agreements in the chain, with the day it lapses.",
    whyItMatters:
      "When it lapses, AYA stops answering wherever that vendor serves: every channel for the model provider, the host and the database host; phone for the voice provider. Calls go to each clinic's direct line until a renewal is recorded.",
    steps: [
      "Open the Compliance page and read Business associate agreements in the chain: the vendor whose row says until a day within the next 30 days is the one.",
      "Ask the owner for the renewed agreement: the document is the owner's, and the console only records it. Do not press Withdraw: that stops AYA at once wherever the vendor serves.",
      "Press Attest again on that vendor's row once the renewal is in hand, with where the document is kept, the day it took effect, the new day under Lapses on, and a fresh code from your authenticator.",
      "Check Business associate agreements in the chain. You are done when the row says Attested with the new expiry, before the old one passes.",
    ],
  },
  // `phase` withdrawn (recorded on /admin/compliance) or expired (`expiresOn`
  // passed with no renewal).
  vendor_agreement_lapsed: {
    title: "A vendor's agreement lapsed: AYA has stopped there",
    whatHappened:
      "One of the vendors in our chain has a business associate agreement that was withdrawn or passed its recorded expiry with no renewal, so AYA has stopped answering wherever that vendor serves. The Compliance page shows which vendor, marked Lapsed or Withdrawn.",
    whyItMatters:
      "Calls go to each clinic's direct line, website chat is a contact form, and Meta messages wait unanswered. Patient data may have reached the vendor between the agreement's real end and this stop, which is an incident to open. AYA answers again the moment a renewal is recorded.",
    steps: [
      "Open the Compliance page and read Business associate agreements in the chain: the vendor marked Lapsed or Withdrawn is the one, with its last recorded entry.",
      "Ask the owner for the renewed agreement now: every production clinic is affected until it is recorded. Do not press Attest without the document in hand.",
      "Press Attest on the vendor's row with where the renewal is kept, its effective day, its expiry under Lapses on, and a fresh code from your authenticator. AYA answers again as soon as it is recorded.",
      "Open an incident from one affected production clinic's Care tab with Open incident and start the clock, in ids and counts, saying patient data may have gone to the vendor after its agreement ended. The owner decides on the Incidents page whether to report it.",
      "Check Business associate agreements in the chain. You are done when the vendor's row says Attested and the incident is open.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

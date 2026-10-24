import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "availability" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/clinic/change-events.ts, from the minute sweep, once per clinic and
  // kind an hour. The steps name the Setup tab's "Availability changes" card
  // (lane A3): "Run audit now" and "Mark as seen". The alert's link lands on
  // that card.
  clinic_availability_changed: {
    title: "A clinic changed when or with whom AYA books",
    whatHappened:
      "{clinicName} changed its {section}[, {count:change} in all].[ It added {written:closed day}.][ It took off {deleted:closed day}.] AYA uses the change for bookings straight away.",
    whyItMatters:
      "Most changes come from the clinic's own portal and need nothing from us. A change nobody at the clinic made could send patients to the wrong times. An audit checks each change while audits are switched on; the card says when they are off.",
    steps: [
      "Open the clinic's Setup tab and find the change under Availability changes: it says who made it (the clinic, ops, a change file or outside the portal) and how its audit went.",
      "Press Mark as seen beside the change if the clinic made it and the audit passed, or audits are off. Nothing else is owed.",
      "Press Run audit now on the Availability changes card if the audit needs attention, could not run, or is still waiting. It runs every pack at once; a second press within a minute is refused.",
      "Phone the clinic on its published number, shown under Phone line on the Setup tab, if the change was made outside the portal or by nobody you expected. Ask whether they made it.",
      "Press Mark as seen once you have the answer. You are done when every change on the Availability changes card shows seen, or you have told the owner a change was not the clinic's.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

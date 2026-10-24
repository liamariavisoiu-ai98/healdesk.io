import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "availability" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/clinic/change-events.ts, from the minute sweep, once per clinic and
  // kind an hour.
  // Today's true steps use the Touch log. Lane A3 is adding the Availability
  // changes card's own controls; lane N2 swaps them in once they exist.
  clinic_availability_changed: {
    title: "A clinic changed when or with whom AYA books",
    whatHappened:
      "{clinicName} changed its {section}[, {count:change} in all].[ It added {written:closed day}.][ It took off {deleted:closed day}.] AYA uses the change for bookings straight away.",
    whyItMatters:
      "Most changes come from the clinic's own portal and need nothing from us. A change nobody at the clinic made could send patients to the wrong times.",
    steps: [
      "Open the clinic's Care tab and look in the Touch log for a request from the clinic to make this change.",
      "Stop here if the Touch log shows the clinic asked for it, or it matches what the clinic told you.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if nobody expected the change. Ask whether they made it.",
      "Press Record in the Touch log on the Care tab to note the answer. You are done when the clinic confirms the change, or you have told the owner it was not theirs.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

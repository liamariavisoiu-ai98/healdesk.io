import type { OpsEvent } from "@/lib/ops/notify";

import { legacy, type AlertWording } from "./types";

/** The "usage" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  meter_report_failing: legacy(
    "Usage is not reaching Stripe's meters",
    "Overage on monthly plans keeps failing to report. Usage reported after an invoice is finalised is never billed, so check the Stripe key and the meters today.",
  ),
  // The usage alerts job (lib/billing/usage-alerts.ts), once per clinic,
  // meter and window, whatever the clinic's own switch says.
  usage_near_cap: {
    title: "A clinic is close to its monthly allowance",
    whatHappened:
      "{clinicName} has used {percent} of the {meter} its plan includes this month[: {used} of {included}][, counted since {windowStart}].",
    whyItMatters:
      "When the allowance runs out, the clinic either pays for extra blocks of 100 or AYA stops answering and sends people to the clinic itself. The clinic chose which. Moving up one step always costs it less than an extra block.",
    steps: [
      "Open the clinic's Billing tab and read Usage and the allowance to see when this month's window ends.",
      "Check the At the allowance setting on the same tab, so you know what happens at the limit. Leave it as the clinic set it.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if it will likely run out before the window ends. Offer to move it up one step.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has chosen to move up or to stay as it is.",
    ],
  },
  usage_cap_reached: legacy(
    "A clinic has used its whole allowance",
    "The clinic below has used all of the allowance on the meter shown, in its current window. What happens next is its own setting on its Billing page: extra blocks of 100 are billed, or, with Stop and fall back, AYA stops on that meter and calls go to its direct line. Check which, and call the clinic if a step up would serve it better.",
  ),
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>([
  "meter_report_failing",
  "usage_cap_reached",
]);

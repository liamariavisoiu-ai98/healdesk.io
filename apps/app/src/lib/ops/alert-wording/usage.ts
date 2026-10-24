import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "usage" section of docs/on-call.md's alert runbook. The Touch log's
 * Record button shows for every clinic until its account is closed (lane
 * N3; apps/web TouchLog.tsx, lib/ops/health.ts touchRefusal).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/billing/usage-report.ts, once per clinic and run: `count` overage
  // events of the clinic's have failed to reach Stripe's meters three times
  // or more. Only on monthly plans with overage billed, and only while the
  // rates are not provisional (the job reports nothing while they are).
  meter_report_failing: {
    title: "Usage is not reaching Stripe's meters",
    whatHappened:
      "{clinicName}'s usage above its allowance is not being reported to Stripe[: {count:report} failed three times or more]. Stripe bills overage only from what it is told.",
    whyItMatters:
      "Usage reported after an invoice is finalised is never billed, so every report that misses the clinic's billing period is usage the clinic is never charged for.",
    steps: [
      "Open the clinic's Billing tab and read Usage and the allowance: the Window column says when the current period ends, which is the deadline, and Over shows what should be billed.",
      "Open the Jobs page under System and read the result and note on the usage-meter-report row: the note counts what was reported and what failed this run.",
      "Check the Map page under System: the row Stripe key (engine) must read In place on the AWS host. Tell the owner today if it does not, or if the Jobs page keeps showing failures; the fix is on our side, not the clinic's.",
      "Check the Jobs page after the next run. You are done when its note shows nothing failed before the clinic's period ends.",
    ],
  },
  // The usage alerts job (lib/billing/usage-alerts.ts), once per clinic,
  // meter and window, whatever the clinic's own switch says. At the
  // allowance is `allow` by default (db/schema.ts entitlements.overageMode).
  usage_near_cap: {
    title: "A clinic is close to its monthly allowance",
    headline: "{clinicName} has used {percent} of its {meter} for this billing period",
    whatHappened:
      "{clinicName} has used {percent} of the {meter} its plan includes for this billing period[: {used} of {included}][, counted since {windowStart}].",
    whyItMatters:
      "When the allowance runs out, the clinic either pays for extra blocks of 100 or AYA stops answering and sends people to the clinic itself. The clinic's At the allowance setting decides which; it starts as Keep going and bill the extra. Moving up one step always costs it less than an extra block.",
    steps: [
      "Open the clinic's Billing tab and read Usage and the allowance to see when this billing period ends.",
      "Check the At the allowance setting on the same tab, so you know what happens at the limit. Leave it as the clinic set it.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if it will likely run out before the period ends. Offer to move it up one step.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has chosen to move up or to stay as it is.",
    ],
  },
  // The same job, at 100% of the meter. What happens next is the clinic's At
  // the allowance setting: `allow` bills started blocks of 100; `hard_cap`
  // passes every new call or message through (lib/billing/answering.ts),
  // and the clinic is emailed that AYA stopped (allowance_fallback).
  usage_cap_reached: {
    title: "A clinic has used its whole monthly allowance",
    whatHappened:
      "{clinicName} has used all of the {meter} its plan includes for this billing period[: {used} of {included}][, counted since {windowStart}].",
    whyItMatters:
      "What happens now is the clinic's At the allowance setting, which starts as Keep going and bill the extra. With Keep going and bill the extra, each started block of 100 is billed at the block price. With Stop and fall back, AYA stops on that meter: calls go to the clinic's direct line, website chat becomes a contact form, Meta messages wait for staff, and the clinic is emailed that AYA stopped. Moving up one step always costs less than an extra block.",
    steps: [
      "Open the clinic's Billing tab and read At the allowance under Usage and the allowance, so you know which of the two is happening. Leave it as the clinic set it.",
      "Phone the clinic on its published number, shown under Phone line on its Setup tab, if it is on Stop and fall back, or if the extra blocks will cost more than the next step. Offer to move it up one step.",
      "Press Record in the Touch log on the clinic's Care tab to note the call. You are done when the clinic has chosen to move up, to pay for the extra, or to stay stopped until the period ends.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

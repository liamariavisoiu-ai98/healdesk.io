import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "morning-digest" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // The 07:00 digest's line in Slack (lib/ops/digest.ts), posted once the
  // digest email has gone, never emailed itself. Counts only, no clinic: its
  // link opens the Clinics page. The decisions owed are lifecycleView's
  // decisionOwed, which counts a clinic waiting on us a business day or
  // more; the allowance counts sum both meters, so one clinic can count
  // twice. The Slack clause is optional: it drops once the digest passes the
  // count only when it is above zero.
  ops_digest_summary: {
    title: "Morning digest: what needs a person today",
    whatHappened:
      "The morning digest email went to the ops address. Today it counts {decisionsOwedCount:setup decision} owed, {waitingOnUsCount:clinic} waiting on us, {nearCapCount:clinic} close to the monthly allowance, and {atCapCount:clinic} with the whole allowance used. A clinic waiting on us a business day or more counts as a decision owed; voice and chat are counted apart.[ Alerts Slack could not post: {slackUnpostedCount}.]",
    whyItMatters:
      "These are the counts that need a person today, in one place. Each decision owed, and each alert of the last day, is a row on the Home page.",
    steps: [
      "Open the Home page: the last day's alerts are rows there, one per alert and clinic, whether or not Slack took them, each with a button that opens the clinic. Each setup decision owed is a row too, with a Decide button.",
      "Open the Clinics page for the rest: each clinic's row shows its stage, such as the day of setup, its channels and its usage, and each cell opens the right tab.",
      "Decide each setup decision owed on the clinic's Setup tab, on the Setup window card: it shows what we suggest and the buttons to record your decision.",
      "Fix our side for each clinic waiting on us: the Channels card and the Go live card on its Setup tab list what is missing.",
      "Check Usage and the allowance on the Billing tab of each clinic close to or at its allowance, and phone it if a step up would serve it better. You are done when each count above has been looked at.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

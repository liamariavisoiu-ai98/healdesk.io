import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/** The "availability" section of docs/on-call.md's alert runbook. */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/clinic/change-events.ts, from the minute sweep, once per clinic and
  // kind an hour. The steps name the Setup tab's "Availability changes" card
  // (lane A3): "Run audit now" and "Mark as seen". The alert's link lands on
  // that card. The change may be ops', a change file's or a direct edit's,
  // not the clinic's, so the sentence names the clinic as the owner of what
  // changed, never as who changed it. For closed days the raise site sends
  // both counts whatever they are, so they share one clause that reads with
  // a zero.
  clinic_availability_changed: {
    title: "A clinic's booking hours or providers changed",
    headline: "{clinicName}'s {section} changed[, {count:change} in all]",
    whatHappened:
      "{clinicName}'s {section} changed[, {count:change} in all].[ {written:closed day} added.][ {deleted:closed day} taken off.] AYA uses the change for bookings straight away.",
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

/**
 * clinic_availability_changed raised for a settings change (`section`
 * setting; lib/clinic/change-events.ts settingAlertFields; owner, 28 October
 * 2026): one alert per change, by email and in Slack, whoever made it. Read
 * by ./index.ts alertWording in place of the availability wording, as the
 * dead letter replaces critical_notice_undelivered's. Its placeholders are
 * SETTING_FIELDS, every one a closed word.
 */
export const SETTING_FIELDS = ["clinicId", "section", "setting", "before", "after", "actor"] as const;

export const SETTING_CHANGED: AlertWording = {
  title: "A clinic's setting changed",
  headline: "{clinicName}'s {setting} setting changed[ from {before} to {after}]",
  whatHappened:
    "{clinicName}'s {setting} setting changed[ from {before} to {after}][, by {actor}]. It applies straight away.",
  whyItMatters:
    "Most changes are the clinic's own and need nothing from us. A change nobody expected could change how AYA answers, books or asks for payment.",
  steps: [
    "Open the clinic's Setup tab and check the setting named above: the tab shows it as it is now.",
    "Leave it as it is if the clinic or a colleague made the change, as the Setup tab shows. Nothing else is owed.",
    "Phone the clinic on its published number, shown under Phone line on the Setup tab, if nobody you expected made it, and ask whether they did before you change it back.",
  ],
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "incidents" section of docs/on-call.md's alert runbook. An incident is
 * opened, notified and resolved on the clinic's Care tab (apps/web
 * CarePanel.tsx) and decided, report or not reportable, on the Incidents
 * page under Compliance (IncidentsBoard.tsx).
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // Raised once per incident by the hourly incident-deadlines job, with the
  // clinic's and the incident's ids. The 24 hours are healdesk's own target
  // (lib/incidents), never a promise; the agreement's deadline is later.
  incident_notice_overdue: {
    title: "An incident has passed our 24-hour notice target",
    whatHappened:
      "An incident is open for {clinicName}, and our own target of telling the practice within 24 hours of discovery has passed with no notice recorded. The agreement's own deadline is later and is shown beside the incident; our target is internal and never a promise.",
    whyItMatters:
      "A notice left past our target slides towards the agreement's deadline, which is a promise. Deciding now, report or not reportable, keeps the record straight.",
    steps: [
      "Open the clinic's Care tab and read Incidents: the incident shows our internal target as passed, the agreement's deadline, and whether the clinic has been told.",
      "Open the Incidents page under Compliance and find the incident. Press Send report to email the practice a report built from fixed fields, which names no one; or press Not reportable and record why, in ids and counts.",
      "Press Record clinic notified under Incidents on the Care tab if the practice was told another way, such as by phone, saying who and how, with no patient detail.",
      "Check Incidents on the clinic's Care tab. You are done when it shows the report sent, the incident recorded as not reportable, or the clinic told.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

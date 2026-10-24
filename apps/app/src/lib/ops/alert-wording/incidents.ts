import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "incidents" section of docs/on-call.md's alert runbook. An incident is
 * opened, notified and resolved on the clinic's Care tab (apps/web
 * CarePanel.tsx) and decided on the Incidents page under Compliance
 * (IncidentsBoard.tsx). The decision is the owner's: Send report emails the
 * practice and cannot be taken back, and Not reportable records a legal
 * finding; a phone call recorded with Record clinic notified leaves the
 * Decision reading Waiting.
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
      "Ask the owner to decide it today on the Incidents page under Compliance. Send report emails the practice a report built from fixed fields and cannot be taken back; Not reportable records a legal finding with its reason. Do not press either yourself.",
      "Press Record clinic notified under Incidents on the Care tab only for a notice actually given to the practice, saying who and how, with no patient detail. A phone call does not replace the report: the decision still reads Waiting until the owner decides.",
      "Check Incidents on the clinic's Care tab. You are done when it shows Report sent, or Not reportable recorded by the owner.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

import type { OpsEvent } from "@/lib/ops/notify";

import type { AlertWording } from "./types";

/**
 * The "incident-assistant" section of docs/on-call.md's alert runbook (ops
 * automation Phase 6, lane P6i): the incident assistant's two kinds of item
 * in the approval inbox, an incident opened at each clinic a vendor's or a
 * channel's incident reached, and one practice's incident report.
 *
 * The items are decided on the Incidents page under Compliance, where lane
 * P6j adds the assistant's section ("Incident assistant") to the existing
 * page, with Approve and Reject behind the field "Code from your
 * authenticator". Until P6j lands, apps/web reads the items
 * (lib/admin/ops-client.ts fetchIncidentApprovals) but no screen draws them:
 * P6j must draw them before this wording, which sends the owner to the
 * Incidents page, is true. Raised by lib/approvals/incident-sweep.ts from the
 * hourly incident-deadlines job (seeded on) and from approvals-propose.
 */
export const WORDING: Partial<Record<OpsEvent, AlertWording>> = {
  // lib/approvals/proposers.ts remind, once per kind, for the two incident
  // kinds (lib/approvals/incident-kinds.ts waitingAlertEvent): on arrival
  // and every 4 hours while an item waits (owner decision D18). Raised with
  // the kind and how many items are due a reminder, and no clinic. `kind` is
  // not printable, so the wording names both kinds.
  incident_step_waiting: {
    title: "An incident step is waiting for your yes",
    headline: "{count:incident step} waiting for your yes: an agreement's clock is running",
    whatHappened:
      "{count:incident step} waiting for your yes: an agreement's clock is running. Each is either opening an incident at every clinic a vendor's or one of our channels' incident reached, or sending one practice its incident report, built only from fixed choices. Nothing is opened or sent until you approve it, and nothing is approved, sent or closed by waiting. This alert comes at the first hourly check after an item arrives, then again at the first hourly check 4 hours or more after the last one, for as long as one waits.",
    whyItMatters:
      "Each practice's agreement promises it notice by a deadline, shown beside each report. Our own target, 24 hours from discovery, is internal and never quoted to a practice. A report still waiting at the agreement's deadline breaks that promise.",
    steps: [
      "Open the Incidents page under Compliance and read each waiting item: the clinics or the incident, both deadlines, and what approving does.",
      "Check each choice in a report on the Incidents page: what happened, the dates, the information involved with its counts, what we did, what the people affected can do and what we recommend. Change one only by picking from its list.",
      "Press Approve and enter the code from your authenticator. An incident is opened once at each clinic, never twice; a report is emailed to the practice's address once.",
      "Phone the practice once its report has gone, then tick each step you have done on the incident's checklist on the Incidents page. The call repeats the report; it does not replace it.",
      "Press Reject, with a reason and the code, only if the item should not run. Nothing is opened or sent, and the agreement's clock keeps running. Not reportable stays its own button on the Incidents page.",
      "Check the Incidents page. You are done when no incident step is waiting and each report reads sent.",
    ],
  },
};

/** This section's events still in their pre-rewrite wording (LEGACY_WORDING, ./index.ts). */
export const LEGACY: ReadonlySet<OpsEvent> = new Set<OpsEvent>();

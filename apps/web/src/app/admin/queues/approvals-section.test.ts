// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  BILLING_TAB_RETRY,
  DRAFT_HEADING,
  EDIT_WORDS,
  EMPTY_JOB_OFF,
  EMPTY_WORDS,
  FACTS_NOT_READ,
  FAMILY_WORDS,
  IRREVERSIBLE_CONFIRM,
  NO_CLINIC_EVENT,
  NO_LONGER_NEEDED,
  REJECT_HEAD,
  REMINDER_FIXED_WORDS,
  rejectConfirm,
  whenWords,
} from "@/components/admin/approval-words";
import { AGREEMENT_DEADLINE_LABEL, INTERNAL_TARGET_LABEL, PICK_EVENT_WORDS } from "@/components/admin/incident-words";
import { UNAUDITED } from "@/components/admin/ui";
import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import type {
  ApprovalHistoryEvent,
  ApprovalItem,
  IncidentApprovalHistoryEvent,
  IncidentApprovalItem,
  IncidentReportChoices,
  OpsResult,
} from "@/lib/admin/ops-client";

import { ApprovalsSection, History, type DecideApproval, type PreviewDraft } from "./ApprovalsSection";
import { PREVIEW_STALE } from "./ContactDraft";

/**
 * Queues › Approvals (Phase 6, lanes P6b and P6j): each waiting item as one
 * card, grouped (incidents, emails to clinics, billing), with the clinic,
 * what approving does, the facts in words, how long it has waited and when
 * it leaves the list; the irreversible sentence before the code field;
 * Approve and Reject both refusing to run without six digits and both
 * calling the page's decide action with the item's id, the action, the
 * reason chosen and the code; an email item's draft, its Edit of the closed
 * fields alone, its Preview, and the fields carried by Approve once changed;
 * an incident batch's clinics and a report's two clocks and choices, Approve
 * held until what happened is picked; the outcome in the operation's own
 * words, kept by the section once the item has left; the History tab across
 * both reads; and the empty, failed-read and facts-not-read states.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const OTHER_CLINIC = "4fa85f64-5717-4562-b3fc-2c963f66afa7";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const OTHER = "6d1ffee1-2222-4d3b-8b9c-2a3f4e5d6c7b";
const EMAIL = "7e2ffee2-3333-4e4c-9c0d-3b4f5e6d7c8d";
const REMINDER = "8f3ffee3-4444-4f5d-8d1e-4c5f6e7d8c9e";
const BATCH = "9a4ffee4-5555-4a6e-9e2f-5d6f7e8d9caf";
const REPORT = "0b5ffee5-6666-4b7f-8f30-6e7f8e9daab0";
const INCIDENT = "1c6ffee6-7777-4c80-9041-7f8f9eabbcc1";
const NOW = "2026-11-03T12:00:00.000Z";
const NEVER: DecideApproval = async () => {
  throw new Error("a decision ran during a static render");
};
const NO_PREVIEW: PreviewDraft = async () => {
  throw new Error("a preview ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const request: ApprovalItem = {
  id: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e:0",
  urgency: "money",
  status: "waiting",
  proposedAt: "2026-11-01T10:00:00.000Z",
  dueAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-08T10:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: true,
  irreversible: true,
  operation: "retryBillingRequest",
  hasDraft: false,
  packet: {
    operation: "retryBillingRequest",
    irreversible: true,
    stillNeeded: true,
    effect: "Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with fresh tries.",
    facts: {
      kind: "billing_request_retry",
      requestKind: "cancel_now",
      channel: null,
      reasonCode: "attempts_exhausted",
      lastErrorCode: "stripe:api_error",
      attempts: 10,
      maxAttempts: 10,
      billingStatus: "active",
      supersededBy: null,
      workerOn: false,
      closureOn: null,
    },
  },
};

const event: ApprovalItem = {
  ...request,
  id: OTHER,
  kind: "billing_event_replay",
  clinic: { id: CLINIC, name: null },
  subjectRef: "evt_1AbCdEf:1762000000",
  pastDue: false,
  expiresAt: null,
  operation: "replayBillingEvent",
  packet: {
    operation: "replayBillingEvent",
    irreversible: true,
    stillNeeded: false,
    effect: "Applies a paid invoice.",
    facts: { kind: "billing_event_replay", eventType: "invoice.paid", failures: 3, maxFailures: 3 },
  },
};

/** An extension and its email (lane P6f): a draft, a day count and a closing sentence the owner may change. */
const extension: ApprovalItem = {
  ...request,
  id: EMAIL,
  kind: "setup_extended",
  urgency: "routine",
  pastDue: false,
  expiresAt: "2026-11-15T10:00:00.000Z",
  operation: "extendSetupDeadline",
  hasDraft: true,
  packet: {
    operation: "extendSetupDeadline",
    irreversible: true,
    stillNeeded: true,
    effect: "Extends the setup deadline to the end of 2026-11-20, then emails the clinic that it has more time. The email goes only if the extension went through.",
    facts: {
      kind: "setup_extended",
      stage: "in_setup",
      stageSince: "2026-10-20T09:00:00.000Z",
      remainingDays: 3,
      lastDay: "2026-11-06",
      newLastDay: "2026-11-20",
      stepsLeft: 2,
      alreadySent: false,
      stageMoved: false,
      recommendation: { action: "extend", days: 14, reason: "2 steps left and progress 1 day ago: 14 more days matches their pace." },
    },
    contact: {
      draft: { subject: "More time to finish setting up AYA", body: "Hello Radiance Med Spa,\n\nYou now have until 20 Nov 2026.\n\nThe healdesk team" },
      editable: [
        { field: "days", type: "days", min: 1, max: 30 },
        { field: "note", type: "choice", options: ["call_offer", "thanks"], optional: true },
      ],
      fields: { days: 14, note: null },
    },
  },
};

/** A reminder sent sooner: no draft, nothing to edit, blocked now. */
const reminder: ApprovalItem = {
  ...extension,
  id: REMINDER,
  kind: "setup_reminder_now",
  operation: "queueSetupReminder",
  hasDraft: false,
  packet: {
    operation: "queueSetupReminder",
    irreversible: true,
    stillNeeded: false,
    effect: "Sends setup reminder 3 of 6 now instead of on 2026-11-10, with its usual wording. It adds no reminder: that one is not sent again on its day.",
    facts: {
      kind: "setup_reminder_now",
      reminderNumber: 3,
      ofTotal: 6,
      normallyDueOn: "2026-11-10",
      sentSoFar: 2,
      blocked: "night",
      recommendation: null,
    },
    contact: { draft: null, editable: [], fields: null },
  },
};

const batch: IncidentApprovalItem = {
  id: BATCH,
  kind: "incident_open_batch",
  clinic: null,
  subjectRef: "vendor:retell:window_only:2026-10-30T00:00:00.000Z:2026-10-31T00:00:00.000Z:security_incident",
  urgency: "legal_clock",
  status: "waiting",
  proposedAt: "2026-11-03T09:00:00.000Z",
  dueAt: "2026-11-04T09:00:00.000Z",
  expiresAt: null,
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "openIncident",
  hasDraft: false,
  packet: {
    operation: "openIncident",
    irreversible: true,
    stillNeeded: true,
    effect: "Opens an incident at each of the 2 clinics below, classed as a security incident, and puts each one's report in this list for your yes. Nothing is sent to any clinic.",
    facts: {
      kind: "incident_open_batch",
      source: "vendor",
      value: "retell",
      reach: "window_only",
      from: "2026-10-30T00:00:00.000Z",
      to: "2026-10-31T00:00:00.000Z",
      incidentClass: "security_incident",
      discoveredAt: "2026-11-03T08:00:00.000Z",
      clinicsTotal: 2,
      toOpen: 2,
      alreadyOpen: 0,
      outOfService: 0,
      clinics: [
        {
          clinicId: CLINIC,
          clinicName: "Radiance Med Spa",
          conversations: 4,
          agreementVersion: "1.5.1",
          clocks: { internalTarget: "2026-11-04T08:00:00.000Z", agreementDeadline: "2027-01-02T08:00:00.000Z", agreementRule: "sixty_calendar_days", ownerNoticeBy: null },
          opened: false,
          inService: true,
        },
        {
          clinicId: OTHER_CLINIC,
          clinicName: "Glow Aesthetics",
          conversations: 1,
          agreementVersion: null,
          clocks: { internalTarget: "2026-11-04T08:00:00.000Z", agreementDeadline: "2026-11-10T08:00:00.000Z", agreementRule: "five_days", ownerNoticeBy: null },
          opened: false,
          inService: true,
        },
      ],
    },
  },
};

const prefilled: IncidentReportChoices = {
  event: null,
  occurredOn: null,
  info: [],
  mitigations: ["investigating"],
  steps: [],
  recommendations: ["assess_notice_duty", "keep_record"],
  delayedByLawEnforcement: false,
  delayEndedOn: null,
};

const report: IncidentApprovalItem = {
  ...batch,
  id: REPORT,
  kind: "incident_report_send",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${INCIDENT}:1`,
  pastDue: true,
  operation: "sendIncidentReport",
  packet: {
    operation: "sendIncidentReport",
    irreversible: true,
    stillNeeded: true,
    effect: "Emails the practice's address this incident's report, built only from the choices below, and records the practice as told. It cannot be taken back.",
    facts: {
      kind: "incident_report_send",
      incidentId: INCIDENT,
      incidentClass: "breach",
      report: 1,
      discoveredAt: "2026-11-01T08:00:00.000Z",
      internalTarget: "2026-11-02T08:00:00.000Z",
      agreementDeadline: "2026-12-31T08:00:00.000Z",
      agreementVersion: "1.5.1",
      ownerNoticeBy: null,
      affectedRecorded: 3,
      ticked: ["contain", "open"],
      fields: prefilled,
    },
  },
};

const historyRow: ApprovalHistoryEvent = {
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  approvalId: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  event: "approved",
  actorLabel: "ops@healdesk.test",
  ip: "203.0.113.9",
  userAgent: "vitest",
  draftHashApproved: null,
  draftHashSent: null,
  outcomeCode: "cause_fixed",
  at: "2026-11-02T10:01:00.000Z",
};

const incidentRow: IncidentApprovalHistoryEvent = {
  ...historyRow,
  id: "9a8b7c6d-1111-4222-8333-444455557777",
  approvalId: REPORT,
  kind: "incident_report_send",
  event: "proposed",
  actorLabel: "incident-assistant",
  outcomeCode: null,
  at: "2026-11-03T09:00:00.000Z",
};

type Read<T> = OpsResult<{ items: T[]; partial: string[] }>;
const read = <T,>(items: T[]): Read<T> => ({ ok: true, data: { items, partial: [] } });
const noHistory: OpsResult<ApprovalHistoryEvent[]> = { ok: true, data: [] };
const noIncidentHistory: OpsResult<IncidentApprovalHistoryEvent[]> = { ok: true, data: [] };

function render(
  approvals: Read<ApprovalItem>,
  options: { history?: OpsResult<ApprovalHistoryEvent[]>; proposerOn?: boolean | null; incidents?: Read<IncidentApprovalItem> } = {},
): string {
  return renderToStaticMarkup(
    h(ApprovalsSection, {
      approvals,
      incidentApprovals: options.incidents ?? read<IncidentApprovalItem>([]),
      history: options.history ?? noHistory,
      incidentHistory: noIncidentHistory,
      proposerOn: options.proposerOn ?? null,
      now: NOW,
      onDecide: NEVER,
      onPreview: NO_PREVIEW,
    }),
  );
}

describe("the waiting items", () => {
  test("a card: the clinic linked to its Billing tab, the kind, what approving does, the facts, the worker's switch, the wait and the day it leaves", () => {
    const html = render(read([request]));
    const page = text(html);
    expect(html).toContain('id="approvals"');
    expect(page).toContain("Approvals");
    expect(page).toContain("Waiting (1)");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/billing"`);
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Past due");
    expect(page).toContain(FAMILY_WORDS.billing);
    expect(page).toContain("Retry a billing change the billing worker gave up on");
    expect(page).toContain("Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with fresh tries.");
    expect(page).toContain("Change an immediate cancellation");
    expect(page).toContain("Tries 10 of 10");
    expect(page).toContain("Stopped because every try was used");
    expect(page).toContain("Last error Stripe had an error on its side");
    expect(page).toContain("Billing now active");
    expect(page).toContain("Billing worker off");
    // The off switch is explained once, by the packet's own effect sentence, not again on the fact line.
    expect(page.match(/switched off/g) ?? []).toHaveLength(0);
    expect(page).toContain("Waiting 2 days, past due. Can no longer be approved after 8 Nov 2026, 10:00 UTC; the approvals job then takes it off the list.");
    expect(page).not.toContain(NO_CLINIC_EVENT);
    expect(page).toContain("Approve");
    expect(page).toContain("Reject");
    expect(page).toContain("Why approve");
    expect(page).toContain("Why reject");
    expect(page).toContain("The cause is fixed");
    expect(page).toContain("Ask the clinic first");
    // No other group's heading when it has no item.
    expect(page).not.toContain(FAMILY_WORDS.contact);
    expect(page).not.toContain(FAMILY_WORDS.incident);
    // Never the codes, the ids or the subject reference.
    for (const raw of ["cancel_now", "attempts_exhausted", "stripe:api_error", "billing_request_retry", ITEM, "7d1e2f30"]) expect(page).not.toContain(raw);
  });

  test("the irreversible sentence stands before the code field, and both buttons wait for six digits", () => {
    const html = render(read([request]));
    const page = text(html);
    const sentence = page.indexOf(IRREVERSIBLE_CONFIRM.billing_request_retry);
    const field = page.indexOf("Code from your authenticator");
    expect(sentence).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(sentence);
    expect(page.match(/Code from your authenticator/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });

  test("a parked event with no printable clinic name, no expiry and a subject that moved on: said so, and Runs at once", () => {
    const page = text(render(read([event])));
    expect(page).toContain("A clinic with no printable name");
    expect(page).toContain("Replay a Stripe event that was parked");
    expect(page).toContain(NO_LONGER_NEEDED);
    expect(page).toContain("Stripe event invoice paid");
    expect(page).toContain("Failed 3 of 3 times");
    expect(page).toContain("Runs at once, in the same request, when approved");
    expect(page).toContain("Waiting 2 days. Waits until decided.");
    expect(page).not.toContain("Past due");
    expect(page).toContain(IRREVERSIBLE_CONFIRM.billing_event_replay);
    expect(page).not.toContain("evt_1AbCdEf");
    // It has a clinic (with no printable name), so its Billing tab lists it: no clinic-less sentence.
    expect(page).not.toContain(NO_CLINIC_EVENT);
  });

  test("a parked event that resolved to no clinic says it is on no clinic's Billing tab and that Approve here is the only button that replays it", () => {
    const page = text(render(read([{ ...event, clinic: null, packet: { ...event.packet!, stillNeeded: true } }])));
    expect(page).toContain("No clinic");
    expect(page).toContain(NO_CLINIC_EVENT);
    expect(page).not.toContain(NO_LONGER_NEEDED);
    expect(page).not.toContain("href=");
  });

  test("the empty line says the approvals job is off when its switch is read off, and nothing extra otherwise", () => {
    expect(text(render(read([]), { proposerOn: false }))).toContain(EMPTY_JOB_OFF);
    expect(text(render(read([]), { proposerOn: true }))).toContain(EMPTY_WORDS);
    expect(text(render(read([]), { proposerOn: true }))).not.toContain("approvals job is off");
    expect(text(render(read([]), { proposerOn: null }))).not.toContain("approvals job is off");
    // Items waiting: the switch is not mentioned, whatever it says.
    expect(text(render(read([request]), { proposerOn: false }))).not.toContain("approvals job is off");
    expect(EMPTY_JOB_OFF).toBe("Nothing is waiting for your yes, but the approvals job is off at System > Jobs, so nothing is being proposed.");
  });

  test("an item whose facts could not be read offers Reject alone and says why", () => {
    const page = text(render({ ok: true, data: { items: [{ ...request, packet: null }], partial: [ITEM] } }));
    expect(page).toContain(FACTS_NOT_READ);
    expect(page).not.toContain("Approve this");
    expect(page).not.toContain("Why approve");
    expect(page).toContain("Why reject");
    expect(page).toContain("Reject");
  });

  test("empty says the one line; a failed read says so and is never a zero; the tab count follows both reads", () => {
    const empty = text(render(read([])));
    expect(empty).toContain(EMPTY_WORDS);
    expect(empty).toContain("Waiting (0)");
    const failed = text(render({ ok: false, code: "failed", message: "The approvals could not be read." }));
    expect(failed).toContain("Could not read the approvals: The approvals could not be read.");
    expect(failed).not.toContain(EMPTY_WORDS);
    expect(failed).not.toContain("Waiting (0)");
    expect(failed).toContain("Waiting");
    // The incident read failing costs its group alone: the billing card still draws, and no count is claimed.
    const incidentsFailed = text(render(read([request]), { incidents: { ok: false, code: "failed", message: "The incident items could not be read." } }));
    expect(incidentsFailed).toContain("Could not read the incident assistant's items: The incident items could not be read.");
    expect(incidentsFailed).toContain("Retry a billing change the billing worker gave up on");
    expect(incidentsFailed).not.toContain("Waiting (1)");
  });
});

describe("an email to a clinic", () => {
  test("the card: the clinic linked to its Setup tab, the facts in words, the draft as the clinic reads it, the Edit control, and the setup watch's sentence as it came", () => {
    const html = render(read([extension]));
    const page = text(html);
    expect(page).toContain(FAMILY_WORDS.contact);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/setup"`);
    expect(page).toContain("Give a clinic more time to finish setup, and tell it");
    expect(page).toContain("Stage in setup since 20 Oct 2026");
    expect(page).toContain("Window ends 6 Nov 2026 (3 days left)");
    expect(page).toContain("If approved, ends 20 Nov 2026");
    expect(page).toContain("Steps left 2");
    expect(page).toContain("The setup watch recommends 2 steps left and progress 1 day ago: 14 more days matches their pace.");
    expect(page).toContain(DRAFT_HEADING);
    expect(page).toContain("More time to finish setting up AYA");
    expect(page).toContain("You now have until 20 Nov 2026.");
    expect(page).toContain("Edit");
    // Closed: no free-text field anywhere on the card.
    expect(html).not.toContain("<textarea");
    expect(html).not.toMatch(/<input[^>]*type="text"/);
    expect(page).toContain(IRREVERSIBLE_CONFIRM.setup_extended);
    expect(page).toContain("Waiting 2 days. Can no longer be approved after 15 Nov 2026, 10:00 UTC; the approvals job then takes it off the list.");
    for (const raw of ["setup_extended", "in_setup", "call_offer", EMAIL]) expect(page).not.toContain(raw);
  });

  test("a reminder sent sooner has no draft and nothing to edit, and says why it would send nothing now", () => {
    const html = render(read([reminder]));
    const page = text(html);
    expect(page).toContain("Send the next setup reminder sooner");
    expect(page).toContain("Reminder 3 of 6, normally due 10 Nov 2026");
    expect(page).toContain("Sent so far 2");
    expect(page).toContain("Would send nothing now it is night at the clinic: it would wait until morning");
    expect(page).toContain(NO_LONGER_NEEDED);
    expect(page).toContain(REMINDER_FIXED_WORDS);
    expect(page).not.toContain(DRAFT_HEADING);
    expect(page).not.toContain("Edit");
    expect(page).toContain(IRREVERSIBLE_CONFIRM.setup_reminder_now);
  });

  test("rejecting an email says nothing is sent and whether it can be proposed again, per kind", () => {
    expect(rejectConfirm({ kind: "setup_extended", clinic: extension.clinic })).toContain("Nothing is sent and the deadline does not move.");
    expect(rejectConfirm({ kind: "baa_resign_chase", clinic: extension.clinic })).toContain("the approvals job proposes the next round's chase 7 days on");
    expect(rejectConfirm({ kind: "incident_open_batch", clinic: null })).toContain("Nothing is opened, and this scope is not proposed again.");
    expect(rejectConfirm({ kind: "incident_report_send", clinic: extension.clinic })).toContain("the agreement's clock keeps running");
    // A billing kind keeps its own words.
    expect(rejectConfirm({ kind: "billing_request_retry", clinic: extension.clinic })).toBe(`${REJECT_HEAD} ${BILLING_TAB_RETRY}`);
  });
});

describe("the incident assistant's items", () => {
  test("a batch lists its scope, reach and class, and each clinic with its conversations, agreement version, both clocks and state, before Approve", () => {
    const html = render(read([]), { incidents: read([batch]) });
    const page = text(html);
    expect(page).toContain(FAMILY_WORDS.incident);
    expect(page).toContain("Legal clock");
    expect(page).toContain("No clinic");
    expect(page).toContain("Open an incident at each clinic a vendor's or a channel's incident reached");
    expect(page).toContain("Scope Retell (the voice provider)'s incident, window 30 Oct 2026, 00:00 UTC to 31 Oct 2026, 00:00 UTC");
    expect(page).toContain("Reach only clinics reached in the window");
    expect(page).toContain("Class Security incident");
    expect(page).toContain("Clinics 2 clinics listed: 2 to open");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Glow Aesthetics");
    expect(page).toContain(INTERNAL_TARGET_LABEL);
    expect(page).toContain("2 Jan 2027");
    expect(page).toContain("10 Nov 2026");
    expect(page).toContain("4 Nov 2026, 08:00 UTC");
    expect(page).toContain("none on file");
    expect(page).toContain("to open");
    // Every clinic is listed, so no "first N of" line.
    expect(page).not.toContain("soonest agreement deadline first");
    expect(page).toContain(IRREVERSIBLE_CONFIRM.incident_open_batch);
    expect(page).toContain("Waiting 3 hours. Waits until decided.");
    for (const raw of ["window_only", "security_incident", "sixty_calendar_days", BATCH]) expect(page).not.toContain(raw);
  });

  test("a report shows both clocks, our own labelled as never shown to the clinic, the pre-filled choices from fixed lists, and holds Approve until what happened is picked", () => {
    const html = render(read([]), { incidents: read([report]) });
    const page = text(html);
    expect(page).toContain("Send a practice its incident report");
    expect(page).toContain("Report the report, for breach of unsecured phi");
    expect(page).toContain(`${AGREEMENT_DEADLINE_LABEL} 31 Dec 2026 (agreement 1.5.1)`);
    expect(page).toContain(`${INTERNAL_TARGET_LABEL} 2 Nov 2026, 08:00 UTC`);
    expect(page).toContain("People recorded as affected 3");
    expect(page).toContain("Checklist steps ticked Contain it: stop the exposure continuing; Open the incident, which starts both clocks");
    expect(page).toContain("Not picked yet");
    expect(page).toContain("We're still investigating, and we'll add to this report as we learn more.");
    expect(html).toMatch(/name="done:investigating"[^>]*checked=""/);
    expect(html).toMatch(/name="advise:keep_record"[^>]*checked=""/);
    expect(page).toContain("Notice delayed (45 CFR 164.412)");
    expect(page).toContain(PICK_EVENT_WORDS);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).not.toContain("<textarea");
    expect(page).toContain("Past due");
    expect(page).toContain(IRREVERSIBLE_CONFIRM.incident_report_send);
    for (const raw of ["incident_report_send", "assess_notice_duty", INCIDENT, REPORT]) expect(page).not.toContain(raw);
  });
});

describe("the History tab", () => {
  test("each row: when, whose, the kind, what happened and why, who by; never the IP, the user agent or a hash", () => {
    const html = renderToStaticMarkup(h(History, { history: { ok: true, data: [historyRow, { ...historyRow, id: "1", event: "proposed", outcomeCode: null, actorLabel: "approvals-propose", at: "2026-11-01T10:00:00.000Z" }] } }));
    const page = text(html);
    expect(page).toContain("2 Nov 2026, 10:01 UTC");
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Retry a billing change the billing worker gave up on");
    expect(page).toContain("approved (the cause is fixed)");
    expect(page).toContain("by ops@healdesk.test");
    expect(page).toContain("proposed by the approvals job");
    expect(page).not.toContain("203.0.113.9");
    expect(page).not.toContain("vitest");
    expect(page).not.toContain("cause_fixed");
    expect(whenWords("2026-11-02T10:01:00.000Z")).toBe("2 Nov 2026, 10:01 UTC");
  });

  test("the incident assistant's rows are merged in, newest first, with its own actor named", () => {
    const html = renderToStaticMarkup(h(History, { history: { ok: true, data: [historyRow] }, incidentHistory: { ok: true, data: [incidentRow] } }));
    const page = text(html);
    expect(page.indexOf("Send a practice its incident report")).toBeLessThan(page.indexOf("Retry a billing change"));
    expect(page).toContain("proposed by the incident assistant");
    // An incident row's clinic opens its Care tab; a billing row's its Billing tab.
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/billing"`);
  });

  test("empty and failed", () => {
    expect(text(renderToStaticMarkup(h(History, { history: noHistory })))).toBe("Nothing has happened yet.");
    expect(text(renderToStaticMarkup(h(History, { history: { ok: false, code: "failed", message: "The approval history could not be read." } })))).toContain(
      "Could not read the approval history: The approval history could not be read.",
    );
    // One read failing: its sentence, and the other's rows still shown; never "nothing has happened".
    const half = text(renderToStaticMarkup(h(History, { history: { ok: false, code: "failed", message: "x" }, incidentHistory: { ok: true, data: [incidentRow] } })));
    expect(half).toContain("Could not read the approval history: x");
    expect(half).toContain("Send a practice its incident report");
    expect(half).not.toContain("Nothing has happened yet.");
  });
});

describe("the controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  }
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  async function setValue(selector: string, value: string, event: "input" | "change" = "input"): Promise<void> {
    const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    if (!node) throw new Error(`no field ${selector}`);
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    await act(async () => {
      setter?.call(node, value);
      node.dispatchEvent(new Event(event, { bubbles: true }));
    });
  }

  async function type(code: string): Promise<void> {
    await setValue('input[name="code"]', code);
  }

  async function choose(name: string, value: string): Promise<void> {
    await setValue(`select[name="${name}"]`, value, "change");
  }

  async function click(label: string): Promise<void> {
    await act(async () => {
      button(label).click();
    });
  }

  async function mount(onDecide: DecideApproval, items: ApprovalItem[] = [request], options: { incidents?: IncidentApprovalItem[]; onPreview?: PreviewDraft } = {}): Promise<void> {
    await act(async () => {
      root.render(
        h(ApprovalsSection, {
          approvals: read(items),
          incidentApprovals: read(options.incidents ?? []),
          history: { ok: true, data: [historyRow] },
          incidentHistory: noIncidentHistory,
          proposerOn: null,
          now: NOW,
          onDecide,
          onPreview: options.onPreview ?? NO_PREVIEW,
        }),
      );
    });
  }

  test("Approve runs nothing without six digits, asks once, sends the id, the reason chosen and the code, and the section keeps the operation's own sentence once the card has gone", async () => {
    const message =
      "Re-armed: the change is due again, with fresh tries. The billing worker carries it out at its next run if it still applies. The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";
    const decide = vi.fn<DecideApproval>(async () => ({
      ok: true,
      data: { status: "executed", outcomeCode: "rearmed", message, auditRecorded: true } satisfies ApprovalDecisionEntry,
    }));
    await mount(decide);
    expect(button("Approve").disabled).toBe(true);
    await type("12345");
    expect(button("Approve").disabled).toBe(true);
    await type("123456");
    expect(button("Approve").disabled).toBe(false);
    await choose("approveReason", "owner_checked");
    await click("Approve");
    expect(decide).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Approve this item? Its operation runs once now. A billing change is then carried out by the billing worker, with fresh tries.",
    );
    await click("Yes, approve");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(ITEM, "approve", "owner_checked", "123456", undefined);
    expect(statuses()).toContain(`Approved. ${message}`);
    // The card has gone; the outcome stays; the list is empty.
    expect(container.textContent).not.toContain("Code from your authenticator");
    expect(container.textContent).toContain(EMPTY_WORDS);
    expect(container.textContent).toContain("Waiting (0)");
  });

  test("Reject asks once with its own sentence, sends the reason chosen, and says the item has left; an unaudited decision says so", async () => {
    const decide = vi.fn<DecideApproval>(async () => ({
      ok: true,
      data: { status: "rejected", outcomeCode: "wrong_amount", auditRecorded: false } satisfies ApprovalDecisionEntry,
    }));
    await mount(decide);
    await type("123456");
    await choose("rejectReason", "wrong_amount");
    await click("Reject");
    expect(decide).not.toHaveBeenCalled();
    expect(container.textContent).toContain(`${REJECT_HEAD} ${BILLING_TAB_RETRY}`);
    await click("Yes, reject");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(ITEM, "reject", "wrong_amount", "123456", undefined);
    expect(statuses()).toContain(`Rejected. ${REJECT_HEAD} ${BILLING_TAB_RETRY} ${UNAUDITED}`);
    expect(container.textContent).not.toContain("Why reject");
  });

  test("a clinic-less Stripe event: Reject's second press and the rejected line say no clinic's Billing tab lists it", async () => {
    const decide = vi.fn<DecideApproval>(async () => ({ ok: true, data: { status: "rejected", outcomeCode: "not_needed", auditRecorded: true } }));
    await mount(decide, [{ ...event, clinic: null }]);
    await type("123456");
    await click("Reject");
    expect(container.textContent).toContain(`${REJECT_HEAD} ${NO_CLINIC_EVENT}`);
    await click("Yes, reject");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(OTHER, "reject", "not_needed", "123456", undefined);
    expect(statuses()).toContain(`Rejected. ${REJECT_HEAD} This event is on no clinic's Billing tab.`);
  });

  test("a refused code, or an item already decided, is said on the card and the card stays; a failed operation leaves the list in red", async () => {
    let answer: ApprovalDecisionEntry = { status: "code_refused", message: "That code is not right. Nothing was changed." };
    const decide = vi.fn<DecideApproval>(async () => ({ ok: true, data: answer }));
    await mount(decide);
    await type("654321");
    await click("Reject");
    await click("Yes, reject");
    await act(async () => {});
    expect(statuses()).toContain("That code is not right. Nothing was changed.");
    expect(container.textContent).toContain("Code from your authenticator");

    answer = { status: "refused", message: "This has already been decided, so nothing more was done. Reload to see where it stands." };
    await click("Reject");
    await click("Yes, reject");
    await act(async () => {});
    expect(statuses()).toContain("This has already been decided, so nothing more was done. Reload to see where it stands.");
    expect(container.textContent).toContain("Code from your authenticator");

    answer = { status: "failed", outcomeCode: "no_longer_needed", message: "This has already been dealt with since it was proposed, so nothing was run.", auditRecorded: true };
    await click("Approve");
    await click("Yes, approve");
    await act(async () => {});
    expect(decide).toHaveBeenLastCalledWith(ITEM, "approve", "cause_fixed", "654321", undefined);
    const line = [...container.querySelectorAll('[role="status"]')].find((n) => n.textContent?.startsWith("Approved, but"));
    expect(line?.textContent).toBe("Approved, but it did not go through: This has already been dealt with since it was proposed, so nothing was run.");
    expect(line?.className).toContain("text-red-deep");
    expect(container.textContent).not.toContain("Code from your authenticator");
  });

  test("an email: Edit offers the closed fields, Preview sends them to the read and shows the rendering, Approve carries them once changed and never before", async () => {
    const preview = vi.fn<PreviewDraft>(async () => ({
      ok: true,
      data: {
        status: "preview",
        draft: { subject: "More time to finish setting up AYA", body: "Hello Radiance Med Spa,\n\nYou now have until 27 Nov 2026.\n\nIf it's easier to talk it through, reply with a time that suits you and we'll call.\n\nThe healdesk team" },
        editable: extension.packet!.contact!.editable,
      },
    }));
    const decide = vi.fn<DecideApproval>(async () => ({ ok: true, data: { status: "executed", outcomeCode: "queued", message: null, auditRecorded: true } }));
    await mount(decide, [extension], { onPreview: preview });
    // Unchanged: Approve carries no edit.
    await type("123456");
    await click("Approve");
    await click("Yes, approve");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(EMAIL, "approve", "cause_fixed", "123456", undefined);
    expect(statuses()).toContain("Approved. The email is queued in the outbox; the billing-notices job sends it.");

    // Again (the section remembers the decided id, so a second item), with the choices changed.
    await mount(decide, [{ ...extension, id: OTHER }], { onPreview: preview });
    await click("Edit");
    expect(container.textContent).toContain(EDIT_WORDS);
    expect(container.querySelector('input[name="days"]')).not.toBeNull();
    expect(container.querySelector('select[name="note"]')).not.toBeNull();
    expect(container.querySelector('select[name="phrase"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    await setValue('input[name="days"]', "21");
    await choose("note", "call_offer");
    expect(container.textContent).toContain(PREVIEW_STALE);
    await click("Preview");
    await act(async () => {});
    expect(preview).toHaveBeenCalledWith(OTHER, { days: 21, note: "call_offer" });
    expect(container.textContent).toContain("You now have until 27 Nov 2026.");
    expect(container.textContent).not.toContain(PREVIEW_STALE);
    await type("123456");
    await click("Approve");
    await click("Yes, approve");
    await act(async () => {});
    expect(decide).toHaveBeenLastCalledWith(OTHER, "approve", "cause_fixed", "123456", { fields: { days: 21, note: "call_offer" } });
  });

  test("an email whose preview found problems says them, in apps/app's words", async () => {
    const preview = vi.fn<PreviewDraft>(async () => ({ ok: true, data: { status: "problems", problems: ["the days must be a whole number from 1 to 30"] } }));
    await mount(NEVER, [extension], { onPreview: preview });
    await click("Edit");
    await setValue('input[name="days"]', "40");
    await click("Preview");
    await act(async () => {});
    expect(statuses()).toContain("the days must be a whole number from 1 to 30");
  });

  test("a report: Approve is held until what happened is picked, then carries every choice from the lists", async () => {
    const decide = vi.fn<DecideApproval>(async () => ({
      ok: true,
      data: { status: "executed", outcomeCode: "sent", message: "Sent. Phone the practice as well, and tick Notify by phone on the incident's checklist once you have.", auditRecorded: true },
    }));
    await mount(decide, [], { incidents: [report] });
    await type("123456");
    expect(button("Approve").disabled).toBe(true);
    expect(container.textContent).toContain(PICK_EVENT_WORDS);
    await choose("event", "subcontractor_incident");
    expect(button("Approve").disabled).toBe(false);
    expect(container.textContent).not.toContain(PICK_EVENT_WORDS);
    await setValue('input[name="count:first_name"]', "12");
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="step:unexpected_contact"]')!.click();
    });
    await click("Approve");
    await click("Yes, approve");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(REPORT, "approve", "cause_fixed", "123456", {
      incident: {
        event: "subcontractor_incident",
        occurredOn: null,
        info: [{ type: "first_name", count: 12 }],
        mitigations: ["investigating"],
        steps: ["unexpected_contact"],
        recommendations: ["assess_notice_duty", "keep_record"],
        delayedByLawEnforcement: false,
        delayEndedOn: null,
      },
    });
    expect(statuses()).toContain("Approved. Sent. Phone the practice as well, and tick Notify by phone on the incident's checklist once you have.");
  });

  test("a batch: Reject says nothing is opened and the scope is not proposed again; Approve carries no edit", async () => {
    const decide = vi.fn<DecideApproval>(async () => ({ ok: true, data: { status: "rejected", outcomeCode: "not_needed", auditRecorded: true } }));
    await mount(decide, [], { incidents: [batch] });
    await type("123456");
    await click("Reject");
    expect(container.textContent).toContain("Nothing is opened, and this scope is not proposed again.");
    await click("Yes, reject");
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(BATCH, "reject", "not_needed", "123456", undefined);
    expect(statuses().some((s) => s.startsWith("Rejected. Nothing is opened"))).toBe(true);
  });

  test("the History tab shows the record", async () => {
    await mount(NEVER);
    expect(container.textContent).not.toContain("by ops@healdesk.test");
    await click("History");
    expect(container.textContent).toContain("approved (the cause is fixed)");
    expect(container.textContent).toContain("by ops@healdesk.test");
    expect(container.textContent).not.toContain("Code from your authenticator");
  });
});

describe("the section's source", () => {
  test("names the raw decision nowhere, and goes through the step-up wrapper's type alone", () => {
    for (const file of ["ApprovalsSection.tsx", "ApprovalDecision.tsx", "ContactDraft.tsx", "IncidentApprovalCard.tsx", "approval-edit.ts"]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(/\bdecideApproval\b/);
    }
    expect(readFileSync(join(__dirname, "ApprovalDecision.tsx"), "utf8")).toMatch(/approval-decide/);
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toContain("decideApprovalWithCode(");
    expect(page).not.toMatch(/\bdecideApproval\b/);
  });
});

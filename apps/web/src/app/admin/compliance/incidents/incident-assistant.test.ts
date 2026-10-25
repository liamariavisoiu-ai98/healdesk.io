// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { DecideApproval } from "@/app/admin/queues/ApprovalDecision";
import { INTERNAL_TARGET_LABEL, TICK_CONFIRM, TICK_WORDS } from "@/components/admin/incident-words";
import type { IncidentApprovalItem, IncidentChecklistStep, IncidentRegisterRow, IncidentScopeView, OpsResult } from "@/lib/admin/ops-client";

import { IncidentAssistant, WAITING_EMPTY } from "./IncidentAssistant";
import { IncidentChecklist, reportProposedWords, tickedWords, type ChecklistActions } from "./IncidentChecklist";
import { IncidentScope, PROPOSE_NEEDS, PROPOSE_WORDS, proposedWords, SCOPE_INCOMPLETE, type ProposeBatch, type ReadScope } from "./IncidentScope";
import { IncidentsBoard } from "./IncidentsBoard";

/**
 * Compliance › Incidents › Incident assistant (lane P6j): the waiting items
 * drawn with the Approvals cards, the scope form building the one query and
 * "Propose opening these incidents" held until the class and discovery are
 * given and every clinic is read; each card's checklist read on demand,
 * "Tick" recording a step through the action and nothing else, "Propose the
 * report" offered only while a report is awaited; and the sentences that
 * say what proposes and what records.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INCIDENT = "1c6ffee6-7777-4c80-9041-7f8f9eabbcc1";
const NOW = "2026-11-03T12:00:00.000Z";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const batch: IncidentApprovalItem = {
  id: "9a4ffee4-5555-4a6e-9e2f-5d6f7e8d9caf",
  kind: "incident_open_batch",
  clinic: null,
  subjectRef: "vendor:retell:window_only:a:b:security_incident",
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
    effect: "Opens an incident at the 1 clinic below, classed as a security incident, and puts each one's report in this list for your yes. Nothing is sent to any clinic.",
    facts: {
      kind: "incident_open_batch",
      source: "vendor",
      value: "retell",
      reach: "window_only",
      from: "2026-10-30T00:00:00.000Z",
      to: "2026-10-31T00:00:00.000Z",
      incidentClass: "security_incident",
      discoveredAt: "2026-11-03T08:00:00.000Z",
      clinicsTotal: 1,
      toOpen: 1,
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
      ],
    },
  },
};

const scope: IncidentScopeView = {
  source: "vendor",
  value: "database_host",
  reach: "all_holding",
  channels: ["voice", "web", "meta"],
  from: "2026-10-30T00:00:00.000Z",
  to: "2026-11-01T00:00:00.000Z",
  clinics: [
    {
      clinicId: CLINIC,
      clinicName: "Radiance Med Spa",
      billingClinicId: null,
      conversations: { voice: 3, web: 1, meta: 0 },
      total: 4,
      holdsData: true,
      agreementVersion: "1.5.1",
      coveredEntity: true,
      demo: false,
      offboarding: false,
      clocks: { internalTarget: "2026-11-01T08:00:00.000Z", agreementDeadline: "2026-12-30T08:00:00.000Z", agreementRule: "sixty_calendar_days", ownerNoticeBy: null },
    },
  ],
  clinicsWithNone: 2,
  unread: 0,
};

const ROW: IncidentRegisterRow = {
  id: INCIDENT,
  clinicId: CLINIC,
  clinicSlug: "radiance",
  clinicName: "Radiance Med Spa",
  class: "breach",
  summary: "Notice 7f3a went to a second inbox.",
  conversationId: null,
  discoveredAt: "2026-10-05 12:00 UTC",
  agreementNotifyBy: "2026-12-04 12:00 UTC",
  agreementNotifyByIso: "2026-12-04T12:00:00.000Z",
  agreementVersion: "1.5.0",
  targetNotifyBy: "2026-10-06 12:00 UTC",
  targetNotifyByIso: "2026-10-06T12:00:00.000Z",
  ftcNotifyBy: null,
  notifiedAt: null,
  notifiedHow: null,
  reportedAt: null,
  reportsSent: 0,
  notReportableAt: null,
  notReportableReason: null,
  decidedBy: null,
  resolvedAt: null,
  openedBy: "ops@healdesk.test",
  affectedCount: 0,
};

const steps: IncidentChecklistStep[] = [
  { step: "contain", tickedAt: "2026-10-05T13:00:00.000Z", tickedBy: "ops@healdesk.test", affectedCount: null, fromBatch: false },
  { step: "open", tickedAt: "2026-10-05T13:05:00.000Z", tickedBy: "ops@healdesk.test", affectedCount: null, fromBatch: true },
  { step: "preserve_ids", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
  { step: "investigate", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
  { step: "notify_email", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
  { step: "notify_phone", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
  { step: "affected_list_recorded", tickedAt: "2026-10-06T09:00:00.000Z", tickedBy: "ops@healdesk.test", affectedCount: 3, fromBatch: false },
  { step: "help_clinic", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
  { step: "resolve", tickedAt: null, tickedBy: null, affectedCount: null, fromBatch: false },
];

const assistant: ChecklistActions = { checklist: NEVER, tick: NEVER, proposeReport: NEVER };

describe("the section", () => {
  test("its anchor and title, the waiting items as Approvals cards with both clocks, and the scope form", () => {
    const html = renderToStaticMarkup(
      h(IncidentAssistant, { items: { ok: true, data: { items: [batch], partial: [] } }, now: NOW, onDecide: NEVER as DecideApproval, onReadScope: NEVER as ReadScope, onProposeBatch: NEVER as ProposeBatch }),
    );
    const page = text(html);
    expect(html).toContain('id="incident-assistant"');
    expect(page).toContain("Incident assistant");
    expect(page).toContain("It proposes; you decide here with the code from your authenticator.");
    expect(page).toContain("Waiting for your yes (1)");
    expect(page).toContain("Open an incident at each clinic a vendor's or a channel's incident reached");
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain(INTERNAL_TARGET_LABEL);
    expect(page).toContain("Code from your authenticator");
    expect(page).toContain("Approve");
    expect(page).toContain("Reject");
    expect(page).toContain("Find a scope");
    expect(page).toContain("Read the scope");
    expect(page).toContain("Include healdesk's demo clinic");
    // No result yet: no propose control, no table.
    expect(page).not.toContain("Propose opening these incidents");
  });

  test("empty and failed reads say so, never a zero count for a failed read", () => {
    const empty = text(renderToStaticMarkup(h(IncidentAssistant, { items: { ok: true, data: { items: [], partial: [] } }, now: NOW, onDecide: NEVER, onReadScope: NEVER, onProposeBatch: NEVER })));
    expect(empty).toContain(WAITING_EMPTY);
    expect(empty).toContain("Waiting for your yes (0)");
    const failed = text(renderToStaticMarkup(h(IncidentAssistant, { items: { ok: false, code: "failed", message: "x" }, now: NOW, onDecide: NEVER, onReadScope: NEVER, onProposeBatch: NEVER })));
    expect(failed).toContain("Could not read the incident assistant's items: x");
    expect(failed).not.toContain(WAITING_EMPTY);
    expect(failed).not.toContain("(0)");
  });

  test("the outcome lines of the two proposals say what waits where, and that nothing was opened or sent", () => {
    expect(proposedWords({ status: "proposed", approvalId: batch.id, clinics: 3, auditRecorded: true })).toBe(
      "Proposed: one item for 3 clinics is waiting for your yes under Approvals, on this page and under Queues.",
    );
    expect(proposedWords({ status: "already_waiting", approvalId: batch.id, clinics: null, auditRecorded: true })).toBe("This scope is already waiting for your yes under Approvals.");
    expect(reportProposedWords({ status: "proposed", approvalId: batch.id, clinics: null, auditRecorded: true })).toContain("Nothing has been sent.");
    expect(reportProposedWords({ status: "already_waiting", approvalId: batch.id, clinics: null, auditRecorded: true })).toContain("already waiting");
    expect(PROPOSE_WORDS).toContain("Nothing is opened until you approve it in Approvals.");
    expect(SCOPE_INCOMPLETE(2)).toBe("2 clinics could not be read, so this list may be missing some. Nothing can be proposed until every clinic is read.");
  });
});

describe("the board with the assistant", () => {
  test("every card gets a Checklist; Propose the report only where a report is awaited; Send report and Not reportable stand as before", () => {
    const resolved: IncidentRegisterRow = { ...ROW, id: "2d7ffee7-8888-4d91-a152-8fa0afbccdd2", resolvedAt: "2026-10-20 12:00 UTC" };
    const complaint: IncidentRegisterRow = { ...ROW, id: "3e8ffee8-9999-4ea2-b263-9ab1bacddee3", class: "service_complaint" };
    const html = renderToStaticMarkup(
      h(IncidentsBoard, { register: { ok: true, data: [ROW, resolved, complaint] } as OpsResult<IncidentRegisterRow[]>, now: NOW, actions: { sendReport: NEVER, notReportable: NEVER, assistant } }, h("p", null, "the assistant's section")),
    );
    const page = text(html);
    expect(page.match(/Checklist/g)).toHaveLength(3);
    expect(page.match(/Propose the report/g)).toHaveLength(1);
    expect(page).toContain("Send report");
    expect(page).toContain("Not reportable");
    expect(page).toContain("the assistant's section");
    // Without the assistant's actions (the older test's render), nothing of it is drawn.
    const plain = text(renderToStaticMarkup(h(IncidentsBoard, { register: { ok: true, data: [ROW] }, now: NOW, actions: { sendReport: NEVER, notReportable: NEVER } })));
    expect(plain).not.toContain("Checklist");
    expect(plain).not.toContain("Propose the report");
  });

  test("a ticked step's line: when, who, a batch's tick, the people recorded as a count", () => {
    expect(tickedWords(steps[0]!)).toBe("Ticked 5 Oct 2026, 13:00 UTC by ops@healdesk.test");
    expect(tickedWords(steps[1]!)).toBe("Ticked 5 Oct 2026, 13:05 UTC by an approved batch");
    expect(tickedWords(steps[6]!)).toBe("Ticked 6 Oct 2026, 09:00 UTC by ops@healdesk.test; 3 people recorded then");
    expect(tickedWords(steps[2]!)).toBe("not ticked");
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
  const buttons = (label: string) => [...container.querySelectorAll("button")].filter((b) => b.textContent === label);
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  async function click(label: string, which = 0): Promise<void> {
    await act(async () => {
      buttons(label)[which]!.click();
    });
  }

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

  test("the scope: a problem is said before any read; the read sends the query; the table shows each clinic, its counts, both clocks and the reach; Propose waits for the class", async () => {
    const read = vi.fn<ReadScope>(async () => ({ ok: true, data: scope }));
    const propose = vi.fn<ProposeBatch>(async () => ({ ok: true, data: { status: "proposed", approvalId: batch.id, clinics: 1, auditRecorded: true } }));
    await act(async () => {
      root.render(h(IncidentScope, { now: NOW, onRead: read, onPropose: propose }));
    });
    await click("Read the scope");
    expect(read).not.toHaveBeenCalled();
    expect(statuses()).toContain("Give the window as two days, the first and the last.");

    await setValue('select[name="vendor"]', "database_host", "change");
    expect(container.querySelector('select[name="reach"]')).not.toBeNull();
    await setValue('input[name="fromDay"]', "2026-10-30");
    await setValue('input[name="toDay"]', "2026-10-31");
    await click("Read the scope");
    await act(async () => {});
    expect(read).toHaveBeenCalledWith({ vendor: "database_host", from: "2026-10-30T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z", reach: "all_holding" });
    const page = text(container.innerHTML);
    expect(page).toContain("1 clinic in scope");
    expect(page).toContain("every clinic holding data, 30 Oct 2026, 00:00 UTC to 1 Nov 2026, 00:00 UTC. 2 clinics were read and hold nothing.");
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Holds data");
    expect(page).toContain(INTERNAL_TARGET_LABEL);
    expect(page).toContain("30 Dec 2026 (no later than 60 calendar days after discovery)");
    expect(page).toContain("1 Nov 2026, 08:00 UTC");
    expect(container.innerHTML).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain(PROPOSE_WORDS);
    expect(page).toContain(PROPOSE_NEEDS);
    expect(button("Propose opening these incidents").disabled).toBe(true);

    await setValue('select[name="incidentClass"]', "breach", "change");
    await setValue('input[name="discoveredAt"]', "2026-10-31T08:00");
    await click("Read the scope");
    await act(async () => {});
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ vendor: "database_host", class: "breach", discoveredAt: expect.stringMatching(/^2026-10-31T\d{2}:\d{2}:00\.000Z$/) }));
    expect(text(container.innerHTML)).not.toContain(PROPOSE_NEEDS);
    expect(button("Propose opening these incidents").disabled).toBe(false);
    await click("Propose opening these incidents");
    expect(propose).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Propose this scope for your yes? Nothing is opened now.");
    await click("Yes, propose opening these incidents");
    await act(async () => {});
    expect(propose).toHaveBeenCalledWith(read.mock.calls[1]![0]);
    expect(statuses()).toContain("Proposed: one item for 1 clinic is waiting for your yes under Approvals, on this page and under Queues.");
  });

  test("a scope with a clinic unread cannot be proposed, and says why", async () => {
    const read = vi.fn<ReadScope>(async () => ({ ok: true, data: { ...scope, source: "vendor", value: "retell", reach: "window_only", channels: ["voice"], unread: 1 } }));
    await act(async () => {
      root.render(h(IncidentScope, { now: NOW, onRead: read, onPropose: NEVER }));
    });
    await setValue('input[name="fromDay"]', "2026-10-30");
    await setValue('input[name="toDay"]', "2026-10-31");
    await setValue('select[name="incidentClass"]', "breach", "change");
    await setValue('input[name="discoveredAt"]', "2026-10-31T08:00");
    await click("Read the scope");
    await act(async () => {});
    expect(statuses()).toContain(SCOPE_INCOMPLETE(1));
    expect(button("Propose opening these incidents").disabled).toBe(true);
    // A vendor read by its window shows no reach control and no holds-data column.
    expect(container.querySelector('select[name="reach"]')).toBeNull();
    expect(text(container.innerHTML)).not.toContain("Holds data");
  });

  test("the checklist: read when opened, each step in words with who and when, Tick asks once then records through the action and reads again, the two held steps say what they wait for", async () => {
    const checklist = vi.fn<ChecklistActions["checklist"]>(async () => ({ ok: true, data: { status: "read", steps } }));
    const tick = vi.fn<ChecklistActions["tick"]>(async () => ({
      ok: true,
      data: { status: "ticked", step: "preserve_ids", tickedAt: "2026-11-03T12:00:00.000Z", affectedCount: null, auditRecorded: true },
    }));
    const proposeReport = vi.fn<ChecklistActions["proposeReport"]>(async () => ({ ok: true, data: { status: "already_waiting", approvalId: batch.id, clinics: null, auditRecorded: true } }));
    await act(async () => {
      root.render(h(IncidentChecklist, { clinicId: CLINIC, incidentId: INCIDENT, reportable: true, actions: { checklist, tick, proposeReport } }));
    });
    expect(checklist).not.toHaveBeenCalled();
    await click("Checklist");
    await act(async () => {});
    expect(checklist).toHaveBeenCalledWith(CLINIC, INCIDENT);
    const page = text(container.innerHTML);
    expect(page).toContain(TICK_WORDS);
    expect(page).toContain("1. Contain it: stop the exposure continuing Ticked 5 Oct 2026, 13:00 UTC by ops@healdesk.test");
    expect(page).toContain("2. Open the incident, which starts both clocks Ticked 5 Oct 2026, 13:05 UTC by an approved batch");
    expect(page).toContain("7. Record the list of who it affected, by contact id, on the host Ticked 6 Oct 2026, 09:00 UTC by ops@healdesk.test; 3 people recorded then");
    expect(page).toContain("(ticked only once a report has gone or a notice is recorded)");
    expect(page).toContain("(ticked only once the incident is resolved on the clinic's Care tab)");
    // Six steps untouched, six Tick controls.
    expect(buttons("Tick")).toHaveLength(6);
    for (const raw of ["preserve_ids", "notify_email", "affected_list_recorded"]) expect(page).not.toContain(raw);

    await click("Tick");
    expect(tick).not.toHaveBeenCalled();
    expect(container.textContent).toContain(TICK_CONFIRM);
    await click("Yes, tick");
    await act(async () => {});
    expect(tick).toHaveBeenCalledWith(CLINIC, INCIDENT, "preserve_ids");
    expect(checklist).toHaveBeenCalledTimes(2);

    await click("Propose the report");
    await act(async () => {});
    expect(proposeReport).toHaveBeenCalledWith(CLINIC, INCIDENT);
    expect(statuses()).toContain("This incident's report is already waiting for your yes under Approvals.");
  });

  test("a checklist apps/app refused says so; a report is not offered where none is awaited", async () => {
    const checklist = vi.fn<ChecklistActions["checklist"]>(async () => ({ ok: true, data: { status: "refused", message: "No such incident at this clinic." } }));
    await act(async () => {
      root.render(h(IncidentChecklist, { clinicId: CLINIC, incidentId: INCIDENT, reportable: false, actions: { checklist, tick: NEVER, proposeReport: NEVER } }));
    });
    expect(buttons("Propose the report")).toHaveLength(0);
    await click("Checklist");
    await act(async () => {});
    expect(statuses()).toContain("Could not read the checklist: No such incident at this clinic.");
  });
});

describe("the files' source", () => {
  test("name the raw decision nowhere", () => {
    for (const file of ["IncidentAssistant.tsx", "IncidentScope.tsx", "IncidentChecklist.tsx", "IncidentsBoard.tsx", "scope-input.ts"]) {
      expect(readFileSync(join(__dirname, file), "utf8"), file).not.toMatch(/\bdecideApproval\b/);
    }
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toContain("decideApprovalWithCode(");
    expect(page).not.toMatch(/\bdecideApproval\b/);
  });
});

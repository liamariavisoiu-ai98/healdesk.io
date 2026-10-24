// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ClinicAuditsView, ClinicChangeView, OpsResult, RunClinicAuditOutcome } from "@/lib/admin/ops-client";

import { AvailabilityChanges, changeWords } from "./AvailabilityChanges";

/**
 * The Setup tab's "Availability changes" card (wave 2, lane A3): each change
 * in words with who and when, whether it was seen, each pack's latest
 * result with the failing checks' hints; "audits are off" and "running"
 * said as such; "Run audit now" disabled while running and its outcome in
 * one line; "Mark as seen" calling the acknowledge operation with the
 * change's id; an empty card says "No changes yet."; a read that failed
 * says so and costs only its half.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CHANGE = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const SEEN = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function change(over: Partial<ClinicChangeView>): ClinicChangeView {
  return {
    id: CHANGE,
    clinicId: CLINIC,
    clinicName: "Radiance Med Spa",
    locationId: null,
    kind: "closures",
    source: "portal",
    actorKind: "clinic_device",
    summary: { closuresAdded: ["2026-11-27"], closuresRemoved: ["2026-11-20"], closuresUpcoming: 3 },
    changedAt: "2026-10-23T09:12:00.000Z",
    alertedAt: "2026-10-23T09:13:00.000Z",
    auditStatus: "attention",
    auditId: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...over,
  };
}

const changes: OpsResult<{ since: string; changes: ClinicChangeView[] }> = {
  ok: true,
  data: {
    since: "2026-09-23T00:00:00.000Z",
    changes: [
      change({}),
      change({ id: SEEN, kind: "hours", actorKind: "change_file", summary: { weeklyChanged: true, holdsReleased: 2 }, auditStatus: "passed", acknowledgedAt: "2026-10-22T10:00:00.000Z", acknowledgedBy: "ops@healdesk.test" }),
    ],
  },
};

const audits: OpsResult<ClinicAuditsView> = {
  ok: true,
  data: {
    history: null,
    clinics: [
      {
        clinicId: CLINIC,
        name: "Radiance Med Spa",
        overall: "warn",
        lastChange: { kind: "closures", at: "2026-10-23T09:12:00.000Z" },
        packs: {
          availability: {
            result: "warn",
            at: "2026-10-23T09:15:00.000Z",
            trigger: "change",
            failing: [{ id: "closure_without_slots", hint: "A closed day still has bookable slots in the calendar." }],
          },
          roster: { result: "pass", at: "2026-10-23T03:00:00.000Z", trigger: "scheduled", failing: [] },
        },
      },
    ],
  },
};

describe("the card's words", () => {
  test("each change is said in words with who, when, its audit and whether it was seen", () => {
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits, onRunAudit: NEVER, onAcknowledge: NEVER })));
    expect(page).toContain("Availability changes");
    expect(page).toContain("Closed days: added 2026-11-27; taken off 2026-11-20 (3 upcoming)");
    expect(page).toContain("2026-10-23 09:12 UTC · by the clinic");
    expect(page).toContain("audit needs attention");
    expect(page).toContain("Mark as seen");
    expect(page).toContain("Weekly hours changed; 2 holds released");
    expect(page).toContain("by a change file · seen 2026-10-22 10:00 UTC by ops@healdesk.test");
    expect(page).toContain("audit passed");
    // One "Mark as seen" for the unseen change, none for the seen one.
    expect(page.match(/Mark as seen/g)).toHaveLength(1);
  });

  test("each pack's latest result, its failing checks' hints, and 'never' for a pack that has not run", () => {
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits, onRunAudit: NEVER, onAcknowledge: NEVER })));
    expect(page).toContain("Availability warn 2026-10-23 09:15 UTC A closed day still has bookable slots in the calendar.");
    expect(page).toContain("Roster pass");
    expect(page).toContain("Go-live never");
    expect(page).toContain("Transcripts never");
    expect(page).toContain("Run audit now");
  });

  test("audits off and running are said as such, and running disables the button", () => {
    const off = { ...audits, data: { ...audits.data, clinics: [{ ...audits.data.clinics[0]!, overall: "audits_off" as const }] } } as OpsResult<ClinicAuditsView>;
    const offPage = renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes: { ...changes, data: { ...changes.data, changes: [change({ auditStatus: null })] } }, audits: off, onRunAudit: NEVER, onAcknowledge: NEVER }));
    expect(text(offPage)).toContain("audits are off Changes wait for an audit while the clinic-audits job is off.");
    expect(text(offPage)).toContain("audits are off");
    const running = { ...audits, data: { ...audits.data, clinics: [{ ...audits.data.clinics[0]!, overall: "running" as const }] } } as OpsResult<ClinicAuditsView>;
    const runningPage = renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits: running, onRunAudit: NEVER, onAcknowledge: NEVER }));
    expect(text(runningPage)).toContain("running");
    expect(runningPage).toMatch(/<button[^>]*disabled=""[^>]*>Run audit now<\/button>/);
  });

  test("an empty card says 'No changes yet.', and a read that failed says so and costs only its half", () => {
    const empty = text(renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes: { ok: true, data: { since: "2026-09-23T00:00:00.000Z", changes: [] } }, audits, onRunAudit: NEVER, onAcknowledge: NEVER })));
    expect(empty).toContain("No changes yet.");
    expect(empty).not.toContain("0 changes");
    const failed = { ok: false as const, code: "unreachable" as const, message: "Could not reach the ops API." };
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes: failed, audits: failed, onRunAudit: NEVER, onAcknowledge: NEVER })));
    expect(page).toContain("Could not read the audits: Could not reach the ops API.");
    expect(page).toContain("Could not read the changes: Could not reach the ops API.");
    expect(page).toContain("Run audit now");
    const half = text(renderToStaticMarkup(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits: failed, onRunAudit: NEVER, onAcknowledge: NEVER })));
    expect(half).toContain("Could not read the audits");
    expect(half).toContain("Closed days: added 2026-11-27");
  });

  test("every change kind has words, from counts and dates only", () => {
    expect(changeWords(change({ kind: "location_hours", summary: {} }))).toBe("A location's hours changed");
    expect(changeWords(change({ kind: "providers", summary: { providersActive: 4 } }))).toBe("Providers changed (4 active)");
    expect(changeWords(change({ kind: "provider_services", summary: { servicesMapped: 12 } }))).toBe("Provider services changed (12 mapped)");
    expect(changeWords(change({ kind: "closures", summary: { rows: 2, operation: "delete" } }))).toBe("Closed days: 2 rows delete");
  });
});

describe("the two buttons", () => {
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

  test("Run audit now calls the run operation and says what it did", async () => {
    const outcomes: RunClinicAuditOutcome[] = [
      { status: "ran", result: "pass", audits: [], auditRecorded: true },
      { status: "too_soon", notBefore: "2026-10-23T09:13:00.000Z" },
      { status: "busy" },
      { status: "closed" },
    ];
    const runs: number[] = [];
    const onRunAudit = vi.fn(async () => {
      runs.push(1);
      return { ok: true as const, data: outcomes[runs.length - 1]! };
    });
    await act(async () => {
      root.render(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits, onRunAudit, onAcknowledge: NEVER }));
    });
    const said: string[] = [];
    for (let i = 0; i < outcomes.length; i += 1) {
      await act(async () => {
        button("Run audit now").click();
      });
      await act(async () => {});
      said.push(container.querySelector('[role="status"]')?.textContent ?? "");
    }
    expect(onRunAudit).toHaveBeenCalledTimes(4);
    expect(said[0]).toBe("Ran: pass.");
    expect(said[1]).toContain("Too soon: a run is allowed once a minute; try again after 2026-10-23 09:13 UTC.");
    expect(said[2]).toBe("Busy: another run for this clinic is under way.");
    expect(said[3]).toBe("Closed account: nothing to audit.");
  });

  test("Mark as seen calls the acknowledge operation with that change's id", async () => {
    const onAcknowledge = vi.fn(async (_changeId: string) => ({ ok: true as const, data: { status: "acknowledged" as const, acknowledgedAt: "2026-10-23T10:00:00.000Z", auditRecorded: true } }));
    await act(async () => {
      root.render(h(AvailabilityChanges, { clinicId: CLINIC, changes, audits, onRunAudit: NEVER, onAcknowledge }));
    });
    await act(async () => {
      button("Mark as seen").click();
    });
    await act(async () => {});
    expect(onAcknowledge).toHaveBeenCalledWith(CHANGE);
    expect([...container.querySelectorAll('[role="status"]')].map((n) => n.textContent)).toContain("Seen.");
  });
});

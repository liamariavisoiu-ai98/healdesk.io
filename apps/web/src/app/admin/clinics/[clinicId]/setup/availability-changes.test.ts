// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ClinicAuditsView, ClinicChangeView, OpsResult, RunClinicAuditOutcome } from "@/lib/admin/ops-client";

import { AvailabilityChanges, CHANGES_SHOWN, changeWords, noChangesWords } from "./AvailabilityChanges";

/**
 * The Setup tab's "Availability changes" card (wave 2, lane A3): each change
 * in words with who and when, whether it was seen, each pack's latest
 * result with the failing checks' hints; "audits are off" and "running"
 * said once; "Run audit now" disabled while running and its outcome in one
 * line; "Mark as seen" calling the acknowledge operation with the change's
 * id; the empty state naming the window read; the ten newest shown with a
 * count of the rest; a read that failed costing only its half.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CHANGE = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const SEEN = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";
const NOW = "2026-10-24T09:00:00.000Z";
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
    since: "2026-09-24T09:00:00.000Z",
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

const props = { clinicId: CLINIC, changes, audits, now: NOW, onRunAudit: NEVER, onAcknowledge: NEVER };

describe("the card's words", () => {
  test("each change is said in words with who, when, its audit and whether it was seen", () => {
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, props)));
    expect(page).toContain("Availability changes");
    expect(page).toContain("Closed days: added 2026-11-27; taken off 2026-11-20 (3 upcoming)");
    expect(page).toContain("2026-10-23 09:12 UTC · by the clinic");
    expect(page).toContain("audit needs attention");
    expect(page).toContain("Mark as seen");
    expect(page).toContain("Weekly hours changed; 2 holds released");
    expect(page).toContain("by a change file · seen 2026-10-22 10:00 UTC by ops@healdesk.test");
    expect(page).toContain("audit passed");
    expect(page.match(/Mark as seen/g)).toHaveLength(1);
  });

  test("each pack's latest result, its failing checks' hints, and 'never' for a pack that has not run", () => {
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, props)));
    expect(page).toContain("Availability warn 2026-10-23 09:15 UTC A closed day still has bookable slots in the calendar.");
    expect(page).toContain("Roster pass");
    expect(page).toContain("Go-live never");
    expect(page).toContain("Transcripts never");
    expect(page).toContain("Run audit now");
  });

  test("audits off is said once, for the card and not again per change; running disables the button", () => {
    const off = { ...audits, data: { ...audits.data, clinics: [{ ...audits.data.clinics[0]!, overall: "audits_off" as const }] } } as OpsResult<ClinicAuditsView>;
    const offPage = renderToStaticMarkup(h(AvailabilityChanges, { ...props, changes: { ...changes, data: { ...changes.data, changes: [change({ auditStatus: null }), change({ id: SEEN, auditStatus: null })] } }, audits: off }));
    expect(text(offPage)).toContain("audits are off Changes wait for an audit while audits are switched off.");
    expect(text(offPage).match(/audits are off/g)).toHaveLength(1);
    expect(text(offPage)).not.toContain("clinic-audits job");
    const running = { ...audits, data: { ...audits.data, clinics: [{ ...audits.data.clinics[0]!, overall: "running" as const }] } } as OpsResult<ClinicAuditsView>;
    const runningPage = renderToStaticMarkup(h(AvailabilityChanges, { ...props, audits: running }));
    expect(text(runningPage)).toContain("running");
    expect(runningPage).toMatch(/<button[^>]*disabled=""[^>]*>Run audit now<\/button>/);
  });

  test("the empty state names the window read, and a read that failed says so and costs only its half", () => {
    const month = text(renderToStaticMarkup(h(AvailabilityChanges, { ...props, changes: { ok: true, data: { since: "2026-09-24T09:00:00.000Z", changes: [] } } })));
    expect(month).toContain("No changes in the last 30 days.");
    expect(month).not.toContain("No changes yet.");
    const ever = text(renderToStaticMarkup(h(AvailabilityChanges, { ...props, changes: { ok: true, data: { since: "2025-01-01T00:00:00.000Z", changes: [] } } })));
    expect(ever).toContain("No changes yet.");
    expect(noChangesWords("nonsense", NOW)).toBe("No changes in the window read.");
    const failed = { ok: false as const, code: "unreachable" as const, message: "Could not reach the ops API." };
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, { ...props, changes: failed, audits: failed })));
    expect(page).toContain("Could not read the audits: Could not reach the ops API.");
    expect(page).toContain("Could not read the changes: Could not reach the ops API.");
    expect(page).toContain("Run audit now");
    const half = text(renderToStaticMarkup(h(AvailabilityChanges, { ...props, audits: failed })));
    expect(half).toContain("Could not read the audits");
    expect(half).toContain("Closed days: added 2026-11-27");
  });

  test("the ten newest changes are drawn, the rest counted, and the button only on unseen ones", () => {
    const many = Array.from({ length: CHANGES_SHOWN + 3 }, (_, i) =>
      change({ id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, changedAt: `2026-10-${String(23 - i).padStart(2, "0")}T09:00:00.000Z`, acknowledgedAt: i % 2 ? "2026-10-23T10:00:00.000Z" : null }),
    );
    const page = text(renderToStaticMarkup(h(AvailabilityChanges, { ...props, changes: { ok: true, data: { since: "2026-09-24T09:00:00.000Z", changes: many } } })));
    expect(page.match(/Closed days:/g)).toHaveLength(CHANGES_SHOWN);
    expect(page).toContain("3 older changes since 2026-09-24 not shown.");
    expect(page.match(/Mark as seen/g)).toHaveLength(CHANGES_SHOWN / 2);
  });

  test("every change kind has words, from counts and dates only, and no enum ever prints", () => {
    expect(changeWords(change({ kind: "location_hours", summary: {} }))).toBe("A location's hours changed");
    expect(changeWords(change({ kind: "providers", summary: { providersActive: 4 } }))).toBe("Providers changed (4 active)");
    expect(changeWords(change({ kind: "provider_services", summary: { servicesMapped: 12 } }))).toBe("Provider services changed (12 mapped)");
    expect(changeWords(change({ kind: "closures", summary: { rows: 2, operation: "delete" } }))).toBe("Closed days: 2 taken off");
    expect(changeWords(change({ kind: "closures", summary: { rows: 1, operation: "insert" } }))).toBe("Closed days: 1 added");
    expect(changeWords(change({ kind: "closures", summary: { rows: 3, operation: "update" } }))).toBe("Closed days: 3 changed");
    expect(changeWords(change({ kind: "closures", summary: {} }))).toBe("Closed days: changed");
    for (const kind of ["hours", "closures", "location_hours", "providers", "provider_services"] as const) {
      expect(changeWords(change({ kind, summary: { rows: 2, operation: "delete", table: "clinic_closures" } }))).not.toMatch(/delete|insert|update|clinic_/);
    }
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

  test("Run audit now calls the run operation and says what it did, in words", async () => {
    const outcomes: RunClinicAuditOutcome[] = [
      { status: "ran", result: "pass", audits: [], auditRecorded: true },
      { status: "too_soon", notBefore: "2026-10-23T09:13:00.000Z" },
      { status: "busy" },
      { status: "closed" },
      { status: "ran", result: "error", audits: [], auditRecorded: true },
    ];
    const runs: number[] = [];
    const onRunAudit = vi.fn(async () => {
      runs.push(1);
      return { ok: true as const, data: outcomes[runs.length - 1]! };
    });
    await act(async () => {
      root.render(h(AvailabilityChanges, { ...props, onRunAudit }));
    });
    const said: string[] = [];
    for (let i = 0; i < outcomes.length; i += 1) {
      await act(async () => {
        button("Run audit now").click();
      });
      await act(async () => {});
      said.push(container.querySelector('[role="status"]')?.textContent ?? "");
    }
    expect(onRunAudit).toHaveBeenCalledTimes(5);
    expect(said[0]).toBe("Ran: pass.");
    expect(said[1]).toContain("Too soon: a run is allowed once a minute; try again after 2026-10-23 09:13 UTC.");
    expect(said[2]).toBe("Busy: another run for this clinic is under way.");
    expect(said[3]).toBe("Closed account: nothing to audit.");
    expect(said[4]).toBe("The audit could not finish. Try again in a minute.");
  });

  test("Mark as seen calls the acknowledge operation with that change's id", async () => {
    const onAcknowledge = vi.fn(async (_changeId: string) => ({ ok: true as const, data: { status: "acknowledged" as const, acknowledgedAt: "2026-10-23T10:00:00.000Z", auditRecorded: true } }));
    await act(async () => {
      root.render(h(AvailabilityChanges, { ...props, onAcknowledge }));
    });
    await act(async () => {
      button("Mark as seen").click();
    });
    await act(async () => {});
    expect(onAcknowledge).toHaveBeenCalledWith(CHANGE);
    expect([...container.querySelectorAll('[role="status"]')].map((n) => n.textContent)).toContain("Seen.");
  });
});

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { IncidentRegisterRow, OpsResult } from "@/lib/admin/ops-client";

import { affectedLine, IncidentsBoard, reportRecommendations, reportSentLine } from "./IncidentsBoard";

/**
 * What /admin/incidents tells the operator about each incident's clock (WP7):
 * the deadline the practice's agreement promises, and beside it our internal
 * target, labelled as never a promise (owner, 12 October 2026). The page
 * must not present the 24 hours as anything a practice was promised, and it
 * offers the two decisions only where one can still be taken. Rendered to
 * static markup and read as text, as the other admin honesty rules are.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|\u2019/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

const ROW: IncidentRegisterRow = {
  id: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
  clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
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

function board(rows: IncidentRegisterRow[], now = "2026-10-07T12:00:00.000Z"): string {
  const register: OpsResult<IncidentRegisterRow[]> = { ok: true, data: rows };
  return text(
    h(IncidentsBoard, { register, now, actions: { sendReport: NEVER, notReportable: NEVER } }),
  );
}

describe("the incidents page", () => {
  test("shows the agreement's deadline and, beside it, our internal target, which is never a promise", () => {
    const page = board([ROW]);
    expect(page).toContain("The agreement's deadline 2026-12-04 12:00 UTC (agreement 1.5.0)");
    expect(page).toContain(
      "Our internal target 2026-10-06 12:00 UTC — past our target · internal only, never a promise",
    );
    expect(page).not.toContain("PAST THE AGREEMENT'S DEADLINE");
    expect(page).not.toMatch(/24 hours/i);
    // The promise itself, as BAA 1.5.0's Reporting clause words it.
    expect(page).toContain("without unreasonable delay and in no case later than 60 calendar days");
    expect(page).toContain("Send report");
    expect(page).toContain("Not reportable");
  });

  test("past the agreement's own deadline, says so in its own words", () => {
    expect(board([ROW], "2026-12-05T00:00:00.000Z")).toContain("PAST THE AGREEMENT'S DEADLINE");
  });

  test("once a report has gone, offers an update and no longer 'Not reportable'", () => {
    const page = board([
      {
        ...ROW,
        reportsSent: 1,
        reportedAt: "2026-10-06 09:00 UTC",
        notifiedAt: "2026-10-06 09:00 UTC",
      },
    ]);
    expect(page).toContain("Report sent 2026-10-06 09:00 UTC");
    expect(page).toContain("Send an update");
    expect(page).not.toContain("Not reportable");
  });

  test("a not-reportable incident shows its reason and offers nothing more; a service complaint is never reported", () => {
    const decided = board([
      {
        ...ROW,
        notReportableAt: "2026-10-06 09:00 UTC",
        notReportableReason: "Blocked sign-ins only.",
        decidedBy: "ops@healdesk.test",
      },
    ]);
    expect(decided).toContain(
      "Not reportable (2026-10-06 09:00 UTC, ops@healdesk.test): Blocked sign-ins only.",
    );
    expect(decided).not.toContain("Send report");
    const complaint = board([
      { ...ROW, class: "service_complaint", agreementNotifyBy: null, agreementNotifyByIso: null },
    ]);
    expect(complaint).toContain("None: a service complaint is no agreement's to report.");
    expect(complaint).not.toContain("Send report");
  });

  test("an incident with no agreement on file says the strictest rule applied", () => {
    expect(board([{ ...ROW, agreementVersion: null }])).toContain(
      "(no agreement on file: the strictest rule)",
    );
  });

  test("notifying the people affected is offered only in a breach's report, the one that links to its list", () => {
    const codes = (cls: IncidentRegisterRow["class"]) => reportRecommendations(cls).map(([code]) => code);
    expect(codes("breach")).toContain("notify_people");
    expect(codes("security_incident")).not.toContain("notify_people");
    expect(codes("improper_use_or_disclosure")).not.toContain("notify_people");
    expect(codes("security_incident")).toContain("assess_notice_duty");
  });

  test("who an incident affected is a count and where it is recorded, never who, and unknown before apps/app has it", () => {
    const none = board([ROW]);
    expect(none).toContain("Who it affected No one recorded yet.");
    // The AWS host has no shell: its one-off task, as the runbook gives it.
    expect(none).toContain("run-task.sh incident-affected");
    expect(none).toContain("npm run ops:incident-affected");
    expect(none).toContain("The report itself never names anyone.");
    expect(board([{ ...ROW, affectedCount: 3 }])).toContain("3 people recorded.");
    expect(affectedLine(1)).toMatch(/^1 person recorded\./);
    // An apps/app before its deploy sends no count: said as unknown, never as none.
    expect(board([{ ...ROW, affectedCount: null }])).toContain(
      "Not known here until apps/app is deployed.",
    );
    // A service complaint affects no one an agreement reports.
    expect(board([{ ...ROW, class: "service_complaint" }])).not.toContain("Who it affected");
  });

  test("a report's written steps for the people affected and our recommendations, and a reply from an older apps/app that dropped them", () => {
    const sent = { status: "sent" as const, report: 1, auditRecorded: true };
    expect(reportSentLine({ ...sent, steps: 2, recommendations: 1 }, { steps: 2, recommendations: 1 })).toBe(
      "Report queued: it goes to the practice's address now.",
    );
    // apps/web is live before apps/app: the older reply has no counts and the lists were ignored.
    expect(
      reportSentLine({ ...sent, steps: null, recommendations: null }, { steps: 1, recommendations: 0 }),
    ).toContain("It went WITHOUT the steps and recommendations you chose");
    // Nothing chosen, nothing dropped.
    expect(
      reportSentLine({ ...sent, steps: null, recommendations: null }, { steps: 0, recommendations: 0 }),
    ).toBe("Report queued: it goes to the practice's address now.");
    expect(
      reportSentLine({ ...sent, report: 3, steps: 0, recommendations: 0, auditRecorded: false }, {
        steps: 0,
        recommendations: 0,
      }),
    ).toBe("Update 2 queued: it goes to the practice's address now. It is NOT in the audit log: record it by hand.");
  });
});

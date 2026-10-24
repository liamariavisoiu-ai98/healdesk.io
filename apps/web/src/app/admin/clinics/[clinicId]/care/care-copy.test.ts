import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import type { CareView, OpsResult } from "@/lib/admin/ops-client";

import { CarePanel } from "./CarePanel";

/**
 * What the care page tells the operator about a leaving practice's export.
 *
 * BAA 1.2.1 and earlier give the export "on request", but Terms §7 promises
 * every practice one within thirty days of the end, and the canceled email
 * tells it one is coming, so a practice has no reason to ask. Under those
 * agreements the data is destroyed at day 29 whatever the export, so a page
 * that said to deliver "any export the practice asked for" let an operator
 * leave a practice that was told to expect its records without them, for
 * good. Rendered to static markup and read as text, as the other admin
 * honesty rules are.
 */

function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type Actions = Parameters<typeof CarePanel>[0]["actions"];

const NOT_IN_A_RENDER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};
const ACTIONS: Actions = {
  addRecipient: NOT_IN_A_RENDER,
  removeRecipient: NOT_IN_A_RENDER,
  openIncident: NOT_IN_A_RENDER,
  markNotified: NOT_IN_A_RENDER,
  resolve: NOT_IN_A_RENDER,
  startOffboarding: NOT_IN_A_RENDER,
  markExportDelivered: NOT_IN_A_RENDER,
  markVoiceVendorDataDeleted: NOT_IN_A_RENDER,
  markErasureVendorDeleted: NOT_IN_A_RENDER,
};

type Vendor = NonNullable<CareView["clinic"]["voiceVendorDeletion"]>;

function leaving(
  destruction: NonNullable<CareView["clinic"]["destruction"]>,
  exportDeliveredOn: string | null = null,
  vendor: Partial<Vendor> = {},
): OpsResult<CareView> {
  return {
    ok: true,
    data: {
      clinic: {
        id: "0c1d2e3f-0000-4000-8000-000000000000",
        slug: "leaving-clinic",
        name: "Leaving Clinic",
        dataClassification: "synthetic",
        isCoveredEntity: true,
        wentLiveOn: "2026-09-01",
        offboardingStartedOn: "2026-11-01",
        exportDeliveredOn,
        destroyAfterOn: "2026-12-01",
        destroyedOn: null,
        destruction,
        voiceVendorDeletion: {
          deadline: destruction.destroyDueAt,
          recordedAt: null,
          recordedBy: null,
          how: null,
          agentNotBefore: "2026-12-01 15:00 UTC",
          agentReleasable: false,
          agentRecordedAt: null,
          agentRecordedBy: null,
          agentHow: null,
          ...vendor,
        },
      },
      patientRights: { amendments: 0, corrections: 0 },
      deletionRequests: [],
      recipients: [],
      deliveries: [],
      incidents: [],
    },
  };
}

const THIRTY_DAYS = {
  rule: "thirty_days",
  basis: "agreement",
  agreementVersion: "1.2.1",
  exportDueAt: "2026-11-30 15:00 UTC",
  destroyDueAt: "2026-11-30 15:00 UTC",
  latestDestroyAt: "2026-11-30 15:00 UTC",
} as const;

/** BAA 1.3.0 with no export delivered: due at day 89, and at day 29 once one is. */
const EXPORT_RULE = {
  rule: "export_or_ninety",
  basis: "agreement",
  agreementVersion: "1.3.0",
  exportDueAt: "2026-11-30 15:00 UTC",
  destroyDueAt: "2027-01-29 15:00 UTC",
  latestDestroyAt: "2027-01-29 15:00 UTC",
} as const;

describe("the care page's export step", () => {
  test("under the thirty days, with none delivered: deliver it before destruction, asked for or not", () => {
    const page = text(h(CarePanel, { view: leaving(THIRTY_DAYS), actions: ACTIONS }));
    expect(page).toContain(
      "Not yet delivered. Deliver it and record the handover before 2026-11-30 15:00 UTC",
    );
    expect(page).toContain("whether or not it asks (Terms §7)");
    expect(page).not.toMatch(/asked for/);
  });

  test("with no agreement on file, the same", () => {
    const page = text(
      h(CarePanel, {
        view: leaving({ ...THIRTY_DAYS, basis: "no_agreement", agreementVersion: null }),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain("whether or not it asks (Terms §7)");
    expect(page).not.toMatch(/asked for/);
  });

  test("delivered, it says when the data goes and asks for nothing more", () => {
    const page = text(h(CarePanel, { view: leaving(THIRTY_DAYS, "2026-11-10"), actions: ACTIONS }));
    expect(page).toContain(
      "Export delivered 2026-11-10. Destruction is due at 2026-11-30 15:00 UTC.",
    );
    expect(page).not.toContain("Not yet delivered");
  });
});

// BAA 1.3.0 destroys "thirty days after the Services end if the export has
// been delivered by then; otherwise as soon as the export is delivered; and
// in any case no later than ninety days", and the DPA the same. The job runs
// every hour for every rule and meets each limit a day early, so the page
// names the day-29 and day-89 times and no once-a-day run.
describe("the care page's rule under BAA 1.3.0 and the DPA", () => {
  test("it gives day 29 with the export, every hourly run after a later delivery, and day 89 without", () => {
    const page = text(h(CarePanel, { view: leaving(EXPORT_RULE), actions: ACTIONS }));
    expect(page).toContain(
      "Destroyed at 2026-11-30 15:00 UTC, a day before the thirty days are up, if the export is recorded by then",
    );
    expect(page).toContain("otherwise at the first hourly run after it is recorded");
    expect(page).toContain(
      "and at 2027-01-29 15:00 UTC, a day before the ninety days are up, if it never is",
    );
    expect(page).toContain("Not yet delivered: owed by 2026-11-30 15:00 UTC");
    expect(page).not.toMatch(/04:00|once a day|daily/);
  });

  test("delivered, it says when the data goes", () => {
    const page = text(
      h(CarePanel, {
        view: leaving({ ...EXPORT_RULE, destroyDueAt: "2026-11-30 15:00 UTC" }, "2026-11-10"),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain(
      "Export delivered 2026-11-10. Destruction is due at 2026-11-30 15:00 UTC.",
    );
  });
});

// The voice vendor (the audit's R8 item 4): the clinic's calls are PHI and go
// by the destruction, which can be day 29; its agent is what passes forwarded
// calls through to the direct line until the pass-through ends on day 30.
// Until 19 October the page asked for "the calls and agent" by the
// destruction date, and to switch the agent off at the start. The agent's
// step also deletes the calls it took after the first deletion: each
// passed-through call is a new record at Retell.
describe("the care page's Retell steps", () => {
  /** The page in plain text, with its typographic apostrophes as plain ones. */
  const plain = (node: React.ReactElement) => text(node).replace(/\u2019/g, "'");

  test("the calls by the destruction date, the agent not before the pass-through ends, and no switching it off at the start", () => {
    const page = plain(h(CarePanel, { view: leaving(THIRTY_DAYS), actions: ACTIONS }));
    expect(page).toContain(
      "Outstanding: delete the clinic's calls in Retell's console by 2026-11-30 15:00 UTC, when its data is destroyed here, then record it. Leave its agent and number in place until the pass-through ends.",
    );
    expect(page).toContain(
      "Not before 2026-12-01 15:00 UTC: release the clinic's agent and its number at Retell, and delete every call it took since its calls were first deleted. Until then the agent is what passes forwarded calls through to the clinic's direct line",
    );
    expect(page).toContain("Leave its agent on at the voice vendor");
    expect(page).not.toMatch(/calls and agent/);
    expect(page).not.toMatch(/Switch the agent off/);
    expect(page).toContain("Record Retell call deletion");
    expect(page).not.toContain("Record Retell agent release");
  });

  test("from an apps/app that does not split the steps yet, the page still reads: no agent date, no agent button, the calls step as before", () => {
    // apps/web goes live when main moves, apps/app when the owner deploys
    // (wave2-common): an older reply has no agent fields, and the client reads
    // them as their safe defaults (ops-client.test.ts); the page then offers
    // nothing the older apps/app could not record.
    const page = plain(
      h(CarePanel, {
        view: leaving(THIRTY_DAYS, null, {
          agentNotBefore: null,
          agentReleasable: false,
          agentRecordedAt: null,
          agentRecordedBy: null,
          agentHow: null,
        }),
        actions: ACTIONS,
      }),
    );
    expect(page).toContain("Outstanding: delete the clinic's calls in Retell's console by 2026-11-30 15:00 UTC");
    expect(page).toContain("Not before the pass-through ends: release the clinic's agent and its number at Retell");
    expect(page).toContain("Record Retell call deletion");
    expect(page).not.toContain("Record Retell agent release");
    expect(page).not.toMatch(/null|undefined/);
  });

  test("once the pass-through has ended the release is owed and can be recorded; each record shows on its own", () => {
    const due = plain(
      h(CarePanel, {
        view: leaving(THIRTY_DAYS, "2026-11-10", {
          recordedAt: "2026-11-29 10:00 UTC",
          recordedBy: "ops@healdesk.test",
          how: "calls deleted",
          agentReleasable: true,
        }),
        actions: ACTIONS,
      }),
    );
    expect(due).toContain("Calls deleted at Retell: recorded 2026-11-29 10:00 UTC by ops@healdesk.test (calls deleted).");
    expect(due).toContain(
      "Outstanding: the pass-through ended 2026-12-01 15:00 UTC. Release the clinic's agent and its number in Retell's console, delete every call Retell holds for the clinic since its calls were first deleted (the calls passed through to its direct line), then record it.",
    );
    expect(due).toContain("Record Retell agent release");
    expect(due).not.toContain("Record Retell call deletion");
    const done = plain(
      h(CarePanel, {
        view: leaving(THIRTY_DAYS, "2026-11-10", {
          recordedAt: "2026-11-29 10:00 UTC",
          recordedBy: "ops@healdesk.test",
          agentReleasable: true,
          agentRecordedAt: "2026-12-02 09:00 UTC",
          agentRecordedBy: "ops@healdesk.test",
          agentHow: "agent and number released",
        }),
        actions: ACTIONS,
      }),
    );
    expect(done).toContain(
      "Agent and number released, and the calls since deleted, at Retell: recorded 2026-12-02 09:00 UTC by ops@healdesk.test (agent and number released).",
    );
    expect(done).not.toMatch(/Record Retell/);
  });
});

// A deletion, an amendment and a correction carry a patient's details, so
// they are entered in apps/app's own shell and never on this page: until 12
// October 2026 its forms sent them through a Vercel server action.
describe("the care page takes no patient data", () => {
  test("it has no field for a number, an address, a name or an amendment's words, and names the scripts instead", () => {
    const html = renderToStaticMarkup(h(CarePanel, { view: leaving(THIRTY_DAYS), actions: ACTIONS }));
    // (The report recipients' form keeps its one `email` field: a clinic
    // staff address, business contact data, not a patient's.)
    for (const field of ["phone", "fullName", "amendment", "targetId", "contactId", "requestedBy", "receivedAt"]) {
      expect(html, field).not.toContain(`name="${field}"`);
    }
    expect(html.match(/name="email"/g) ?? []).toHaveLength(1);
    const page = text(h(CarePanel, { view: leaving(THIRTY_DAYS), actions: ACTIONS }));
    expect(page).toContain("npm run ops:erase-person -w @healdesk/app");
    expect(page).toContain("npm run ops:amend-record -w @healdesk/app");
    expect(page).toContain("npm run ops:amend-contact -w @healdesk/app");
    expect(page).toContain("0 amendments appended · 0 contact corrections");
  });
});

// The incident clocks (WP7; owner, 12 October 2026): the agreements promise
// "without unreasonable delay and in no case later than 60 calendar days",
// and 24 hours is healdesk's internal target. Until then this page labelled
// each class "(24 hours to tell the clinic)" as if the agreement said so.
describe("the care page's incident clocks", () => {
  function withIncident(incident: Partial<CareView["incidents"][number]>): OpsResult<CareView> {
    const view = leaving(THIRTY_DAYS);
    if (!view.ok) throw new Error("unreachable");
    return {
      ok: true,
      data: {
        ...view.data,
        incidents: [
          {
            id: "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a",
            class: "security_incident",
            summary: "Notice 7f3a went to a second inbox.",
            conversationId: null,
            discoveredAt: "2026-10-05 12:00 UTC",
            notifyBy: "2026-10-06 12:00 UTC",
            ftcNotifyBy: null,
            notifiedAt: null,
            notifiedHow: null,
            resolvedAt: null,
            resolution: null,
            openedBy: "ops@healdesk.test",
            agreementNotifyBy: "2026-12-04 12:00 UTC",
            reportsSent: 0,
            notReportableReason: null,
            ...incident,
          },
        ],
      },
    };
  }

  test("show the agreement's deadline and our internal target, and never a 24-hour promise", () => {
    const page = text(h(CarePanel, { view: withIncident({}), actions: ACTIONS }));
    expect(page).toContain("The agreement's deadline: 2026-12-04 12:00 UTC");
    expect(page).toContain("our internal target: 2026-10-06 12:00 UTC");
    expect(page).not.toMatch(/24 hours/);
    expect(page).toContain("Send the report, or record it as not reportable, from Incidents");
  });

  test("say what was decided", () => {
    expect(text(h(CarePanel, { view: withIncident({ reportsSent: 2 }), actions: ACTIONS }))).toContain(
      "Report and 1 update(s) sent from Incidents.",
    );
    expect(
      text(h(CarePanel, { view: withIncident({ notReportableReason: "Blocked sign-ins only." }), actions: ACTIONS })),
    ).toContain("Not reportable: Blocked sign-ins only.");
  });
});

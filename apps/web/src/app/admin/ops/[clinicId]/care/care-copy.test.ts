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
  erasePerson: NOT_IN_A_RENDER,
  markErasureVendorDeleted: NOT_IN_A_RENDER,
  amendRecord: NOT_IN_A_RENDER,
  amendContact: NOT_IN_A_RENDER,
};

function leaving(
  destruction: NonNullable<CareView["clinic"]["destruction"]>,
  exportDeliveredOn: string | null = null,
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
        },
      },
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

import { describe, expect, it } from "vitest";

import type { DemoSession } from "@/lib/sheets/schema";

import { claimedShare, conversionBySource, countDemos, demoPipeline, demoSource, wasBuilt } from "./pipeline";
import { DEMO_LIFETIME_MS } from "./sessions";

/**
 * The pipeline's numbers over fixed rows (lib/demo/pipeline.ts): a window is
 * the rows created in it, "built" means the link opened at some point, a
 * claimed row is never also an expired one, the states a row is in now are
 * counted over every row, and a share with nothing built is absent rather
 * than 0%.
 */

const NOW = new Date("2026-10-23T12:00:00Z").getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function row(overrides: Partial<DemoSession> & { createdDaysAgo: number }): DemoSession {
  const { createdDaysAgo, ...rest } = overrides;
  const createdAt = new Date(NOW - createdDaysAgo * DAY);
  return {
    id: `id-${createdDaysAgo}`,
    slug: `clinic-${createdDaysAgo}-abcdefghij`,
    status: "ready",
    leadEmail: null,
    clinicName: "Clinic",
    websiteUrl: "https://clinic.test/",
    phoneE164: null,
    niche: null,
    specialty: null,
    brandName: null,
    logoUrl: null,
    brandColor: null,
    profile: null,
    scrapeSource: null,
    buildNote: null,
    createdBy: "ops@healdesk.test",
    createdAt,
    readyAt: new Date(createdAt.getTime() + 3 * MINUTE),
    expiresAt: new Date(createdAt.getTime() + DEMO_LIFETIME_MS),
    claimed: false,
    claimedAt: null,
    claimedPlan: null,
    emailSentAt: null,
    buildStartedAt: createdAt,
    emailRequested: false,
    auditVerdict: "pass",
    auditScore: 90,
    auditReport: null,
    auditedAt: null,
    auditHash: null,
    ...rest,
  };
}

/** The register as a busy month leaves it; the comments say what each row proves. */
const ROWS: DemoSession[] = [
  // Live, built by an operator yesterday.
  row({ createdDaysAgo: 1 }),
  // Live and sold.
  row({ createdDaysAgo: 2, claimed: true, claimedAt: new Date(NOW - DAY), claimedPlan: "voice-500" }),
  // Held by the audit: requested, never built.
  row({ createdDaysAgo: 3, createdBy: "webhook", status: "held", readyAt: null, auditVerdict: "held" }),
  // Failed.
  row({ createdDaysAgo: 4, createdBy: "webhook", status: "failed", readyAt: null, auditVerdict: null }),
  // Stalled: building for twenty minutes, past the eight the route allows.
  row({ createdDaysAgo: 5, createdBy: "homepage", status: "building", readyAt: null, auditVerdict: null, buildStartedAt: new Date(NOW - 20 * MINUTE) }),
  // Running: building for two minutes. Neither stalled nor built.
  row({ createdDaysAgo: 6, status: "auditing", readyAt: null, auditVerdict: null, buildStartedAt: new Date(NOW - 2 * MINUTE) }),
  // Outreach demo whose week ran out unsold: in the month, not the week.
  row({ createdDaysAgo: 10, createdBy: "webhook" }),
  // Homepage demo that sold, now expired: claimed, never "expired unclaimed".
  row({ createdDaysAgo: 20, createdBy: "homepage", claimed: true, claimedAt: new Date(NOW - 19 * DAY), claimedPlan: "chat-300" }),
  // Forty days old, rebuilt by hand and stalled again: outside both windows, stalled now.
  row({ createdDaysAgo: 40, status: "building", readyAt: null, buildStartedAt: new Date(NOW - 30 * MINUTE) }),
];

describe("where a demo came from", () => {
  it("reads created_by the way the register does", () => {
    expect(demoSource({ createdBy: "homepage" })).toBe("homepage");
    expect(demoSource({ createdBy: "webhook" })).toBe("outreach");
    expect(demoSource({ createdBy: "ops@healdesk.test" })).toBe("operator");
    expect(demoSource({ createdBy: null })).toBe("operator");
  });

  it("counts a demo as built once its link opened, held or failed ones never", () => {
    expect(wasBuilt({ readyAt: new Date(NOW), status: "ready", claimed: false })).toBe(true);
    expect(wasBuilt({ readyAt: null, status: "ready", claimed: false })).toBe(true);
    expect(wasBuilt({ readyAt: null, status: "building", claimed: true })).toBe(true);
    expect(wasBuilt({ readyAt: null, status: "held", claimed: false })).toBe(false);
    expect(wasBuilt({ readyAt: null, status: "failed", claimed: false })).toBe(false);
  });
});

describe("the pipeline over a month of rows", () => {
  const pipeline = demoPipeline(ROWS, NOW);
  const week = pipeline.windows.find((w) => w.days === 7)!;
  const month = pipeline.windows.find((w) => w.days === 30)!;

  it("counts the week's rows", () => {
    expect(week).toMatchObject({ requested: 6, built: 2, live: 2, held: 1, failed: 1, stalled: 1, expired: 0, claimed: 1 });
    expect(week.bySource).toEqual([
      { source: "operator", built: 2, claimed: 1 },
      { source: "outreach", built: 0, claimed: 0 },
      { source: "homepage", built: 0, claimed: 0 },
    ]);
  });

  it("counts the month's rows, with a sold demo claimed rather than expired", () => {
    expect(month).toMatchObject({ requested: 8, built: 4, live: 2, held: 1, failed: 1, stalled: 1, expired: 1, claimed: 2 });
    expect(month.bySource).toEqual([
      { source: "operator", built: 2, claimed: 1 },
      { source: "outreach", built: 1, claimed: 0 },
      { source: "homepage", built: 1, claimed: 1 },
    ]);
  });

  it("counts the states a row is in now over every row, windows aside", () => {
    // The forty-day-old rebuild is stalled now and in neither window.
    expect(pipeline.now).toEqual({ live: 2, held: 1, failed: 1, stalled: 2 });
    expect(pipeline.rows).toBe(9);
  });

  it("says when the read's cap cut the month short", () => {
    expect(pipeline.truncated).toBe(false);
    // Nine rows read at a cap of nine, but the oldest is older than the month: the month is whole.
    expect(demoPipeline(ROWS, NOW, 9).truncated).toBe(false);
    // Eight at a cap of eight with the oldest inside the month: there may be more.
    expect(demoPipeline(ROWS.slice(0, 8), NOW, 8).truncated).toBe(true);
  });

  it("gives no share when nothing was built to convert from", () => {
    expect(claimedShare({ built: 0, claimed: 0 })).toBeNull();
    expect(claimedShare({ built: 4, claimed: 1 })).toBe(0.25);
    expect(countDemos([], NOW)).toEqual({ requested: 0, built: 0, live: 0, held: 0, failed: 0, stalled: 0, expired: 0, claimed: 0 });
    expect(conversionBySource([])).toEqual([
      { source: "operator", built: 0, claimed: 0 },
      { source: "outreach", built: 0, claimed: 0 },
      { source: "homepage", built: 0, claimed: 0 },
    ]);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { couldNotReadWords, lateWords, LAUNCH_PROMISES_WORDS, PACK_JOB_OFF, partialWords, SIGN_INS_WORDS, TARGET_MISSED_HEADING } from "@/components/admin/pack-words";
import type { CompliancePackRecordView, CompliancePackSummaryView, CompliancePackView, OpsResult } from "@/lib/admin/ops-client";

import { PackView, PRINT_HIDE_RULE } from "./[week]/PackView";
import { madeWords, MAKE_WORDS, PackList, type MakePack } from "./PackList";

/**
 * The compliance pack pages (lane P6j): the printable pack with every
 * section in words, each number labelled with what it measures and when,
 * the three labels explained once, a section that could not be read saying
 * so with no number, the incomplete and late banners, the launch promises
 * read from this app, and the print markup; and the list of weeks with
 * "Make this week's pack" beside a week that has none, calling the action
 * with that week.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INCIDENT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const HASH = "a".repeat(64);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const payload: CompliancePackView = {
  schema: 1,
  week: { start: "2026-10-19", lastDay: "2026-10-25", timeZone: "America/New_York", from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" },
  build: { partial: false, unreadSections: [], builtLate: false, lateDays: 0 },
  headline: { incidentsOpen: 1, rightsOverdue: 0, resignsOpen: 2, vendorsNeedingAttention: 3, transcriptCopiesPast30Days: 0 },
  agreements: {
    status: "ok",
    boundThisWeek: [{ kind: "baa", version: "1.5.1", count: 2 }],
    resigns: { openedThisWeek: 1, signedThisWeek: 0, withdrawnThisWeek: 0, openAtWeekEnd: 2, openAtWeekEndBelowFloorNow: 1 },
    reviews: { openedThisWeek: 0, decidedThisWeek: 1, openAtWeekEndNow: 0 },
  },
  vendors: {
    status: "ok",
    subjects: [
      { subject: "anthropic", kind: "vendor", state: "in_force", effectiveOn: "2026-09-01", expiresOn: "2026-11-10", expiresWithin30Days: true },
      { subject: "retell", kind: "vendor", state: "not_attested", effectiveOn: null, expiresOn: null, expiresWithin30Days: false },
      { subject: "runtime_web", kind: "readiness", state: "in_force", effectiveOn: "2026-09-01", expiresOn: null, expiresWithin30Days: false },
    ],
    recordedThisWeek: 1,
  },
  incidents: {
    status: "ok",
    openedThisWeek: 1,
    openedByClass: [{ class: "breach", count: 1 }],
    notifiedThisWeek: 0,
    reportedThisWeek: 0,
    notReportableThisWeek: 0,
    resolvedThisWeek: 0,
    openAtWeekEnd: 2,
    reportableOpenAtWeekEnd: 1,
    targetMissed: [{ clinicId: CLINIC, incidentId: INCIDENT }],
    agreementDeadlineAtRisk: [{ clinicId: CLINIC, incidentId: INCIDENT, agreementNotifyBy: "2026-11-03T12:00:00.000Z" }],
  },
  rights: { status: "could_not_read", unreadClinics: 1 },
  dataLifecycle: {
    status: "ok",
    transcripts: { queuedThisWeek: 5, deliveredThisWeek: 5, copiesPast30DaysNow: 0 },
    jobsNow: [
      { job: "retention-purge", enabled: true, lastRunAt: "2026-10-25T03:00:00.000Z", lastRunStatus: "ok" },
      { job: "transcript-emails", enabled: false, lastRunAt: null, lastRunStatus: null },
      { job: "offboarding-destroy", enabled: true, lastRunAt: "2026-10-25T03:00:00.000Z", lastRunStatus: "ok" },
    ],
    failureAlertsThisWeek: [
      { event: "retention_purge_failed", count: 0 },
      { event: "transcript_undelivered", count: 1 },
      { event: "export_undelivered_before_destruction", count: 0 },
    ],
  },
  access: {
    status: "ok",
    events: [
      { event: "approval_approved", count: 2 },
      { event: "passkey_added", count: 1 },
    ],
    freshCodeSteps: { approvalDecisions: 2, platformAttestations: 1, deviceRecoveriesIssued: 0 },
    operatorSignIns: "not_recorded_on_the_host",
  },
  approvals: { status: "ok", approvedThisWeek: 2, rejectedThisWeek: 0, executedThisWeek: 2, failedThisWeek: 0, expiredThisWeek: 0, medianMinutesToDecide: 95, waitingAtWeekEnd: 1 },
  launchPromises: { status: "read_on_the_console" },
};

const record: CompliancePackRecordView = {
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  weekStart: "2026-10-19",
  generatedAt: "2026-10-26T11:00:00.000Z",
  generatedBy: "compliance-pack",
  payloadHash: HASH,
  payload,
};

describe("the printable pack", () => {
  test("the week, how it was stored, the three labels explained, the headline, and every section in words", () => {
    const html = renderToStaticMarkup(h(PackView, { record }));
    const page = text(html);
    expect(page).toContain("Compliance pack");
    expect(page).toContain("Week of Monday 19 Oct to Sunday 25 Oct 2026, New York");
    expect(page).toContain("Stored 26 Oct 2026, 11:00 UTC by the weekly compliance-pack job. A stored pack never changes.");
    expect(page).toContain(HASH);
    expect(page).toContain("How to read the numbers");
    expect(page).toContain("this week events whose own time fell inside the week");
    expect(page).toContain("at week end the state at the week's last instant");
    expect(page).toContain("now as the database stood when the pack was made");
    expect(page).toContain("The five headline numbers");
    expect(page).toContain("1 Incidents open at week end incidents not resolved when the week ended, less service complaints");
    expect(page).toContain("3 Vendor agreements needing attention");
    // Agreements.
    expect(page).toContain("2 BAA version 1.5.1");
    expect(page).toContain("2 Re-signs open at week end");
    expect(page).toContain("1 Of them, below the floor now");
    expect(page).toContain("1 Agreement checks decided this week");
    // Vendors.
    expect(page).toContain("Anthropic (the AI model provider) vendor agreement in force, ends within 30 days 1 Sept 2026 10 Nov 2026");
    expect(page).toContain("Retell (the voice provider) vendor agreement not attested — none set");
    expect(page).toContain("Website chat runtime deployed and tested readiness in force");
    // Incidents, with the two lists.
    expect(page).toContain("1 Of them, reportable at week end");
    expect(page).toContain("1 breach of unsecured PHI");
    expect(page).toContain(TARGET_MISSED_HEADING);
    expect(page).toContain("two business days to a first reply");
    expect(page).not.toContain("24-hour target missed");
    expect(page).toContain("never a promise to a clinic");
    expect(page.match(/never one recorded not reportable/g)).toHaveLength(2);
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain(`incident ${INCIDENT} : agreement deadline 3 Nov 2026`);
    // Data lifecycle, access, approvals.
    // A job's last run in words (jobs.ts record statuses), never the raw status or a dash.
    expect(page).toContain("Retention purge on 25 Oct 2026, 03:00 UTC went through");
    expect(page).toContain("Transcript emails off never no run recorded");
    expect(page).not.toContain("never —");
    expect(page).toContain("1 a transcript copy was not delivered");
    expect(page).toContain("2 an approval approved");
    expect(page).toContain(SIGN_INS_WORDS);
    // The attestations are counted once, under Vendors and readiness, never again under Access.
    expect(page.match(/Attestations recorded/g)).toHaveLength(1);
    expect(page).not.toContain("Platform attestations");
    expect(page).toContain("1 Waiting at week end");
    expect(page).toContain("Taken off the list without running this week");
    expect(page).toContain("1.6 hours Median time to decide this week");
    // The launch promises from this app, said to be read now.
    expect(page).toContain(LAUNCH_PROMISES_WORDS);
    expect(page).toContain("Launch:");
    expect(page).toContain("blocks go-live");
    // No banner when complete and on time.
    expect(page).not.toContain("Incomplete:");
    expect(page).not.toContain("Made after its due time");
    for (const raw of ["in_force", "not_attested", "retention-purge", "approval_approved", "openAtWeekEnd", "could_not_read"]) expect(page).not.toContain(raw);
  });

  test("a section that could not be read says so and shows no number for it, never a zero", () => {
    const page = text(renderToStaticMarkup(h(PackView, { record })));
    expect(page).toContain(couldNotReadWords(1));
    expect(page).not.toContain("Patient-rights requests received");
    expect(page).not.toContain("0 Received this week");
    // The headline's rights number is read, so it still shows; a null headline number says it could not be read.
    const nulls = { ...record, payload: { ...payload, headline: { ...payload.headline, rightsOverdue: null } } };
    const withNull = text(renderToStaticMarkup(h(PackView, { record: nulls })));
    expect(withNull).toContain("could not be read Patient-rights requests overdue");
    expect(withNull).not.toContain("0 Patient-rights requests overdue");
  });

  test("the incomplete and late banners, in their words: a hand-made partial pack, and one hours late with zero whole days", () => {
    const late = { ...record, generatedBy: "ops-console", payload: { ...payload, build: { partial: true, unreadSections: ["rights" as const], builtLate: true, lateDays: 3 } } };
    const page = text(renderToStaticMarkup(h(PackView, { record: late })));
    expect(page).toContain(partialWords(["rights"]));
    expect(page).toContain("Incomplete: the Patient rights section could not be read when the pack was made, two or more days after the week was due, so it was stored missing.");
    expect(page).toContain(lateWords(3));
    expect(page).toContain("Made after its due time (07:00 New York on the Monday after the week): 3 days late.");
    expect(page).not.toContain("did not run");
    expect(page).toContain("by the console, by hand");
    // builtLate with lateDays 0 (job.ts buildInfo: an hour late, under a day): a real banner, never "0 days late".
    const hoursLate = { ...record, payload: { ...payload, build: { partial: false, unreadSections: [], builtLate: true, lateDays: 0 } } };
    const hours = text(renderToStaticMarkup(h(PackView, { record: hoursLate })));
    expect(hours).toContain("Made after its due time (07:00 New York on the Monday after the week): less than a day late.");
    expect(hours).not.toContain("0 days late");
    expect(hours).not.toContain("Incomplete:");
  });

  test("a median with no decision says so", () => {
    const none = { ...record, payload: { ...payload, approvals: { ...payload.approvals, medianMinutesToDecide: null } } };
    const page = text(renderToStaticMarkup(h(PackView, { record: none })));
    expect(page).toContain("none Median time to decide");
    expect(page).toContain("No decision was made this week, so there is no median.");
  });

  test("the print markup: a stylesheet that hides the console's one header and the controls and breaks before each group after the first", () => {
    const html = renderToStaticMarkup(h(PackView, { record }));
    expect(html).toContain("@media print");
    expect(html).toContain(PRINT_HIDE_RULE);
    // The rule hides every <header>: the admin layout renders exactly one (its chrome), and this page renders none, so it hides that and nothing else.
    expect(PRINT_HIDE_RULE).toBe("header, .no-print { display: none !important; }");
    const layout = readFileSync(join(__dirname, "..", "..", "layout.tsx"), "utf8");
    expect(layout.match(/<header\b/g)).toHaveLength(1);
    expect(layout).toMatch(/<header className="[^"]*sticky top-0[^"]*"/);
    expect(html).not.toMatch(/<header\b/);
    expect(html).toContain(".pack-group { break-before: page;");
    expect((html.match(/class="pack-group print:break-before-page"/g) ?? []).length).toBe(3);
    expect(html).toContain('class="pack-group"');
    expect(html).toContain(">Print<");
    expect(html).toContain("no-print");
  });
});

const packs: CompliancePackSummaryView[] = [
  { id: "1", weekStart: "2026-10-19", generatedAt: "2026-10-26T11:00:00.000Z", generatedBy: "compliance-pack", payloadHash: HASH, headline: payload.headline },
  { id: "2", weekStart: "2026-10-05", generatedAt: "2026-10-12T11:00:00.000Z", generatedBy: "ops-console", payloadHash: HASH, headline: { ...payload.headline, rightsOverdue: null } },
  { id: "3", weekStart: "2026-06-01", generatedAt: "2026-06-08T11:00:00.000Z", generatedBy: "compliance-pack", payloadHash: HASH, headline: null },
];
const weeks = ["2026-10-19", "2026-10-12", "2026-10-05"];
const NO_MAKE: MakePack = async () => ({ ok: true, data: { status: "refused", message: "x" } });

describe("the list of packs", () => {
  test("each recent week stored or not, the headline numbers, a null said as not read, and the older packs after", () => {
    const html = renderToStaticMarkup(h(PackList, { weeks, packs: { ok: true, data: packs } as OpsResult<CompliancePackSummaryView[]>, packJobOn: true, onMake: NO_MAKE }));
    const page = text(html);
    expect(html).toContain('href="/admin/compliance/pack/2026-10-19"');
    expect(html).toContain('href="/admin/compliance/pack/2026-10-05"');
    expect(html).toContain('href="/admin/compliance/pack/2026-06-01"');
    expect(html).not.toContain('href="/admin/compliance/pack/2026-10-12"');
    // An older missing week: "Make this pack"; "Make this week's pack" is the due week's alone.
    expect(page).toContain("12 Oct 2026 Not stored. Make this pack");
    expect(page).not.toContain("Make this week's pack");
    expect(page).toContain("26 Oct 2026, 11:00 UTC by the weekly compliance-pack job");
    expect(page).toContain("12 Oct 2026, 11:00 UTC by the console, by hand");
    expect(page).toContain("not read");
    expect(page).not.toContain(PACK_JOB_OFF);
    // The older pack with no headline shows "not read" five times, never zeros.
    expect(page).not.toContain("1 Jun 2026 8 Jun 2026, 11:00 UTC by the weekly compliance-pack job 0");
    // The due week missing: its control is "Make this week's pack", once.
    const dueMissing = text(renderToStaticMarkup(h(PackList, { weeks: ["2026-10-26", ...weeks], packs: { ok: true, data: packs }, packJobOn: true, onMake: NO_MAKE })));
    expect(dueMissing).toContain("26 Oct 2026 Not stored. Make this week's pack");
    expect(dueMissing.match(/Make this week's pack/g)).toHaveLength(1);
    expect(dueMissing.match(/Make this pack/g)).toHaveLength(1);
  });

  test("the pack job's switch read off says no week is made by itself; read on or unread, nothing extra", () => {
    const off = text(renderToStaticMarkup(h(PackList, { weeks, packs: { ok: true, data: packs }, packJobOn: false, onMake: NO_MAKE })));
    expect(off).toContain(PACK_JOB_OFF);
    expect(text(renderToStaticMarkup(h(PackList, { weeks, packs: { ok: true, data: packs }, packJobOn: null, onMake: NO_MAKE })))).not.toContain("is off at System");
  });

  test("a failed read says so and offers no Make control: a missing week is not known", () => {
    const page = text(renderToStaticMarkup(h(PackList, { weeks, packs: { ok: false, code: "failed", message: "x" }, packJobOn: null, onMake: NO_MAKE })));
    expect(page).toContain("Could not read the stored packs: x");
    expect(page).not.toContain("Make this");
    expect(page).toContain("Not known: the stored packs could not be read.");
  });

  test("the stored line names the week and any sections marked missing", () => {
    expect(madeWords({ status: "stored", weekStart: "2026-10-12", packId: "x", payloadHash: HASH, unreadSections: 0, auditRecorded: true })).toBe(
      "Stored the pack for the week of 12 Oct 2026. Open it from the list.",
    );
    expect(madeWords({ status: "stored", weekStart: "2026-10-12", packId: "x", payloadHash: HASH, unreadSections: 2, auditRecorded: true })).toContain("with 2 sections that could not be read, marked as missing");
    expect(MAKE_WORDS).toContain("A stored pack is never made again.");
  });

  describe("the control", () => {
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
    const button = (label: string) => {
      const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!found) throw new Error(`no button "${label}"`);
      return found;
    };

    test("Make this pack asks once, then calls the action with that week and says what was stored", async () => {
      const make = vi.fn<MakePack>(async () => ({ ok: true, data: { status: "stored", weekStart: "2026-10-12", packId: "x", payloadHash: HASH, unreadSections: 0, auditRecorded: true } }));
      await act(async () => {
        root.render(h(PackList, { weeks, packs: { ok: true, data: packs }, packJobOn: true, onMake: make }));
      });
      await act(async () => {
        button("Make this pack").click();
      });
      expect(make).not.toHaveBeenCalled();
      expect(container.textContent).toContain(MAKE_WORDS);
      await act(async () => {
        button("Yes, make this pack").click();
      });
      await act(async () => {});
      expect(make).toHaveBeenCalledWith("2026-10-12");
      expect([...container.querySelectorAll('[role="status"]')].map((n) => n.textContent)).toContain("Stored the pack for the week of 12 Oct 2026. Open it from the list.");
    });
  });
});

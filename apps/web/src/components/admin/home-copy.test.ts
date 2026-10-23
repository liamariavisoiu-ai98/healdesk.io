import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { composeInbox, sortInboxRows, type InboxReads } from "@/lib/admin/inbox-rows";
import type { InboxRow, OpsInbox } from "@/lib/admin/strip-types";

import { InboxList } from "./InboxList";

/**
 * Home, "what needs me today" (E1 step 4): every row has a count, a sentence
 * and a link or a button; the empty state is one line with the time; a
 * source that could not be read prints "Could not read X" and never a zero.
 * Fixtures first: the list is drawn from `OpsInbox` whoever builds it, so
 * lane A2's rows render the same way.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const NEVER = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const ROWS: InboxRow[] = [
  {
    id: "transcripts:undelivered",
    kind: "transcripts_undelivered",
    count: 3,
    sentence: "transcripts undelivered for more than 72 hours.",
    clinic: { id: CLINIC, name: "Radiance Med Spa" },
    button: { label: "Open Deliveries", kind: "link", href: `/admin/clinics/${CLINIC}/deliveries#transcript_undelivered-${CLINIC}` },
    tone: "bad",
    dueAt: "2026-10-23T12:00:00.000Z",
  },
  {
    id: "golive:ready",
    kind: "ready_to_go_live",
    count: 1,
    sentence: "clinic is ready to go live: every bought channel passed and nothing blocks.",
    clinic: { id: CLINIC, name: "Radiance Med Spa" },
    button: { label: "Go live", kind: "op", op: "goLive", args: { clinicId: CLINIC } },
    tone: "ok",
    dueAt: null,
  },
];

describe("the home list", () => {
  test("every row has a count, a sentence, the clinic with its id, and one button", () => {
    const inbox: OpsInbox = { rows: ROWS, checkedAt: "2026-10-23T09:12:00.000Z", unreadable: [] };
    const html = renderToStaticMarkup(h(InboxList, { inbox, run: NEVER }));
    const page = text(html);
    for (const row of ROWS) {
      expect(page).toContain(`${row.count} ${row.sentence}`);
      expect(page).toContain(row.clinic!.name);
      expect(html).toContain(`<code class="font-mono select-all">${CLINIC}</code>`);
      expect(page).toContain(row.button.label);
    }
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/deliveries#transcript_undelivered-${CLINIC}"`);
    expect(html).toContain(">Go live</button>");
    expect(page).toContain("Last checked 09:12 UTC.");
  });

  test("the empty state is one line with the time of the read", () => {
    const inbox: OpsInbox = { rows: [], checkedAt: "2026-10-23T09:12:00.000Z", unreadable: [] };
    expect(text(renderToStaticMarkup(h(InboxList, { inbox, run: NEVER })))).toBe("Nothing needs you. Last checked 09:12 UTC.");
  });

  test("an empty list with something unread does not claim nothing needs you", () => {
    const inbox: OpsInbox = {
      rows: [],
      checkedAt: "2026-10-23T09:12:00.000Z",
      unreadable: [{ source: "the alerts", reason: "the ops inbox has not landed in this console yet" }],
    };
    const page = text(renderToStaticMarkup(h(InboxList, { inbox, run: NEVER })));
    expect(page).toContain("Could not read the alerts: the ops inbox has not landed in this console yet");
    expect(page).toContain("Nothing in what could be read; the rest is above. Last checked 09:12 UTC.");
    expect(page).not.toContain("Nothing needs you");
  });

  test("a source that could not be read is said, and the rest of the list still shows", () => {
    const inbox: OpsInbox = {
      rows: [ROWS[0]!],
      checkedAt: "2026-10-23T09:12:00.000Z",
      unreadable: [{ source: "the support requests", reason: "Could not reach the ops API." }],
    };
    const page = text(renderToStaticMarkup(h(InboxList, { inbox, run: NEVER })));
    expect(page).toContain("Could not read the support requests: Could not reach the ops API.");
    expect(page).toContain("3 transcripts undelivered");
    expect(page).not.toContain("Nothing needs you");
  });
});

describe("the composed inbox, while apps/app's is not read", () => {
  const ok = <T,>(data: T) => ({ ok: true as const, data });
  const failed = { ok: false as const, code: "unreachable" as const, message: "Could not reach the ops API." };
  const reads: InboxReads = {
    clinics: ok([
      {
        clinicId: CLINIC,
        name: "Radiance Med Spa",
        specialty: "med-spa",
        synthetic: false,
        stage: { kind: "setup" as const, day: null, of: null, deadlineAt: null, since: null },
        channels: null,
        availability: null,
        calendar: null,
        voice: null,
        transcripts: null,
        usage: null,
        lastReminder: null,
        blocking: "Covered-entity status not determined.",
        attention: true,
        connection: "unknown" as const,
      },
    ]),
    health: ok([
      {
        clinicId: CLINIC,
        slug: "radiance",
        name: "Radiance Med Spa",
        plan: null,
        wentLiveOn: "2026-10-11",
        daysLive: 12,
        conversations: { total: 4, last7: 1 },
        recovered: { total: 1, last7: 0 },
        bookings: 1,
        firstRecoveredBookingOn: "2026-10-20",
        lastConversationAt: null,
        recipients: 1,
        forwardingTested: true,
        connected: false,
        usage: null,
        touches: [],
        flags: ["first_win" as const],
      },
    ]),
    reviews: ok([
      {
        id: "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
        clinicId: CLINIC,
        clinicSlug: "radiance",
        clinicName: "Radiance Med Spa",
        runId: "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e",
        status: "open" as const,
        createdAt: { on: "2026-10-22", at: "2026-10-22 10:00 UTC" },
        dueOn: "2026-10-24",
        pastDue: true,
        decidedAt: null,
        decidedByLabel: null,
        section: null,
        cases: [],
      },
    ]),
    agreementChecks: ok([]),
    support: failed,
    recordings: ok({ alerts: [], unreadClinics: 0 }),
    siteReads: ok({ failures: [], limit: 100 }),
    launch: [
      { id: "a", promise: "A", where: "x", status: "building", left: "y", evidence: "z", blocksGoLive: true },
      { id: "b", promise: "B", where: "x", status: "on", left: "y", evidence: "z", blocksGoLive: true },
    ],
    setupRequestsWaiting: 2,
  };

  test("one row per blocked clinic, per first-weeks flag and per queue with something owed; a failed read is named", () => {
    const inbox = composeInbox(reads, new Date("2026-10-23T09:12:00.000Z"));
    const kinds = inbox.rows.map((r) => r.kind);
    expect(kinds).toContain("clinic_blocked");
    expect(kinds).toContain("health_first_win");
    expect(kinds).toContain("reviews_owed");
    expect(kinds).toContain("setup_requests_waiting");
    expect(kinds).toContain("launch_promises_open");
    expect(kinds).not.toContain("support_owed");
    expect(kinds).not.toContain("retell_deletions_owed");
    expect(inbox.unreadable).toEqual([{ source: "the support requests", reason: "Could not reach the ops API." }]);
    expect(inbox.checkedAt).toBe("2026-10-23T09:12:00.000Z");
    const first = inbox.rows.find((r) => r.kind === "health_first_win")!;
    expect(first.sentence).toContain("booking by AYA");
    expect(first.sentence).not.toMatch(/recovered/i);
    expect(first.button).toEqual({ label: "Open Care", kind: "link", href: `/admin/clinics/${CLINIC}/care` });
    const launch = inbox.rows.find((r) => r.kind === "launch_promises_open")!;
    expect(launch.count).toBe(1);
    expect(launch.sentence).toContain("1 blocking go-live");
    for (const row of inbox.rows) {
      expect(row.count).toBeGreaterThan(0);
      expect(row.sentence.length).toBeGreaterThan(0);
      expect(row.button.kind === "link" ? row.button.href : row.button.op).toBeTruthy();
    }
  });

  test("rows are ordered by deadline, then severity", () => {
    const inbox = composeInbox(reads, new Date("2026-10-23T09:12:00.000Z"));
    expect(inbox.rows[0]?.kind).toBe("reviews_owed");
    expect(inbox.rows[0]?.sentence).toBe("practice-question run waits for a decision, 1 past its day.");
    const sorted = sortInboxRows([
      { ...ROWS[1]!, id: "b", tone: "ok", dueAt: null },
      { ...ROWS[1]!, id: "a", tone: "bad", dueAt: null },
      { ...ROWS[0]!, id: "c", tone: "info", dueAt: "2026-10-30" },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  test("a clinic the strip flags synthetic has no blocked row; one merely classed synthetic in setup does", () => {
    const row = reads.clinics.ok ? reads.clinics.data[0]! : (null as never);
    const demo: InboxReads = { ...reads, clinics: ok([{ ...row, synthetic: true }]) };
    expect(composeInbox(demo, new Date()).rows.map((r) => r.kind)).not.toContain("clinic_blocked");
    const inSetup: InboxReads = { ...reads, clinics: ok([{ ...row, synthetic: false }]) };
    expect(composeInbox(inSetup, new Date()).rows.map((r) => r.kind)).toContain("clinic_blocked");
  });
});

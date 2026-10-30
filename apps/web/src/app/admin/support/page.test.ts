import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { CASE_SECTIONS, REPLY_WAITING } from "@/components/admin/support-words";
import type { OpsResult, SupportCaseRowView, SupportCasesView, SupportReplyApprovalItem } from "@/lib/admin/ops-client";

/**
 * /admin/support as the operator sees it (lane P7d): the four sections with
 * their counts, a row's words (the clinic linked to its Care tab, the ref as
 * selectable text, the topic, the badge, the age, the reply day red once
 * past, the assignee, the hidden counts, the reply waiting for Send), the
 * empty lines, a failed read that is never a zero, and the host in standby.
 * Nothing on the page can carry a conversation's words: the rows have no
 * element for text, and the page has no form.
 */

const state = vi.hoisted(() => ({
  cases: null as unknown,
  waiting: null as unknown,
  asked: [] as unknown[],
}));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchSupportCases: async (options: unknown) => {
    state.asked.push(options);
    return state.cases;
  },
  fetchSupportReplyApprovals: async () => state.waiting,
}));

const { default: SupportPage } = await import("./page");

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CASE = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const OTHER = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";
const ITEM = "7d6c5e4f-3a21-4c1d-8e9f-8a7b6c5d4e3f";

const row: SupportCaseRowView = {
  id: CASE,
  ref: "HD-7F3KQ",
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  source: "chat",
  category: "forwarding",
  symptom: "calls_ring_out",
  urgency: "now",
  state: "drafted",
  assigneeLabel: "The Healdesk Team",
  openedAt: "2026-11-02T15:00:00.000Z",
  ageHours: 3,
  replyByOn: "2026-11-03",
  pastDue: false,
  snoozedUntil: null,
  lastInboundAt: "2026-11-02T15:00:00.000Z",
  lastOutboundAt: null,
  closedAt: null,
  closedReason: null,
  phiSuspected: false,
  hidden: { numbers: 0, emails: 0, treatments: 0, clinical: 0 },
  inboundCount: 2,
};

const item: SupportReplyApprovalItem = {
  id: ITEM,
  kind: "support_reply_send",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${OTHER}:1`,
  urgency: "routine",
  status: "waiting",
  proposedAt: "2026-11-02T16:00:00.000Z",
  dueAt: "2026-11-03T04:59:00.000Z",
  expiresAt: "2026-11-16T16:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "sendSupportReply",
  hasDraft: true,
  packet: {
    operation: "sendSupportReply",
    irreversible: true,
    stillNeeded: true,
    effect: "Sends this reply.",
    facts: {
      kind: "support_reply_send",
      ref: "HD-7F3KQ",
      caseId: CASE,
      topic: "forwarding",
      symptom: "calls_ring_out",
      caseUrgency: "now",
      caseState: "drafted",
      replyByOn: "2026-11-03",
      draftVersion: 1,
      currentDraftVersion: 1,
      checks: [],
      action: null,
    },
    draft: { subject: "Re: Your call forwarding (ref HD-7F3KQ)", body: "Hi, calls are reaching your line." },
  },
};

const read = (rows: SupportCaseRowView[], truncated = false): OpsResult<SupportCasesView> => ({ ok: true, data: { rows, count: rows.length, truncated } });
const noWaiting: OpsResult<{ items: SupportReplyApprovalItem[]; partial: string[] }> = { ok: true, data: { items: [], partial: [] } };

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function render(query: { demo?: string } = {}): Promise<string> {
  return renderToStaticMarkup(await SupportPage({ searchParams: Promise.resolve(query) })).replace(/<!-- -->/g, "");
}

beforeEach(() => {
  state.cases = read([row]);
  state.waiting = noWaiting;
  state.asked = [];
});

describe("/admin/support", () => {
  test("the title, the four sections with their anchors and counts, and a row's words", async () => {
    const html = await render();
    const page = text(html);
    expect(page).toContain("Support");
    for (const section of CASE_SECTIONS) expect(html).toContain(`id="${section.id}"`);
    expect(page).toContain("Needs you (1)");
    expect(page).toContain("Waiting on the clinic (0)");
    expect(page).toContain("Snoozed (0)");
    expect(page).toContain("Closed (30 days) (0)");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/care"`);
    expect(page).toContain("Radiance Med Spa");
    expect(html).toContain('<code class="font-mono text-sm select-all">HD-7F3KQ</code>');
    expect(html).toContain(`href="/admin/support/${CASE}"`);
    expect(page).toContain("Open case");
    expect(page).toContain("Now");
    expect(page).toContain("Call forwarding: Calls ring out unanswered");
    expect(page).toContain("Portal support chat · Drafted · opened 3 hours ago · reply by 3 Nov 2026 · with The Healdesk Team");
    expect(page).toContain("2 escalations from the portal chat");
    // No hidden counts on a chat case, and no reply waiting.
    expect(page).not.toContain("patient details hidden");
    expect(page).not.toContain(REPLY_WAITING);
    // The reads: every open case and the ones closed within 30 days, demo clinics left out, and the waiting replies.
    expect(state.asked).toEqual([{ state: "all", limit: 200, includeDemo: false }]);
    expect(page).toContain("Show demo clinics' cases");
    // Never the codes or the ids as words.
    for (const raw of ["calls_ring_out", "drafted", "this_week", CASE]) expect(page).not.toContain(raw);
  });

  test("each state falls in its section; a snoozed row says until when, a closed one its reason", async () => {
    state.cases = read([
      row,
      { ...row, id: OTHER, ref: "HD-8G4MP", state: "new", clinicId: null, clinicName: null, assigneeLabel: null },
      { ...row, id: "1" + OTHER.slice(1), state: "waiting_clinic", lastOutboundAt: "2026-11-02T18:00:00.000Z" },
      { ...row, id: "2" + OTHER.slice(1), state: "snoozed", snoozedUntil: "2026-11-04T14:00:00.000Z" },
      { ...row, id: "3" + OTHER.slice(1), state: "closed", closedAt: "2026-11-01T10:00:00.000Z", closedReason: "replied_by_hand" },
      { ...row, id: "4" + OTHER.slice(1), state: "needs_edit" },
      { ...row, id: "5" + OTHER.slice(1), state: "drafting" },
    ]);
    const page = text(await render());
    expect(page).toContain("Needs you (4)");
    expect(page).toContain("Waiting on the clinic (1)");
    expect(page).toContain("Snoozed (1)");
    expect(page).toContain("Closed (30 days) (1)");
    expect(page).toContain("No clinic yet");
    expect(page).toContain("New, no draft yet");
    expect(page).toContain("Being drafted");
    expect(page).toContain("Draft needs an edit");
    expect(page).toContain("Snoozed until 4 Nov 2026, 14:00 UTC.");
    expect(page).toContain("Closed 1 Nov 2026: Replied by hand from the mailbox.");
  });

  test("past its reply day is red; hidden counts show when set; a reply waiting for Send is said on its row alone", async () => {
    state.cases = read([
      { ...row, pastDue: true, hidden: { numbers: 2, emails: 0, treatments: 1, clinical: 0 }, source: "email", inboundCount: 1 },
      { ...row, id: OTHER, ref: "HD-8G4MP" },
    ]);
    state.waiting = { ok: true, data: { items: [item], partial: [] } };
    const html = await render();
    const page = text(html);
    expect(html).toMatch(/<span class="text-red-deep font-semibold">past its reply day \(3 Nov 2026\)<\/span>/);
    expect(page).toContain("patient details hidden: 2 numbers, 1 treatment");
    expect(page).toContain("Email ·");
    expect(page).toContain("1 email");
    expect(page.match(new RegExp(REPLY_WAITING, "g"))).toHaveLength(1);
    // The waiting reply is the first row's (its packet names that case).
    expect(page.indexOf(REPLY_WAITING)).toBeLessThan(page.indexOf("HD-8G4MP"));
    // The reply's words never reach the list.
    expect(page).not.toContain("calls are reaching your line");
  });

  test("empty says the one line per section, and the demo filter asks apps/app for demo clinics' cases", async () => {
    state.cases = read([]);
    const page = text(await render({ demo: "1" }));
    for (const section of CASE_SECTIONS) expect(page).toContain(section.empty);
    expect(page).toContain("Nothing needs you here.");
    expect(state.asked).toEqual([{ state: "all", limit: 200, includeDemo: true }]);
    expect(page).toContain("Hide demo clinics' cases");
  });

  test("a failed read says so and is never a zero; a cut list says so; the waiting read failing costs its line alone", async () => {
    state.cases = { ok: false, code: "failed", message: "The support cases could not be read." };
    const failed = text(await render());
    expect(failed).toContain("Could not read the support cases: The support cases could not be read.");
    expect(failed).not.toContain("(0)");
    expect(failed).not.toContain("Nothing needs you here.");

    state.cases = read([row], true);
    state.waiting = { ok: false, code: "failed", message: "The approvals could not be read." };
    const cut = text(await render());
    expect(cut).toContain("The list is cut at 1 cases; the ones that need you come first, the most urgent at the top.");
    expect(cut).toContain("Could not read the replies waiting for your Send: The approvals could not be read.");
    expect(cut).toContain("Needs you (1)");
    expect(cut).not.toContain(REPLY_WAITING);
  });

  test("a host in standby is the standby notice, not an error, and no section", async () => {
    state.cases = { ok: false, code: "unreachable", message: "Could not reach the ops API, so nothing below could be read." };
    const html = await render();
    expect(html).toContain("The AWS host is in standby.");
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("Could not read");
  });

  test("the page has nowhere for a conversation's words: no form, no text field, no textarea", async () => {
    state.cases = read([row, { ...row, id: OTHER, source: "email", hidden: { numbers: 1, emails: 1, treatments: 1, clinical: 1 } }]);
    const html = await render();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<input");
    for (const file of ["page.tsx", "CaseList.tsx"]) {
      const src = readFileSync(join(__dirname, file), "utf8");
      expect(src, file).not.toMatch(/<textarea|<input|<form|dangerouslySetInnerHTML/);
    }
  });
});

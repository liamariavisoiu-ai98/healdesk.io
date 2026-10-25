import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { TEXT_RULE } from "@/components/admin/support-words";
import type { OpsResult, SupportReplyApprovalItem } from "@/lib/admin/ops-client";

import { CASE, CLINIC, DRAFT_TEXT, item, ITEM, view } from "./fixtures";
import { EDIT_NEEDS_ITEM, PROPOSED_NOT_READ, sendEdit, waitingItemFor } from "./send-item";

/**
 * /admin/support/<case id> as the operator sees it (lane P7d), and its
 * server actions: each calls the one ops-client function it names with the
 * case's id and the closed value handed to it, refuses what is not an id or
 * not on a list, and Send finds or proposes the waiting item, then decides
 * it through the step-up wrapper alone, with the owner's code and the edit
 * only when the text changed. The host in standby is the one notice; a case
 * that is not a uuid is not found; a failed read says so.
 */

type Actions = {
  onSave: (id: string, text: string) => Promise<unknown>;
  onCheck: (id: string, text: string) => Promise<unknown>;
  onRegenerate: (id: string) => Promise<unknown>;
  onSend: (id: string, code: string, text: string) => Promise<unknown>;
  onSnooze: (id: string, choice: unknown) => Promise<unknown>;
  onAssign: (id: string, label: string) => Promise<unknown>;
  onMatch: (id: string, clinicId: string) => Promise<unknown>;
  onClose: (id: string, reason: string) => Promise<unknown>;
};

const state = vi.hoisted(() => ({
  view: null as unknown,
  waiting: null as unknown,
  /** Answers for the next reads of the waiting replies, consumed in order before `waiting` is used. */
  waitingQueue: [] as unknown[],
  clinics: null as unknown,
  proposal: null as unknown,
  calls: [] as { fn: string; args: unknown[] }[],
  decision: null as unknown,
  revalidated: [] as string[],
}));
const record = (fn: string, answer: () => unknown) => {
  return async (...args: unknown[]) => {
    state.calls.push({ fn, args });
    return answer();
  };
};
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => state.revalidated.push(path) }));
vi.mock("@/lib/admin/approval-decide", () => ({
  decideApprovalWithCode: record("decideApprovalWithCode", () => state.decision),
}));
vi.mock("@/lib/admin/ops-client", () => ({
  SUPPORT_CLOSED_REASONS: ["replied_by_hand", "no_reply_needed", "duplicate", "not_a_clinic", "spam", "no_further_reply"],
  fetchSupportCase: record("fetchSupportCase", () => state.view),
  fetchSupportReplyApprovals: record("fetchSupportReplyApprovals", () => (state.waitingQueue.length > 0 ? state.waitingQueue.shift() : state.waiting)),
  fetchClinics: record("fetchClinics", () => state.clinics),
  saveSupportDraft: record("saveSupportDraft", () => ({ ok: true, data: { ref: "HD-7F3KQ", draftVersion: 3, state: "drafted", approvalId: ITEM, ok: true, checks: [], failed: [], auditRecorded: true } })),
  previewSupportReply: record("previewSupportReply", () => ({ ok: true, data: { ref: "HD-7F3KQ", ok: true, checks: [], failed: [] } })),
  regenerateSupportDraft: record("regenerateSupportDraft", () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "new", auditRecorded: true } })),
  proposeSupportReply: record("proposeSupportReply", () => state.proposal),
  snoozeSupportCase: record("snoozeSupportCase", () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "snoozed", auditRecorded: true } })),
  assignSupportCase: record("assignSupportCase", () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "drafted", auditRecorded: true } })),
  matchSupportCase: record("matchSupportCase", () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "new", auditRecorded: true } })),
  closeSupportCase: record("closeSupportCase", () => ({ ok: true, data: { outcome: "done", ref: "HD-7F3KQ", state: "closed", auditRecorded: true } })),
}));

const { default: CasePage } = await import("./page");
const { CaseView } = await import("./CaseView");

const read = <T,>(data: T): OpsResult<T> => ({ ok: true, data });
const waiting = (items: SupportReplyApprovalItem[]) => read({ items, partial: [] as string[] });

async function page(caseId: string = CASE): Promise<ReactElement> {
  return CasePage({ params: Promise.resolve({ caseId }) });
}

/** The CaseView element in the page's tree, with its action props. */
function caseView(node: ReactNode): ReactElement<{ actions: Actions; item: unknown; clinics: unknown; waitingRead: boolean }> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = caseView(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode; actions?: Actions }>;
  if (element.type === CaseView) return element as ReactElement<{ actions: Actions; item: unknown; clinics: unknown; waitingRead: boolean }>;
  return caseView(element.props.children);
}

async function actions(): Promise<Actions> {
  const found = caseView(await page());
  if (!found) throw new Error("no CaseView on the page");
  return found.props.actions;
}

const calls = (fn: string) => state.calls.filter((c) => c.fn === fn).map((c) => c.args);

beforeEach(() => {
  state.view = read(view);
  state.waiting = waiting([item]);
  state.clinics = read({ clinics: [{ id: CLINIC, name: "Radiance Med Spa", dataClassification: "production" }], connectionStateLimit: 50 });
  state.proposal = read({ outcome: "proposed", ref: "HD-7F3KQ", approvalId: ITEM, draftVersion: 2, failed: [], auditRecorded: true });
  state.decision = read({ status: "executed", outcomeCode: "sent", message: null, auditRecorded: true });
  state.waitingQueue = [];
  state.calls = [];
  state.revalidated = [];
});

describe("the page", () => {
  test("reads the case and the waiting replies, hands the view its item and the people, and reads the clinics only for a case with no clinic", async () => {
    const element = await page();
    const found = caseView(element)!;
    expect(found.props.item).toEqual(item);
    expect(found.props.waitingRead).toBe(true);
    expect(found.props.clinics).toBeNull();
    expect(calls("fetchSupportCase")).toEqual([[CASE]]);
    expect(calls("fetchSupportReplyApprovals")).toEqual([[{ status: "waiting" }]]);
    expect(calls("fetchClinics")).toEqual([]);
    const html = renderToStaticMarkup(element);
    expect(html).toContain('href="/admin/support"');
    expect(html).toContain('id="support-case"');

    state.calls = [];
    state.view = read({ ...view, case: { ...view.case, clinicId: null, clinicName: null }, facts: null, draft: null });
    const unmatched = caseView(await page())!;
    expect(calls("fetchClinics")).toEqual([[{ connectionState: false }]]);
    expect(unmatched.props.clinics).toEqual([{ id: CLINIC, name: "Radiance Med Spa", synthetic: false }]);
    // An item for an older draft is not this case's.
    state.view = read(view);
    state.waiting = waiting([{ ...item, packet: { ...item.packet!, facts: { ...item.packet!.facts, draftVersion: 1 } } }]);
    expect(caseView(await page())!.props.item).toBeNull();
  });

  test("a case id that is not a uuid is not found; a failed read says so; the host in standby is the one notice", async () => {
    await expect(page("not-a-case")).rejects.toThrow("404");
    state.view = { ok: false, code: "refused", message: "The ops API refused this read. The reason is in our logs." };
    expect(renderToStaticMarkup(await page())).toContain("Could not read the support case: The ops API refused this read. The reason is in our logs.");
    state.view = { ok: false, code: "unreachable", message: "Could not reach the ops API, so nothing below could be read." };
    const standby = renderToStaticMarkup(await page());
    expect(standby).toContain("The AWS host is in standby.");
    expect(standby).not.toContain("Could not read");
  });
});

describe("the actions", () => {
  test("Save draft, Check and Regenerate call their operation with the case id and the text as apps/app keeps it, and refuse an empty or overlong text", async () => {
    const a = await actions();
    await a.onSave(CASE, "  Hi,\r\n\r\n\r\nthanks.  ");
    expect(calls("saveSupportDraft")).toEqual([[CASE, "Hi,\n\nthanks."]]);
    expect(state.revalidated).toEqual([`/admin/support/${CASE}`, "/admin/support"]);
    await a.onCheck(CASE, "Hi.");
    expect(calls("previewSupportReply")).toEqual([[CASE, "Hi."]]);
    await a.onRegenerate(CASE);
    expect(calls("regenerateSupportDraft")).toEqual([[CASE]]);
    expect(await a.onSave(CASE, "   ")).toEqual({ ok: false, code: "refused", message: TEXT_RULE });
    expect(await a.onCheck(CASE, "x".repeat(1501))).toEqual({ ok: false, code: "refused", message: TEXT_RULE });
    expect(await a.onSave("nope", "Hi.")).toEqual({ ok: false, code: "refused", message: "No such support case." });
    expect(calls("saveSupportDraft")).toHaveLength(1);
  });

  test("Send with a reply waiting: decides it through the wrapper with the owner's code, carrying the edit only when the text changed", async () => {
    const a = await actions();
    state.calls = [];
    // Unchanged (as apps/app stores it): no edit.
    expect(await a.onSend(CASE, "123456", `${DRAFT_TEXT}\r\n`)).toEqual(state.decision);
    expect(calls("proposeSupportReply")).toEqual([]);
    expect(calls("decideApprovalWithCode")).toEqual([[ITEM, "approve", "owner_checked", "123456", undefined]]);
    expect(state.revalidated).toEqual([`/admin/support/${CASE}`, "/admin/support"]);
    // Changed: the edit under the item's own subject.
    state.calls = [];
    await a.onSend(CASE, "654321", `${DRAFT_TEXT} Thank you.`);
    expect(calls("decideApprovalWithCode")).toEqual([
      [ITEM, "approve", "owner_checked", "654321", { subject: "Re: Your call forwarding (ref HD-7F3KQ)", body: `${DRAFT_TEXT} Thank you.` }],
    ]);
  });

  test("Send with nothing waiting: proposes first, reads the item back, then decides; a proposal the checks refuse sends nothing and names the rules", async () => {
    state.waiting = waiting([]);
    const a = await actions();
    state.calls = [];
    // The first read finds nothing; the read after the proposal finds the item.
    state.waitingQueue = [waiting([]), waiting([item])];
    expect(await a.onSend(CASE, "123456", DRAFT_TEXT)).toEqual(state.decision);
    expect(calls("fetchSupportReplyApprovals")).toHaveLength(2);
    expect(calls("proposeSupportReply")).toEqual([[CASE]]);
    expect(calls("decideApprovalWithCode")).toEqual([[ITEM, "approve", "owner_checked", "123456", undefined]]);
    // The proposal came before the decision, and the decision after the item was read back.
    const order = state.calls.map((c) => c.fn);
    expect(order.indexOf("proposeSupportReply")).toBeLessThan(order.indexOf("decideApprovalWithCode"));

    state.calls = [];
    state.waiting = waiting([]);
    state.proposal = read({ outcome: "checks_failed", ref: "HD-7F3KQ", approvalId: null, draftVersion: 2, failed: ["The reply names no person."], auditRecorded: true });
    expect(await a.onSend(CASE, "123456", DRAFT_TEXT)).toEqual({
      ok: true,
      data: { status: "not_proposed", message: "Nothing was sent: the saved draft fails: The reply names no person. Edit it, press Save draft, then Send." },
    });
    expect(calls("decideApprovalWithCode")).toEqual([]);

    // Proposed, but the item could not be read back: nothing is decided, and the line says so.
    state.calls = [];
    state.proposal = read({ outcome: "already_waiting", ref: "HD-7F3KQ", approvalId: ITEM, draftVersion: 2, failed: [], auditRecorded: true });
    state.waiting = { ok: false, code: "failed", message: "x" };
    expect(await a.onSend(CASE, "123456", DRAFT_TEXT)).toEqual({ ok: true, data: { status: "not_proposed", message: PROPOSED_NOT_READ } });
    expect(calls("decideApprovalWithCode")).toEqual([]);
  });

  test("Send refuses what the wrapper would: an empty text, a case id that is not one; and never decides when the case cannot be read", async () => {
    const a = await actions();
    state.calls = [];
    expect(await a.onSend(CASE, "123456", " ")).toEqual({ ok: false, code: "refused", message: TEXT_RULE });
    expect(await a.onSend("x", "123456", "Hi.")).toEqual({ ok: false, code: "refused", message: "No such support case." });
    state.view = { ok: false, code: "failed", message: "The ops API failed while answering, so nothing below could be read." };
    expect(await a.onSend(CASE, "123456", "Hi.")).toEqual(state.view);
    expect(calls("decideApprovalWithCode")).toEqual([]);
    expect(calls("proposeSupportReply")).toEqual([]);
  });

  test("Snooze turns the choice into 09:00 New York and refuses a bad day; Assign, Match and Close carry the closed value and refuse one off its list", async () => {
    const a = await actions();
    state.calls = [];
    const snoozed = (await a.onSnooze(CASE, { kind: "tomorrow" })) as { ok: true; data: { until: string } };
    expect(snoozed.ok).toBe(true);
    expect(snoozed.data.until).toMatch(/T1[34]:00:00\.000Z$/);
    expect(calls("snoozeSupportCase")).toEqual([[CASE, snoozed.data.until]]);
    expect(await a.onSnooze(CASE, { kind: "day", day: "2020-01-01" })).toEqual({ ok: false, code: "refused", message: "Pick a day after today (New York)." });
    expect(await a.onSnooze(CASE, "tomorrow")).toEqual({ ok: false, code: "refused", message: "Pick when the case comes back." });
    await a.onAssign(CASE, "Liam");
    expect(calls("assignSupportCase")).toEqual([[CASE, "Liam"]]);
    expect(await a.onAssign(CASE, "liam@example.com")).toEqual({ ok: false, code: "refused", message: "Pick a name from the list." });
    await a.onMatch(CASE, CLINIC.toUpperCase());
    expect(calls("matchSupportCase")).toEqual([[CASE, CLINIC]]);
    expect(await a.onMatch(CASE, "radiance")).toEqual({ ok: false, code: "refused", message: "Pick a clinic from the list." });
    await a.onClose(CASE, "spam");
    expect(calls("closeSupportCase")).toEqual([[CASE, "spam"]]);
    expect(await a.onClose(CASE, "bored")).toEqual({ ok: false, code: "refused", message: "Pick a reason from the list." });
    expect(calls("closeSupportCase")).toHaveLength(1);
  });
});

describe("the pure half of Send", () => {
  test("the waiting item is the case's, still needed, for the version held", () => {
    expect(waitingItemFor([item], CASE, 2)).toBe(item);
    expect(waitingItemFor([item], CASE, null)).toBe(item);
    expect(waitingItemFor([item], CASE, 3)).toBeNull();
    expect(waitingItemFor([item], "4fa85f64-5717-4562-b3fc-2c963f66afa7", 2)).toBeNull();
    expect(waitingItemFor([{ ...item, packet: { ...item.packet!, stillNeeded: false } }], CASE, 2)).toBeNull();
    expect(waitingItemFor([{ ...item, packet: null }], CASE, 2)).toBeNull();
  });

  test("the edit: none when the text is the item's draft, the item's subject and the text when it is not, a refusal with no draft to compare", () => {
    expect(sendEdit(item, DRAFT_TEXT)).toEqual({ ok: true, edit: undefined });
    expect(sendEdit(item, `${DRAFT_TEXT} Thank you.`)).toEqual({ ok: true, edit: { subject: "Re: Your call forwarding (ref HD-7F3KQ)", body: `${DRAFT_TEXT} Thank you.` } });
    expect(sendEdit({ ...item, packet: { ...item.packet!, draft: null } }, DRAFT_TEXT)).toEqual({ ok: false, message: EDIT_NEEDS_ITEM });
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EMPTY_WORDS, FACTS_NOT_READ, IRREVERSIBLE_CONFIRM, NO_LONGER_NEEDED, REJECT_CONFIRM } from "@/components/admin/approval-words";
import { UNAUDITED } from "@/components/admin/ui";
import type { ApprovalDecisionEntry } from "@/lib/admin/approval-decide";
import type { ApprovalHistoryEvent, ApprovalItem, OpsResult } from "@/lib/admin/ops-client";

import { ApprovalsSection, History, whenWords, type DecideApproval } from "./ApprovalsSection";

/**
 * Queues › Approvals (Phase 6, lane P6b): each waiting item as one card with
 * the clinic, what approving does, the facts in words, the worker's switch,
 * how long it has waited and when it leaves the list; the irreversible
 * sentence before the code field; Approve and Reject both refusing to run
 * without six digits and both calling the page's decide action with the
 * item's id, the action, the reason chosen and the code; the outcome in the
 * operation's own words, kept by the section once the item has left; the
 * History tab; and the empty, failed-read and facts-not-read states.
 */

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const OTHER = "6d1ffee1-2222-4d3b-8b9c-2a3f4e5d6c7b";
const NOW = "2026-11-03T12:00:00.000Z";
const NEVER: DecideApproval = async () => {
  throw new Error("a decision ran during a static render");
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;|&rsquo;|’/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const request: ApprovalItem = {
  id: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e:0",
  urgency: "money",
  status: "waiting",
  proposedAt: "2026-11-01T10:00:00.000Z",
  dueAt: "2026-11-02T10:00:00.000Z",
  expiresAt: "2026-11-08T10:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: true,
  irreversible: true,
  operation: "retryBillingRequest",
  hasDraft: false,
  packet: {
    operation: "retryBillingRequest",
    irreversible: true,
    stillNeeded: true,
    effect: "Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with ten fresh tries.",
    facts: {
      kind: "billing_request_retry",
      requestKind: "cancel_now",
      channel: null,
      reasonCode: "attempts_exhausted",
      lastErrorCode: "stripe:api_error",
      attempts: 10,
      maxAttempts: 10,
      billingStatus: "active",
      supersededBy: null,
      workerOn: false,
      closureOn: null,
    },
  },
};

const event: ApprovalItem = {
  ...request,
  id: OTHER,
  kind: "billing_event_replay",
  clinic: { id: CLINIC, name: null },
  subjectRef: "evt_1AbCdEf:1762000000",
  pastDue: false,
  expiresAt: null,
  operation: "replayBillingEvent",
  packet: {
    operation: "replayBillingEvent",
    irreversible: true,
    stillNeeded: false,
    effect: "Applies a paid invoice.",
    facts: { kind: "billing_event_replay", eventType: "invoice.paid", failures: 3, maxFailures: 3 },
  },
};

const historyRow: ApprovalHistoryEvent = {
  id: "9a8b7c6d-1111-4222-8333-444455556666",
  approvalId: ITEM,
  kind: "billing_request_retry",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  event: "approved",
  actorLabel: "ops@healdesk.test",
  ip: "203.0.113.9",
  userAgent: "vitest",
  draftHashApproved: null,
  draftHashSent: null,
  outcomeCode: "cause_fixed",
  at: "2026-11-02T10:01:00.000Z",
};

const read = (items: ApprovalItem[]): OpsResult<{ items: ApprovalItem[]; partial: string[] }> => ({ ok: true, data: { items, partial: [] } });
const noHistory: OpsResult<ApprovalHistoryEvent[]> = { ok: true, data: [] };

function render(approvals: OpsResult<{ items: ApprovalItem[]; partial: string[] }>, history = noHistory): string {
  return renderToStaticMarkup(h(ApprovalsSection, { approvals, history, now: NOW, onDecide: NEVER }));
}

describe("the waiting items", () => {
  test("a card: the clinic linked to its Billing tab, the kind, what approving does, the facts, the worker's switch, the wait and the day it leaves", () => {
    const html = render(read([request]));
    const page = text(html);
    expect(html).toContain('id="approvals"');
    expect(page).toContain("Approvals");
    expect(page).toContain("Waiting (1)");
    expect(html).toContain(`href="/admin/clinics/${CLINIC}/billing"`);
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Past due");
    expect(page).toContain("Retry a billing change the billing worker gave up on");
    expect(page).toContain("Makes this cancellation due again. The billing worker carries it out at its next run if it still applies, with ten fresh tries.");
    expect(page).toContain("Change an immediate cancellation");
    expect(page).toContain("Tries 10 of 10");
    expect(page).toContain("Stopped because every try was used");
    expect(page).toContain("Last error Stripe had an error on its side");
    expect(page).toContain("Billing now active");
    expect(page).toContain("Billing worker off: nothing happens until it is switched on at System › Jobs");
    expect(page).toContain("Waiting 2 days, past due. Leaves the list without running on 8 Nov 2026 if nobody decides.");
    expect(page).toContain("Approve");
    expect(page).toContain("Reject");
    expect(page).toContain("Why approve");
    expect(page).toContain("Why reject");
    expect(page).toContain("The cause is fixed");
    expect(page).toContain("Ask the clinic first");
    // Never the codes, the ids or the subject reference.
    for (const raw of ["cancel_now", "attempts_exhausted", "stripe:api_error", "billing_request_retry", ITEM, "7d1e2f30"]) expect(page).not.toContain(raw);
  });

  test("the irreversible sentence stands before the code field, and both buttons wait for six digits", () => {
    const html = render(read([request]));
    const page = text(html);
    const sentence = page.indexOf(IRREVERSIBLE_CONFIRM.billing_request_retry);
    const field = page.indexOf("Code from your authenticator");
    expect(sentence).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(sentence);
    expect(page.match(/Code from your authenticator/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reject<\/button>/);
  });

  test("a parked event with no printable clinic name, no expiry and a subject that moved on: said so, and Runs at once", () => {
    const page = text(render(read([event])));
    expect(page).toContain("A clinic with no printable name");
    expect(page).toContain("Replay a Stripe event that was parked");
    expect(page).toContain(NO_LONGER_NEEDED);
    expect(page).toContain("Stripe event invoice paid");
    expect(page).toContain("Failed 3 of 3 times");
    expect(page).toContain("Runs at once, in the same request, when approved");
    expect(page).toContain("Waiting 2 days. Waits until decided.");
    expect(page).not.toContain("Past due");
    expect(page).toContain(IRREVERSIBLE_CONFIRM.billing_event_replay);
    expect(page).not.toContain("evt_1AbCdEf");
  });

  test("an item whose facts could not be read offers Reject alone and says why", () => {
    const page = text(render({ ok: true, data: { items: [{ ...request, packet: null }], partial: [ITEM] } }));
    expect(page).toContain(FACTS_NOT_READ);
    expect(page).not.toContain("Approve this");
    expect(page).not.toContain("Why approve");
    expect(page).toContain("Why reject");
    expect(page).toContain("Reject");
  });

  test("empty says the one line; a failed read says so and is never a zero; the tab count follows the read", () => {
    const empty = text(render(read([])));
    expect(empty).toContain(EMPTY_WORDS);
    expect(empty).toContain("Waiting (0)");
    const failed = text(render({ ok: false, code: "failed", message: "The approvals could not be read." }));
    expect(failed).toContain("Could not read the approvals: The approvals could not be read.");
    expect(failed).not.toContain(EMPTY_WORDS);
    expect(failed).not.toContain("Waiting (0)");
    expect(failed).toContain("Waiting");
  });
});

describe("the History tab", () => {
  test("each row: when, whose, the kind, what happened and why, who by; never the IP, the user agent or a hash", () => {
    const html = renderToStaticMarkup(h(History, { history: { ok: true, data: [historyRow, { ...historyRow, id: "1", event: "proposed", outcomeCode: null, actorLabel: "approvals-propose", at: "2026-11-01T10:00:00.000Z" }] } }));
    const page = text(html);
    expect(page).toContain("2 Nov 2026, 10:01 UTC");
    expect(page).toContain("Radiance Med Spa");
    expect(page).toContain("Retry a billing change the billing worker gave up on");
    expect(page).toContain("approved (the cause is fixed)");
    expect(page).toContain("by ops@healdesk.test");
    expect(page).toContain("proposed by the approvals job");
    expect(page).not.toContain("203.0.113.9");
    expect(page).not.toContain("vitest");
    expect(page).not.toContain("cause_fixed");
    expect(whenWords("2026-11-02T10:01:00.000Z")).toBe("2 Nov 2026, 10:01 UTC");
  });

  test("empty and failed", () => {
    expect(text(renderToStaticMarkup(h(History, { history: noHistory })))).toBe("Nothing has happened yet.");
    expect(text(renderToStaticMarkup(h(History, { history: { ok: false, code: "failed", message: "The approval history could not be read." } })))).toContain(
      "Could not read the approval history: The approval history could not be read.",
    );
  });
});

describe("the two controls", () => {
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
  const statuses = () => [...container.querySelectorAll('[role="status"]')].map((n) => n.textContent ?? "");

  async function type(code: string): Promise<void> {
    const input = container.querySelector<HTMLInputElement>('input[name="code"]');
    if (!input) throw new Error("no code field");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function choose(name: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`select[name="${name}"]`);
    if (!select) throw new Error(`no select "${name}"`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function mount(onDecide: DecideApproval, items = [request]): Promise<void> {
    await act(async () => {
      root.render(h(ApprovalsSection, { approvals: read(items), history: { ok: true, data: [historyRow] }, now: NOW, onDecide }));
    });
  }

  test("Approve runs nothing without six digits, asks once, sends the id, the reason chosen and the code, and the section keeps the operation's own sentence once the card has gone", async () => {
    const message =
      "Re-armed: the change is due again, with ten fresh tries. The billing worker carries it out at its next run if it still applies. The billing worker is switched off, so nothing happens until it is switched on at System > Jobs.";
    const decide = vi.fn<DecideApproval>(async () => ({
      ok: true,
      data: { status: "executed", outcomeCode: "rearmed", message, auditRecorded: true } satisfies ApprovalDecisionEntry,
    }));
    await mount(decide);
    expect(button("Approve").disabled).toBe(true);
    await type("12345");
    expect(button("Approve").disabled).toBe(true);
    await type("123456");
    expect(button("Approve").disabled).toBe(false);
    await choose("approveReason", "owner_checked");
    await act(async () => {
      button("Approve").click();
    });
    expect(decide).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Approve this item? The operation runs once.");
    await act(async () => {
      button("Yes, approve").click();
    });
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(ITEM, "approve", "owner_checked", "123456");
    expect(statuses()).toContain(`Approved. ${message}`);
    // The card has gone; the outcome stays; the list is empty.
    expect(container.textContent).not.toContain("Code from your authenticator");
    expect(container.textContent).toContain(EMPTY_WORDS);
    expect(container.textContent).toContain("Waiting (0)");
  });

  test("Reject asks once with its own sentence, sends the reason chosen, and says the item has left; an unaudited decision says so", async () => {
    const decide = vi.fn<DecideApproval>(async () => ({
      ok: true,
      data: { status: "rejected", outcomeCode: "wrong_amount", auditRecorded: false } satisfies ApprovalDecisionEntry,
    }));
    await mount(decide);
    await type("123456");
    await choose("rejectReason", "wrong_amount");
    await act(async () => {
      button("Reject").click();
    });
    expect(decide).not.toHaveBeenCalled();
    expect(container.textContent).toContain(REJECT_CONFIRM);
    await act(async () => {
      button("Yes, reject").click();
    });
    await act(async () => {});
    expect(decide).toHaveBeenCalledWith(ITEM, "reject", "wrong_amount", "123456");
    expect(statuses()).toContain(`Rejected: nothing was run, and the item has left the list. This failure is not proposed again. ${UNAUDITED}`);
    expect(container.textContent).not.toContain("Why reject");
  });

  test("a refused code, or an item already decided, is said on the card and the card stays; a failed operation leaves the list in red", async () => {
    let answer: ApprovalDecisionEntry = { status: "code_refused", message: "That code is not right. Nothing was changed." };
    const decide = vi.fn<DecideApproval>(async () => ({ ok: true, data: answer }));
    await mount(decide);
    await type("654321");
    await act(async () => {
      button("Reject").click();
    });
    await act(async () => {
      button("Yes, reject").click();
    });
    await act(async () => {});
    expect(statuses()).toContain("That code is not right. Nothing was changed.");
    expect(container.textContent).toContain("Code from your authenticator");

    answer = { status: "refused", message: "This has already been decided, so nothing more was done. Reload to see where it stands." };
    await act(async () => {
      button("Reject").click();
    });
    await act(async () => {
      button("Yes, reject").click();
    });
    await act(async () => {});
    expect(statuses()).toContain("This has already been decided, so nothing more was done. Reload to see where it stands.");
    expect(container.textContent).toContain("Code from your authenticator");

    answer = { status: "failed", outcomeCode: "no_longer_needed", message: "This has already been dealt with since it was proposed, so nothing was run.", auditRecorded: true };
    await act(async () => {
      button("Approve").click();
    });
    await act(async () => {
      button("Yes, approve").click();
    });
    await act(async () => {});
    expect(decide).toHaveBeenLastCalledWith(ITEM, "approve", "cause_fixed", "654321");
    const line = [...container.querySelectorAll('[role="status"]')].find((n) => n.textContent?.startsWith("Approved, but"));
    expect(line?.textContent).toBe("Approved, but it did not go through: This has already been dealt with since it was proposed, so nothing was run.");
    expect(line?.className).toContain("text-red-deep");
    expect(container.textContent).not.toContain("Code from your authenticator");
  });

  test("the History tab shows the record", async () => {
    await mount(NEVER);
    expect(container.textContent).not.toContain("by ops@healdesk.test");
    await act(async () => {
      button("History").click();
    });
    expect(container.textContent).toContain("approved (the cause is fixed)");
    expect(container.textContent).toContain("by ops@healdesk.test");
    expect(container.textContent).not.toContain("Code from your authenticator");
  });
});

describe("the section's source", () => {
  test("names the raw decision nowhere, and goes through the step-up wrapper's type alone", () => {
    const source = readFileSync(join(__dirname, "ApprovalsSection.tsx"), "utf8");
    expect(source).toMatch(/approval-decide/);
    expect(source).not.toMatch(/\bdecideApproval\b/);
    const page = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(page).toContain("decideApprovalWithCode(");
    expect(page).not.toMatch(/\bdecideApproval\b/);
  });
});

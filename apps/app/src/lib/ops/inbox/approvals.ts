import { waitingItems } from "@/lib/approvals/store";
import type { ApprovalKind, ApprovalUrgency } from "@/lib/approvals/kinds";

import type { InboxRow, InboxSource, Tone } from "./types";

/**
 * The approval inbox on Home (ops automation Phase 6, lane P6a): one row per
 * kind with items waiting for the owner's yes, across clinics, due at the
 * earliest item's due time, each opening the Approvals section of the Queues
 * page (lane P6b builds it there, `#approvals`). A plain sentence, never a
 * code; the tone follows the most urgent item. Reads one table, writes
 * nothing.
 */

export const APPROVALS_PAGE = "/admin/queues#approvals";

/** Each kind's words, for one item and for many. */
const WORDS: Readonly<Record<ApprovalKind, { one: string; many: string }>> = {
  billing_request_retry: {
    one: "1 billing change the billing worker gave up on is waiting for your yes.",
    many: "{n} billing changes the billing worker gave up on are waiting for your yes.",
  },
  // In the list only while the daily extra-usage run is switched off (lib/approvals/proposers.ts).
  overage_invoice_retry: {
    one: "1 extra-usage invoice that failed is waiting for your yes.",
    many: "{n} extra-usage invoices that failed are waiting for your yes.",
  },
  billing_event_replay: {
    one: "1 Stripe event replay is waiting for your yes.",
    many: "{n} Stripe event replays are waiting for your yes.",
  },
  // The incident assistant (lane P6i): legal clocks, so these rows read
  // "bad". The row opens the Approvals section, which reads only the billing
  // family: lane P6j must draw these items (on the Incidents page) and point
  // this row there before it is true.
  incident_open_batch: {
    one: "1 incident scope is waiting for your yes to open its incidents.",
    many: "{n} incident scopes are waiting for your yes to open their incidents.",
  },
  incident_report_send: {
    one: "1 incident report is waiting for your yes.",
    many: "{n} incident reports are waiting for your yes.",
  },
};

const TONE: Readonly<Record<ApprovalUrgency, Tone>> = { legal_clock: "bad", money: "warn", routine: "info" };
const RANK: Readonly<Record<ApprovalUrgency, number>> = { legal_clock: 0, money: 1, routine: 2 };

export function approvalSentence(kind: ApprovalKind, n: number): string {
  const words = WORDS[kind];
  return n === 1 ? words.one : words.many.replace("{n}", String(n));
}

export const approvalsSource: InboxSource = {
  name: "the approvals",
  async read() {
    const byKind = new Map<ApprovalKind, { count: number; dueAt: Date; urgency: ApprovalUrgency }>();
    for (const item of await waitingItems()) {
      const kind = item.kind as ApprovalKind;
      if (!WORDS[kind]) continue;
      const seen = byKind.get(kind);
      if (!seen) {
        byKind.set(kind, { count: 1, dueAt: item.dueAt, urgency: item.urgency });
        continue;
      }
      seen.count += 1;
      if (item.dueAt < seen.dueAt) seen.dueAt = item.dueAt;
      if (RANK[item.urgency] < RANK[seen.urgency]) seen.urgency = item.urgency;
    }
    const rows: InboxRow[] = [...byKind].map(([kind, r]) => ({
      id: `approvals:${kind}`,
      kind: "approval",
      count: r.count,
      sentence: approvalSentence(kind, r.count),
      clinic: null,
      button: { label: "Open approvals", kind: "link", href: APPROVALS_PAGE },
      tone: TONE[r.urgency],
      dueAt: r.dueAt.toISOString(),
    }));
    return { rows };
  },
};

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
 *
 * It counts what the table says is waiting. An item moves to expired only
 * when a sweep runs: approvals-propose (OFF until the owner switches it on)
 * for every kind, and for the incident kinds also the incident-deadlines
 * job (ON). So while approvals-propose is off, a billing or clinic-contact
 * item past its window is still counted here; approving it is refused
 * (approval-ops.ts checks the window itself), so nothing goes late.
 */

export const APPROVALS_PAGE = "/admin/queues#approvals";

/** Lane P7c: a support reply waits beside its case, on the Support console (lane P7d), where its case's page has Send. */
export const SUPPORT_PAGE = "/admin/support";

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
  // The emails to a clinic (lane P6f): each goes only once you approve it.
  baa_resign_chase: {
    one: "1 email chasing a practice to sign its updated agreement is waiting for your yes.",
    many: "{n} emails chasing practices to sign their updated agreement are waiting for your yes.",
  },
  agreement_question: {
    one: "1 email asking a practice which agreement it needs is waiting for your yes.",
    many: "{n} emails asking practices which agreement they need are waiting for your yes.",
  },
  setup_extended: {
    one: "1 setup extension and its email are waiting for your yes.",
    many: "{n} setup extensions and their emails are waiting for your yes.",
  },
  setup_waiting_on_us: {
    one: "1 email telling a clinic we're finishing its setup is waiting for your yes.",
    many: "{n} emails telling clinics we're finishing their setup are waiting for your yes.",
  },
  setup_help_offer: {
    one: "1 offer of a five-minute setup call is waiting for your yes.",
    many: "{n} offers of a five-minute setup call are waiting for your yes.",
  },
  setup_reminder_now: {
    one: "1 setup reminder to send sooner is waiting for your yes.",
    many: "{n} setup reminders to send sooner are waiting for your yes.",
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
  // Lane P7c: a composed reply to a clinic's support request; the support
  // console (lane P7d) draws these items, beside their case.
  support_reply_send: {
    one: "1 support reply is waiting for your yes.",
    many: "{n} support replies are waiting for your yes.",
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
      button:
        kind === "support_reply_send"
          ? { label: "Open support", kind: "link", href: SUPPORT_PAGE }
          : { label: "Open approvals", kind: "link", href: APPROVALS_PAGE },
      tone: TONE[r.urgency],
      dueAt: r.dueAt.toISOString(),
    }));
    return { rows };
  },
};

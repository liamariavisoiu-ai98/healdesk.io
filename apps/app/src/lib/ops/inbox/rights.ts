import { clockState, utcDay } from "@/lib/rights/clocks";
import { collectRights } from "@/lib/rights/tracker";

import type { InboxRow, InboxSource } from "./types";

/**
 * Home's patient-rights rows (ops automation lane P6c; design E6 item 16):
 * at most two, counted across clinics from the tracker's own read (demo
 * clinics left out): the open requests due within two business days, and
 * those past their day, blocked ones included, since a blocked request's
 * clock keeps running. Each opens the Patient rights page, where every
 * request is listed with its clock and its prepared command. Counts and a
 * day only; no clinic, no person.
 */

export const RIGHTS_HREF = "/admin/rights";

function requests(n: number): string {
  return n === 1 ? "1 patient request" : `${n} patient requests`;
}

export function dueSoonSentence(n: number): string {
  return `${requests(n)} ${n === 1 ? "is" : "are"} due within two business days.`;
}

export function overdueSentence(n: number): string {
  return `${requests(n)} ${n === 1 ? "is" : "are"} past ${n === 1 ? "its" : "their"} date.`;
}

export const rightsSource: InboxSource = {
  name: "the patient-rights requests",
  async read(ctx) {
    const { rows, unreadClinics } = await collectRights({
      actor: ctx.actor,
      request: ctx.request,
      operator: ctx.operator.email,
      filter: "open",
      now: ctx.now,
    });
    const today = utcDay(ctx.now);
    const soon = rows.filter((r) => clockState(today, r.dueOn) === "due_soon");
    const late = rows.filter((r) => clockState(today, r.dueOn) === "overdue");
    const earliest = (list: typeof rows) => list.map((r) => r.dueOn).sort()[0] ?? null;
    const out: InboxRow[] = [];
    if (late.length > 0) {
      out.push({
        id: "rights:overdue",
        kind: "rights",
        count: late.length,
        sentence: overdueSentence(late.length),
        clinic: null,
        button: { label: "Open patient rights", kind: "link", href: RIGHTS_HREF },
        tone: "bad",
        dueAt: earliest(late),
      });
    }
    if (soon.length > 0) {
      out.push({
        id: "rights:due_soon",
        kind: "rights",
        count: soon.length,
        sentence: dueSoonSentence(soon.length),
        clinic: null,
        button: { label: "Open patient rights", kind: "link", href: RIGHTS_HREF },
        tone: "warn",
        dueAt: earliest(soon),
      });
    }
    return { rows: out, partial: unreadClinics > 0 ? `${unreadClinics} clinic(s) could not be read.` : undefined };
  },
};

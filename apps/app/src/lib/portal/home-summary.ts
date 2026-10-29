import type { ClaimsPayload } from "@/lib/reporting/claim-words";

import type { AttentionItem } from "./attention";
import { portalCount } from "./format";
import { waitingSentence, type WaitingFigures } from "./waiting-words";

/**
 * Home's two plain answers (spec, "Home: what happened, and is everything
 * working"): what AYA did this week, and what needs the clinic. Pure, so the
 * wording is one table test. Counts only; nothing here names a patient, a time
 * or a service. Only what v1 may claim is said (CLAUDE.md, "Claims and copy"):
 * conversations handled, appointments booked, booking requests taken, calls
 * answered that would otherwise have rung out. Never "revenue", never a
 * full-payment "collected".
 */

/** One thing that needs the clinic: a sentence and the one tap that does it. */
export type NeedItem = {
  key: string;
  text: string;
  action: { label: string; href: string } | null;
};

/**
 * The week in one sentence, or the empty-state sentence when nothing has
 * happened yet. "AYA handled 12 conversations, booked 3 appointments and took
 * 2 booking requests." Bookings AYA made and requests the team confirms are
 * kept apart, as claim-words does.
 */
export function weekHeadline(p: ClaimsPayload): string {
  if (p.handledCount === 0) {
    return "No conversations in the last 7 days yet. AYA is designed to answer the moment someone gets in touch.";
  }
  const parts = [`handled ${portalCount(p.handledCount, "conversation", "conversations")}`];
  if (p.bookedByAyaCount > 0) {
    parts.push(`booked ${portalCount(p.bookedByAyaCount, "appointment", "appointments")}`);
  }
  if (p.requestsTakenCount > 0) {
    parts.push(`took ${portalCount(p.requestsTakenCount, "booking request", "booking requests")}`);
  }
  const last = parts.pop() as string;
  const body = parts.length > 0 ? `${parts.join(", ")} and ${last}` : last;
  const rang =
    p.rangOutCount !== null && p.rangOutCount > 0
      ? ` ${portalCount(p.rangOutCount, "call", "calls")} would otherwise have rung out.`
      : "";
  return `AYA ${body}.${rang}`;
}

/**
 * The single list: what is waiting on Bookings, calls cut off, then every
 * setup, sign-in and billing item. The most time-sensitive first, as the page
 * used to stack them in separate cards. A missing destination (a screen not
 * built) leaves the sentence without a button rather than a dead link.
 */
export function needItems(input: {
  waiting: WaitingFigures | null;
  endedEarly: number;
  attention: readonly AttentionItem[];
  bookingsHref: string | null;
  conversationsHref: string | null;
  now: Date;
  weekDays: number;
}): NeedItem[] {
  const items: NeedItem[] = [];
  const w = input.waiting;
  if (w && (w.toCallBack > 0 || w.depositsToCollect > 0)) {
    items.push({
      key: "waiting",
      text: `Waiting for you: ${waitingSentence(w, input.now)}`,
      action: input.bookingsHref ? { label: "Open Bookings", href: input.bookingsHref } : null,
    });
  }
  if (input.endedEarly > 0) {
    items.push({
      key: "ended_early",
      text: `${portalCount(input.endedEarly, "call", "calls")} ended early in the last ${input.weekDays} days. The caller may want a call back.`,
      action: input.conversationsHref
        ? { label: "Open Conversations", href: input.conversationsHref }
        : null,
    });
  }
  for (const a of input.attention) {
    items.push({ key: a.key ?? a.id, text: a.text, action: a.action });
  }
  return items;
}

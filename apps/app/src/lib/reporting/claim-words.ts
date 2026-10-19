import { portalCount, portalMoney } from "@/lib/portal/format";

/**
 * The claims in words (lib/reporting/claims.ts counts them): one wording for
 * Home's week, the daily summary and the weekly recap, so a figure is never
 * named two ways. It says what v1 may claim and nothing else (CLAUDE.md,
 * "Claims and copy"): conversations handled, calls answered that would
 * otherwise have rung out, booking requests taken and confirmed by the team
 * or appointments booked by AYA, booked value at the clinic's own listed
 * prices, and deposits collected. Never "revenue", and "collected" only in
 * "deposits collected": tests/claims-and-summary.test.ts runs the email copy
 * lint over every line.
 *
 * Pure, with no database: the email templates render from a stored payload,
 * and this is what they and Home both call.
 */

/**
 * The claims as an email payload carries them, and as Home passes them on.
 * Counts and cents only, every key one the payload allowlist knows
 * (lib/email/lint.ts: `…Count`, `…Cents`, `is…`). A channel's count is null
 * when the clinic did not buy it; the rang-out count is null where it is
 * unavailable (no phone channel), never a zero that would claim we looked.
 */
export type ClaimsPayload = {
  handledCount: number;
  voiceCount: number | null;
  webCount: number | null;
  metaCount: number | null;
  rangOutCount: number | null;
  /** Bookings are requests the team confirms (lib/booking/mode.ts), not AYA's own. */
  isRequestMode: boolean;
  requestsTakenCount: number;
  requestsConfirmedCount: number;
  bookedByAyaCount: number;
  bookedValueCents: number;
  pricedBookingsCount: number;
  perUnitBookingsCount: number;
  unpricedBookingsCount: number;
  depositsCollectedCount: number;
  depositsCollectedCents: number;
  urgentCount: number;
  handoverCount: number;
};

/** One claim: what it is, and the figure. */
export type ClaimLine = { label: string; value: string };

export const CLAIM_LABELS = {
  handled: "Conversations handled",
  voice: "Phone",
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  requests: "Booking requests taken",
  bookedByAya: "Appointments booked by AYA",
  bookedValue: "Booked value at your listed prices",
  deposits: "Deposits collected",
} as const;

/**
 * The claims, in the order every surface shows them: conversations handled,
 * then each channel (the rang-out count in the phone row), then bookings,
 * booked value and deposits.
 *
 * Bookings lead with what is true of the clinic now: booking requests taken
 * and confirmed by the team while bookings are requests, appointments booked
 * by AYA once she books. Each line still shows whenever the period has any
 * of it, because a clinic that books directly still takes requests on
 * Instagram, Messenger and WhatsApp, and one that takes requests may have
 * had AYA book before its calendar stopped working.
 *
 * Booked value shows only once something booked had a listed price, flat or
 * per unit; a per-unit price is counted and never multiplied in, and a
 * booking with no listed price is named as such, so the total is never read
 * as covering what it does not. Deposits show once one was collected: phone
 * never collects one, and a clinic without a payment account takes none.
 */
export function claimLines(p: ClaimsPayload): ClaimLine[] {
  const lines: ClaimLine[] = [{ label: CLAIM_LABELS.handled, value: n(p.handledCount) }];
  if (p.voiceCount !== null) {
    const calls = portalCount(p.voiceCount, "call", "calls");
    lines.push({
      label: CLAIM_LABELS.voice,
      value:
        p.rangOutCount === null
          ? calls
          : `${calls} · ${n(p.rangOutCount)} would otherwise have rung out`,
    });
  }
  if (p.webCount !== null) {
    lines.push({ label: CLAIM_LABELS.web, value: portalCount(p.webCount, "chat", "chats") });
  }
  if (p.metaCount !== null) {
    lines.push({
      label: CLAIM_LABELS.meta,
      value: portalCount(p.metaCount, "conversation", "conversations"),
    });
  }

  const requests: ClaimLine = {
    label: CLAIM_LABELS.requests,
    value: `${n(p.requestsTakenCount)} · ${n(p.requestsConfirmedCount)} confirmed by your team`,
  };
  const booked: ClaimLine = {
    label: CLAIM_LABELS.bookedByAya,
    value: n(p.bookedByAyaCount),
  };
  if (p.isRequestMode) {
    lines.push(requests);
    if (p.bookedByAyaCount > 0) lines.push(booked);
  } else {
    lines.push(booked);
    if (p.requestsTakenCount > 0) lines.push(requests);
  }

  if (p.pricedBookingsCount > 0 || p.perUnitBookingsCount > 0) {
    const parts: string[] = [];
    if (p.pricedBookingsCount > 0) {
      parts.push(
        `${portalMoney(p.bookedValueCents)} across ${portalCount(p.pricedBookingsCount, "booking", "bookings")}`,
      );
    }
    if (p.perUnitBookingsCount > 0) {
      parts.push(
        `${portalCount(p.perUnitBookingsCount, "booking", "bookings")} priced per unit, not added in`,
      );
    }
    if (p.unpricedBookingsCount > 0) {
      parts.push(
        `${portalCount(p.unpricedBookingsCount, "booking", "bookings")} with no listed price`,
      );
    }
    lines.push({ label: CLAIM_LABELS.bookedValue, value: parts.join(" · ") });
  }

  if (p.depositsCollectedCount > 0) {
    lines.push({
      label: CLAIM_LABELS.deposits,
      value: `${n(p.depositsCollectedCount)} · ${portalMoney(p.depositsCollectedCents)}`,
    });
  }
  return lines;
}

/**
 * The daily summary's "escalated": what went to the clinic at the moment it
 * happened, as counts. Null when nothing did.
 */
export function escalatedLine(
  p: Pick<ClaimsPayload, "urgentCount" | "handoverCount">,
): string | null {
  const parts: string[] = [];
  if (p.urgentCount > 0) parts.push(portalCount(p.urgentCount, "urgent report", "urgent reports"));
  if (p.handoverCount > 0) {
    parts.push(
      portalCount(
        p.handoverCount,
        "request to speak with a person",
        "requests to speak with a person",
      ),
    );
  }
  if (parts.length === 0) return null;
  return `Sent to you as they happened: ${parts.join(" and ")}.`;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

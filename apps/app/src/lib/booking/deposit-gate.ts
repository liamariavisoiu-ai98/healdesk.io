import type Stripe from "stripe";

import { createDepositLink, depositLinkText } from "@/lib/billing/deposit-link";
import {
  depositDecision,
  effectiveDepositUsd,
  findService,
  readClinicDepositFacts,
  type DepositAction,
  type DepositChannel,
  type DepositOutcome,
} from "@/lib/billing/deposits";
import type { TenantTx } from "@/lib/tenant";

/**
 * The booking engine's deposit gate (plan §7.6, as the design record's §6
 * settles it once package D landed): D's depositDecision weighs the
 * service's own deposit (else the clinic default), the connected account and
 * the clinic's deposit switches, and the engine takes one of three branches
 * from its answer, before anything is held or written:
 *
 *   write    `book`, `book_and_flag`: the booking is written to Google; a
 *            flagged deposit is left to the front desk, with the L10 alert;
 *   reserve  `hold_and_alert`, and chat's `collect`: the slot is reserved for
 *            the clinic's deposit hold window and staff confirm it;
 *   decline  `decline_and_alert`: a request is logged, nothing is held or
 *            written, and staff are alerted.
 *
 * What a decision leaves on the appointment and the alert it raises are D's
 * recordDepositOutcome, the one deposit writer for the engine's bookings
 * (lib/meta/booking-requests.ts insertAppointment calls it). Staff
 * confirming a deposit reservation get the same decision for its service,
 * its L10 alert already sent when the time was reserved; other staff
 * confirmations still apply the clinic-level rule there.
 *
 * Voice never collects: a call hears depositLine (lib/booking/lines.ts) and is
 * never sent a link. The chat channels send one only through
 * depositLinkMessage below: createDepositLink's URL inside depositLinkText,
 * nothing more.
 */

export type DepositBranch = "write" | "reserve" | "decline";

export function depositBranch(action: DepositAction): DepositBranch {
  if (action === "book" || action === "book_and_flag") return "write";
  if (action === "hold_and_alert" || action === "collect") return "reserve";
  return "decline";
}

export type DepositGate = {
  outcome: DepositOutcome;
  branch: DepositBranch;
  /** clinic_settings.deposit_hold_minutes: how long a reservation keeps the slot. */
  holdMinutes: number;
};

/**
 * The decision for one booking at the tenant clinic, for the service named
 * (matched on its whole name; anything else gets the clinic default, never a
 * guess at the nearest service). `canCollectNow` is the chat channels' own:
 * a link can be created and sent in this conversation right now.
 */
export async function depositGateFor(
  tx: TenantTx,
  input: { channel: DepositChannel; service: string | null; canCollectNow?: boolean },
): Promise<DepositGate> {
  const facts = await readClinicDepositFacts(tx);
  const service = findService(facts.services, input.service);
  const outcome = depositDecision({
    channel: input.channel,
    depositsEnabled: facts.depositsEnabled,
    isConnected: facts.isConnected,
    amountUsd: effectiveDepositUsd({ service, policy: facts.policy }),
    bookVoiceWithoutDeposit: facts.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: facts.bookChatWithoutDeposit,
    uncollectable: facts.uncollectable,
    canCollectNow: input.channel === "voice" ? false : input.canCollectNow === true,
  });
  return { outcome, branch: depositBranch(outcome.action), holdMinutes: facts.holdMinutes };
}

/**
 * The deposit a booking that IS in the calendar carries: the decision as it
 * stands, except that a booking already made can no longer be declined or
 * reserved, so a deposit that is due is flagged for the front desk. Used by
 * the record step, which may run after the call (a write confirmed late).
 */
export function bookedDepositOutcome(outcome: DepositOutcome): DepositOutcome {
  if (!outcome.isRequired) return outcome;
  return depositBranch(outcome.action) === "write" || outcome.action === "collect"
    ? outcome
    : { ...outcome, action: "book_and_flag" };
}

/** What a voice line about a deposit needs (lib/booking/lines.ts depositLine): never a link. */
export type DepositLineFacts = { action: DepositAction; amountUsd: number | null };

/**
 * The one message a chat channel (the website, Meta) sends about a deposit:
 * the clinic's own payment link from createDepositLink, inside the fixed
 * words of depositLinkText, and nothing more; no amount, no service, no
 * time. Null when no link can be made (deposits off, not connected, no
 * amount, Stripe unavailable): the adapter falls back to the clinic's
 * "cannot be collected" setting. Voice has no branch here: a call is never
 * sent a link.
 */
export async function depositLinkMessage(
  clinicId: string,
  appointmentId: string,
  channel: "web" | "meta",
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<string | null> {
  const link = await createDepositLink(clinicId, appointmentId, { channel, ...options });
  return link.status === "open" ? depositLinkText(link.url) : null;
}

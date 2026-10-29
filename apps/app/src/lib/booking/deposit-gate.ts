import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";

import { appointments } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
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
import { describeError, log } from "@/lib/log";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The booking engine's deposit gate (plan §7.6, as the design record's §6
 * settles it once package D landed): D's depositDecision weighs the
 * service's own deposit (else the clinic default), the connected account and
 * the clinic's deposit switches, and the engine takes one of three branches
 * from its answer, before anything is held or written:
 *
 *   write    `book`, `book_and_flag`, and chat's `collect`: the booking is
 *            written to Google; a flagged deposit is left to the front desk,
 *            with the L10 alert; a `collect` deposit is the chat's payment
 *            link, sent once the booking is in (chatDepositFor, below: the
 *            spec's web chat "the slot is held, the booking is written ...
 *            a hosted checkout link opens ... the booking flips to paid");
 *   reserve  `hold_and_alert`: the slot is reserved for the clinic's
 *            deposit hold window and staff confirm it;
 *   decline  `decline_and_alert`: a request is logged, nothing is held or
 *            written, and staff are alerted.
 *
 * What a decision leaves on the appointment and the alert it raises are D's
 * recordDepositOutcome, the one deposit writer for the engine's bookings
 * (lib/meta/booking-requests.ts insertAppointment calls it). Staff
 * confirming a deposit reservation get the same decision for its service,
 * its L10 alert already sent when the time was reserved; staff confirming
 * a Meta request get the decision for its service on channel `meta`, whose
 * `collect` link lib/meta/deposit-link.ts sends after the commit (DEP-META
 * slice 1); other staff confirmations (a call's request) still apply the
 * clinic-level rule there.
 *
 * Voice never collects: a call hears depositLine (lib/booking/lines.ts) and is
 * never sent a link. The chat channels send one only through
 * chatDepositFor (the website chat's booking tool layer) or
 * depositLinkMessage below: createDepositLink's URL inside depositLinkText,
 * nothing more.
 */

export type DepositBranch = "write" | "reserve" | "decline";

/**
 * `collect` was a reservation until the chat sent links (21 October 2026):
 * a reservation has no appointment, and a deposit link is made for an
 * appointment's own amount (createDepositLink), so a reserved `collect` could
 * never have been sent a link at all.
 */
export function depositBranch(action: DepositAction): DepositBranch {
  if (action === "book" || action === "book_and_flag" || action === "collect") return "write";
  if (action === "hold_and_alert") return "reserve";
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
export type ChatDeposit =
  /** Nothing to say: no deposit, already paid or waived, or a link another request is opening. */
  | { kind: "none" }
  /**
   * The clinic's own payment link, inside depositLinkText's fixed words.
   * `url` and `depositId` are for an adapter with fixed words of its own (the
   * Meta desk-confirmed link, lib/meta/deposit-link.ts); the URL is never stored.
   */
  | { kind: "link"; text: string; reused: boolean; url: string; depositId: string }
  /** Left to the front desk, with the L10 alert: the chat says so, never a link. */
  | { kind: "flagged"; amountUsd: number | null };

/**
 * What the website chat says about a booking's deposit, once the booking is
 * in the calendar (lib/assistant/booking-tools.ts): the appointment's own
 * state decides, so a repeated tool call gets the same answer.
 *
 *   none, with an amount, or pending_link   the link: created once, and the
 *                                           open one returned after that
 *                                           (createDepositLink's one live
 *                                           link per appointment);
 *   pending_front_desk                      the front desk takes it;
 *   paid, waived, or no amount              nothing.
 *
 * A link that cannot be made (deposits switched off or the clinic's Stripe
 * disconnected since the booking, Stripe unavailable, a service name that
 * would reach Stripe) leaves the deposit to the front desk instead, with the
 * L10 alert, in the same transaction that moves it there. If this never runs
 * or never finishes (the process dies after the booking commits), the
 * booking was written `pending_link`, and lib/billing/deposit-sweep.ts hands
 * it to the front desk once its grace has passed.
 */
export async function chatDepositFor(
  clinicId: string,
  appointmentId: string,
  options: { channel: "web" | "meta"; actor: ActorContext; now?: Date; stripe?: Stripe },
): Promise<ChatDeposit> {
  const read = await withTenant({ clinicId, actor: options.actor }, async (tx) => {
    const [row] = await tx.db
      .select({ status: appointments.depositStatus, usd: appointments.depositUsd })
      .from(appointments)
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
      .limit(1);
    return row ?? null;
  });
  if (!read) return { kind: "none" };
  const amountUsd = read.usd === null ? null : Number(read.usd);
  if (read.status === "pending_front_desk") return { kind: "flagged", amountUsd };
  if (read.status !== "pending_link" && !(read.status === "none" && amountUsd !== null && amountUsd > 0)) {
    return { kind: "none" };
  }
  let link: Awaited<ReturnType<typeof createDepositLink>>;
  try {
    link = await createDepositLink(clinicId, appointmentId, {
      channel: options.channel,
      now: options.now,
      stripe: options.stripe,
    });
  } catch (error) {
    // A fault of our own, not Stripe's answer: the deposit still has to be
    // collected by someone, so it goes to the front desk as below.
    log.error("deposit link failed", { clinicId, error: describeError(error) });
    link = { status: "unavailable", reason: "stripe_error" };
  }
  if (link.status === "open") {
    return { kind: "link", text: depositLinkText(link.url), reused: link.reused, url: link.url, depositId: link.depositId };
  }
  if (link.reason === "already_paid" || link.reason === "in_progress") return { kind: "none" };
  const flagged = await withTenant({ clinicId, actor: options.actor }, async (tx) => {
    const moved = await tx.db
      .update(appointments)
      .set({ depositStatus: "pending_front_desk" })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          inArray(appointments.depositStatus, ["none", "pending_link"]),
        ),
      )
      .returning({ id: appointments.id });
    if (moved.length > 0) {
      tx.audit.record({
        action: "update",
        resourceType: "appointment",
        resourceId: appointmentId,
        metadata: { outcome: "deposit_to_front_desk", reason: link.reason },
      });
      await notifyBookingAlert(tx, "deposit_to_collect", { appointmentId });
    }
    return moved.length > 0;
  });
  log.warn("deposit link not made: left to the front desk", { clinicId, code: link.reason });
  return flagged ? { kind: "flagged", amountUsd } : { kind: "none" };
}

export async function depositLinkMessage(
  clinicId: string,
  appointmentId: string,
  channel: "web" | "meta",
  options: { now?: Date; stripe?: Stripe } = {},
): Promise<string | null> {
  const link = await createDepositLink(clinicId, appointmentId, { channel, ...options });
  return link.status === "open" ? depositLinkText(link.url) : null;
}

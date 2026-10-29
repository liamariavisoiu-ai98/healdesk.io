import { findClinicalContent, namesMetaTreatment } from "@healdesk/catalog";
import { assertNoTreatmentName, TreatmentNameError } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";

import { depositPayments } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { flagForFrontDesk, readClinicDepositFacts, recordDepositLapsed } from "@/lib/billing/deposits";
import { getStripe } from "@/lib/billing/stripe-client";
import { chatDepositFor } from "@/lib/booking/deposit-gate";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { META_WINDOW_MS, metaThreadLastInbound, resolveFollowUpOwner, sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import type { MetaPlatform } from "./front-door";

/**
 * The desk-confirmed deposit link on Instagram, Messenger and WhatsApp
 * (DEP-META slice 1, docs/design/launch-readiness-2026-10-27/dep-meta-deposit-links.md).
 *
 * When staff confirm a Meta booking request on Bookings and the service's
 * deposit could be collected in that conversation (decideWithin decided
 * `collect`, so the appointment owes `pending_link`), this runs after the
 * decision has committed, beside the calendar write, and never inside it:
 *
 *   1. the practice's switches and the thread's window are read again: an
 *      owner refused, or a window with under META_DEPOSIT_MIN_WINDOW_MS left,
 *      hands the deposit to the front desk before Stripe is called;
 *   2. the clinic's own link is made by chatDepositFor / createDepositLink
 *      (channel `meta`: amount, "Appointment deposit", DEPOSIT and an opaque
 *      reference, nothing else reaches Stripe), whose refusals already land
 *      with the front desk and its L10 alert;
 *   3. one fixed line, metaDepositLinkText, is sent through sendMetaReply in
 *      a fresh transaction, so the adapter enforces the window again at the
 *      moment of sending.
 *
 * Anything that stops the line (the window closed, the front door, the
 * platform or the answer gate off, the clinic gone, Graph refusing or timing
 * out) expires the Checkout session, cancels the deposit row and moves the
 * appointment to `pending_front_desk` with the L10 alert. A link nobody was
 * sent never stays payable beside a desk collecting by phone.
 *
 * Nothing of the message is stored: no copy of the line, no URL. The audit
 * rows carry ids, the platform and an outcome. The line is fixed text, not
 * the model's, so it never goes through guardReply (which refuses "deposit"
 * in the model's words by design); it has checks of its own, on the words
 * and never on the URL, whose random characters could false-match a short
 * service name.
 */

/** A link is sent only while at least this much of the thread's 24-hour window is left. */
export const META_DEPOSIT_MIN_WINDOW_MS = 5 * 60_000;

/** The fixed words before the URL: no amount, treatment, time, provider or clinic name. */
export const META_DEPOSIT_LINK_WORDS = "To hold your request, please pay the deposit through this secure link:";

const CHECKOUT_HOST = "checkout.stripe.com";

/**
 * The one line sent with the link. Refuses any URL that is not an https link
 * on checkout.stripe.com: no other host, port, credentials or whitespace.
 */
export function metaDepositLinkText(url: string): string {
  if (!isCheckoutUrl(url)) throw new Error("metaDepositLinkText takes the Stripe Checkout link createDepositLink returned.");
  return `${META_DEPOSIT_LINK_WORDS} ${url}`;
}

export function isCheckoutUrl(url: string): boolean {
  if (typeof url !== "string" || !/^https:\/\/\S+$/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === CHECKOUT_HOST && parsed.port === "" && parsed.username === "" && parsed.password === "";
}

/**
 * The checks on the fixed words, against the clinic's own service names:
 * no service named, nothing clinical (Meta's screen, everyday conditions
 * included), no treatment from the Meta vocabulary. False fails closed to
 * the front desk.
 */
export function metaDepositWordsAllowed(serviceNames: readonly string[]): boolean {
  try {
    assertNoTreatmentName(META_DEPOSIT_LINK_WORDS, serviceNames);
  } catch (error) {
    if (error instanceof TreatmentNameError) return false;
    throw error;
  }
  if (findClinicalContent({ words: META_DEPOSIT_LINK_WORDS }, { conditions: true }).length > 0) return false;
  return !namesMetaTreatment(META_DEPOSIT_LINK_WORDS);
}

/** At least META_DEPOSIT_MIN_WINDOW_MS of the thread's window left at `now`. */
export function metaDepositWindowOpen(lastInbound: Date | null, now: Date): boolean {
  return lastInbound !== null && lastInbound.getTime() + META_WINDOW_MS - now.getTime() >= META_DEPOSIT_MIN_WINDOW_MS;
}

/** Whether a follow-up owner may be sent for: the front door, the platform and the answer gate all said yes. */
export function ownerSendable(owner: MetaChannelOwner | null | undefined): boolean {
  return Boolean(owner && owner.enabled && owner.platformEnabled && !owner.withheld);
}

export type MetaDepositThread = { platform: MetaPlatform; externalId: string; senderId: string; connectionId: string };

/** What staff are told: the link went on the thread, or the front desk collects it; null when there is nothing to say. */
export type MetaDepositLinkOutcome = "sent" | "front_desk" | null;

export type MetaDepositLinkOptions = {
  actor: ActorContext;
  now?: Date;
  send?: MetaSender;
  stripe?: Stripe;
};

/**
 * Send the clinic's deposit link for one desk-confirmed Meta appointment,
 * after the decision committed. Never throws for a send or Stripe failure:
 * the outcome says where the deposit went.
 */
export async function sendMetaDepositLink(
  clinicId: string,
  appointmentId: string,
  thread: MetaDepositThread,
  options: MetaDepositLinkOptions,
): Promise<MetaDepositLinkOutcome> {
  const now = options.now ?? new Date();
  const actor = options.actor;

  // 1. The switches and the window, again, before Stripe is called.
  const owner = await resolveFollowUpOwner({ clinicId, connectionId: thread.connectionId, platform: thread.platform, actor, now });
  const before = await withTenant({ clinicId, actor }, async (tx) => {
    const facts = await readClinicDepositFacts(tx);
    const serviceNames = facts.services.map((s) => s.name).filter((n): n is string => typeof n === "string");
    const lastInbound = await metaThreadLastInbound(tx, thread.platform, thread.senderId);
    const reason = !ownerSendable(owner)
      ? "withheld"
      : !metaDepositWindowOpen(lastInbound, now)
        ? "outside_window"
        : !metaDepositWordsAllowed(serviceNames)
          ? "treatment_name"
          : null;
    if (reason) await toFrontDesk(tx, appointmentId, thread.platform, reason);
    return reason;
  });
  if (before) return "front_desk";

  // 2. The link. A refusal is already with the front desk and its alert.
  const deposit = await chatDepositFor(clinicId, appointmentId, { channel: "meta", actor, now, stripe: options.stripe });
  if (deposit.kind === "none") return null;
  if (deposit.kind === "flagged") return "front_desk";
  // A link already open for this appointment belongs to an earlier attempt,
  // which sent it or died before it could: never a second message. One never
  // sent lapses at its expiry and the webhook hands it to the front desk.
  if (deposit.reused) return null;

  // 3. The fixed line, in a fresh transaction, the adapter's window checked at send time.
  let failure: string;
  if (!isCheckoutUrl(deposit.url)) {
    failure = "not_checkout_url";
  } else {
    try {
      const sendNow = options.now ?? new Date();
      // The switches once more, now that the link exists: one turned off
      // while Stripe was making it withholds the line.
      const sendOwner = await resolveFollowUpOwner({ clinicId, connectionId: thread.connectionId, platform: thread.platform, actor, now: sendNow });
      const sent = await withTenant({ clinicId, actor }, async (tx) => {
        const lastInbound = await metaThreadLastInbound(tx, thread.platform, thread.senderId);
        if (!metaDepositWindowOpen(lastInbound, sendNow)) {
          tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: thread.platform, outcome: "outside_window", source: "deposit_link" } });
          return "outside_window";
        }
        const result = await sendMetaReply(tx, sendOwner, thread.externalId, thread.senderId, metaDepositLinkText(deposit.url), options.send, { now: sendNow });
        if (result.status !== "sent") return result.status;
        tx.audit.record({
          action: "create",
          resourceType: "meta_front_door_reply",
          resourceId: tx.clinicId,
          resourceIds: [deposit.depositId],
          metadata: { platform: thread.platform, source: "deposit_link", depositId: deposit.depositId },
        });
        return "sent";
      });
      if (sent === "sent") return "sent";
      failure = sent;
    } catch (error) {
      log.error("meta deposit link not sent", { clinicId, appointmentId, error: describeError(error) });
      failure = "send_failed";
    }
  }
  await unsend(clinicId, appointmentId, deposit.depositId, thread.platform, failure, { actor, now, stripe: options.stripe });
  return "front_desk";
}

/** The deposit to the front desk with the L10 alert (flagForFrontDesk moves `pending_link` only), audited by reason. */
async function toFrontDesk(tx: TenantTx, appointmentId: string, platform: MetaPlatform, reason: string, mayBePaid = false): Promise<void> {
  const moved = await flagForFrontDesk(tx, appointmentId, mayBePaid ? { mayBePaid: true } : {});
  if (moved) {
    tx.audit.record({ action: "update", resourceType: "appointment", resourceId: appointmentId, metadata: { outcome: "deposit_to_front_desk", reason, channel: "meta", platform } });
  }
}

/**
 * The link was made but not sent: expire the Checkout session first, outside
 * any transaction, then cancel the row and hand the deposit to the front
 * desk. If Stripe cannot expire it, the row stays open so the webhook still
 * records a payment or a lapse, and the alert says it may already be paid.
 */
async function unsend(
  clinicId: string,
  appointmentId: string,
  depositId: string,
  platform: MetaPlatform,
  reason: string,
  options: { actor: ActorContext; now: Date; stripe?: Stripe },
): Promise<void> {
  const row = await withTenant({ clinicId, actor: options.actor }, async (tx) => {
    const [found] = await tx.db
      .select({ sessionId: depositPayments.checkoutSessionId, account: depositPayments.stripeAccountId })
      .from(depositPayments)
      .where(and(eq(depositPayments.id, depositId), eq(depositPayments.clinicId, tx.clinicId)))
      .limit(1);
    return found ?? null;
  });
  let expired = false;
  if (row?.sessionId) {
    try {
      const stripe = options.stripe ?? getStripe();
      await stripe.checkout.sessions.expire(row.sessionId, {}, { stripeAccount: row.account, timeout: 20_000, maxNetworkRetries: 1 });
      expired = true;
    } catch (error) {
      log.warn("meta deposit link: the unsent session could not be expired", { clinicId, code: error instanceof Error ? error.name : "unknown" });
    }
  }
  await withTenant({ clinicId, actor: options.actor }, async (tx) => {
    if (expired) {
      await recordDepositLapsed(tx, { depositId, status: "cancelled", from: ["creating", "open"], eventId: null, at: options.now });
    }
    await toFrontDesk(tx, appointmentId, platform, reason, !expired);
    tx.audit.record({ action: "update", resourceType: "deposit_payment", resourceId: depositId, metadata: { outcome: "link_not_sent", reason, channel: "meta", platform, sessionExpired: expired } });
  });
}

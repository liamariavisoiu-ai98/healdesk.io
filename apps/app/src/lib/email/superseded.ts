import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq, gt, sql } from "drizzle-orm";

import { appointments, bookingRequests, clinicChannels, clinics, paymentLinkTexts, type ChannelWaitingOn } from "@/db/schema";
import { flagForFrontDeskReporting } from "@/lib/billing/deposits";
import { pauseEmailSuperseded } from "@/lib/channels/pause";
import type { TenantTx } from "@/lib/tenant";

import type { NoticeKind } from "./kinds";

/**
 * Notices whose subject can be over before they go. The outbox asks here at
 * send time, after quiet hours have let the notice through and before it
 * claims a send, so an email queued in the evening and held until 07:00 is
 * not sent about a step the clinic finished overnight. A superseded notice is
 * closed unsent, like one whose optional switch is off.
 *
 * Five kinds today. O10 (`channel_ready`): "{Channel} is ready: one step
 * left" is wrong once the step is done or the channel is live. L15's
 * reminder (`ai_paused`, 24 hours into a pause with no end, or a channel left
 * Off): wrong once AYA is back on there (lib/channels/pause.ts). L8
 * (`request_still_open`): "still waiting" is wrong once the desk has answered
 * every request, which matters when the sender's switch was off and a day's
 * L8 would otherwise go out late. E4 and E5 (`export_ready`,
 * `export_reminder`): "Your export is ready" and "Download it by" are wrong
 * once a download or the operator's handover has recorded the export as
 * delivered, or once the data is destroyed (lib/offboarding/
 * after-cancellation.ts). L10 (`deposit_to_collect`) about a booking: "left
 * the deposit for your team to collect" is wrong once the deposit is no
 * longer the front desk's, paid, waived, or with a payment link out (the
 * payment-link text after a call, lib/sms/payment-text.ts, which holds the
 * L10 while the caller is offered it), so staff are never told to collect a
 * deposit the caller was just texted a link for. Every other kind, the
 * first L15 among them, is about something that has already happened, and
 * goes regardless.
 */

/**
 * The one step O10 names for each channel that has its ready email: phone's
 * forwarding, and website chat's line, which stops being the step once an
 * operator has seen it on the clinic's site (`runtime_seen`) or the channel
 * is live, so a line already in place is never mailed as the step left.
 */
export const READY_STEP: Readonly<Partial<Record<Channel, ChannelWaitingOn>>> = {
  voice: "forwarding",
  web: "snippet",
};

/** A channel is still waiting on the step O10 names: ready on our side, not live, that step open. */
export function isWaitingOnReadyStep(
  channel: Channel,
  row: { readyAt: Date | null; waitingOn: string | null; liveAt: Date | null } | undefined,
): boolean {
  const step = READY_STEP[channel];
  return Boolean(step && row?.readyAt && !row.liveAt && row.waitingOn === step);
}

/**
 * Why the notice no longer needs sending, for its `last_error`, or null when
 * it still does. Runs in the outbox's tenant transaction, and mostly reads;
 * for a call booking's L10 over a payment-link text whose outcome is
 * unknown, it also hands the deposit to the front desk and queues the
 * possibly-paid L10 that replaces the plain one (depositAlertSuperseded).
 */
export async function supersededReason(
  tx: TenantTx,
  kind: NoticeKind,
  payload: unknown,
): Promise<string | null> {
  if (kind === "ai_paused") return pauseEmailSuperseded(tx, payload);
  if (kind === "export_ready" || kind === "export_reminder") return exportNoticeSuperseded(tx);
  if (kind === "deposit_to_collect") return depositAlertSuperseded(tx, payload);
  if (kind === "request_still_open") {
    const [open] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.clinicId, tx.clinicId),
          eq(bookingRequests.status, "requested"),
          gt(bookingRequests.expiresAt, sql`now()`),
        ),
      );
    return (open?.n ?? 0) > 0 ? null : "no booking request is still waiting";
  }
  if (kind !== "channel_ready") return null;
  const channel = (payload as { channel?: unknown } | null)?.channel;
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) {
    return null;
  }
  const [row] = await tx.db
    .select({
      readyAt: clinicChannels.readyAt,
      waitingOn: clinicChannels.waitingOn,
      liveAt: clinicChannels.liveAt,
    })
    .from(clinicChannels)
    .where(
      and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel as Channel)),
    )
    .limit(1);
  return isWaitingOnReadyStep(channel as Channel, row)
    ? null
    : "the channel's last step was done before it could go";
}

/** L10 about a booking is moot once its deposit is no longer the front desk's to collect. */
async function depositAlertSuperseded(tx: TenantTx, payload: unknown): Promise<string | null> {
  const appointmentId = (payload as { appointmentId?: unknown } | null)?.appointmentId;
  if (typeof appointmentId !== "string") return null;
  const [row] = await tx.db
    .select({ deposit: appointments.depositStatus })
    .from(appointments)
    .where(and(eq(appointments.clinicId, tx.clinicId), eq(appointments.id, appointmentId)))
    .limit(1);
  if (!row || row.deposit === "pending_front_desk") return null;
  if (row.deposit === "pending_link") {
    // A call's link counts as gone out only once its text is recorded sent:
    // a link made for a text that never went (a crash between the link and
    // the send) leaves the L10 to go, and the front desk to collect.
    const [text] = await tx.db
      .select({ status: paymentLinkTexts.status })
      .from(paymentLinkTexts)
      .where(and(eq(paymentLinkTexts.clinicId, tx.clinicId), eq(paymentLinkTexts.appointmentId, appointmentId)))
      .limit(1);
    // The possibly-paid email itself is decided on the deposit's own state:
    // were it sent here, its own key already exists, nothing new would be
    // queued, and closing it would leave neither email to go.
    const possiblyPaid = (payload as { isPossiblyPaid?: unknown } | null)?.isPossiblyPaid === true;
    if (text?.status === "queued" && !possiblyPaid) {
      // Claimed and never settled: the process died, or the outcome could
      // not be recorded, possibly after AWS accepted the text. The texted
      // link may be paid, so the front desk is told to check Stripe first
      // (the possibly-paid L10, the same key the payment-text "unknown"
      // path uses, so never twice), and this plain "collect" one is closed.
      // Closed only once that alert is known to be queued: if it could not
      // be, the plain email goes, since a plain email beats none.
      const flagged = await flagForFrontDeskReporting(tx, appointmentId, { mayBePaid: true });
      if (flagged.moved) {
        // As the payment-text tool layer records its own hand-over (toFrontDesk).
        tx.audit.record({
          action: "update",
          resourceType: "appointment",
          resourceId: appointmentId,
          metadata: { outcome: "deposit_to_front_desk", reason: "payment_text_unknown" },
        });
      }
      if (!flagged.moved || !flagged.queued) return null;
      return "the payment-link text's outcome is unknown; the possibly-paid alert replaces it";
    }
    if (text && text.status !== "sent") return null;
    return "a payment link went out for the deposit before it could go";
  }
  return "the deposit was no longer the front desk's before it could go";
}

/** E4 and E5 are moot once the export is delivered, or once there is nothing left to export. */
async function exportNoticeSuperseded(tx: TenantTx): Promise<string | null> {
  const [clinic] = await tx.db
    .select({ deliveredAt: clinics.exportDeliveredAt, destroyedAt: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (clinic?.destroyedAt) return "the clinic's data was destroyed before it could go";
  if (clinic?.deliveredAt) return "the export was delivered before it could go";
  return null;
}

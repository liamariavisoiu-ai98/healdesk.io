import { billingRecipients } from "@/lib/billing/recipients";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { getJob, JOB_BILLING_NOTICES } from "@/lib/scheduler/jobs";
import type { TenantTx } from "@/lib/tenant";

/**
 * Whether an urgent alert (L12) raised now would reach this clinic, so the
 * fixed urgent reply may say "I've told the team" (@healdesk/catalog,
 * fixedUrgentReply) and the wizard's urgent screen may say AYA tells the
 * team at once.
 *
 * Until 21 October 2026 this was a constant, URGENT_ALERT_DELIVERED = true.
 * But the alert is only queued by the conversation: it is sent by the
 * outbox (lib/email/outbox.ts), which sends nothing while the
 * `billing-notices` job is off (and jobs ship off), sends only through
 * Resend once HEALDESK_EMAIL_TRANSPORT, RESEND_API_KEY and
 * HEALDESK_EMAIL_FROM are set (lib/email/send.ts, platformTransport, and
 * ResendTransport), and marks the row dead when the clinic has no address
 * to send to (billingRecipients). With any of the three missing, a caller
 * was told the team knew while nothing would ever be sent. So the line is
 * said only while all three hold for this clinic, read when the facts are:
 *
 *   - the sender's switch, the `billing-notices` job row, is on;
 *   - a transport is configured: the one this conversation's caller hands
 *     the outbox (a test's fake), else Resend with its key and its sender
 *     address present. Presence only: the key's value is never read into
 *     anything, logged or returned;
 *   - the clinic has an address the outbox would send L12 to, resolved
 *     exactly as deliverNotice resolves it, on the clinic the alert is
 *     queued on (notifyBookingAlert queues it on the conversation's clinic).
 *
 * Every check fails closed: one that throws counts as missing. The alert is
 * queued either way (notifyBookingAlert), so it goes the moment the switch,
 * the key and the address exist; only the promise waits for them. Ready is
 * still not sent: a turn whose own row fails to queue drops the line too
 * (withoutTeamTold, lib/notices/booking-alerts.ts).
 */

export type UrgentAlertGap =
  /** The `billing-notices` job is off: the outbox sends nothing. */
  | "sender_off"
  /** No email transport: HEALDESK_EMAIL_TRANSPORT is not resend, or its key or sender is missing. */
  | "no_transport"
  /** The clinic has no address the outbox would send L12 to. */
  | "no_recipient";

export type UrgentAlertReadiness = {
  ready: boolean;
  /** What is missing, in this order; empty exactly when ready. */
  missing: UrgentAlertGap[];
};

/** The variables read here, as process.env holds them or a test passes them. */
type Environment = Readonly<Record<string, string | undefined>>;

/** A value the host's entrypoint would have unset (docker-entrypoint.sh), or none at all. */
function present(value: string | undefined): boolean {
  const v = value?.trim();
  return Boolean(v) && v !== "__unset__";
}

/**
 * Whether this process would send the outbox's mail through a real
 * transport: Resend, with its key and its sender address present. Anything
 * else is the console stub, which sends nothing (and refuses in production).
 * Reads presence only.
 */
export function emailTransportConfigured(environment: Environment = process.env): boolean {
  return (
    environment.HEALDESK_EMAIL_TRANSPORT === "resend" &&
    present(environment.RESEND_API_KEY) &&
    present(environment.HEALDESK_EMAIL_FROM)
  );
}

async function senderOn(): Promise<boolean> {
  try {
    return (await getJob(JOB_BILLING_NOTICES))?.enabled === true;
  } catch (error) {
    log.error("urgent readiness: the sender's switch could not be read", { error: describeError(error) });
    return false;
  }
}

async function hasRecipient(tx: TenantTx): Promise<boolean> {
  try {
    // In a savepoint: a failed read must not abort the caller's transaction.
    return await tx.db.transaction(async (savepoint) => {
      const recipients = await billingRecipients({ ...tx, db: savepoint }, "urgent");
      return recipients.length > 0;
    });
  } catch (error) {
    log.error("urgent readiness: the clinic's address could not be read", {
      clinicId: tx.clinicId,
      error: describeError(error),
    });
    return false;
  }
}

/**
 * The three conditions, for the clinic `tx` is open on. Never throws.
 * `transport` is the transport this conversation hands the outbox, when it
 * hands one; production hands none and the environment decides.
 */
export async function urgentAlertReadiness(
  tx: TenantTx,
  options: { transport?: EmailTransport; environment?: Environment } = {},
): Promise<UrgentAlertReadiness> {
  const missing: UrgentAlertGap[] = [];
  if (!(await senderOn())) missing.push("sender_off");
  if (!options.transport && !emailTransportConfigured(options.environment)) missing.push("no_transport");
  if (!(await hasRecipient(tx))) missing.push("no_recipient");
  return { ready: missing.length === 0, missing };
}

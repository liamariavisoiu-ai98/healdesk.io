import { and, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { opsAlerts } from "@/db/schema";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { OPS_REASON } from "@/lib/email/templates/context";
import { renderFlagAlert, type FlagAlertPayload } from "@/lib/email/templates/flag_alert";
import { describeError, log } from "@/lib/log";

/**
 * I4 (Annex X5): each "Flag this answer", and two flags from one clinic in
 * seven days, to ops. The internal ticket the spec's flag opens ("The flag
 * also opens an internal ticket. Two flags from one clinic in a week is an
 * alert, not a statistic").
 *
 * The ticket is a row in the ops log (ops_alerts, event `flag_alert`, key
 * `flag=<flag id>`), as Annex X3 keeps a kind with no clinic's address on its
 * own row, and the email to HEALDESK_OPS_EMAIL (falling back to
 * HEALDESK_ADMIN_EMAIL, as notifyOps and the digest do), keyed
 * `hd-flag_alert-<row id>-1`. One per flag, ever: the row is claimed under an
 * advisory lock, so a flag recorded once is one ticket however often this is
 * called. A ticket whose email could not go keeps its row with the error, and
 * the 07:00 digest counts it among the ops alerts left unsent.
 *
 * Called once the flag's own transaction has committed (lib/portal/flag-answer.ts),
 * so a flag that rolled back opens no ticket. Ids, counts and categories
 * only (the payload allowlist runs on every send). Never throws: the flag is
 * recorded already, and a mail outage must not turn the clinic's click into
 * an error.
 */

export const FLAG_ALERT_EVENT = "flag_alert";

export type FlagAlertOutcome =
  | { status: "sent"; alertId: string }
  | { status: "already_raised"; alertId: string | null }
  | { status: "no_address"; alertId: string }
  /** The environment sends no email (the console transport): recorded on the row, as notifyOps records it. */
  | { status: "skipped"; alertId: string; reason: string }
  | { status: "failed"; alertId: string | null; reason: string };

/** Where I4 goes. Never a clinic's address. */
function opsAddress(): string | null {
  const configured =
    process.env.HEALDESK_OPS_EMAIL?.trim() || process.env.HEALDESK_ADMIN_EMAIL?.trim();
  return configured ? configured : null;
}

/** The ticket's row: inserted once per flag, or null when one exists already. */
async function claimTicket(payload: FlagAlertPayload, now: Date): Promise<string | null> {
  const key = `flag=${payload.flagId}`;
  return unsafeDb.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ops_alert|${FLAG_ALERT_EVENT}|${key}`}, 0))`,
    );
    const [existing] = await tx
      .select({ id: opsAlerts.id })
      .from(opsAlerts)
      .where(and(eq(opsAlerts.event, FLAG_ALERT_EVENT), eq(opsAlerts.dedupeKey, key)))
      .limit(1);
    if (existing) return null;
    const [inserted] = await tx
      .insert(opsAlerts)
      .values({
        event: FLAG_ALERT_EVENT,
        dedupeKey: key,
        fields: {
          clinicId: payload.clinicId,
          flagId: payload.flagId,
          conversationId: payload.conversationId,
          flagsCount: payload.flagsCount,
        },
        raisedAt: now,
        lastRaisedAt: now,
      })
      .returning({ id: opsAlerts.id });
    return inserted?.id ?? null;
  });
}

/** Record what became of the email on the ticket's row. The row is only ever stamped (0046). */
async function stamp(
  alertId: string,
  outcome: { sentAt: Date; messageId: string } | { lastError: string },
): Promise<void> {
  try {
    await unsafeDb
      .update(opsAlerts)
      .set("sentAt" in outcome ? { ...outcome, lastError: null } : outcome)
      .where(eq(opsAlerts.id, alertId));
  } catch (error) {
    log.warn("flag alert not stamped", { deliveryId: alertId, error: describeError(error) });
  }
}

/** Open the ticket for one recorded flag and email it to ops. Never throws. */
export async function sendFlagAlert(
  payload: FlagAlertPayload,
  options: SendEmailOptions = {},
): Promise<FlagAlertOutcome> {
  const now = options.now ?? new Date();
  let alertId: string | null = null;
  try {
    // The allowlist first: a payload that could carry anything else opens no
    // ticket and sends nothing.
    assertPayloadAllowed(payload, "flag_alert");
    alertId = await claimTicket(payload, now);
    if (!alertId) return { status: "already_raised", alertId: null };
    log.info("answer flagged", {
      event: FLAG_ALERT_EVENT,
      clinicId: payload.clinicId,
      conversationId: payload.conversationId,
      deliveryId: alertId,
      count: payload.flagsCount,
    });

    const to = opsAddress();
    if (!to) {
      await stamp(alertId, { lastError: "HEALDESK_OPS_EMAIL is not set." });
      return { status: "no_address", alertId };
    }
    const rendered = renderFlagAlert(payload, {
      clinicName: null,
      audience: "patients",
      reason: OPS_REASON,
      raisedAt: now,
      timeZone: "UTC",
    });
    const result = await sendEmail(
      {
        to,
        kind: "flag_alert",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        deliveryId: alertId,
        idempotencyKey: `hd-flag_alert-${alertId}-1`,
      },
      { now, ...options },
    );
    if (result.status !== "sent") {
      const reason = `${result.status}: ${result.reason}`.slice(0, 300);
      await stamp(alertId, { lastError: reason });
      if (result.status === "failed") {
        log.warn("flag alert email failed", { deliveryId: alertId, reason: result.reason });
        return { status: "failed", alertId, reason };
      }
      return { status: "skipped", alertId, reason };
    }
    await stamp(alertId, { sentAt: new Date(), messageId: result.messageId });
    return { status: "sent", alertId };
  } catch (error) {
    const reason = describeError(error);
    if (alertId) await stamp(alertId, { lastError: reason.slice(0, 300) });
    log.warn("flag alert not sent", { deliveryId: alertId ?? undefined, error: reason });
    return { status: "failed", alertId, reason };
  }
}

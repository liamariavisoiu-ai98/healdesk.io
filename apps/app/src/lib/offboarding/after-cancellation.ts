import { agreementKindOfVersion, BACKUP_RETENTION_DAYS, isCarrier } from "@healdesk/catalog";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinicChannels, clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { readCoverageMode } from "@/lib/billing/answering";
import type { ForwardingFacts } from "@/lib/billing/notices";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { verdictOf } from "@/lib/email/outbox";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import {
  renderDataDestroyed,
  type DataDestroyedPayload,
} from "@/lib/email/templates/data_destroyed";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { notifyOps } from "@/lib/ops/notify";
import { publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { withTenant, type TenantTx } from "@/lib/tenant";

import {
  destructionPlan,
  destructionPlanIn,
  passThroughEndsAt,
  type DestructionPlan,
} from "./offboarding";

/**
 * After cancellation (Annex X5, E3–E6): what a leaving clinic is told, and
 * when, between the end of its service and the destruction of its data.
 * E1 and E2 are Package C's billing notices; these four follow them.
 *
 *   - E3, `pass_through_ending`: 7 days and 1 day before calls still
 *     forwarded to us stop passing through to the direct line (Terms §7,
 *     FORWARDING_PASS_THROUGH_DAYS from the end), to a clinic whose line was
 *     pointed at us: phone went live, or a forwarding test saw a forwarded
 *     call (phoneWasForwardedToUs). Never from calls recorded after the end:
 *     the database takes no new patient row once offboarding has started
 *     (app_clinic_accepts_phi), so a passed-through call leaves none. A
 *     clinic destroyed before its pass-through ended gets it too: its line
 *     still forwards, and its number is kept, until then. With the carrier
 *     undo codes.
 *   - E4, `export_ready`: once the service has ended. The export is the
 *     portal's (Conversations, behind the sign-in and the passkey step-up),
 *     built in full from the records at each download; only a download that
 *     reaches the browser whole records it as delivered (lib/portal/
 *     conversations.ts), and that stamp is what the destruction clock reads.
 *   - E5, `export_reminder`: EXPORT_REMINDER_DAYS before the data goes
 *     undownloaded, while no download is recorded.
 *   - E6, `data_destroyed`: on destruction, to the address destroyClinicData
 *     captured in its own transaction (clinics.destruction_notice_address,
 *     drizzle/0086), which is cleared once E6 is sent, once it fails for
 *     good, and in any case DESTRUCTION_NOTICE_DAYS after the destruction.
 *
 * ## How the export is triggered on this host
 *
 * The export pipeline that existed was two things: the operator's one-off
 * ECS task (`patient-export`, started by hand with infra/aws/scripts/
 * run-task.sh) writing a bundle to the export bucket, and the portal's own
 * download on Conversations. The bucket cannot hold a clinic's export: only
 * that task's role may write to it, only administrators may read it (the web
 * tier and the worker cannot), and its lifecycle deletes every object after a
 * day, against a download window of up to 89 days. Nothing in the app may
 * start an ECS task either. So the trigger is the worker's hourly tick
 * (lib/scheduler/tick.ts, the `after-cancellation` step), which queues E4 once
 * a clinic's service has ended, and the export itself is the portal's,
 * produced by exportClinic from the database at the moment it is
 * downloaded. No second copy of the clinic's records is ever stored: one
 * would go stale against the access log, against calls passed through after
 * the end, and against every erasure, amendment and purge after it was
 * built, each of which would have to chase it.
 *
 * Every email here is a pointer: no patient data, and the export only
 * through the portal. Queued in the clinic's own transaction through the
 * plan's outbox (E3–E5), or sent straight with a ledger row (E6, a direct
 * kind: the outbox sends to the clinic's address as it stands at send time,
 * and E6 must go to the one captured before destruction).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "after-cancellation" } as const;

/** E3's two notices: a week ahead, then a day ahead. */
export const PASS_THROUGH_NOTICE_DAYS = [7, 1] as const;
export type PassThroughNotice = (typeof PASS_THROUGH_NOTICE_DAYS)[number];
/** E5 goes this long before the data is destroyed undownloaded. */
export const EXPORT_REMINDER_DAYS = 7;
/**
 * How long the captured address may wait for E6 to go before it is cleared
 * anyway: a week of hourly attempts. Past it ops is told, and writes to the
 * practice by hand.
 */
export const DESTRUCTION_NOTICE_DAYS = 7;
/** The ledger's period for E6: once per clinic. */
const DESTROYED_PERIOD = "destroyed";

// -----------------------------------------------------------------------------
// Dates: pure, so each rule is one table test
// -----------------------------------------------------------------------------

/** When forwarded calls stop passing through: lib/offboarding's, which keeps AYA's number until then. */
export { passThroughEndsAt };

/**
 * The E3 notice due at `now`, or null: the nearer of the two whose time has
 * come, and none once the pass-through has ended. A worker that was down
 * through the week's notice sends the day's alone, not both at once.
 */
export function passThroughNoticeDue(endedAt: Date, now: Date): PassThroughNotice | null {
  const ends = passThroughEndsAt(endedAt).getTime();
  if (now.getTime() >= ends) return null;
  for (const days of [...PASS_THROUGH_NOTICE_DAYS].sort((a, b) => a - b)) {
    if (now.getTime() >= ends - days * DAY_MS) return days;
  }
  return null;
}

/**
 * The last whole UTC day on which a download is sure to beat the latest
 * destruction: the day before it (an hourly run can destroy the data any
 * time on the day it is due). On the thirty days it is the plan's exportByOn.
 */
export function downloadByOn(plan: DestructionPlan): string {
  return isoDay(new Date(plan.latestDestroyAt.getTime() - DAY_MS));
}

/** E5 is due: no download recorded, and the latest destruction a week off or less, not yet passed. */
export function exportReminderDue(
  plan: DestructionPlan,
  exportDeliveredAt: Date | null,
  now: Date,
): boolean {
  if (exportDeliveredAt) return false;
  const at = plan.latestDestroyAt.getTime();
  return now.getTime() >= at - EXPORT_REMINDER_DAYS * DAY_MS && now.getTime() < at;
}

/** The day the last backup that could hold the destroyed data expires. */
export function backupsExpireOn(destroyedAt: Date): string {
  return isoDay(new Date(destroyedAt.getTime() + BACKUP_RETENTION_DAYS * DAY_MS));
}

/** Whether E6's captured address has waited past its bound. */
export function destructionNoticeExpired(destroyedAt: Date, now: Date): boolean {
  return now.getTime() >= destroyedAt.getTime() + DESTRUCTION_NOTICE_DAYS * DAY_MS;
}

// -----------------------------------------------------------------------------
// E3, E4 and E5: queued from the hourly tick
// -----------------------------------------------------------------------------

export type AfterCancellationRun = { clinics: number; queued: number; failures: number };

/**
 * Every clinic whose service has ended, each in its own transaction: E4
 * once and E5 when it is due, while its data is not yet destroyed; E3 when
 * one is due to a clinic whose line was pointed at us, destroyed or not.
 * Each dedupe key queues once, so an hour that runs twice queues nothing new. Not a switched job: the export is
 * owed whether or not anyone switched anything on (Terms §7), and the outbox
 * that sends these has its own switch.
 */
export async function queueAfterCancellationNotices(
  now: Date = new Date(),
): Promise<AfterCancellationRun> {
  const run: AfterCancellationRun = { clinics: 0, queued: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (!clinic.offboardingStartedAt) continue;
    const plan = destructionPlan(clinic);
    if (!plan) continue;
    // A destroyed clinic has nothing left to export, and is reached only
    // while E3 may still be due.
    if (clinic.destroyedAt && passThroughNoticeDue(plan.endedAt, now) === null) continue;
    run.clinics += 1;
    try {
      run.queued += await withTenant({ clinicId: clinic.id, actor: ACTOR }, (tx) =>
        queueFor(tx, clinic, plan, now),
      );
    } catch (error) {
      run.failures += 1;
      log.error("after-cancellation notices not queued", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return run;
}

async function queueFor(
  tx: TenantTx,
  clinic: ClinicOverview,
  plan: DestructionPlan,
  now: Date,
): Promise<number> {
  let queued = 0;
  const exportUrl = publicUrl(`/c/${clinic.slug}/conversations#export`);

  if (!clinic.destroyedAt && !clinic.exportDeliveredAt && (await exportOwed(tx))) {
    if (
      await enqueuePlanNotice(tx.db, tx.clinicId, "export_ready", "export_ready", {
        exportByOn: plan.exportByOn,
        destroyByOn: plan.destroyByOn,
        exportUrl,
      })
    ) {
      queued += 1;
    }
    if (exportReminderDue(plan, clinic.exportDeliveredAt, now)) {
      if (
        await enqueuePlanNotice(tx.db, tx.clinicId, "export_reminder", "export_reminder", {
          downloadByOn: downloadByOn(plan),
          destroyByOn: plan.destroyByOn,
          exportUrl,
        })
      ) {
        queued += 1;
      }
    }
  }

  const notice = passThroughNoticeDue(plan.endedAt, now);
  if (notice !== null && (await phoneWasForwardedToUs(tx, clinic))) {
    if (
      await enqueuePlanNotice(
        tx.db,
        tx.clinicId,
        "pass_through_ending",
        `pass_through_ending:${notice}`,
        {
          passThroughEndsAt: passThroughEndsAt(plan.endedAt).toISOString(),
          noticeDays: notice,
          ...(await forwardingFactsIn(tx)),
        },
      )
    ) {
      queued += 1;
    }
  }
  return queued;
}

/**
 * Whether the clinic is owed E4 and E5: it holds records to export, or E2
 * has told it an export is coming. A setup closure with nothing ever
 * recorded gets its own email (setup_closed), which promises no export, and
 * an empty file would tell it nothing.
 */
async function exportOwed(tx: TenantTx): Promise<boolean> {
  const c = tx.clinicId;
  const result = await tx.db.execute<{ owed: boolean }>(
    sql`select (exists (select 1 from contacts where clinic_id = ${c}::uuid)
             or exists (select 1 from conversations where clinic_id = ${c}::uuid)
             or exists (select 1 from booking_requests where clinic_id = ${c}::uuid)
             or exists (select 1 from appointments where clinic_id = ${c}::uuid)
             or exists (select 1 from chat_threads where clinic_id = ${c}::uuid)
             or exists (select 1 from webhook_events where clinic_id = ${c}::uuid)
             or exists (select 1 from billing_notices
                         where clinic_id = ${c}::uuid and kind = 'canceled')) as owed`,
  );
  return result.rows[0]?.owed === true;
}

/**
 * Whether the clinic pointed its line at us, so has forwarding to undo: phone
 * went live (clinic_channels.live_at for voice, which phone reaches only
 * with a forwarding test's evidence, lib/channels/events.ts), or a test
 * saw a forwarded call that still stands (clinics.forwarding_test_observed,
 * which a test started again clears until it sees another). Both are
 * configuration, kept through destruction, and neither is written by a call
 * after the end. healdesk holds no record of a clinic undoing its forwarding,
 * which happens at its carrier, so E3 asks it to "if you haven't already".
 */
async function phoneWasForwardedToUs(
  tx: TenantTx,
  clinic: Pick<ClinicOverview, "forwardingTestObserved">,
): Promise<boolean> {
  if (clinic.forwardingTestObserved) return true;
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt })
    .from(clinicChannels)
    .where(
      and(
        eq(clinicChannels.clinicId, tx.clinicId),
        eq(clinicChannels.channel, "voice"),
        isNotNull(clinicChannels.liveAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * How the clinic's calls reach us, as catalog ids, for the undo codes: the
 * carrier when the catalog knows it, the phone system, and the coverage mode
 * from clinic_settings, the single source (readCoverageMode). The same facts
 * Package C's E2 carries.
 */
async function forwardingFactsIn(tx: TenantTx): Promise<ForwardingFacts> {
  const [clinic] = await tx.db
    .select({
      carrier: clinics.carrier,
      phoneSystem: clinics.phoneSystemType,
      callRouting: clinics.callRouting,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return { carrier: null, phoneSystem: "unknown", routing: "overflow_after_hours" };
  return {
    carrier: isCarrier(clinic.carrier) ? clinic.carrier : null,
    phoneSystem: clinic.phoneSystem,
    routing: await readCoverageMode(tx.db, tx.clinicId, clinic),
  };
}

// -----------------------------------------------------------------------------
// E6: sent straight, to the address captured at destruction
// -----------------------------------------------------------------------------

export type DestructionNoticeOutcome =
  /** Sent, and the address cleared. */
  | "sent"
  /** Nothing owed: no address held. */
  | "none"
  /** The ledger says it went already: the address cleared. */
  | "already_sent"
  /** The send failed and may succeed later: the address kept for the next hour. */
  | "retrying"
  /** Refused for good, or out of time: the address cleared and ops told. */
  | "given_up";

/**
 * Send E6 for one destroyed clinic, if it still holds the captured address.
 * Never throws: the destruction it reports has happened whatever this does.
 *
 * Once: the ledger row (report_deliveries, kind data_destroyed, period
 * `destroyed`) is claimed before the send and recorded after it, and a row
 * already sent clears the address without sending again. The body renders
 * from the clinic row alone, with the destruction as its moment, so a retry
 * inside Resend's 24 hours sends the same bytes under the same key.
 */
export async function sendDestructionNotice(
  clinicId: string,
  options: SendEmailOptions = {},
): Promise<DestructionNoticeOutcome> {
  const now = options.now ?? new Date();
  try {
    const prepared = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
      const [clinic] = await tx.db
        .select({
          name: clinics.name,
          timezone: clinics.timezone,
          specialty: clinics.specialty,
          destroyedAt: clinics.destroyedAt,
          address: clinics.destructionNoticeAddress,
          agreementVersion: sql<
            string | null
          >`(select e.document_version from app_agreement_at_end(${clinics.id}) e)`,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic?.address || !clinic.destroyedAt) return { outcome: "none" as const };
      const destroyedAt = new Date(clinic.destroyedAt);
      if (destructionNoticeExpired(destroyedAt, now)) {
        await clearAddress(tx);
        return { outcome: "expired" as const };
      }
      const deliveryId = await claimDelivery(tx, {
        kind: "data_destroyed",
        periodKey: DESTROYED_PERIOD,
        recipient: clinic.address,
      });
      if (!deliveryId) {
        await clearAddress(tx);
        return { outcome: "already_sent" as const };
      }
      return {
        outcome: "claimed" as const,
        clinic: { ...clinic, address: clinic.address, destroyedAt },
        deliveryId,
      };
    });
    if (prepared.outcome === "none" || prepared.outcome === "already_sent") return prepared.outcome;
    if (prepared.outcome === "expired") {
      await notifyOps("destruction_notice_undelivered", { clinicId, phase: "expired" });
      return "given_up";
    }

    const { clinic, deliveryId } = prepared;
    const payload: DataDestroyedPayload = {
      destroyedAt: clinic.destroyedAt.toISOString(),
      backupsExpireOn: backupsExpireOn(clinic.destroyedAt),
      isDataProtectionAgreement:
        clinic.agreementVersion !== null &&
        agreementKindOfVersion(clinic.agreementVersion) === "dpa",
    };
    const finish = (result: Parameters<typeof recordDelivery>[2], clear: boolean): Promise<void> =>
      withTenant({ clinicId, actor: ACTOR }, async (tx) => {
        await recordDelivery(tx, deliveryId, result);
        if (clear) await clearAddress(tx);
      });

    let result;
    try {
      assertPayloadAllowed(payload, "data_destroyed");
      const rendered = renderDataDestroyed(payload, {
        clinicName: clinic.name,
        audience: audienceFor(clinic.specialty),
        reason: clinicReason(clinic.name),
        // The destruction's own moment, never the clock: a retry renders the same bytes.
        raisedAt: clinic.destroyedAt,
        timeZone: clinic.timezone,
      });
      result = await sendEmail(
        {
          to: clinic.address,
          kind: "data_destroyed",
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          phiClass: "none",
          clinicId,
          clinicName: clinic.name,
          deliveryId,
          idempotencyKey: `hd-data_destroyed-${deliveryId}-1`,
        },
        options,
      );
    } catch (error) {
      // A refusal on this side (an envelope, a link, the payload): sending
      // again cannot cure it.
      await finish({ status: "failed", reason: describeError(error) }, true);
      log.error("destruction notice refused", {
        clinicId,
        deliveryId,
        error: describeError(error),
      });
      await notifyOps("destruction_notice_undelivered", { clinicId, phase: "refused" });
      return "given_up";
    }

    const verdict = verdictOf(result);
    if (result.status === "sent" || verdict === "sent") {
      await finish(
        {
          status: "sent",
          messageId:
            result.status === "sent"
              ? result.messageId
              : "unknown: sent under this idempotency key before",
        },
        true,
      );
      log.info("destruction notice sent", { clinicId, deliveryId });
      return "sent";
    }
    if (result.status === "skipped") {
      // No transport configured (development): the console had it, and there
      // is nothing a later attempt would do differently.
      await finish({ status: "skipped", reason: result.reason }, true);
      return "sent";
    }
    if (verdict === "permanent") {
      await finish({ status: "failed", reason: result.reason }, true);
      log.warn("destruction notice refused by the mail provider", { clinicId, deliveryId });
      await notifyOps("destruction_notice_undelivered", { clinicId, phase: "rejected" });
      return "given_up";
    }
    await finish({ status: "failed", reason: result.reason }, false);
    log.warn("destruction notice not sent yet", { clinicId, deliveryId });
    return "retrying";
  } catch (error) {
    log.error("destruction notice failed", { clinicId, error: describeError(error) });
    return "retrying";
  }
}

export type DestructionNoticeRun = {
  owed: number;
  sent: number;
  retrying: number;
  givenUp: number;
};

/**
 * Every clinic still holding a captured address, sent or given up on: right
 * after the destruction job in the same tick, so E6 follows the destruction
 * within minutes, and every hour after that until it goes or its time is up.
 * Not a switched job: the address must not outlive its bound because a
 * switch was off.
 */
export async function runDestructionNotices(
  options: SendEmailOptions = {},
): Promise<DestructionNoticeRun> {
  const run: DestructionNoticeRun = { owed: 0, sent: 0, retrying: 0, givenUp: 0 };
  const owed = await unsafeDb.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_destruction_notices_owed()`,
  );
  for (const { clinic_id: clinicId } of owed.rows) {
    run.owed += 1;
    const outcome = await sendDestructionNotice(clinicId, options);
    if (outcome === "sent" || outcome === "already_sent") run.sent += 1;
    else if (outcome === "retrying") run.retrying += 1;
    else if (outcome === "given_up") run.givenUp += 1;
  }
  return run;
}

async function clearAddress(tx: TenantTx): Promise<void> {
  await tx.db
    .update(clinics)
    .set({ destructionNoticeAddress: null })
    .where(eq(clinics.id, tx.clinicId));
}

// -----------------------------------------------------------------------------
// Billing after cancellation
// -----------------------------------------------------------------------------

export type AfterCancellation = {
  endedAt: Date;
  /** The export was recorded as delivered: a whole download, or the operator's handover. */
  exportDeliveredAt: Date | null;
  destroyedAt: Date | null;
  /** destructionPlan's: the last day to download the export and keep the thirty days. */
  exportByOn: string;
  /**
   * The day to show as the download deadline: exportByOn until it has
   * passed, then the last whole day before the latest destruction (on the
   * thirty days the two are one day).
   */
  downloadByOn: string;
  /** destructionPlan's: the day the data is gone whatever happens. */
  destroyByOn: string;
  /** When the data may be destroyed, given what has happened so far: once delivered, the date to show. */
  destroyDueAt: Date;
};

/**
 * Where a clinic whose service has ended stands, for Billing: its export's
 * deadline, or its delivery, and when its data goes, or went. Business data
 * only. Null while the service has not ended.
 */
export async function readAfterCancellation(input: {
  clinicId: string;
  actor: ActorContext;
  now?: Date;
}): Promise<AfterCancellation | null> {
  const today = isoDay(input.now ?? new Date());
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const plan = await destructionPlanIn(tx);
    if (!plan) return null;
    const [clinic] = await tx.db
      .select({ exportDeliveredAt: clinics.exportDeliveredAt, destroyedAt: clinics.destroyedAt })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return {
      endedAt: plan.endedAt,
      exportDeliveredAt: clinic?.exportDeliveredAt ?? null,
      destroyedAt: clinic?.destroyedAt ?? null,
      exportByOn: plan.exportByOn,
      downloadByOn: today <= plan.exportByOn ? plan.exportByOn : downloadByOn(plan),
      destroyByOn: plan.destroyByOn,
      destroyDueAt: plan.destroyDueAt,
    };
  });
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

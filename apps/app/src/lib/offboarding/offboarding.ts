import { agreementKindOfVersion, DPA_VERSION_PREFIX, type AgreementKind } from "@healdesk/catalog";
import { and, asc, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  appointments,
  chatThreads,
  clinicClosures,
  clinics,
  contacts,
  conversations,
  metaBookingDrafts,
  metaInboundMessages,
  providerConnections,
  reconciliationExceptions,
  securityEvents,
  transactions,
  webhookEvents,
} from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOpsOnce } from "@/lib/ops/notify";
import type { TenantTx } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant";

/**
 * Offboarding: each agreement's return-or-destroy clause, as dates and a job.
 *
 * When a subscription ends (Stripe's customer.subscription.deleted, an
 * operator, or our own setup closure), the clinic gets
 * `offboarding_started_at`, the end of its service, and a `destroy_after`
 * thirty days on. For a Stripe deletion the end is the subscription's own
 * (`ended_at` in Stripe's signed event, else the event's `created`), clamped
 * by the database to no earlier than a week before the call, because the
 * agreements count from termination and a deletion can be processed hours or
 * days after it (Stripe's retries, a dead letter replayed by a person); a
 * clamp that bites tells ops the days it cost (offboarding_started_late). An
 * operator and the setup closure end the service when they act, so they get
 * the moment of the call. In between, by a person: the agent is switched off
 * at the voice vendor and the clinic is told how to remove forwarding (terms
 * §7); the export is produced (`exportClinic`, `npm run patient-export --
 * --all`) and handed over, and only the operator's record of the handover
 * stamps `export_delivered_at` (`markExportDelivered`), so producing an
 * export never counts as delivering it; and the clinic's calls and agent are
 * deleted at the voice vendor, Retell, and recorded on the care page
 * (`recordVoiceVendorDeletion`), which shows the step outstanding, with its
 * deadline, until it is.
 *
 * ## Which rule, and why
 *
 * Each clinic is destroyed on the rule its own agreement states: the
 * agreement it was bound to when its service ended (app_agreement_at_end in
 * drizzle/0056), terminated since or not. The agreement "in effect" skips a
 * terminated acceptance, and an operator records a termination whenever they
 * get to it, so at destruction time it may name none.
 *
 *   - BAA 1.2.1, 1.2.0 and 1.1.0-draft say "Within thirty days of
 *     termination healdesk will return or destroy all PHI it holds for
 *     Practice and retain no copies, and will give Practice, on request
 *     before that date, an export". 1.0.0 and 0.1.0-draft say "On
 *     termination healdesk will, if feasible, return or destroy" it and name
 *     no period, so they get the same rule, the strictest there is. The data
 *     goes whether or not the export was delivered, and it goes at day 29, a
 *     day early: the job runs every hour, so whatever hour the practice left
 *     its data is gone before the thirty days are up, with most of a day to
 *     spare for a worker that was down. The export is owed before then to
 *     every leaving practice, whether or not it asks: these agreements give
 *     it "on request", but Terms §7 promises it within thirty days of the
 *     end, and the canceled email tells the practice it is coming, so a
 *     practice has no reason to ask. Ops is told at day 21 when none has been
 *     recorded (export_undelivered_before_destruction).
 *   - DPA 1.0.0 says healdesk delivers the export unasked within thirty
 *     days, and that its destruction "runs once a day" and destroys "at the
 *     first run once thirty days have passed ..., if the export has been
 *     delivered by then; otherwise at the first run after the export is
 *     delivered; and in any case at the first run once ninety days have
 *     passed". BAA 1.3.0 takes the same rule, whose words its redraft gives
 *     it (the draft as it stands still says "no later than ninety days":
 *     docs/counsel/agreement-changes.md §12.14, gate 7). So these clinics are
 *     destroyed only by the day's 04:00 UTC run, from day 30, from the
 *     delivery, or from day 90.
 *   - No agreement (a synthetic or legacy clinic): the strictest, the thirty
 *     days.
 *   - A version DESTRUCTION_RULES does not know: the thirty days too, and the
 *     job logs it on every run. Not a throw: the job catches each clinic's
 *     failure and goes on to the next, so a throw would keep the others
 *     running but hold this clinic's patients for ever, which no agreement
 *     allows. The strictest rule breaks no promise to destroy, and the day-21
 *     alert puts any export owed in front of a person first.
 *
 * `destructionPlan` is the one statement of those dates. `dueForDestruction`,
 * the job, the canceled email and the ops console read it, and
 * app_destruction_due() states the same rule in the database, as the floor
 * the deletes and the destroyed stamp refuse to go below.
 *
 * ## The database's dates
 *
 * `offboarding_started_at`, `destroy_after`, `export_delivered_at` and
 * `destroyed_at` are stamped by app_start_offboarding(),
 * app_mark_export_delivered() and app_mark_clinic_destroyed(), from the
 * database's clock (each at the moment of its call, not when its transaction
 * began); the runtime role has no UPDATE on them, and a new clinic cannot
 * carry them (a trigger): if it could write the dates the floor reads, it
 * could stamp a live clinic as due, empty it and put the dates back. The one
 * moment it may pass in, the end of the service, is clamped to the week
 * before the call. Every day the database counts for these dates, the
 * clamp's seven and the floor's twenty-nine, thirty and ninety, is
 * twenty-four hours: the functions run in UTC, because any role may set its
 * own session's time zone and Postgres counts days in it (drizzle/0056's
 * header). app_mark_clinic_destroyed() also refuses while any row
 * destroyClinicData deletes is still there, because once `destroyed_at` is
 * set the job passes the clinic over for good. Its list and the deletes below
 * are one list: tests/booking-request-destruction.test.ts fails if they
 * differ, or if a table with a clinic_id is on neither it nor the list of
 * what stays. Tests that need days to pass move the stamps back as the
 * migrator, which owns the table.
 *
 * ## What goes, and what stays
 *
 * Every patient row, the keyed hashes of who messaged the clinic, its closed
 * days, its connections, and its suppressions, consent records and contact
 * attempts. Those three were kept until BAA 1.3.0's release gate 7 as the
 * TCPA evidence that an outbound contact was lawful; v1 contacts no one
 * first, so there is nothing for them to evidence, and every agreement's
 * return-or-destroy clause reaches them (1.3.0's Term clause keeps only the
 * signed agreement and a record of disclosures that holds no patient's
 * contact details). The runtime role still cannot delete them, so
 * app_destroy_contact_evidence() does, on the same floor.
 *
 * What stays: the clinic row (a customer we had), the audit log
 * (append-only, and the record that the destruction happened), the signed
 * agreement (its own six-year floor), and the billing history. That history
 * includes channel_events, kept like billing_notices: the plan start and
 * every step-up were charged from its rows, which hold no patient data.
 * Deposit rows are money records too and stay, without the appointment they
 * were taken for.
 *
 * Of the tables 0044 added, clinic_closures (the days the clinic was closed)
 * goes with the patient rows. clinic_channels is classed with it but cannot
 * go yet: the runtime role holds no DELETE on it (a channel in service must
 * never drop out of the price), and destruction runs as that role. It holds
 * no patient data.
 *
 * Of 0043's, chat_threads and meta_inbound_messages go too. Each holds an
 * HMAC of what a patient's messages carried (the sender's id, a WhatsApp
 * number among them; a message's id), and the key is ours
 * (lib/identifier-ref.ts), so beside the clinic messaged and when, a row
 * still identifies a person: keeping it would leave patient-derived rows
 * behind a destruction record that says none remain.
 *
 * Vendor-side data (the clinic's calls and agent at the voice vendor) is
 * deleted in the vendor's console by the operator and recorded as a
 * voice_vendor_data_deleted security event; this job cannot reach it and does
 * not claim to.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The days app_start_offboarding() puts between the start and destroy_after; a test pins the two together. */
export const DESTROY_AFTER_DAYS = 30;
/** The DPA rule's outer limit: destroyed at the first daily run once this many days have passed, export or not. */
export const DESTROY_WITHOUT_EXPORT_AFTER_DAYS = 90;
/**
 * The thirty days' due day: a day early, so the hourly job has the data gone
 * before thirty days have passed since the end whatever hour it ended.
 * app_destruction_due() refuses earlier.
 */
export const THIRTY_DAY_RULE_DUE_DAYS = 29;
/** When ops is told that a clinic on the thirty days has no export delivered. */
export const UNDELIVERED_EXPORT_ALERT_DAYS = 21;
/**
 * The UTC hour of the once-a-day run, the only run that destroys a clinic on
 * the DPA's rule (lib/scheduler/tick.ts runs the job every hour and says
 * which run is this one).
 */
export const DAILY_DESTRUCTION_HOUR_UTC = 4;
/** How far back app_start_offboarding() lets the end of the service start the clock. */
export const OFFBOARDING_BACKDATE_LIMIT_DAYS = 7;

/**
 * thirty_days: destroyed at day 29 whatever the export (BAA 1.2.1 and
 * earlier). export_or_ninety: at the daily run from day 30 if the export was
 * delivered by then, from its delivery if later, and from day 90 regardless
 * (BAA 1.3.0, DPA 1.0.0).
 */
export type DestructionRule = "thirty_days" | "export_or_ninety";

/**
 * The rule each agreement version states, by kind, under the version's bare
 * number: a DPA's stored version is namespaced ("dpa/1.0.0", drizzle/0051),
 * so the DPA's 1.0.0 and the BAA's 1.0.0 are different agreements with
 * different rules. Every version in BAA_TEMPLATES and DPA_TEMPLATES must have
 * an entry (tests/destruction-clock.test.ts), so a new version cannot ship
 * until someone decides its rule here and in app_destruction_rule(), the SQL
 * allow-list of the export_or_ninety versions, which the same test holds to
 * this map.
 */
export const DESTRUCTION_RULES: Readonly<Record<AgreementKind, Readonly<Record<string, DestructionRule>>>> = {
  baa: {
    "1.3.0": "export_or_ninety",
    "1.2.1": "thirty_days",
    "1.2.0": "thirty_days",
    "1.1.0-draft": "thirty_days",
    "1.0.0": "thirty_days",
    "0.1.0-draft": "thirty_days",
  },
  dpa: {
    "1.0.0": "export_or_ninety",
  },
};

/** Where the rule came from: the agreement's version, no agreement at all, or a version the map does not know. */
export type DestructionBasis = "agreement" | "no_agreement" | "unknown_version";

/** The rule a stored agreement version states; the strictest for none and for one the map does not know. */
export function destructionRuleFor(version: string | null): {
  rule: DestructionRule;
  basis: DestructionBasis;
} {
  if (version === null) return { rule: "thirty_days", basis: "no_agreement" };
  const kind = agreementKindOfVersion(version);
  const bare = kind === "dpa" ? version.slice(DPA_VERSION_PREFIX.length) : version;
  const rules = DESTRUCTION_RULES[kind];
  const rule = Object.hasOwn(rules, bare) ? rules[bare] : undefined;
  return rule ? { rule, basis: "agreement" } : { rule: "thirty_days", basis: "unknown_version" };
}

/** What the plan is computed from: the clinic's offboarding dates and the agreement its service ended under. */
export type DestructionInput = {
  offboardingStartedAt: Date | null;
  destroyAfter: Date | null;
  exportDeliveredAt: Date | null;
  /** The version of the agreement the clinic was bound to when its service ended (app_agreement_at_end). */
  destructionAgreementVersion: string | null;
};

export type DestructionPlan = {
  rule: DestructionRule;
  basis: DestructionBasis;
  agreementVersion: string | null;
  /** The end of the service: offboarding_started_at. */
  endedAt: Date;
  /**
   * The export is owed by then, whether or not the practice asks (Terms §7):
   * under the thirty days, before destruction is due; under the DPA's rule,
   * by day 30.
   */
  exportDueBy: Date;
  /** When the job may destroy the clinic's data, given what has happened so far. */
  destroyDueAt: Date;
  /** The latest destroyDueAt can become, whatever happens next. */
  latestDestroyAt: Date;
  /** Destroyed only by the once-a-day run, as the agreement describes it. */
  dailyRunOnly: boolean;
  /**
   * What a notice may tell the practice, as UTC days (YYYY-MM-DD): the last
   * whole day on which an export delivered in time can still be downloaded
   * before any run can destroy the data, and the day by which the data is
   * gone whatever happens.
   */
  exportByOn: string;
  destroyByOn: string;
};

/**
 * The one function that decides a clinic's destruction dates from its own
 * agreement. Null while the clinic is not offboarding.
 */
export function destructionPlan(clinic: DestructionInput): DestructionPlan | null {
  const endedAt = clinic.offboardingStartedAt;
  if (!endedAt) return null;
  const { rule, basis } = destructionRuleFor(clinic.destructionAgreementVersion);
  const agreementVersion = clinic.destructionAgreementVersion;
  const thirty = clinic.destroyAfter ?? addDays(endedAt, DESTROY_AFTER_DAYS);

  if (rule === "thirty_days") {
    const due = addDays(endedAt, THIRTY_DAY_RULE_DUE_DAYS);
    return {
      rule,
      basis,
      agreementVersion,
      endedAt,
      exportDueBy: due,
      destroyDueAt: due,
      latestDestroyAt: due,
      dailyRunOnly: false,
      // An hourly run can reach it the moment it is due, so the last whole
      // day to download is the day before; and the data is gone within the
      // thirty days the agreement gives, with a day to spare.
      exportByOn: isoDay(addDays(due, -1)),
      destroyByOn: isoDay(thirty),
    };
  }

  const ninety = addDays(endedAt, DESTROY_WITHOUT_EXPORT_AFTER_DAYS);
  const delivered = clinic.exportDeliveredAt;
  const due =
    delivered === null
      ? ninety
      : delivered.getTime() <= thirty.getTime()
        ? thirty
        : delivered.getTime() < ninety.getTime()
          ? delivered
          : ninety;
  return {
    rule,
    basis,
    agreementVersion,
    endedAt,
    exportDueBy: thirty,
    destroyDueAt: due,
    latestDestroyAt: ninety,
    dailyRunOnly: true,
    exportByOn: isoDay(addDays(firstDailyRunThatMayReach(thirty), -1)),
    destroyByOn: isoDay(firstDailyRunThatMustReach(ninety)),
  };
}

/**
 * Whether the clinic's data is due for destruction at `now`, by its plan. The
 * job also keeps a clinic on the DPA's rule for the daily run.
 */
export function dueForDestruction(
  clinic: DestructionInput & { destroyedAt: Date | null },
  now: Date,
): boolean {
  if (clinic.destroyedAt || !clinic.destroyAfter) return false;
  const plan = destructionPlan(clinic);
  return plan !== null && now.getTime() >= plan.destroyDueAt.getTime();
}

/**
 * The plan inside the clinic's own transaction, which sees what that
 * transaction has written (the canceled email, queued in the transaction that
 * starts offboarding). Null while the clinic is not offboarding.
 */
export async function destructionPlanIn(tx: TenantTx): Promise<DestructionPlan | null> {
  const result = await tx.db.execute<{
    offboarding_started_at: Date | string | null;
    destroy_after: Date | string | null;
    export_delivered_at: Date | string | null;
    agreement_version: string | null;
  }>(
    sql`select c.offboarding_started_at, c.destroy_after, c.export_delivered_at,
               (select e.document_version from app_agreement_at_end(c.id) e) as agreement_version
          from clinics c
         where c.id = ${tx.clinicId}::uuid`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return destructionPlan({
    offboardingStartedAt: dateOf(row.offboarding_started_at),
    destroyAfter: dateOf(row.destroy_after),
    exportDeliveredAt: dateOf(row.export_delivered_at),
    destructionAgreementVersion: row.agreement_version ?? null,
  });
}

/** What app_start_offboarding() stamped, and what it was asked for. */
export type OffboardingStart = {
  startedAt: Date;
  destroyAfter: Date;
  /** This call stamped them; false when offboarding had already started. */
  firstStart: boolean;
  /** The end of the service the caller passed, or the moment of the call. */
  endedAt: Date;
  /** Days the week's clamp cost the practice: the stamp is this much later than the end. 0 when it did not bite. */
  lateDays: number;
};

/**
 * Stamps the start and destroy_after from the database's clock, once;
 * starting again moves neither. `endedAt` is the end of the service when the
 * caller knows it (a Stripe deletion: the subscription's own end), and the
 * database clamps it to the week before the call; without it, the moment of
 * the call. The caller tells ops when the clamp cost the practice days
 * (alertIfOffboardingStartedLate), after its transaction commits.
 */
export async function startOffboarding(
  tx: TenantTx,
  reason: string,
  endedAt: Date | null = null,
): Promise<OffboardingStart> {
  const result = await tx.db.execute<{
    started_at: Date | string;
    due_at: Date | string;
    first_start: boolean;
    asked_for: Date | string;
  }>(
    sql`select started_at, due_at, first_start, asked_for
          from app_start_offboarding(${tx.clinicId}::uuid, ${endedAt ? endedAt.toISOString() : null}::timestamptz)`,
  );
  const row = result.rows[0];
  if (!row) throw new Error(`app_start_offboarding returned nothing for clinic ${tx.clinicId}.`);
  const startedAt = new Date(row.started_at);
  const asked = new Date(row.asked_for);
  // A minute's grace, so a clock read twice is not a clamp.
  const lateMs = row.first_start ? startedAt.getTime() - asked.getTime() : 0;
  const lateDays = lateMs > 60_000 ? Math.round((lateMs / DAY_MS) * 10) / 10 : 0;
  tx.audit.record({
    action: "update",
    resourceType: "clinic_offboarding",
    resourceId: tx.clinicId,
    metadata: { started: true, reason, ...(lateDays > 0 ? { lateDays } : {}) },
  });
  return {
    startedAt,
    destroyAfter: new Date(row.due_at),
    firstStart: row.first_start,
    endedAt: asked,
    lateDays,
  };
}

/**
 * One ops alert, once per clinic and end, when the week's clamp started the
 * clock later than the service ended: the practice's data will be destroyed
 * that many days later than its agreement counts. Call it after the
 * transaction that started offboarding commits; it never throws.
 */
export async function alertIfOffboardingStartedLate(
  clinicId: string,
  start: OffboardingStart,
): Promise<void> {
  if (start.lateDays <= 0) return;
  await notifyOpsOnce("offboarding_started_late", {
    clinicId,
    serviceEndedAt: start.endedAt.toISOString(),
    lateDays: start.lateDays,
  });
}

/**
 * The export reached the practice. `how` is the operator's record of the
 * handover (the channel, and to whom by role). The stamp is the database's
 * (app_mark_export_delivered): this moment, once, and only while the clinic
 * is offboarding and not yet destroyed. Never call it when an export is
 * merely produced: `exportClinic` and the patient-export script produce one
 * and stamp nothing.
 */
export async function markExportDelivered(tx: TenantTx, how: string): Promise<Date> {
  const result = await tx.db.execute<{ delivered: Date | string }>(
    sql`select app_mark_export_delivered(${tx.clinicId}::uuid) as delivered`,
  );
  tx.audit.record({ action: "export", resourceType: "clinic_offboarding", resourceId: tx.clinicId, metadata: { how: how.slice(0, 200) } });
  return new Date(result.rows[0]!.delivered);
}

export type DestructionResult = { clinicId: string; deleted: Record<string, number> };

/**
 * Every patient row for one clinic, booking requests included, the hashes of
 * who messaged it, its closed days, and its suppressions, consent records
 * and contact attempts, gone. Audit, agreements and billing stay.
 */
export async function destroyClinicData(tx: TenantTx): Promise<DestructionResult> {
  const c = tx.clinicId;
  const deleted: Record<string, number> = {};
  const del = async (name: string, run: () => Promise<{ id: string }[]>) => {
    deleted[name] = (await run()).length;
  };
  await del("reconciliation_exceptions", () => tx.db.delete(reconciliationExceptions).where(eq(reconciliationExceptions.clinicId, c)).returning({ id: reconciliationExceptions.id }));
  await del("transactions", () => tx.db.delete(transactions).where(eq(transactions.clinicId, c)).returning({ id: transactions.id }));
  // Booking requests before the appointments: a confirmed request must keep
  // its appointment (CHECK, 0039) and cannot be rewritten (trigger, 0041), so
  // its appointment cannot go while it stands, and waiting for the contact's
  // cascade (0037) never gets that far. The app role has no DELETE on them;
  // app_destroy_booking_requests() deletes this tenant's, once the clinic is
  // due by its agreement's rule and the database's clock.
  const requests = await tx.db.execute<{ n: number }>(sql`select app_destroy_booking_requests(${c}::uuid) as n`);
  deleted.booking_requests = requests.rows[0]?.n ?? 0;
  await del("appointments", () => tx.db.delete(appointments).where(eq(appointments.clinicId, c)).returning({ id: appointments.id }));
  await del("conversations", () => tx.db.delete(conversations).where(eq(conversations.clinicId, c)).returning({ id: conversations.id }));
  // Who messaged the clinic, as keyed hashes of their sender ids (see the header).
  await del("chat_threads", () => tx.db.delete(chatThreads).where(eq(chatThreads.clinicId, c)).returning({ id: chatThreads.partyRef }));
  await del("meta_inbound_messages", () => tx.db.delete(metaInboundMessages).where(eq(metaInboundMessages.clinicId, c)).returning({ id: metaInboundMessages.messageRef }));
  // The half-collected drafts hold a phone number and nothing the record
  // needs, so they are deleted outright.
  await del("meta_booking_drafts", () => tx.db.delete(metaBookingDrafts).where(eq(metaBookingDrafts.clinicId, c)).returning({ id: metaBookingDrafts.senderId }));
  await del("contacts", () => tx.db.delete(contacts).where(eq(contacts.clinicId, c)).returning({ id: contacts.id }));
  await del("webhook_events", () => tx.db.delete(webhookEvents).where(eq(webhookEvents.clinicId, c)).returning({ id: webhookEvents.id }));
  // sync_runs and connection_links are append-only by grant (0015, 0024):
  // operational history with no patient in it, kept as the record of what
  // ran. The credentials go with the connection row below.
  // Credentials: revoked and their ciphertext gone with the row.
  await del("provider_connections", () => tx.db.delete(providerConnections).where(eq(providerConnections.clinicId, c)).returning({ id: providerConnections.id }));
  // Suppressions, consent records and contact attempts: phone numbers held
  // for the clinic, and append-only by grant (0010), so a definer deletes
  // them on the same floor (app_destroy_contact_evidence, drizzle/0056). They
  // were kept as TCPA evidence until v1 went inbound only (see the header).
  const evidence = await tx.db.execute<{
    suppressions_deleted: number;
    consent_records_deleted: number;
    contact_attempts_deleted: number;
  }>(sql`select * from app_destroy_contact_evidence(${c}::uuid)`);
  deleted.suppressions = evidence.rows[0]?.suppressions_deleted ?? 0;
  deleted.consent_records = evidence.rows[0]?.consent_records_deleted ?? 0;
  deleted.contact_attempts = evidence.rows[0]?.contact_attempts_deleted ?? 0;
  // The closed days go with the clinic; channel_events stays as billing
  // evidence (see the header).
  await del("clinic_closures", () => tx.db.delete(clinicClosures).where(eq(clinicClosures.clinicId, c)).returning({ id: clinicClosures.closedOn }));

  // The number is released with the data. destroyed_at is the database's
  // to stamp, and it refuses a clinic that is not due or still holds any
  // row deleted above (see the header).
  await tx.db.update(clinics).set({ synthflowNumberE164: null }).where(eq(clinics.id, c));
  await tx.db.execute(sql`select app_mark_clinic_destroyed(${c}::uuid)`);
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  tx.audit.record({
    action: "delete",
    resourceType: "clinic_destruction",
    resourceId: c,
    resultCount: total,
    metadata: Object.fromEntries(Object.entries(deleted).map(([k, v]) => [k, v])),
  });
  return { clinicId: c, deleted };
}

/**
 * The job: every clinic whose plan says it is due, destroyed, and ops told
 * before a clinic on the thirty days loses an export nobody has recorded as
 * delivered. Runs every hour (tick.ts); `dailyRun` is true for the 04:00 UTC
 * run, the only one that destroys a clinic on the DPA's rule. Defaults to
 * true, so a caller outside the hourly tick (the post-restore check, a test)
 * destroys everything due.
 */
export async function destroyDueClinics(
  now: Date = new Date(),
  options: { dailyRun?: boolean } = {},
): Promise<DestructionResult[]> {
  const dailyRun = options.dailyRun ?? true;
  const actor = { type: "service", serviceName: "offboarding-destroy" } as const;
  const results: DestructionResult[] = [];
  for (const clinic of await listClinics()) {
    if (clinic.destroyedAt) continue;
    const plan = destructionPlan(clinic);
    if (!plan) continue;
    if (plan.basis === "unknown_version") {
      log.error("destruction rule unknown for the agreement version; using the thirty days", {
        clinicId: clinic.id,
        reason: `no entry in DESTRUCTION_RULES for version ${plan.agreementVersion ?? "none"}`,
      });
    }
    await alertBeforeThirtyDayDestruction(clinic.id, clinic.exportDeliveredAt, plan, now);
    if (!dueForDestruction(clinic, now) || (plan.dailyRunOnly && !dailyRun)) continue;
    let result: DestructionResult;
    try {
      result = await withTenant({ clinicId: clinic.id, actor }, (tx) => destroyClinicData(tx));
    } catch (error) {
      log.error("destruction failed", { clinicId: clinic.id, error: describeError(error) });
      continue;
    }
    // Committed: the clinic's data is gone, whatever happens to the records
    // of it below, so it is reported destroyed either way.
    results.push(result);
    const rows = Object.values(result.deleted).reduce((a, b) => a + b, 0);
    // A line outside the database, written first: a restore from a backup
    // older than this run brings the clinic's rows back, and docs/handover.md
    // ("Restoring") reads these lines to destroy them again. They carry the
    // dates it was destroyed on, because a backup older than them brings the
    // clinic back without them: without the end it is not offboarding at all,
    // and on BAA 1.3.0 or the DPA without the export's delivery it would not
    // be due again until day 90.
    log.info("clinic data destroyed", {
      clinicId: clinic.id,
      count: rows,
      serviceEndedAt: plan.endedAt.toISOString(),
      exportDeliveredAt: clinic.exportDeliveredAt?.toISOString() ?? null,
    });
    try {
      await recordSecurityEvent(unsafeDb, {
        event: "clinic_data_destroyed",
        actorLabel: "offboarding-destroy",
        metadata: {
          clinicSlug: clinic.slug,
          rows,
          exportDelivered: Boolean(clinic.exportDeliveredAt),
          rule: plan.rule,
          agreementVersion: plan.agreementVersion,
        },
      });
    } catch (error) {
      // The audit log's clinic_destruction row went in with the deletes, in
      // their transaction; this is the security log's record of them. If it
      // is refused (the PHI scan reads a slug ending in a long run of digits
      // as a telephone number), the destruction still ran and is reported as
      // run, not as failed.
      log.error("destruction ran but its security event was not recorded", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return results;
}

/**
 * The check after a restore (docs/handover.md, "Restoring"; npm run
 * destroy-due): every clinic due, destroyed now on every rule at once, and the
 * ids of any still due afterwards, for example one whose destruction failed,
 * which the service must not reopen over.
 */
export async function destroyEverythingDue(
  now: Date = new Date(),
): Promise<{ destroyed: DestructionResult[]; stillDue: string[] }> {
  const destroyed = await destroyDueClinics(now, { dailyRun: true });
  const stillDue = (await listClinics())
    .filter((clinic) => dueForDestruction(clinic, now))
    .map((clinic) => clinic.id);
  return { destroyed, stillDue };
}

/**
 * From day 21 until destruction, one ops alert per clinic on the thirty days
 * with no export recorded as delivered: the data goes at destroyAt whatever
 * the export, and the practice is owed its export before then whether or not
 * it asks (Terms §7; see the header). Never for a clinic on the DPA's rule,
 * whose destruction waits for the export.
 */
async function alertBeforeThirtyDayDestruction(
  clinicId: string,
  exportDeliveredAt: Date | null,
  plan: DestructionPlan,
  now: Date,
): Promise<void> {
  if (plan.rule !== "thirty_days" || exportDeliveredAt) return;
  const from = addDays(plan.endedAt, UNDELIVERED_EXPORT_ALERT_DAYS);
  if (now.getTime() < from.getTime() || now.getTime() >= plan.destroyDueAt.getTime()) return;
  await notifyOpsOnce("export_undelivered_before_destruction", {
    clinicId,
    destroyAt: plan.destroyDueAt.toISOString(),
  });
}

// -----------------------------------------------------------------------------
// The voice vendor's copy: an operator step, recorded
// -----------------------------------------------------------------------------

/**
 * The security event an operator's record of deleting the clinic's calls and
 * agent at the voice vendor (Retell) writes. Nothing in apps/app talks to the
 * vendor, so the deletion is done in its console and recorded here; the care
 * page shows the step outstanding, with its deadline, until it is.
 */
export const VOICE_VENDOR_DELETION_EVENT = "voice_vendor_data_deleted";

export type VoiceVendorDeletion = { recordedAt: Date; recordedBy: string; how: string | null };

/** Record that the operator deleted the clinic's calls and agent at the voice vendor. */
export async function recordVoiceVendorDeletion(input: {
  clinicId: string;
  clinicSlug: string;
  how: string;
  actorLabel: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  await recordSecurityEvent(unsafeDb, {
    event: VOICE_VENDOR_DELETION_EVENT,
    actorLabel: input.actorLabel,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: { clinicId: input.clinicId, clinicSlug: input.clinicSlug, how: input.how.slice(0, 200) },
  });
}

/** The first record of the vendor deletion for this clinic, or null while it is outstanding. */
export async function voiceVendorDeletionOf(clinicId: string): Promise<VoiceVendorDeletion | null> {
  const [row] = await unsafeDb
    .select({
      occurredAt: securityEvents.occurredAt,
      actorLabel: securityEvents.actorLabel,
      metadata: securityEvents.metadata,
    })
    .from(securityEvents)
    .where(
      and(
        eq(securityEvents.event, VOICE_VENDOR_DELETION_EVENT),
        sql`${securityEvents.metadata}->>'clinicId' = ${clinicId}`,
      ),
    )
    .orderBy(asc(securityEvents.occurredAt))
    .limit(1);
  if (!row) return null;
  const how = (row.metadata as { how?: unknown } | null)?.how;
  return { recordedAt: row.occurredAt, recordedBy: row.actorLabel, how: typeof how === "string" ? how : null };
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** The UTC calendar date, YYYY-MM-DD: what every `…On` payload field carries. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * The daily run happens during its hour (the tick starts it at
 * DAILY_DESTRUCTION_HOUR_UTC and may run late within the hour). The first run
 * that MAY reach `at` is the first whose hour ends after it; the first that
 * MUST is the first whose hour starts at or after it. Each is returned as the
 * run's UTC midnight.
 */
function firstDailyRunThatMayReach(at: Date): Date {
  const day = utcMidnight(at);
  const hourEnds = day.getTime() + (DAILY_DESTRUCTION_HOUR_UTC + 1) * HOUR_MS;
  return at.getTime() < hourEnds ? day : addDays(day, 1);
}

function firstDailyRunThatMustReach(at: Date): Date {
  const day = utcMidnight(at);
  const hourStarts = day.getTime() + DAILY_DESTRUCTION_HOUR_UTC * HOUR_MS;
  return at.getTime() <= hourStarts ? day : addDays(day, 1);
}

function dateOf(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

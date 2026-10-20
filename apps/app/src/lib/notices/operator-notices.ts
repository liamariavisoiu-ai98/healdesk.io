import {
  GUARANTEE_FINDING_BUSINESS_DAYS,
  GUARANTEE_REFUND_WITHIN_DAYS,
  INCIDENT_REPORT_MAX_COUNT,
  isGuaranteeFailure,
  isGuaranteeOutcome,
  isIncidentInformationType,
  isIncidentMitigation,
  isIncidentPatientStep,
  isIncidentRecommendation,
  isIncidentReportEvent,
  isPhiSubcontractor,
  isProductUpdateCode,
  isSuspensionCause,
  isTermsChangeTopic,
  PRODUCT_UPDATES,
  TERMS_NOTICE_DAYS,
  type GuaranteeFailure,
  type GuaranteeOutcome,
  type IncidentInformationType,
  type IncidentMitigation,
  type IncidentPatientStep,
  type IncidentRecommendation,
  type IncidentReportEvent,
  type PhiSubcontractor,
  type ProductUpdateCode,
  type ProductUpdateScreen,
  type SuspensionCause,
  type TermsChangeTopic,
} from "@healdesk/catalog";
import { and, desc, eq, gte, inArray } from "drizzle-orm";

import { billingNotices, clinics, incidents } from "@/db/schema";
import {
  BAA_VERSION_RESIGNS_WAITING,
  baaVersionResignsReady,
} from "@/lib/agreements/baa-version-ready";
import type { ActorContext } from "@/lib/audit";
import { resolveBillingClinicId } from "@/lib/billing/billing-clinic";
import { getEntitlementsForUpdate } from "@/lib/billing/entitlements";
import { billingRecipients } from "@/lib/billing/recipients";
import { canTransition, transition } from "@/lib/billing/state-machine";
import { isDemoClinic } from "@/lib/booking/terms";
import type { NoticeKind, PlanNoticeKind } from "@/lib/email/kinds";
import { deliverCriticalAfterCommit, MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import { incidentPagePath } from "@/lib/incidents/affected";
import {
  incidentForDecision,
  recordNotReportable,
  recordReportQueued,
  type IncidentDecisionRefusal,
} from "@/lib/incidents/incidents";
import {
  addBusinessDays,
  isReportableClass,
  subcontractorNoticeMs,
  subcontractorNoticeRuleFor,
  type ReportableClass,
} from "@/lib/incidents/reporting-rules";
import { describeError, log } from "@/lib/log";
import { listClinics, type ClinicOverview } from "@/lib/ops/clinics";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice, type PlanNoticePayloads } from "./plan-notices";

/**
 * The notices an operator sends from /admin (WP7; Annex X5, L28 to L31 and
 * L33): every one queued through the outbox, `billing_notices`, from fixed
 * fields only, and nothing reaching a practice unless an operator sends it.
 *
 *   - L28, terms notices: a broadcast to every practice with an agreement in
 *     effect, at least 30 days before the change applies (Terms §4, §16).
 *     Mandatory: no switch, no unsubscribe.
 *   - L29, two emails: a new subcontractor's notice, a broadcast to the same
 *     practices, checked against each one's own agreement for the notice it
 *     promises (lib/incidents/reporting-rules.ts); and an incident report,
 *     to one practice, from the /admin incidents page. Both critical.
 *   - L30, the first-month guarantee: the claim received, with the day of
 *     our finding, and the finding.
 *   - L31, a suspension for a legal or security reason: the billing state
 *     machine's `suspended` and the email that says why, in one transaction.
 *   - L33, product updates: a broadcast to every practice still with us,
 *     behind its own switch and one-click stop link.
 *
 * Who receives a broadcast: the account, never a location (a location is
 * billed on its account's clinic, and billingRecipients reads the account's
 * one address), still in service (not offboarding, not destroyed), not
 * healdesk's own demo clinic, and with an address to send to. A broadcast is
 * idempotent per practice: its dedupe key names what is announced, so
 * sending it again reaches only the practices that did not have it, such as
 * one that signed since.
 *
 * Broadcasts queue and return; the minute queue sends them (the critical
 * subcontractor notice included, and /api/health turns red if it is late).
 * A single practice's critical notice is also sent in-process once its
 * transaction commits, as billing's are.
 *
 * Every text an operator could type stays out of these payloads: the
 * console sends codes from the catalog's closed lists (packages/catalog
 * operator-notices.ts), and the sender's payload allowlist refuses anything
 * else.
 */

const ACTOR_NAME = "operator-notices";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A Terms version, as the welcome email accepts one ("2026-10-07.1"). */
const TERMS_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/;

/**
 * Time allowed on top of each notice period for the email itself: quiet
 * hours hold a terms notice until 07:00 the practice's time, and a retry or a
 * spent daily quota can hold any email for hours. The day it lands, not the
 * day it was queued, is when the practice was told.
 */
const TERMS_NOTICE_MARGIN_DAYS = 1;
const SUBCONTRACTOR_NOTICE_MARGIN_MS = HOUR_MS;

/** How far back a guarantee claim may be dated: the claim window is 30 days after a 30-day first month. */
const CLAIM_MAX_AGE_DAYS = 90;

export type OperatorNoticeRefusal = { status: "refused"; message: string };

const refuse = (message: string): OperatorNoticeRefusal => ({ status: "refused", message });

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function isRealDay(day: unknown): day is string {
  return typeof day === "string" && ISO_DAY.test(day) && isoDay(dayStart(day)) === day;
}

function actorFor(label: string): ActorContext {
  const name = label.trim().slice(0, 200);
  return { type: "service", serviceName: name.length > 0 ? name : ACTOR_NAME };
}

// -----------------------------------------------------------------------------
// Broadcasts: who, and how
// -----------------------------------------------------------------------------

/** The kinds sent to many practices at once. */
export const BROADCAST_KINDS = ["terms_notice", "subprocessor_notice", "product_update"] as const;
export type BroadcastKind = (typeof BROADCAST_KINDS)[number];

/** The kinds sent to one practice. */
export const SINGLE_NOTICE_KINDS = [
  "incident_report",
  "guarantee_claim_received",
  "guarantee_finding",
  "suspended_for_cause",
] as const;

export const OPERATOR_NOTICE_KINDS = [...BROADCAST_KINDS, ...SINGLE_NOTICE_KINDS] as const;

export type BroadcastSummary = {
  status: "queued";
  /** Practices it was queued for now. */
  queued: number;
  /** Practices that already had it (the same dedupe key): sent again to nobody. */
  alreadyQueued: number;
  /** Practices left out because there is no address on the account to send to. */
  noAddress: number;
  /** Practices it could not be queued for: a database error, logged. */
  failed: number;
};

/**
 * The accounts a broadcast goes to: billing clinics still in service, and,
 * for the notices an agreement promises, only those with one in effect.
 */
export function broadcastAudience(
  clinics: readonly ClinicOverview[],
  options: { signedOnly: boolean },
): ClinicOverview[] {
  return clinics.filter(
    (c) =>
      c.billingClinicId === null &&
      c.offboardingStartedAt === null &&
      c.destroyedAt === null &&
      (!options.signedOnly || c.baaVersion !== null),
  );
}

async function broadcast<K extends BroadcastKind>(
  kind: K,
  dedupeKey: string,
  audience: readonly ClinicOverview[],
  payloadFor: (clinic: ClinicOverview) => PlanNoticePayloads[K],
  actor: ActorContext,
): Promise<BroadcastSummary> {
  const summary: BroadcastSummary = {
    status: "queued",
    queued: 0,
    alreadyQueued: 0,
    noAddress: 0,
    failed: 0,
  };
  for (const clinic of audience) {
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
        if (await isDemoClinic(tx)) return "skipped" as const;
        if ((await billingRecipients(tx)).length === 0) return "no_address" as const;
        const inserted = await enqueuePlanNotice(
          tx.db,
          tx.clinicId,
          kind,
          dedupeKey,
          payloadFor(clinic),
        );
        if (inserted) {
          tx.audit.record({
            action: "create",
            resourceType: "billing_notice",
            resourceId: tx.clinicId,
            metadata: { kind, broadcast: true },
          });
        }
        return inserted ? ("queued" as const) : ("already" as const);
      });
      if (outcome === "queued") summary.queued += 1;
      else if (outcome === "already") summary.alreadyQueued += 1;
      else if (outcome === "no_address") summary.noAddress += 1;
    } catch (error) {
      summary.failed += 1;
      log.error("operator broadcast could not queue a notice", {
        clinicId: clinic.id,
        kind,
        error: describeError(error),
      });
    }
  }
  return summary;
}

// -----------------------------------------------------------------------------
// L28: terms notices
// -----------------------------------------------------------------------------

export type TermsNoticeInput = {
  version: unknown;
  effectiveOn: unknown;
  topics: unknown;
  /** The operator's confirmation that the new version is published at healdesk.io/terms. */
  isPublished: unknown;
  actorLabel: string;
  now?: Date;
};

/** The earliest day a terms change may apply from, if its notice goes now. */
export function earliestTermsEffectiveOn(now: Date): string {
  return isoDay(new Date(now.getTime() + (TERMS_NOTICE_DAYS + TERMS_NOTICE_MARGIN_DAYS) * DAY_MS));
}

export async function broadcastTermsNotice(
  input: TermsNoticeInput,
): Promise<BroadcastSummary | OperatorNoticeRefusal> {
  const now = input.now ?? new Date();
  if (typeof input.version !== "string" || !TERMS_VERSION.test(input.version)) {
    return refuse("Give the new Terms version as its page prints it, such as 2026-11-20.1.");
  }
  if (input.isPublished !== true) {
    return refuse(
      "Publish the new version at healdesk.io/terms first: the notice tells the practice to read it there.",
    );
  }
  if (!isRealDay(input.effectiveOn)) return refuse("When does it apply? A date, YYYY-MM-DD.");
  const earliest = earliestTermsEffectiveOn(now);
  if (input.effectiveOn < earliest) {
    return refuse(
      `A change has to be announced at least ${TERMS_NOTICE_DAYS} days before it applies (Terms §4 and §16), with a day for the email itself: the earliest it can apply from, if sent now, is ${earliest}.`,
    );
  }
  const topics = Array.isArray(input.topics) ? input.topics : [];
  if (topics.length === 0 || !topics.every(isTermsChangeTopic)) {
    return refuse("Pick what the change is about, from the list.");
  }
  const unique = [...new Set(topics as TermsChangeTopic[])];
  const version = input.version;
  const effectiveOn = input.effectiveOn;

  const audience = broadcastAudience(await listClinics(), { signedOnly: true });
  return broadcast(
    "terms_notice",
    `terms_notice:${version}`,
    audience,
    (clinic) => ({
      version,
      effectiveOn,
      topicRows: unique.map((code) => ({ code })),
      billingUrl: publicUrl(`/c/${clinic.slug}/billing`),
    }),
    actorFor(input.actorLabel),
  );
}

// -----------------------------------------------------------------------------
// L29: a new subcontractor's notice
// -----------------------------------------------------------------------------

export type SubprocessorNoticeInput = {
  provider: unknown;
  startsAt: unknown;
  actorLabel: string;
  now?: Date;
};

export async function broadcastSubprocessorNotice(
  input: SubprocessorNoticeInput,
): Promise<BroadcastSummary | OperatorNoticeRefusal> {
  const now = input.now ?? new Date();
  if (!isPhiSubcontractor(input.provider)) return refuse("Pick the subcontractor from the list.");
  const provider: PhiSubcontractor = input.provider;
  const startsAt = typeof input.startsAt === "string" ? new Date(input.startsAt) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) {
    return refuse("When does it start handling the information? A date and time.");
  }

  const audience = broadcastAudience(await listClinics(), { signedOnly: true });
  // Each practice's own agreement decides how far ahead it must be told:
  // the start has to clear the longest notice any of them is owed.
  const needed = Math.max(
    0,
    ...audience.map((c) => subcontractorNoticeMs(subcontractorNoticeRuleFor(c.baaVersion).rule)),
  );
  const earliest = new Date(now.getTime() + needed + SUBCONTRACTOR_NOTICE_MARGIN_MS);
  if (startsAt.getTime() < earliest.getTime()) {
    const longer = audience.filter(
      (c) => subcontractorNoticeRuleFor(c.baaVersion).rule === "fifteen_days",
    ).length;
    return refuse(
      `Too soon: ${
        longer > 0
          ? `${longer} practice${longer === 1 ? "'s agreement promises" : "s' agreements promise"} fifteen days' notice`
          : "the agreements promise at least 24 hours' notice"
      }, with an hour for the email itself. The earliest start, if sent now, is ${earliest.toISOString()}.`,
    );
  }
  const startsIso = startsAt.toISOString();
  return broadcast(
    "subprocessor_notice",
    `subprocessor_notice:${provider}:${startsIso}`,
    audience,
    () => ({ provider, startsAt: startsIso }),
    actorFor(input.actorLabel),
  );
}

// -----------------------------------------------------------------------------
// L33: product updates
// -----------------------------------------------------------------------------

export async function broadcastProductUpdate(input: {
  code: unknown;
  actorLabel: string;
}): Promise<BroadcastSummary | OperatorNoticeRefusal> {
  if (!isProductUpdateCode(input.code)) return refuse("Pick the update from the list.");
  const code: ProductUpdateCode = input.code;
  const screen = PRODUCT_UPDATES[code].action.screen;
  const audience = broadcastAudience(await listClinics(), { signedOnly: false });
  return broadcast(
    "product_update",
    `product_update:${code}`,
    audience,
    (clinic) => ({
      code,
      actionUrl: publicUrl(portalPath(clinic.slug, screen)),
    }),
    actorFor(input.actorLabel),
  );
}

/** A portal screen's path: Home is the clinic's root. */
export function portalPath(slug: string, screen: ProductUpdateScreen): string {
  return screen === "home" ? `/c/${slug}` : `/c/${slug}/${screen}`;
}

// -----------------------------------------------------------------------------
// L29: an incident report, and "Not reportable"
// -----------------------------------------------------------------------------

export type IncidentReportInput = {
  event: unknown;
  /** YYYY-MM-DD, or null/absent while it is not known. */
  occurredOn: unknown;
  /** [{ type, count }] from INCIDENT_INFORMATION_TYPES. */
  info: unknown;
  /** Codes from INCIDENT_MITIGATIONS. */
  mitigations: unknown;
  /** Codes from INCIDENT_PATIENT_STEPS: what the people affected can do. Absent from an older console. */
  steps?: unknown;
  /** Codes from INCIDENT_RECOMMENDATIONS: what we recommend the practice do. */
  recommendations?: unknown;
};

const DECISION_REFUSALS: Record<IncidentDecisionRefusal, string> = {
  no_such_incident: "No such incident at this clinic.",
  resolved: "This incident is resolved: nothing more is sent about it.",
  not_reportable_class:
    "A service complaint is no agreement's to report: answer it in the reply thread.",
  already_not_reportable: "This incident is recorded as not reportable.",
  already_reported: "A report has gone for this incident: it can't be recorded as not reportable.",
};

/**
 * The report's fixed fields, checked, or why not. Each code is one the
 * catalog lists, and two of them only where the rest of the report bears
 * them out: "nothing they need to do", which says what was involved was
 * deleted before anyone used it, goes alone and only with the recipient's
 * confirmed deletion among what was done; and the recommendation to notify
 * the people affected, which points to the list on the incident's page,
 * goes only in a breach's report, the one that links to that page.
 */
export function readIncidentReportFields(
  input: IncidentReportInput,
  discoveredOn: string,
  cls: ReportableClass,
):
  | {
      event: IncidentReportEvent;
      occurredOn: string | null;
      infoRows: { type: IncidentInformationType; count: number }[];
      mitigationRows: { code: IncidentMitigation }[];
      stepRows: { code: IncidentPatientStep }[];
      recommendationRows: { code: IncidentRecommendation }[];
    }
  | OperatorNoticeRefusal {
  if (!isIncidentReportEvent(input.event)) return refuse("Pick what happened from the list.");
  let occurredOn: string | null = null;
  if (input.occurredOn !== null && input.occurredOn !== undefined && input.occurredOn !== "") {
    if (!isRealDay(input.occurredOn))
      return refuse("When did it happen? A date, YYYY-MM-DD, or leave it empty.");
    if (input.occurredOn > discoveredOn) {
      return refuse("It can't have happened after it was discovered.");
    }
    occurredOn = input.occurredOn;
  }
  const rawInfo = Array.isArray(input.info) ? input.info : [];
  const infoRows: { type: IncidentInformationType; count: number }[] = [];
  for (const entry of rawInfo) {
    const row = entry as { type?: unknown; count?: unknown } | null;
    if (!row || !isIncidentInformationType(row.type)) {
      return refuse("Pick each type of information from the list.");
    }
    const count = row.count;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > INCIDENT_REPORT_MAX_COUNT
    ) {
      return refuse("Give each type of information a count: a whole number, at least 1.");
    }
    if (infoRows.some((r) => r.type === row.type)) {
      return refuse("Each type of information once, with its count.");
    }
    infoRows.push({ type: row.type, count });
  }
  const rawDone = Array.isArray(input.mitigations) ? input.mitigations : [];
  if (!rawDone.every(isIncidentMitigation)) return refuse("Pick what was done from the list.");
  const mitigationRows = [...new Set(rawDone as IncidentMitigation[])].map((code) => ({ code }));
  // An older console sends neither list: absent is empty, never a refusal.
  const rawSteps = input.steps === undefined || input.steps === null ? [] : input.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.every(isIncidentPatientStep)) {
    return refuse("Pick what the people affected can do from the list.");
  }
  const stepRows = [...new Set(rawSteps as IncidentPatientStep[])].map((code) => ({ code }));
  if (stepRows.some((r) => r.code === "nothing_needed")) {
    if (stepRows.length > 1) {
      return refuse(
        "\"There's nothing they need to do\" can't go with other steps for them: choose one or the other.",
      );
    }
    if (!mitigationRows.some((r) => r.code === "recipient_confirmed_deletion")) {
      return refuse(
        "\"There's nothing they need to do\" says what was involved was deleted before anyone used it: tick that the recipient confirmed deleting it, or choose the steps they can take.",
      );
    }
  }
  const rawAdvice =
    input.recommendations === undefined || input.recommendations === null
      ? []
      : input.recommendations;
  if (!Array.isArray(rawAdvice) || !rawAdvice.every(isIncidentRecommendation)) {
    return refuse("Pick what we recommend from the list.");
  }
  const recommendationRows = [...new Set(rawAdvice as IncidentRecommendation[])].map((code) => ({
    code,
  }));
  if (cls !== "breach" && recommendationRows.some((r) => r.code === "notify_people")) {
    return refuse(
      "Notifying the people affected points to the list on the incident's page, which only a breach's report links to.",
    );
  }
  return {
    event: input.event,
    occurredOn,
    infoRows,
    mitigationRows,
    stepRows,
    recommendationRows,
  };
}

export type IncidentReportSent = {
  status: "sent";
  /** The report's number: 1, then each update. */
  report: number;
  noticeId: string;
  /** How many steps for the people affected, and recommendations, it carries. */
  steps: number;
  recommendations: number;
};

/**
 * Queue an incident report (or an update to one) for the incident's
 * practice, and record it on the incident, in one transaction; then send it
 * in-process, as a critical notice goes. The first report also records the
 * clinic as told, which is what the internal target's alert chases.
 */
export async function sendIncidentReport(
  clinicId: string,
  incidentId: string,
  input: IncidentReportInput,
  options: { actorLabel: string; now?: Date },
): Promise<IncidentReportSent | OperatorNoticeRefusal> {
  const now = options.now ?? new Date();
  const actor = actorFor(options.actorLabel);
  const outcome = await withTenant(
    { clinicId, actor },
    async (tx): Promise<IncidentReportSent | OperatorNoticeRefusal> => {
      const found = await incidentForDecision(tx, incidentId, "report");
      if ("refused" in found) return refuse(DECISION_REFUSALS[found.refused]);
      const row = found.row;
      if (!isReportableClass(row.class)) return refuse(DECISION_REFUSALS.not_reportable_class);
      const fields = readIncidentReportFields(input, isoDay(row.discoveredAt), row.class);
      if ("status" in fields) return fields;
      if ((await billingRecipients(tx, "incident_report")).length === 0) {
        return refuse(
          "The practice has no address on its account to send the report to. Phone it now, then record how it was told on its care page.",
        );
      }

      const n = row.reportsSent + 1;
      const key = `incident_report:${row.id}:${n}`;
      // A breach's report points to the incident's page, where the practice
      // reads who it affected behind its passkey (lib/portal/incidents.ts):
      // the list is never emailed (X5, L29).
      const listUrl = row.class === "breach" ? await incidentListUrl(tx, row.id) : null;
      await enqueuePlanNotice(tx.db, tx.clinicId, "incident_report", key, {
        kind: row.class,
        event: fields.event,
        occurredOn: fields.occurredOn,
        discoveredOn: isoDay(row.discoveredAt),
        infoRows: fields.infoRows,
        mitigationRows: fields.mitigationRows,
        stepRows: fields.stepRows,
        recommendationRows: fields.recommendationRows,
        isUpdate: n > 1,
        ...(listUrl ? { listUrl } : {}),
      });
      const noticeId = await noticeIdOf(tx, "incident_report", key);
      const report = await recordReportQueued(tx, row.id, {
        noticeId,
        decidedBy: options.actorLabel,
        now,
      });
      return {
        status: "sent",
        report,
        noticeId,
        steps: fields.stepRows.length,
        recommendations: fields.recommendationRows.length,
      };
    },
  );
  if (outcome.status === "sent") await deliverCriticalAfterCommit(clinicId);
  return outcome;
}

export async function markIncidentNotReportable(
  clinicId: string,
  incidentId: string,
  reason: string,
  options: { actorLabel: string; now?: Date },
): Promise<{ status: "updated" } | OperatorNoticeRefusal> {
  return withTenant({ clinicId, actor: actorFor(options.actorLabel) }, async (tx) => {
    const found = await incidentForDecision(tx, incidentId, "not_reportable");
    if ("refused" in found) return refuse(DECISION_REFUSALS[found.refused]);
    const row = await recordNotReportable(tx, incidentId, {
      reason,
      decidedBy: options.actorLabel,
      now: options.now,
    });
    return row
      ? { status: "updated" as const }
      : refuse("No open incident with that id at this clinic.");
  });
}

/**
 * The incident's page in the portal, on the public origin, or null when there
 * is none to compose it from: the report then says the list comes by secure
 * transfer, and the critical report still goes.
 */
async function incidentListUrl(tx: TenantTx, incidentId: string): Promise<string | null> {
  const [clinic] = await tx.db
    .select({ slug: clinics.slug })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || publicOriginProblem()) return null;
  try {
    return publicUrl(incidentPagePath(clinic.slug, incidentId));
  } catch (error) {
    log.error("incident report: no link to the incident's page", {
      clinicId: tx.clinicId,
      error: describeError(error),
    });
    return null;
  }
}

async function noticeIdOf(tx: TenantTx, kind: PlanNoticeKind, dedupeKey: string): Promise<string> {
  const [row] = await tx.db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, kind),
        eq(billingNotices.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`The ${kind} notice was not queued.`);
  return row.id;
}

// -----------------------------------------------------------------------------
// L30: the first-month guarantee
// -----------------------------------------------------------------------------

export type GuaranteeClaimQueued = {
  status: "queued";
  /** The account clinic it went to. */
  billingClinicId: string;
  findingByOn: string;
};

/** The day the finding is due: ten business days after the claim (Terms §5). */
export function findingDueOn(claimReceivedOn: string): string {
  return isoDay(addBusinessDays(dayStart(claimReceivedOn), GUARANTEE_FINDING_BUSINESS_DAYS));
}

/**
 * L30, claim received: on the account clinic, once per claim day, with the
 * day our finding is due.
 */
export async function recordGuaranteeClaim(
  clinicId: string,
  input: { claimReceivedOn: unknown; actorLabel: string; now?: Date },
): Promise<GuaranteeClaimQueued | OperatorNoticeRefusal> {
  const now = input.now ?? new Date();
  if (!isRealDay(input.claimReceivedOn))
    return refuse("When did the claim reach us? A date, YYYY-MM-DD.");
  const receivedOn = input.claimReceivedOn;
  if (receivedOn > isoDay(now)) return refuse("A claim can't reach us in the future.");
  if (receivedOn < isoDay(new Date(now.getTime() - CLAIM_MAX_AGE_DAYS * DAY_MS))) {
    return refuse(`That's more than ${CLAIM_MAX_AGE_DAYS} days ago: check the date.`);
  }
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
  const findingByOn = findingDueOn(receivedOn);
  const inserted = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    if ((await billingRecipients(tx, "guarantee_claim_received")).length === 0) return "no_address" as const;
    const queued = await enqueuePlanNotice(
      tx.db,
      tx.clinicId,
      "guarantee_claim_received",
      `guarantee_claim_received:${receivedOn}`,
      { claimReceivedOn: receivedOn, findingByOn },
    );
    return queued ? ("queued" as const) : ("already" as const);
  });
  if (inserted === "no_address")
    return refuse("The practice has no address on its account to send to.");
  if (inserted === "already") return refuse(`A claim dated ${receivedOn} is already recorded.`);
  return { status: "queued", billingClinicId, findingByOn };
}

export type GuaranteeFindingInput = {
  claimReceivedOn: unknown;
  outcome: unknown;
  refundByOn: unknown;
  failure: unknown;
  actorLabel: string;
  now?: Date;
};

/** L30, our finding: only on a claim recorded first, once, with the refund date and what failed for a miss. */
export async function sendGuaranteeFinding(
  clinicId: string,
  input: GuaranteeFindingInput,
): Promise<{ status: "queued"; billingClinicId: string } | OperatorNoticeRefusal> {
  const now = input.now ?? new Date();
  if (!isRealDay(input.claimReceivedOn)) return refuse("Which claim? Its date, YYYY-MM-DD.");
  const claimReceivedOn = input.claimReceivedOn;
  if (!isGuaranteeOutcome(input.outcome)) return refuse("Pick the finding.");
  const outcome: GuaranteeOutcome = input.outcome;
  let refundByOn: string | null = null;
  let code: GuaranteeFailure | null = null;
  if (outcome === "miss_found") {
    if (!isRealDay(input.refundByOn))
      return refuse("By when is the refund made? A date, YYYY-MM-DD.");
    const latest = isoDay(new Date(now.getTime() + GUARANTEE_REFUND_WITHIN_DAYS * DAY_MS));
    if (input.refundByOn < isoDay(now) || input.refundByOn > latest) {
      return refuse(
        `The refund is made within ${GUARANTEE_REFUND_WITHIN_DAYS} days of the finding (Terms §5): a date from today to ${latest}.`,
      );
    }
    if (!isGuaranteeFailure(input.failure)) return refuse("Pick what failed from the list.");
    refundByOn = input.refundByOn;
    code = input.failure;
  } else if (
    (input.refundByOn !== undefined && input.refundByOn !== null && input.refundByOn !== "") ||
    (input.failure !== undefined && input.failure !== null && input.failure !== "")
  ) {
    return refuse("No miss means no refund and nothing failed: leave both empty.");
  }

  const actor = actorFor(input.actorLabel);
  const billingClinicId = await withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
  const result = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    const [claim] = await tx.db
      .select({ id: billingNotices.id })
      .from(billingNotices)
      .where(
        and(
          eq(billingNotices.clinicId, tx.clinicId),
          eq(billingNotices.kind, "guarantee_claim_received"),
          eq(billingNotices.dedupeKey, `guarantee_claim_received:${claimReceivedOn}`),
        ),
      )
      .limit(1);
    if (!claim) return "no_claim" as const;
    const queued = await enqueuePlanNotice(
      tx.db,
      tx.clinicId,
      "guarantee_finding",
      `guarantee_finding:${claimReceivedOn}`,
      { claimReceivedOn, outcome, refundByOn, code },
    );
    return queued ? ("queued" as const) : ("already" as const);
  });
  if (result === "no_claim") {
    return refuse(
      `No claim dated ${claimReceivedOn} is recorded for this practice: record the claim first.`,
    );
  }
  if (result === "already")
    return refuse(`The finding on the claim of ${claimReceivedOn} has already gone.`);
  return { status: "queued", billingClinicId };
}

// -----------------------------------------------------------------------------
// L31: a suspension for a legal or security reason
// -----------------------------------------------------------------------------

/**
 * The reason on the billing transition. Not one of the non-payment reasons
 * (lib/billing/events.ts NON_PAYMENT_SUSPENSIONS), so paying an invoice
 * never lifts it; the billing panel's liftSuspension does, by hand.
 */
export const SUSPENDED_FOR_CAUSE_REASON = "legal_or_security";

export async function suspendForCause(
  clinicId: string,
  input: { cause: unknown; actorLabel: string; now?: Date },
): Promise<{ status: "suspended"; billingClinicId: string } | OperatorNoticeRefusal> {
  const now = input.now ?? new Date();
  if (!isSuspensionCause(input.cause)) return refuse("Pick why, from the list.");
  const cause: SuspensionCause = input.cause;
  const actor = actorFor(input.actorLabel);
  const billingClinicId = await withTenant({ clinicId, actor }, (tx) => resolveBillingClinicId(tx));
  const outcome = await withTenant(
    { clinicId: billingClinicId, actor },
    async (tx): Promise<"suspended" | OperatorNoticeRefusal> => {
      const row = await getEntitlementsForUpdate(tx.db, tx.clinicId);
      if (!row) return refuse("This practice has no billing account to suspend.");
      if (row.status === "suspended") {
        return refuse(
          "This account is already suspended. A suspension for not paying lifts itself when the invoice is paid, so lift that one in Billing first and then suspend it for this reason.",
        );
      }
      if (!canTransition(row.status, "suspended")) {
        return refuse(`An account that is ${row.status} can't be suspended.`);
      }
      await transition(tx, "suspended", { actor: "support", reason: SUSPENDED_FOR_CAUSE_REASON });
      const suspendedAt = now.toISOString();
      await enqueuePlanNotice(
        tx.db,
        tx.clinicId,
        "suspended_for_cause",
        `suspended_for_cause:${suspendedAt}`,
        { code: cause, suspendedAt },
      );
      return "suspended";
    },
  );
  if (outcome !== "suspended") return outcome;
  await deliverCriticalAfterCommit(billingClinicId);
  return { status: "suspended", billingClinicId };
}

// -----------------------------------------------------------------------------
// What has been sent: the console's record
// -----------------------------------------------------------------------------

/** Where one queued notice stands, as the console says it. */
export type NoticeState = "sent" | "switched_off" | "not_sent" | "dead" | "pending";

export function noticeState(row: {
  sentAt: Date | null;
  attempts: number;
  lastError: string | null;
}): NoticeState {
  if (row.sentAt) {
    if (!row.lastError) return "sent";
    return /switch is off/.test(row.lastError) ? "switched_off" : "not_sent";
  }
  return row.attempts >= MAX_NOTICE_ATTEMPTS ? "dead" : "pending";
}

export type BroadcastRecord = {
  kind: BroadcastKind;
  /** What it announced: the dedupe key's tail (a version, a provider and start, an update's code). */
  subject: string;
  firstQueuedAt: string;
  counts: Record<NoticeState, number>;
};

export type ClinicNoticeRecord = {
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  kind: (typeof SINGLE_NOTICE_KINDS)[number];
  /** The dedupe key's tail: an incident and report number, a claim's day, a suspension's moment. */
  subject: string;
  queuedAt: string;
  state: NoticeState;
};

export type OpenGuaranteeClaim = {
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  claimReceivedOn: string;
  findingByOn: string;
};

export type OperatorNoticesView = {
  broadcasts: BroadcastRecord[];
  notices: ClinicNoticeRecord[];
  /** Claims recorded with no finding sent yet, earliest due first. */
  openClaims: OpenGuaranteeClaim[];
  /**
   * Whether "Start the re-signs" may run (lib/agreements/baa-version-ready.ts),
   * and while not, the line the console shows beside it.
   */
  baaVersionResigns: { ready: boolean; waiting: string | null };
};

const RECORD_DAYS = 180;

/**
 * Every operator notice queued in the last 180 days, across practices, as
 * ids, kinds, keys, times and states: broadcasts counted per announcement,
 * single notices listed, and guarantee claims still owed a finding. Never a
 * payload. One tenant at a time, as the incident-deadlines job reads.
 */
export async function operatorNoticesView(
  actor: ActorContext,
  now: Date = new Date(),
): Promise<OperatorNoticesView> {
  const since = new Date(now.getTime() - RECORD_DAYS * DAY_MS);
  const broadcasts = new Map<string, BroadcastRecord>();
  const notices: ClinicNoticeRecord[] = [];
  const openClaims: OpenGuaranteeClaim[] = [];

  for (const clinic of await listClinics()) {
    const rows = await withTenant({ clinicId: clinic.id, actor }, (tx) =>
      tx.db
        .select({
          kind: billingNotices.kind,
          dedupeKey: billingNotices.dedupeKey,
          createdAt: billingNotices.createdAt,
          sentAt: billingNotices.sentAt,
          attempts: billingNotices.attempts,
          lastError: billingNotices.lastError,
        })
        .from(billingNotices)
        .where(
          and(
            eq(billingNotices.clinicId, tx.clinicId),
            inArray(billingNotices.kind, [...OPERATOR_NOTICE_KINDS] as NoticeKind[]),
            gte(billingNotices.createdAt, since),
          ),
        )
        .orderBy(desc(billingNotices.createdAt)),
    );
    const findings = new Set(
      rows.filter((r) => r.kind === "guarantee_finding").map((r) => tailOf(r.dedupeKey)),
    );
    for (const row of rows) {
      const state = noticeState(row);
      const subject = tailOf(row.dedupeKey);
      if ((BROADCAST_KINDS as readonly string[]).includes(row.kind)) {
        const id = `${row.kind}|${subject}`;
        const record =
          broadcasts.get(id) ??
          ({
            kind: row.kind as BroadcastKind,
            subject,
            firstQueuedAt: row.createdAt.toISOString(),
            counts: { sent: 0, switched_off: 0, not_sent: 0, dead: 0, pending: 0 },
          } satisfies BroadcastRecord);
        record.counts[state] += 1;
        if (row.createdAt.toISOString() < record.firstQueuedAt) {
          record.firstQueuedAt = row.createdAt.toISOString();
        }
        broadcasts.set(id, record);
        continue;
      }
      notices.push({
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        kind: row.kind as ClinicNoticeRecord["kind"],
        subject,
        queuedAt: row.createdAt.toISOString(),
        state,
      });
      if (row.kind === "guarantee_claim_received" && !findings.has(subject) && isRealDay(subject)) {
        openClaims.push({
          clinicId: clinic.id,
          clinicSlug: clinic.slug,
          clinicName: clinic.name,
          claimReceivedOn: subject,
          findingByOn: findingDueOn(subject),
        });
      }
    }
  }

  return {
    broadcasts: [...broadcasts.values()].sort((a, b) =>
      b.firstQueuedAt.localeCompare(a.firstQueuedAt),
    ),
    notices: notices.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)),
    openClaims: openClaims.sort((a, b) => a.findingByOn.localeCompare(b.findingByOn)),
    baaVersionResigns: baaVersionResignsReady()
      ? { ready: true, waiting: null }
      : { ready: false, waiting: BAA_VERSION_RESIGNS_WAITING },
  };
}

/** A dedupe key without its kind: "terms_notice:2026-11-20.1" → "2026-11-20.1". */
function tailOf(dedupeKey: string): string {
  const at = dedupeKey.indexOf(":");
  return at === -1 ? dedupeKey : dedupeKey.slice(at + 1);
}

// -----------------------------------------------------------------------------
// The incidents across practices: the /admin incidents page
// -----------------------------------------------------------------------------

export type IncidentRegisterRow = {
  id: string;
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  class: (typeof incidents.$inferSelect)["class"];
  summary: string;
  conversationId: string | null;
  discoveredAt: string;
  /** The agreement's own deadline; null for a service complaint. */
  agreementNotifyBy: string | null;
  agreementVersion: string | null;
  /** healdesk's internal target, never a promise. */
  targetNotifyBy: string;
  ftcNotifyBy: string | null;
  notifiedAt: string | null;
  notifiedHow: string | null;
  reportedAt: string | null;
  reportsSent: number;
  notReportableAt: string | null;
  notReportableReason: string | null;
  decidedBy: string | null;
  resolvedAt: string | null;
  openedBy: string;
  /**
   * How many people the operator recorded as affected (lib/incidents/
   * affected.ts; incidents.affected_recorded): a count, never who, and the
   * count as recorded, which an erasure of one of them does not lower. The
   * practice reads them on the incident's page once a report has gone.
   */
  affectedCount: number;
};

/** How long a resolved incident stays on the cross-practice page. */
const RESOLVED_SHOWN_DAYS = 90;

/**
 * Every open incident, and those resolved in the last 90 days, across
 * practices, open first by the agreement's deadline. One tenant at a time;
 * each read is audited in its own tenant, with a count.
 */
export async function incidentRegister(
  actor: ActorContext,
  now: Date = new Date(),
): Promise<IncidentRegisterRow[]> {
  const shownSince = now.getTime() - RESOLVED_SHOWN_DAYS * DAY_MS;
  const out: IncidentRegisterRow[] = [];
  for (const clinic of await listClinics()) {
    const rows = await withTenant({ clinicId: clinic.id, actor }, async (tx) => {
      const found = await tx.db
        .select()
        .from(incidents)
        .where(eq(incidents.clinicId, tx.clinicId))
        .orderBy(desc(incidents.discoveredAt));
      const shown = found.filter((i) => !i.resolvedAt || i.resolvedAt.getTime() >= shownSince);
      if (shown.length > 0) {
        tx.audit.record({
          action: "read",
          resourceType: "incident",
          resultCount: shown.length,
          metadata: { purpose: "incident_register" },
        });
      }
      return shown;
    });
    for (const i of rows) {
      out.push({
        id: i.id,
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        class: i.class,
        summary: i.summary,
        conversationId: i.conversationId,
        discoveredAt: i.discoveredAt.toISOString(),
        agreementNotifyBy: i.agreementNotifyBy?.toISOString() ?? null,
        agreementVersion: i.agreementVersion,
        targetNotifyBy: i.notifyBy.toISOString(),
        ftcNotifyBy: i.ftcNotifyBy?.toISOString() ?? null,
        notifiedAt: i.notifiedAt?.toISOString() ?? null,
        notifiedHow: i.notifiedHow,
        reportedAt: i.reportedAt?.toISOString() ?? null,
        reportsSent: i.reportsSent,
        notReportableAt: i.notReportableAt?.toISOString() ?? null,
        notReportableReason: i.notReportableReason,
        decidedBy: i.decidedBy,
        resolvedAt: i.resolvedAt?.toISOString() ?? null,
        openedBy: i.openedBy,
        affectedCount: i.affectedRecorded,
      });
    }
  }
  const deadline = (r: IncidentRegisterRow) => r.agreementNotifyBy ?? r.targetNotifyBy;
  return out.sort((a, b) => {
    const openA = a.resolvedAt === null;
    const openB = b.resolvedAt === null;
    if (openA !== openB) return openA ? -1 : 1;
    return openA
      ? deadline(a).localeCompare(deadline(b))
      : b.discoveredAt.localeCompare(a.discoveredAt);
  });
}

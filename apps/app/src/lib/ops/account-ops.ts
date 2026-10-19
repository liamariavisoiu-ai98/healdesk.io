import { isCoveredAnswer, type AgreementKind, type Channel } from "@healdesk/catalog";
import { and, desc, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { auditReviewQueue, checkoutIntents, clinics, type AddressChangeStatus } from "@/db/schema";
import { setCoveredEntity } from "@/lib/agreements/covered-entity";
import { listAgreementReviews } from "@/lib/agreements/misclassification";
import type { ChannelStatus } from "@/lib/channels/state";
import { getCalendarConnection } from "@/lib/connections/google-calendar";
import { readSetupState } from "@/lib/setup/state";
import { buildTracker, type StageId, type StageState } from "@/lib/setup/tracker";
import {
  clinicSignIn,
  listAddressChanges,
  operatorChangeClinicEmail,
  stopAddressChange,
} from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import {
  actorFor,
  audit,
  clinicById,
  ok,
  opsProblem,
  stringArg,
  type Operator,
  type OpsOutcome,
} from "./api";

/**
 * The operator console's account operations (plan Part K), each a
 * projection apps/app decides, never a patient row:
 *
 *   - the clinic's sign-in and its address changes, and changeClinicEmail,
 *     the human route when a clinic has lost the address itself (Part D5);
 *   - setCoveredEntity (Part L);
 *   - the clinic cards' channel states, build tracker and agreement label;
 *   - the site-read failures: purchases whose website read failed.
 *
 * changeClinicEmail is entered with the operator's TOTP, checked on apps/web
 * before the request is signed (apps/web/src/lib/admin/fresh-code.ts): the
 * signed envelope is the only proof that crosses, as for every operation.
 */

// -----------------------------------------------------------------------------
// The sign-in and its address
// -----------------------------------------------------------------------------

export type OpsAddressChange = {
  id: string;
  status: AddressChangeStatus;
  source: "settings" | "operator";
  oldEmail: string;
  newEmail: string;
  requestedBy: string;
  createdAt: string;
  confirmedAt: string | null;
  effectiveAt: string | null;
  resolvedAt: string | null;
  stoppedBy: "clinic" | "operator" | null;
  resolution: string | null;
};

export type ClinicSignInView = {
  clinicId: string;
  clinicName: string;
  /** The clinic's one address: its sign-in, the Stripe customer's email and the notice address. */
  address: string | null;
  changes: OpsAddressChange[];
  coveredEntity: {
    specialty: string;
    regime: string | null;
    agreementKind: AgreementKind | null;
    isCoveredEntity: boolean | null;
  };
};

/** The clinic's address and what has become of each change of it. Business contact data. */
export async function opGetClinicSignIn(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const view = await withTenant(
    { clinicId: clinic.id, actor: actorFor(operator), request: operator.request },
    async (tx) => {
      const [row] = await tx.db
        .select({ regime: clinics.regulatoryRegime, kind: clinics.agreementKind })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      const signIn = await clinicSignIn(tx);
      const changes = await listAddressChanges(tx, 10);
      tx.audit.record({ action: "read", resourceType: "clinic_sign_in", resourceId: tx.clinicId });
      return {
        clinicId: clinic.id,
        clinicName: clinic.name,
        address: signIn?.email ?? null,
        changes: changes.map((c) => ({
          id: c.id,
          status: c.status,
          source: c.source,
          oldEmail: c.oldEmail,
          newEmail: c.newEmail,
          requestedBy: c.requestedBy,
          createdAt: c.createdAt.toISOString(),
          confirmedAt: c.confirmedAt?.toISOString() ?? null,
          effectiveAt: c.effectiveAt?.toISOString() ?? null,
          resolvedAt: c.resolvedAt?.toISOString() ?? null,
          stoppedBy: c.stoppedBy,
          resolution: c.resolution,
        })),
        coveredEntity: {
          specialty: clinic.specialty,
          regime: row?.regime ?? null,
          agreementKind: row?.kind ?? null,
          isCoveredEntity: clinic.isCoveredEntity,
        },
      } satisfies ClinicSignInView;
    },
  );
  return ok(view);
}

export type ChangeClinicEmailState =
  | {
      status: "entered";
      changeId: string;
      newEmail: string;
      /** The end of the 72-hour objection window, when it takes effect. ISO. */
      effectiveAt: string;
      /** Whether O5 reached both addresses. */
      emailed: boolean;
    }
  | { status: "refused"; message: string };

/**
 * changeClinicEmail (plan Part D5): after a call back to the practice's
 * published number, the operator enters the new address. It takes effect 72
 * hours later, moving the sign-in, the Stripe customer and the notice address
 * together, with O5 to both addresses naming that moment; until then either
 * reader objects by replying, and stopClinicEmailChange stops it. The core
 * writes the security events (lib/sign-in/address-change.ts).
 */
export async function opChangeClinicEmail(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic)
    return ok({ status: "refused", message: "No such clinic." } satisfies ChangeClinicEmailState);
  const outcome = await operatorChangeClinicEmail({
    clinicId: clinic.id,
    newEmail: stringArg(args, "newEmail", 320) ?? "",
    requestedBy: operator.email,
    actor: actorFor(operator),
    request: operator.request,
  });
  if (outcome.status === "refused") {
    return ok({ status: "refused", message: outcome.message } satisfies ChangeClinicEmailState);
  }
  return ok({
    status: "entered",
    changeId: outcome.change.id,
    newEmail: outcome.change.newEmail,
    effectiveAt: outcome.change.effectiveAt!.toISOString(),
    emailed: outcome.emailed,
  } satisfies ChangeClinicEmailState);
}

export type StopClinicEmailChangeState = { status: "stopped" | "none" };

/** An objection inside the 72 hours: the operator stops the clinic's open change. */
export async function opStopClinicEmailChange(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic) return opsProblem("No such clinic.", 404, "invalid_args");
  const outcome = await stopAddressChange({
    clinicId: clinic.id,
    stoppedBy: "operator",
    label: operator.email,
    actor: actorFor(operator),
    request: operator.request,
  });
  return ok({ status: outcome.status } satisfies StopClinicEmailChangeState);
}

// -----------------------------------------------------------------------------
// setCoveredEntity
// -----------------------------------------------------------------------------

export type SetCoveredEntityState =
  | {
      status: "recorded";
      agreementKind: AgreementKind;
      isCoveredEntity: boolean | null;
      /** Whether the agreement on record still covers the practice: the PHI gate's answer. */
      covered: boolean;
      /** A DPA practice now covered or not sure: the re-sign as a BAA has started. */
      supersedeStarted: boolean;
      /** Whether L22, with the practice's re-sign link, went (lib/agreements/resign.ts). */
      linkSent: boolean;
      auditRecorded: boolean;
    }
  | { status: "refused"; message: string };

/**
 * setCoveredEntity (plan Part K, L): the practice's answer to the
 * insurance-billing question, after a call. Refuses a veterinary practice;
 * records the answer under a BAA; under a DPA, a "Yes" or "Not sure" closes
 * the PHI gate and starts the DPA→BAA supersede (lib/agreements/covered-entity.ts).
 */
export async function opSetCoveredEntity(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  if (!clinic)
    return ok({ status: "refused", message: "No such clinic." } satisfies SetCoveredEntityState);
  const answer = args.answer;
  if (!isCoveredAnswer(answer)) {
    return ok({
      status: "refused",
      message: "The answer is yes, no or not_sure.",
    } satisfies SetCoveredEntityState);
  }
  const outcome = await setCoveredEntity({
    clinicId: clinic.id,
    answer,
    actor: actorFor(operator),
    actorLabel: operator.email,
    request: operator.request,
  });
  if (outcome.status === "refused") return ok(outcome satisfies SetCoveredEntityState);
  const auditRecorded = await audit(operator, "covered_entity_recorded", {
    clinicId: clinic.id,
    coveredEntity: outcome.isCoveredEntity,
    agreementKind: outcome.agreementKind,
    covered: outcome.covered,
  });
  return ok({
    status: "recorded",
    agreementKind: outcome.agreementKind,
    isCoveredEntity: outcome.isCoveredEntity,
    covered: outcome.covered,
    supersedeStarted: outcome.supersede !== null,
    linkSent: outcome.supersede?.linkSent ?? false,
    auditRecorded,
  } satisfies SetCoveredEntityState);
}

// -----------------------------------------------------------------------------
// The misclassification signal's reviews (WP9, plan Part L)
// -----------------------------------------------------------------------------

/**
 * listAgreementReviews: each DPA "No" practice whose website says it accepts
 * insurance, open first (lib/agreements/misclassification.ts). Ids, names
 * and dates; nothing but the practice's own business data.
 */
export async function opListAgreementReviews(operator: Operator): Promise<OpsOutcome> {
  const reviews = await listAgreementReviews({
    actor: actorFor(operator),
    request: operator.request,
  });
  return ok({ reviews });
}

/**
 * decideAgreementReview: the practice's answer, as ops heard it on a call,
 * recorded through setCoveredEntity, which closes the review: "No" leaves
 * the DPA in force, "Yes" or "Not sure" starts the re-sign to the BAA.
 * The reply is setCoveredEntity's.
 */
export async function opDecideAgreementReview(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const clinic = await clinicById(stringArg(args, "clinicId"));
  const reviewId = stringArg(args, "reviewId") ?? "";
  if (!clinic)
    return ok({ status: "refused", message: "No such clinic." } satisfies SetCoveredEntityState);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reviewId)) {
    return ok({ status: "refused", message: "No such review at this clinic." } satisfies SetCoveredEntityState);
  }
  if (!isCoveredAnswer(args.answer)) {
    return ok({
      status: "refused",
      message: "The answer is yes, no or not_sure.",
    } satisfies SetCoveredEntityState);
  }
  const open = await withTenant({ clinicId: clinic.id, actor: actorFor(operator) }, async (tx) => {
    const [row] = await tx.db
      .select({ status: auditReviewQueue.status })
      .from(auditReviewQueue)
      .where(
        and(
          eq(auditReviewQueue.id, reviewId),
          eq(auditReviewQueue.clinicId, tx.clinicId),
          eq(auditReviewQueue.kind, "agreement_kind"),
        ),
      )
      .limit(1);
    return row?.status ?? null;
  });
  if (open !== "open") {
    return ok({
      status: "refused",
      message: open === null ? "No such review at this clinic." : "This review has been decided already.",
    } satisfies SetCoveredEntityState);
  }
  return opSetCoveredEntity({ clinicId: clinic.id, answer: args.answer }, operator);
}

// -----------------------------------------------------------------------------
// The clinic cards
// -----------------------------------------------------------------------------

export type ClinicCard = {
  id: string;
  agreementKind: AgreementKind | null;
  /** "Business associate agreement", "Data protection agreement", or that none is recorded. */
  agreementLabel: string;
  channels: { channel: Channel; status: ChannelStatus }[];
  /** The build tracker's stages: ids, labels and states only, never a stage's detail. */
  tracker: { id: StageId; label: string; state: StageState }[];
  /** The blocking stages not done, by label. */
  trackerLeft: string[];
};

/** Each card costs a tenant read and a calendar read; newest first, the cap falls on the oldest. */
export const CLINIC_CARD_LIMIT = 50;

export function agreementLabel(kind: AgreementKind | null): string {
  return kind === "baa"
    ? "Business associate agreement"
    : kind === "dpa"
      ? "Data protection agreement"
      : "No agreement recorded";
}

/**
 * What each clinic card adds to listClinics (which stays as it is): every
 * bought channel's state, the build tracker the clinic sees on Home, and the
 * kind of agreement it is under. Computed by the same functions the portal
 * uses (readChannelStates, buildTracker), so the console and the clinic
 * cannot read a clinic differently. The calendar stage carries no account:
 * the tracker's detail lines are never projected.
 */
export async function opListClinicCards(operator: Operator): Promise<OpsOutcome> {
  const listed = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() order by created_at desc limit ${CLINIC_CARD_LIMIT}`,
  );
  const now = new Date();
  const cards: ClinicCard[] = [];
  for (const { id } of listed.rows) {
    const state = await withTenant(
      { clinicId: id, actor: actorFor(operator), request: operator.request },
      (tx) => readSetupState(tx, { userId: null, now }),
    );
    if (!state) continue;
    const calendar = await getCalendarConnection(id, { actor: actorFor(operator) });
    const tracker = buildTracker(state, calendar);
    cards.push({
      id,
      agreementKind: state.clinic.agreementKind,
      agreementLabel: agreementLabel(state.clinic.agreementKind),
      channels: state.channels.map((c) => ({ channel: c.channel, status: c.status })),
      tracker: tracker.stages.map((s) => ({ id: s.id, label: s.label, state: s.state })),
      trackerLeft: tracker.left,
    });
  }
  return ok({ cards, limit: CLINIC_CARD_LIMIT });
}

// -----------------------------------------------------------------------------
// Site-read failures
// -----------------------------------------------------------------------------

export type SiteReadFailure = {
  /** The purchase's ref. */
  ref: string;
  clinicName: string;
  /** The website the read failed on. A practice's public site: business data. */
  website: string | null;
  createdAt: string;
  /** When the first invoice was paid and the clinic provisioned, or null. */
  provisionedAt: string | null;
  clinicId: string | null;
  /** Whether the clinic has a website read since (a re-read, or its answers in setup). */
  profileSince: boolean;
};

/** How many failures one call lists, newest first. */
export const SITE_READ_FAILURE_LIMIT = 100;

/**
 * The purchases whose website read failed at checkout (plan Part B; apps/web's
 * order carries `profileStatus: "failed"` and no profile), newest first: the
 * practices whose wizard asked its three questions instead, for an operator
 * to look at the site and, once WP11's signed re-read exists, ask for it
 * again. checkout_intents is identity-plane (0043), so this reads it
 * directly; whether a profile arrived since is read in each clinic's tenant.
 */
export async function opListSiteReadFailures(operator: Operator): Promise<OpsOutcome> {
  const rows = await unsafeDb
    .select({
      ref: checkoutIntents.ref,
      payload: checkoutIntents.payload,
      createdAt: checkoutIntents.createdAt,
      consumedAt: checkoutIntents.consumedAt,
      clinicId: checkoutIntents.provisionedClinicId,
    })
    .from(checkoutIntents)
    .where(eq(checkoutIntents.profileStatus, "failed"))
    .orderBy(desc(checkoutIntents.createdAt))
    .limit(SITE_READ_FAILURE_LIMIT);

  const failures: SiteReadFailure[] = [];
  for (const row of rows) {
    let profileSince = false;
    if (row.clinicId) {
      profileSince = await withTenant(
        { clinicId: row.clinicId, actor: actorFor(operator), request: operator.request },
        async (tx) => {
          const [clinic] = await tx.db
            .select({ read: sql<boolean>`${clinics.siteProfile} is not null` })
            .from(clinics)
            .where(eq(clinics.id, tx.clinicId))
            .limit(1);
          return clinic?.read ?? false;
        },
      );
    }
    const payload = row.payload as { clinicName?: unknown; website?: unknown };
    failures.push({
      ref: row.ref,
      clinicName: typeof payload.clinicName === "string" ? payload.clinicName : "(no name)",
      website: typeof payload.website === "string" ? payload.website : null,
      createdAt: row.createdAt.toISOString(),
      provisionedAt: row.consumedAt?.toISOString() ?? null,
      clinicId: row.clinicId,
      profileSince,
    });
  }
  return ok({ failures, limit: SITE_READ_FAILURE_LIMIT });
}

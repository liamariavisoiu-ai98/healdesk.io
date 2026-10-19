import { createHash, randomBytes } from "node:crypto";

import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import {
  clinicMemberships,
  clinics,
  clinicSettingsHistory,
  signInAddressChanges,
  signInLinks,
  type AddressChangeSource,
  type AddressChangeStatus,
  type AddressChangeStopper,
} from "@/db/schema";
import { agreementInEffect } from "@/lib/agreements/in-effect";
import { recordSecurityEvent, type ActorContext, type RequestContext } from "@/lib/audit";
import { stripeCustomerOf, updateStripeCustomerEmail } from "@/lib/billing/customer-email";
import { stripeConfigured } from "@/lib/billing/stripe-client";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import {
  addressConfirmReason,
  renderAddressChangeConfirm,
  type AddressChangeConfirmPayload,
} from "@/lib/email/templates/address_change_confirm";
import {
  addressMovingReason,
  renderAddressChanging,
  type AddressChangingPayload,
} from "@/lib/email/templates/address_changing";
import { audienceFor, clinicReason } from "@/lib/email/templates/context";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";
import { portalGrants } from "@/lib/portal/access";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { claimDelivery, recordDelivery } from "@/lib/reporting/recipients";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { maskEmail } from "./links";

/**
 * A change of the clinic's one address (plan Part D5, Annex X5 O5).
 *
 * One address is the clinic's sign-in (the Better Auth user's email), the
 * Stripe customer's email and the agreement's notice address (spec,
 * "Account access and credentials"; Terms §18), so the three move together,
 * and only once the change is past its objection window:
 *
 *   - **From Settings** (signed in, with a passkey step-up): a single-use
 *     link goes to the NEW address. Nothing happens until it is used. Once
 *     it is, the change takes effect 72 hours later, and O5 goes to the OLD
 *     address naming that moment, with "Stop this change", which opens
 *     Settings → Sign-in. Every sign-in link still goes to the old address
 *     until then, so its reader can sign in and stop it.
 *   - **From ops' changeClinicEmail** (the operator's TOTP on apps/web,
 *     after a call back to the practice's published number, when the
 *     address itself was lost): no link, because the operator confirmed it
 *     on the call; O5 goes to BOTH addresses, naming the end of the 72-hour
 *     objection window, which is when it takes effect. Either reader objects
 *     by replying, and the operator stops it.
 *
 * When it takes effect (the hourly job, `runAddressChangesJob`): the Stripe
 * customer first, outside any transaction, so a Stripe failure leaves all
 * three where they were and the job tries again the next hour; then, in one
 * transaction, the sign-in's email, the change's state, every unused sign-in
 * link spent (one mailed to the old address must not sign anyone in after
 * the move), a clinic_settings_history row, and the security events. The
 * notice address has no column of its own: notices go to the clinic's one
 * address, read when each is sent, and the change's row plus its
 * `agreement_notice_address_changed` event are the written notice of a new
 * notice address that every agreement's Notices clause provides for.
 *
 * Every resolution (applied, stopped, expired, failed) writes a
 * security_events row with ids only. Business contact data throughout; no
 * patient.
 */

/** How long after confirmation a change takes effect: the objection window. */
export const ADDRESS_CHANGE_WAIT_MS = 72 * 60 * 60 * 1000;

/** How long the confirmation link works. */
export const ADDRESS_CONFIRM_LINK_TTL_MS = 72 * 60 * 60 * 1000;

const HOURS = 60 * 60 * 1000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The job's actor: the change was asked for by someone else, and its row says who. */
const JOB_ACTOR: ActorContext = { type: "service", serviceName: "address-changes" };

const ADDRESS =
  /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** An address as typed, trimmed and lower-cased, or null when it isn't one. */
export function normaliseAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const address = raw.trim().toLowerCase();
  return address.length <= 254 && ADDRESS.test(address) ? address : null;
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

export type AddressChangeView = {
  id: string;
  status: AddressChangeStatus;
  source: AddressChangeSource;
  oldEmail: string;
  newEmail: string;
  requestedBy: string;
  createdAt: Date;
  confirmExpiresAt: Date | null;
  confirmedAt: Date | null;
  effectiveAt: Date | null;
  resolvedAt: Date | null;
  stoppedBy: AddressChangeStopper | null;
  resolution: string | null;
};

const VIEW = {
  id: signInAddressChanges.id,
  status: signInAddressChanges.status,
  source: signInAddressChanges.source,
  oldEmail: signInAddressChanges.oldEmail,
  newEmail: signInAddressChanges.newEmail,
  requestedBy: signInAddressChanges.requestedBy,
  createdAt: signInAddressChanges.createdAt,
  confirmExpiresAt: signInAddressChanges.confirmExpiresAt,
  confirmedAt: signInAddressChanges.confirmedAt,
  effectiveAt: signInAddressChanges.effectiveAt,
  resolvedAt: signInAddressChanges.resolvedAt,
  stoppedBy: signInAddressChanges.stoppedBy,
  resolution: signInAddressChanges.resolution,
};

/** The clinic's sign-in: its active owner membership's user, else any active member's. */
export async function clinicSignIn(
  tx: TenantTx,
): Promise<{ userId: string; email: string } | null> {
  const [row] = await tx.db
    .select({ userId: user.id, email: user.email })
    .from(clinicMemberships)
    .innerJoin(user, eq(user.id, clinicMemberships.userId))
    .where(and(eq(clinicMemberships.clinicId, tx.clinicId), isNull(clinicMemberships.revokedAt)))
    .orderBy(sql`(${clinicMemberships.role} = 'owner') desc`, clinicMemberships.grantedAt)
    .limit(1);
  return row ? { userId: row.userId, email: row.email.trim().toLowerCase() } : null;
}

/** The clinic's open change, if any, inside its tenant. */
export async function openAddressChange(tx: TenantTx): Promise<AddressChangeView | null> {
  const [row] = await tx.db
    .select(VIEW)
    .from(signInAddressChanges)
    .where(
      and(
        eq(signInAddressChanges.clinicId, tx.clinicId),
        sql`${signInAddressChanges.status} in ('awaiting_confirmation', 'pending')`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Open the clinic's tenant and read its open change: Settings → Sign-in's view. */
export async function loadOpenAddressChange(
  clinicId: string,
  actor: ActorContext,
): Promise<AddressChangeView | null> {
  return withTenant({ clinicId, actor }, (tx) => openAddressChange(tx));
}

/** The clinic's changes, newest first: the open one and what became of the rest. */
export async function listAddressChanges(tx: TenantTx, limit = 10): Promise<AddressChangeView[]> {
  return tx.db
    .select(VIEW)
    .from(signInAddressChanges)
    .where(eq(signInAddressChanges.clinicId, tx.clinicId))
    .orderBy(desc(signInAddressChanges.createdAt))
    .limit(Math.max(1, Math.min(limit, 50)));
}

// -----------------------------------------------------------------------------
// Asking for one
// -----------------------------------------------------------------------------

export type AddressChangeRequestOutcome =
  | {
      status: "requested";
      change: AddressChangeView;
      /** Whether the email the change needs next went: the link (Settings) or both notices (ops). */
      emailed: boolean;
    }
  | { status: "refused"; message: string };

type RequestInput = {
  clinicId: string;
  newEmail: unknown;
  /** The device whose passkey stepped up, or the operator's address. */
  requestedBy: string;
  actor: ActorContext;
  request?: RequestContext;
};

/**
 * From Settings → Sign-in, behind a passkey step-up (the caller checks it):
 * record the change and send the confirmation link to the new address.
 * `userId` is the signed-in user, which must be the clinic's sign-in.
 */
export async function requestAddressChange(
  input: RequestInput & { userId: string },
  options: SendEmailOptions = {},
): Promise<AddressChangeRequestOutcome> {
  return startChange({ ...input, source: "settings" }, options);
}

/**
 * Ops' changeClinicEmail (plan Part D5, the human route): the operator has
 * called the practice back on its published number, and enters the new
 * address with the operator's TOTP on apps/web. Recorded as confirmed, in
 * effect 72 hours on, with O5 to both addresses naming that moment.
 */
export async function operatorChangeClinicEmail(
  input: RequestInput,
  options: SendEmailOptions = {},
): Promise<AddressChangeRequestOutcome> {
  return startChange({ ...input, userId: null, source: "operator" }, options);
}

async function startChange(
  input: RequestInput & { userId: string | null; source: AddressChangeSource },
  options: SendEmailOptions,
): Promise<AddressChangeRequestOutcome> {
  const newEmail = normaliseAddress(input.newEmail);
  if (!newEmail) {
    return { status: "refused", message: "Enter one email address, like info@yourpractice.com." };
  }
  // The links this change mails must point somewhere: refuse before anything
  // is recorded rather than leave a change nobody can confirm or stop.
  if (publicOriginProblem()) {
    return {
      status: "refused",
      message: "Address changes can't be sent from this deployment yet. Nothing was changed.",
    };
  }

  const token = input.source === "settings" ? randomBytes(TOKEN_BYTES).toString("base64url") : null;
  const requestedBy = input.requestedBy.trim().slice(0, 200) || "the clinic's sign-in";

  const prepared = await withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const [clinic] = await tx.db
        .select({ offboardingStartedAt: clinics.offboardingStartedAt })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic || clinic.offboardingStartedAt) {
        return { refused: "This account has closed, so its address can't be changed." } as const;
      }
      const signIn = await clinicSignIn(tx);
      if (!signIn || (input.userId !== null && signIn.userId !== input.userId)) {
        return { refused: "Only the clinic's own sign-in can change its address." } as const;
      }
      if (signIn.email === newEmail) {
        return { refused: "That's already the clinic's address." } as const;
      }
      // One address is one sign-in (user.email is unique), so an address
      // that already signs in to healdesk cannot become this one's.
      const [taken] = await tx.db
        .select({ id: user.id })
        .from(user)
        .where(and(sql`lower(${user.email}) = ${newEmail}`, ne(user.id, signIn.userId)))
        .limit(1);
      if (taken) {
        return {
          refused:
            "That address already signs in to healdesk, so it can't be this clinic's too. Use another, or email hello@healdesk.io.",
        } as const;
      }
      const [open] = await tx.db
        .select({ id: signInAddressChanges.id })
        .from(signInAddressChanges)
        .where(
          and(
            eq(signInAddressChanges.userId, signIn.userId),
            sql`${signInAddressChanges.status} in ('awaiting_confirmation', 'pending')`,
          ),
        )
        .limit(1);
      if (open) {
        return {
          refused: "A change of address is already under way. Stop it first, then ask again.",
        } as const;
      }

      const operator = input.source === "operator";
      const [row] = await tx.db
        .insert(signInAddressChanges)
        .values({
          clinicId: tx.clinicId,
          userId: signIn.userId,
          oldEmail: signIn.email,
          newEmail,
          source: input.source,
          status: operator ? "pending" : "awaiting_confirmation",
          requestedBy,
          confirmTokenHash: token ? hashToken(token) : null,
          // The database's clock, like every other expiry it enforces.
          confirmExpiresAt: operator
            ? null
            : sql`now() + ${ADDRESS_CONFIRM_LINK_TTL_MS} * interval '1 millisecond'`,
          confirmedAt: operator ? sql`now()` : null,
          effectiveAt: operator
            ? sql`now() + ${ADDRESS_CHANGE_WAIT_MS} * interval '1 millisecond'`
            : null,
        })
        .returning(VIEW);
      if (!row) throw new Error("The address change was not recorded.");

      tx.audit.record({
        action: "create",
        resourceType: "sign_in_address_change",
        resourceId: row.id,
        // Ids and categories only: the row holds the addresses.
        metadata: { source: input.source },
      });
      await recordSecurityEvent(tx.db, {
        event: operator ? "sign_in_address_change_entered" : "sign_in_address_change_requested",
        actorLabel: requestedBy,
        userId: signIn.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { changeId: row.id, clinicId: tx.clinicId, source: input.source },
      });
      return { change: row } as const;
    },
  );
  if ("refused" in prepared) return { status: "refused", message: prepared.refused! };

  const { change } = prepared;
  const emailed =
    input.source === "settings"
      ? await sendConfirmLink(input.clinicId, change, token!, options)
      : (await sendChangingNotices(input.clinicId, change, ["old", "new"], options)) === 2;
  return { status: "requested", change, emailed };
}

// -----------------------------------------------------------------------------
// The confirmation link
// -----------------------------------------------------------------------------

export type AddressLinkProblem = "unknown" | "expired" | "used" | "stopped";

export type AddressLinkLookup =
  | {
      ok: true;
      clinicName: string;
      newEmailMasked: string;
      oldEmailMasked: string;
    }
  | {
      ok: false;
      reason: AddressLinkProblem;
      /** For a confirmed change still waiting: when it takes effect, and the clinic's zone. */
      effectiveAt?: Date | null;
      timeZone?: string;
    };

/** What a link would confirm, without confirming it: the GET that renders "Confirm". */
export async function lookUpAddressLink(
  token: unknown,
  now: Date = new Date(),
): Promise<AddressLinkLookup> {
  const found = await findByToken(token);
  if (!found) return { ok: false, reason: "unknown" };
  return withTenant({ clinicId: found.clinicId, actor: JOB_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({ ...VIEW, clinicName: clinics.name, timeZone: clinics.timezone })
      .from(signInAddressChanges)
      .innerJoin(clinics, eq(clinics.id, signInAddressChanges.clinicId))
      .where(eq(signInAddressChanges.id, found.id))
      .limit(1);
    if (!row) return { ok: false, reason: "unknown" } as const;
    if (row.status === "pending") {
      return {
        ok: false,
        reason: "used",
        effectiveAt: row.effectiveAt,
        timeZone: row.timeZone,
      } as const;
    }
    if (row.status === "applied") return { ok: false, reason: "used", effectiveAt: null } as const;
    if (row.status === "stopped" || row.status === "failed")
      return { ok: false, reason: "stopped" } as const;
    if (row.status === "expired" || (row.confirmExpiresAt && row.confirmExpiresAt <= now)) {
      return { ok: false, reason: "expired" } as const;
    }
    return {
      ok: true,
      clinicName: row.clinicName,
      newEmailMasked: maskEmail(row.newEmail),
      oldEmailMasked: maskEmail(row.oldEmail),
    } as const;
  });
}

export type AddressConfirmOutcome =
  { ok: true; effectiveAt: Date; emailed: boolean } | { ok: false; reason: AddressLinkProblem };

/**
 * Use the link: one conditional UPDATE, so of two submissions exactly one
 * confirms. The change takes effect 72 hours from now, and O5 goes to the
 * old address naming that moment.
 */
export async function confirmAddressChange(
  token: unknown,
  request: RequestContext = {},
  options: SendEmailOptions = {},
): Promise<AddressConfirmOutcome> {
  const found = await findByToken(token);
  if (!found) return { ok: false, reason: "unknown" };

  const confirmed = await withTenant(
    { clinicId: found.clinicId, actor: JOB_ACTOR, request },
    async (tx) => {
      const [row] = await tx.db
        .update(signInAddressChanges)
        .set({
          status: "pending",
          confirmedAt: sql`now()`,
          effectiveAt: sql`now() + ${ADDRESS_CHANGE_WAIT_MS} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(signInAddressChanges.id, found.id),
            eq(signInAddressChanges.status, "awaiting_confirmation"),
            sql`${signInAddressChanges.confirmExpiresAt} > now()`,
          ),
        )
        .returning({ ...VIEW, userId: signInAddressChanges.userId });
      if (!row) return null;
      tx.audit.record({
        action: "update",
        resourceType: "sign_in_address_change",
        resourceId: row.id,
        metadata: { status: "pending" },
      });
      await recordSecurityEvent(tx.db, {
        event: "sign_in_address_change_confirmed",
        actorLabel: "the new address's link",
        userId: row.userId,
        ipAddress: request.ipAddress ?? null,
        userAgent: request.userAgent ?? null,
        metadata: { changeId: row.id, clinicId: tx.clinicId },
      });
      return row;
    },
  );
  if (!confirmed) {
    const state = await lookUpAddressLink(token);
    return { ok: false, reason: state.ok ? "used" : state.reason };
  }
  const sent = await sendChangingNotices(found.clinicId, confirmed, ["old"], options);
  return { ok: true, effectiveAt: confirmed.effectiveAt!, emailed: sent === 1 };
}

async function findByToken(token: unknown): Promise<{ id: string; clinicId: string } | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const result = await unsafeDb.execute<{ id: string; clinic_id: string }>(
    sql`select id, clinic_id from app_address_change_by_token(${hashToken(token)})`,
  );
  const row = result.rows[0];
  return row ? { id: row.id, clinicId: row.clinic_id } : null;
}

// -----------------------------------------------------------------------------
// Stopping one
// -----------------------------------------------------------------------------

export type AddressStopOutcome = { status: "stopped"; changeId: string } | { status: "none" };

/**
 * Stop the clinic's open change: by the clinic, signed in (no step-up: a
 * stop keeps things as they are, and whoever holds the old address must be
 * able to do it from any device), or by the operator on an objection.
 */
export async function stopAddressChange(input: {
  clinicId: string;
  stoppedBy: AddressChangeStopper;
  /** The device, the sign-in or the operator's address. */
  label: string;
  actor: ActorContext;
  request?: RequestContext;
  /** Only this change, when the caller names one. */
  changeId?: string;
}): Promise<AddressStopOutcome> {
  const label = input.label.trim().slice(0, 200) || input.stoppedBy;
  return withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const [row] = await tx.db
        .update(signInAddressChanges)
        .set({
          status: "stopped",
          stoppedBy: input.stoppedBy,
          resolution: label,
          resolvedAt: sql`now()`,
        })
        .where(
          and(
            eq(signInAddressChanges.clinicId, tx.clinicId),
            sql`${signInAddressChanges.status} in ('awaiting_confirmation', 'pending')`,
            ...(input.changeId ? [eq(signInAddressChanges.id, input.changeId)] : []),
          ),
        )
        .returning({ id: signInAddressChanges.id, userId: signInAddressChanges.userId });
      if (!row) return { status: "none" } as const;
      tx.audit.record({
        action: "update",
        resourceType: "sign_in_address_change",
        resourceId: row.id,
        metadata: { status: "stopped", stoppedBy: input.stoppedBy },
      });
      await recordSecurityEvent(tx.db, {
        event: "sign_in_address_change_stopped",
        actorLabel: label,
        userId: row.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { changeId: row.id, clinicId: tx.clinicId, stoppedBy: input.stoppedBy },
      });
      return { status: "stopped", changeId: row.id } as const;
    },
  );
}

// -----------------------------------------------------------------------------
// Taking effect: the hourly job
// -----------------------------------------------------------------------------

export type AddressChangesRun = {
  applied: number;
  expired: number;
  failed: number;
  /** Due, and left for the next hour: Stripe did not take the email. */
  waiting: number;
};

/**
 * Apply every change whose 72 hours are up, and close every confirmation
 * link that ran out unused. Not a switched job, like the welcome email's
 * backstop: the clinic was told the moment, and a switch that ships off
 * would break that promise. Idempotent: each change is applied under a row
 * lock that re-checks its state.
 */
export async function runAddressChangesJob(): Promise<AddressChangesRun> {
  const due = await unsafeDb.execute<{ id: string; clinic_id: string; status: string }>(
    sql`select id, clinic_id, status from app_address_changes_due()`,
  );
  const run: AddressChangesRun = { applied: 0, expired: 0, failed: 0, waiting: 0 };
  for (const row of due.rows) {
    try {
      if (row.status === "awaiting_confirmation") {
        if (await expireChange(row.id, row.clinic_id)) run.expired += 1;
        continue;
      }
      const outcome = await applyChange(row.id, row.clinic_id);
      if (outcome === "applied") run.applied += 1;
      else if (outcome === "failed") run.failed += 1;
      else if (outcome === "waiting") run.waiting += 1;
    } catch (error) {
      run.waiting += 1;
      log.error("address change not applied", {
        clinicId: row.clinic_id,
        error: describeError(error),
      });
    }
  }
  return run;
}

async function expireChange(changeId: string, clinicId: string): Promise<boolean> {
  return withTenant({ clinicId, actor: JOB_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .update(signInAddressChanges)
      .set({ status: "expired", resolvedAt: sql`now()` })
      .where(
        and(
          eq(signInAddressChanges.id, changeId),
          eq(signInAddressChanges.status, "awaiting_confirmation"),
          sql`${signInAddressChanges.confirmExpiresAt} <= now()`,
        ),
      )
      .returning({ id: signInAddressChanges.id, userId: signInAddressChanges.userId });
    if (!row) return false;
    await recordSecurityEvent(tx.db, {
      event: "sign_in_address_change_expired",
      actorLabel: "address-changes",
      userId: row.userId,
      metadata: { changeId: row.id, clinicId: tx.clinicId },
    });
    return true;
  });
}

type ApplyOutcome = "applied" | "failed" | "waiting" | "skipped";

async function applyChange(changeId: string, clinicId: string): Promise<ApplyOutcome> {
  const change = await withTenant({ clinicId, actor: JOB_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({ ...VIEW, userId: signInAddressChanges.userId })
      .from(signInAddressChanges)
      .where(
        and(
          eq(signInAddressChanges.id, changeId),
          eq(signInAddressChanges.status, "pending"),
          sql`${signInAddressChanges.effectiveAt} <= now()`,
        ),
      )
      .limit(1);
    // A pending change always names its sign-in: user_id is null only once
    // the account has closed (drizzle/0092), and the closure ends every open
    // change before it deletes the sign-in.
    if (!row?.userId) return null;
    return { ...row, userId: row.userId };
  });
  if (!change) return "skipped";

  // Taken since it was asked for: another sign-in now has the address.
  const [taken] = await unsafeDb
    .select({ id: user.id })
    .from(user)
    .where(and(sql`lower(${user.email}) = ${change.newEmail}`, ne(user.id, change.userId)))
    .limit(1);
  if (taken) return failChange(change, clinicId, "address_taken");

  // The Stripe customer first. A failure here moves nothing, and the next
  // hour tries again; ops hear of it once an hour while it lasts.
  const customers = await stripeCustomersOf(change.userId, clinicId);
  if (customers.length > 0) {
    if (!stripeConfigured()) {
      log.error("address change waiting: Stripe is not configured", { clinicId });
      await notifyOps("address_change_stalled", { clinicId, code: "stripe_unconfigured" });
      return "waiting";
    }
    try {
      for (const customerId of customers) {
        await updateStripeCustomerEmail(
          customerId,
          change.newEmail,
          `hd-address-change-${change.id}-${customerId}`,
        );
      }
    } catch (error) {
      log.error("address change waiting: Stripe refused the email", {
        clinicId,
        error: describeError(error),
      });
      await notifyOps("address_change_stalled", { clinicId, code: "stripe" });
      return "waiting";
    }
  }

  let outcome: ApplyOutcome | "failed_sign_in_changed";
  try {
    outcome = await withTenant({ clinicId, actor: JOB_ACTOR }, async (tx) => {
      const [locked] = await tx.db
        .select({ status: signInAddressChanges.status })
        .from(signInAddressChanges)
        .where(eq(signInAddressChanges.id, change.id))
        .for("update")
        .limit(1);
      if (locked?.status !== "pending") return "skipped" as const;

      const moved = await tx.db
        .update(user)
        .set({ email: change.newEmail, updatedAt: new Date() })
        .where(and(eq(user.id, change.userId), sql`lower(${user.email}) = ${change.oldEmail}`))
        .returning({ id: user.id });
      if (moved.length === 0) {
        return (await resolveFailed(tx, change, "sign_in_changed"))
          ? ("failed_sign_in_changed" as const)
          : ("skipped" as const);
      }

      await tx.db
        .update(signInAddressChanges)
        .set({ status: "applied", resolvedAt: sql`now()` })
        .where(eq(signInAddressChanges.id, change.id));

      // A link already mailed to the old address must not sign anyone in
      // once the address has moved. Spending is the one write the runtime
      // role has on these rows.
      await tx.db
        .update(signInLinks)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(signInLinks.userId, change.userId),
            isNull(signInLinks.usedAt),
            sql`${signInLinks.expiresAt} > now()`,
          ),
        );

      await tx.db.insert(clinicSettingsHistory).values({
        clinicId: tx.clinicId,
        field: "sign_in_email",
        beforeValue: maskEmail(change.oldEmail).slice(0, 64),
        afterValue: maskEmail(change.newEmail).slice(0, 64),
        actorLabel: change.requestedBy.slice(0, 200),
      });
      tx.audit.record({
        action: "update",
        resourceType: "sign_in_address_change",
        resourceId: change.id,
        metadata: { status: "applied", source: change.source, stripeCustomers: customers.length },
      });

      await recordSecurityEvent(tx.db, {
        event: "sign_in_address_changed",
        actorLabel: change.requestedBy,
        userId: change.userId,
        metadata: {
          changeId: change.id,
          clinicId: tx.clinicId,
          source: change.source,
          stripeCustomers: customers.length,
        },
      });
      // The notice address: the practice gave a new one in writing, which
      // every agreement's Notices clause provides for.
      const agreement = await agreementInEffect(tx);
      if (agreement) {
        await recordSecurityEvent(tx.db, {
          event: "agreement_notice_address_changed",
          actorLabel: change.requestedBy,
          userId: change.userId,
          metadata: {
            agreementId: agreement.agreementId,
            changeId: change.id,
            clinicId: tx.clinicId,
          },
        });
      }
      return "applied" as const;
    });
  } catch (error) {
    // The unique index on user.email: another sign-in took the address
    // between the check above and the write.
    if (isUniqueViolation(error)) return failChange(change, clinicId, "address_taken");
    throw error;
  }
  // Told after the transaction, so no email waits on an open one.
  if (outcome === "failed_sign_in_changed") {
    await notifyOps("address_change_failed", { clinicId, code: "sign_in_changed" });
    return "failed";
  }
  return outcome;
}

/** Every Stripe customer the sign-in's clinics are billed on, once each. */
async function stripeCustomersOf(userId: string, clinicId: string): Promise<string[]> {
  const grants = await portalGrants(userId);
  const clinicIds = new Set([clinicId, ...grants.map((g) => g.clinicId)]);
  const customers = new Set<string>();
  for (const id of clinicIds) {
    const customer = await stripeCustomerOf(id, JOB_ACTOR);
    if (customer) customers.add(customer);
  }
  return [...customers];
}

async function failChange(
  change: AddressChangeView & { userId: string },
  clinicId: string,
  code: "address_taken" | "sign_in_changed",
): Promise<ApplyOutcome> {
  const failed = await withTenant({ clinicId, actor: JOB_ACTOR }, (tx) =>
    resolveFailed(tx, change, code),
  );
  if (!failed) return "skipped";
  await notifyOps("address_change_failed", { clinicId, code });
  return "failed";
}

async function resolveFailed(
  tx: TenantTx,
  change: AddressChangeView & { userId: string },
  code: "address_taken" | "sign_in_changed",
): Promise<boolean> {
  const [row] = await tx.db
    .update(signInAddressChanges)
    .set({ status: "failed", resolution: code, resolvedAt: sql`now()` })
    .where(and(eq(signInAddressChanges.id, change.id), eq(signInAddressChanges.status, "pending")))
    .returning({ id: signInAddressChanges.id });
  if (!row) return false;
  await recordSecurityEvent(tx.db, {
    event: "sign_in_address_change_failed",
    actorLabel: "address-changes",
    userId: change.userId,
    metadata: { changeId: change.id, clinicId: tx.clinicId, code },
  });
  return true;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// -----------------------------------------------------------------------------
// The emails
// -----------------------------------------------------------------------------

type ClinicFacts = { name: string; slug: string; specialty: string; timezone: string };

async function clinicFacts(clinicId: string): Promise<ClinicFacts | null> {
  return withTenant({ clinicId, actor: JOB_ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({
        name: clinics.name,
        slug: clinics.slug,
        specialty: clinics.specialty,
        timezone: clinics.timezone,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return row ?? null;
  });
}

/** O5's confirmation link, to the new address. Never throws; says whether it went. */
async function sendConfirmLink(
  clinicId: string,
  change: AddressChangeView,
  token: string,
  options: SendEmailOptions,
): Promise<boolean> {
  const clinic = await clinicFacts(clinicId);
  if (!clinic) return false;
  const payload: AddressChangeConfirmPayload = {
    confirmUrl: publicUrl(`/address-change/${token}`),
    oldAddressMasked: maskEmail(change.oldEmail),
    validHours: Math.round(ADDRESS_CONFIRM_LINK_TTL_MS / HOURS),
    waitHours: Math.round(ADDRESS_CHANGE_WAIT_MS / HOURS),
  };
  return sendOnLedger(
    {
      clinicId,
      changeId: change.id,
      kind: "address_change_confirm",
      to: change.newEmail,
      recipientNumber: 1,
      render: () => {
        assertPayloadAllowed(payload, "address_change_confirm");
        return renderAddressChangeConfirm(payload, {
          clinicName: clinic.name,
          audience: audienceFor(clinic.specialty),
          reason: addressConfirmReason(clinic.name),
          raisedAt: options.now ?? new Date(),
          timeZone: clinic.timezone,
        });
      },
    },
    options,
  );
}

/** O5's notice, to the old address, the new one, or both. Returns how many went. */
async function sendChangingNotices(
  clinicId: string,
  change: AddressChangeView,
  to: readonly ("old" | "new")[],
  options: SendEmailOptions,
): Promise<number> {
  if (!change.effectiveAt) return 0;
  const clinic = await clinicFacts(clinicId);
  if (!clinic) return 0;
  let sent = 0;
  for (const which of to) {
    const payload: AddressChangingPayload = {
      oldAddressMasked: maskEmail(change.oldEmail),
      newAddressMasked: maskEmail(change.newEmail),
      effectiveAt: change.effectiveAt.toISOString(),
      settingsUrl: publicUrl(`/c/${clinic.slug}/settings#sign-in`),
      isFromOperator: change.source === "operator",
      isToNewAddress: which === "new",
    };
    const ok = await sendOnLedger(
      {
        clinicId,
        changeId: change.id,
        kind: "address_changing",
        to: which === "old" ? change.oldEmail : change.newEmail,
        recipientNumber: which === "old" ? 1 : 2,
        render: () => {
          assertPayloadAllowed(payload, "address_changing");
          return renderAddressChanging(payload, {
            clinicName: clinic.name,
            audience: audienceFor(clinic.specialty),
            reason: which === "old" ? clinicReason(clinic.name) : addressMovingReason(clinic.name),
            raisedAt: options.now ?? new Date(),
            timeZone: clinic.timezone,
          });
        },
      },
      options,
    );
    if (ok) sent += 1;
  }
  return sent;
}

/**
 * One email of a change, recorded on the ledger (report_deliveries) under
 * the change's own period key and the recipient, so a retry of the same
 * change and recipient is one row. Never throws.
 */
async function sendOnLedger(
  input: {
    clinicId: string;
    changeId: string;
    kind: "address_change_confirm" | "address_changing";
    to: string;
    recipientNumber: number;
    render: () => { subject: string; text: string; html: string };
  },
  options: SendEmailOptions,
): Promise<boolean> {
  let deliveryId: string | null = null;
  try {
    deliveryId = await withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, (tx) =>
      claimDelivery(tx, {
        kind: input.kind,
        periodKey: `change:${input.changeId}`,
        recipient: input.to,
      }),
    );
    if (!deliveryId) return true; // Already sent for this change and recipient.
    const rendered = input.render();
    const result = await sendEmail(
      {
        to: input.to,
        kind: input.kind,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        clinicId: input.clinicId,
        deliveryId,
        idempotencyKey: `hd-${input.kind}-${deliveryId}-${input.recipientNumber}`,
      },
      options,
    );
    const id = deliveryId;
    await withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, (tx) =>
      recordDelivery(
        tx,
        id,
        result.status === "sent"
          ? { status: "sent", messageId: result.messageId }
          : { status: result.status, reason: result.reason },
      ),
    );
    return result.status === "sent";
  } catch (error) {
    log.error("address change email not sent", {
      clinicId: input.clinicId,
      kind: input.kind,
      deliveryId,
      error: describeError(error),
    });
    if (deliveryId) {
      const id = deliveryId;
      await withTenant({ clinicId: input.clinicId, actor: JOB_ACTOR }, (tx) =>
        recordDelivery(tx, id, { status: "failed", reason: describeError(error) }),
      ).catch(() => undefined);
    }
    return false;
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

import { and, count, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { clinics, userBackupCodes, userFactors } from "@/db/schema";
import { withTenant } from "@/lib/tenant";

import { liveDeviceRecovery } from "./recovery";
import { findLiveStepUp, type LiveStepUp } from "./step-ups";

/**
 * Who may change a sign-in's second factors (plan Part D3). One sign-in is
 * shared by a clinic's staff, so "who" is "which session, holding what":
 *
 * - **The first passkey** may be added from any signed-in session while none
 *   of the sign-in's clinics can hold patient data yet: before go-live there
 *   is nothing behind the factor to protect, and the paying browser has to
 *   be able to add Face ID with nothing but its sign-in link.
 * - **Every later passkey**, and the first one after go-live, needs proof
 *   from a factor the sign-in already has: a passkey step-up on this session
 *   (another device's passkey, over the cross-device QR flow if need be), or
 *   a code from the authenticator app or the backup list.
 * - **With none of those at hand**, the human route (recovery.ts): after a
 *   call back to the practice's published number and the operator's own
 *   code, a link to the clinic's address lets the session it starts add one
 *   passkey, within its window.
 * - **The browser that paid**, for its seven days (Part D3's "7-day
 *   same-browser cookie window for first enrolment"; lib/sign-in/
 *   paying-browser.ts), may add the sign-in's first passkey ever, even once
 *   a clinic has gone live: the Protect screen after /welcome is skippable,
 *   and chat can be answering patients the same session, so without it the
 *   buyer who skipped would be locked out of patient pages from the very
 *   browser that paid. "First ever" counts revoked passkeys too, so removing
 *   every device never reopens it.
 * - **The authenticator backup** is enrolled under a step-up, or, like the
 *   first passkey, while the sign-in has no factor at all and nothing is live.
 *
 * A sign-in link alone never adds a device once patient data can exist, and
 * patient pages open only after a passkey step-up, so a link alone never
 * opens a transcript.
 */

export type ActiveFactors = { passkeys: number; totp: number; backupCodes: number };

/** The sign-in's unrevoked factors, by kind, and its unspent backup codes. */
export async function activeFactors(
  userId: string,
  db: Queryable = unsafeDb,
): Promise<ActiveFactors> {
  const rows = await db
    .select({ kind: userFactors.kind, n: count() })
    .from(userFactors)
    .where(and(eq(userFactors.userId, userId), isNull(userFactors.revokedAt)))
    .groupBy(userFactors.kind);
  const [codes] = await db
    .select({ n: count() })
    .from(userBackupCodes)
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        isNull(userBackupCodes.usedAt),
        isNull(userBackupCodes.revokedAt),
      ),
    );
  const of = (kind: string) => Number(rows.find((r) => r.kind === kind)?.n ?? 0);
  return { passkeys: of("passkey"), totp: of("totp"), backupCodes: Number(codes?.n ?? 0) };
}

/**
 * Whether any clinic this sign-in can open may hold patient data: one in
 * production (its agreement bound, so the BAA gate lets real records in) or
 * one that has gone live. A clinic the tenant read cannot see counts as live,
 * so a surprise fails closed.
 */
export async function anyClinicMayHoldPatientData(userId: string): Promise<boolean> {
  const grants = await unsafeDb.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_user_clinic_grants(${userId})`,
  );
  for (const { clinic_id: clinicId } of grants.rows) {
    const live = await withTenant(
      { clinicId, actor: { type: "service", serviceName: "portal-factors" } },
      async (tx) => {
        const [row] = await tx.db
          .select({ classification: clinics.dataClassification, wentLiveAt: clinics.wentLiveAt })
          .from(clinics)
          .where(eq(clinics.id, clinicId))
          .limit(1);
        return !row || row.classification === "production" || row.wentLiveAt !== null;
      },
    );
    if (live) return true;
  }
  return false;
}

export type PasskeyEnrolDecision =
  | { allowed: true; basis: "first_passkey" }
  | { allowed: true; basis: "step_up"; stepUp: LiveStepUp }
  | { allowed: true; basis: "recovery"; recoveryId: string; expiresAt: Date }
  | { allowed: true; basis: "paying_browser" }
  | {
      allowed: false;
      /** A code from the authenticator app or the backup list could unlock it. */
      codeRoute: boolean;
      /** The sign-in has a passkey another device could step this session up with. */
      hasPasskey: boolean;
    };

/** Whether the sign-in has never had a passkey, removed ones included. */
export async function neverHadPasskey(userId: string, db: Queryable = unsafeDb): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(userFactors)
    .where(and(eq(userFactors.userId, userId), eq(userFactors.kind, "passkey")));
  return Number(row?.n ?? 0) === 0;
}

/**
 * May this session add a passkey without a code? In order: the first
 * passkey before go-live, a live step-up, this session's claim on the human
 * route's link, and the paying browser's first enrolment. A refusal says
 * which proof could still unlock it.
 *
 * `payingBrowser` is lib/sign-in/paying-browser.ts's answer for this
 * request's cookie: the caller reads the cookie, and the window it carries
 * is checked there.
 */
export async function passkeyEnrolDecision(
  userId: string,
  sessionTokenHash: Buffer,
  db: Queryable = unsafeDb,
  options: { payingBrowser?: boolean } = {},
): Promise<PasskeyEnrolDecision> {
  const factors = await activeFactors(userId, db);
  if (factors.passkeys === 0 && !(await anyClinicMayHoldPatientData(userId))) {
    return { allowed: true, basis: "first_passkey" };
  }
  const session = { sessionTokenHash, userId };
  const stepUp = await findLiveStepUp(db, session, { touch: false });
  if (stepUp) return { allowed: true, basis: "step_up", stepUp };
  const recovery = await liveDeviceRecovery(db, session);
  if (recovery) {
    return { allowed: true, basis: "recovery", recoveryId: recovery.id, expiresAt: recovery.expiresAt };
  }
  if (options.payingBrowser === true && (await neverHadPasskey(userId, db))) {
    return { allowed: true, basis: "paying_browser" };
  }
  return {
    allowed: false,
    codeRoute: factors.totp > 0 || factors.backupCodes > 0,
    hasPasskey: factors.passkeys > 0,
  };
}

/** May this session enrol the authenticator backup, or replace the backup codes? */
export async function backupEnrolAllowed(
  userId: string,
  sessionTokenHash: Buffer,
): Promise<boolean> {
  if (await findLiveStepUp(unsafeDb, { sessionTokenHash, userId }, { touch: false })) return true;
  const factors = await activeFactors(userId);
  return (
    factors.passkeys === 0 &&
    factors.totp === 0 &&
    factors.backupCodes === 0 &&
    !(await anyClinicMayHoldPatientData(userId))
  );
}

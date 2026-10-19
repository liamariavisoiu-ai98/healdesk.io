import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { session } from "@/db/auth-schema";
import { userBackupCodes, userFactors } from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { notifyDeviceChange } from "@/lib/notices/device-changes";

import type { SessionBinding } from "./passkeys";
import { lockFactors, revokeOpenDeviceRecoveries } from "./recovery";
import { endStepUps, findLiveStepUp } from "./step-ups";
import { actorLabelFor, type RequestMeta } from "./totp";

/**
 * "Someone left" (plan Part D3; spec, "Who gets access"): when a person who
 * knew the clinic's one sign-in leaves, one action, behind a passkey step-up
 * on this session:
 *
 *   - every session of the sign-in ends, this one included, so whoever left
 *     is signed out wherever they were, and every step-up goes with them;
 *   - the devices picked are removed (their passkeys revoked), so a phone that
 *     left with its owner can no longer open patient details;
 *   - the authenticator-app backup and every unspent backup code are revoked,
 *     because the person may have them.
 *
 * In one transaction, so a failure part-way leaves everything as it was. The
 * devices not picked keep their passkeys: staff sign in again by link and
 * step up with them as before. The clinic's address is then emailed (O3): one
 * email naming what was done, so a "Someone left" nobody at the clinic made
 * is noticed.
 *
 * With every device removed and the backup reset, adding a device again after
 * go-live needs the human route (a call to us, then a link to the clinic's
 * address; recovery.ts), because a link alone never adds one once patient
 * data can exist (authority.ts). The page says so before the button is
 * pressed. Any link of that route still open is ended here too: whoever left
 * may read the inbox it went to.
 *
 * The operator does the same from /admin (`operatorSignOut`, the ops
 * operation removeClinicDevices) when the clinic replies to an O3 it does
 * not recognise and the operator has called it back: O3's promise, "we'll
 * remove the device and sign everyone out". No step-up there, because the
 * clinic may hold no device at all; the operator's own fresh code, checked
 * on apps/web, and the call back are the authority, and the event and the
 * email say it was healdesk.
 */

export type SomeoneLeftResult =
  | { ok: true; removedDevices: number; sessionsEnded: number }
  | { ok: false; reason: "needs_step_up" | "not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids to remove, checked for shape, or null when one cannot be a device. */
function deviceIds(removeFactorIds: readonly string[]): string[] | null {
  const ids = [...new Set(removeFactorIds)];
  return ids.some((id) => !UUID.test(id)) || ids.length > 50 ? null : ids;
}

type Cleared = {
  removedIds: string[];
  backupReset: boolean;
  codesRevoked: number;
  sessionsEnded: number;
  recoveriesRevoked: string[];
};

/**
 * What both share, inside the caller's transaction: the devices named (each
 * must be one of the sign-in's active passkeys, or the whole action stops),
 * the authenticator secret and every unspent backup code, every session and
 * so every step-up, and any open link of the human route.
 */
async function clearSignIn(
  tx: Queryable,
  userId: string,
  ids: readonly string[],
  recoveryReason: "someone_left" | "operator_signed_out",
): Promise<Cleared> {
  let removedIds: string[] = [];
  if (ids.length > 0) {
    const removed = await tx
      .update(userFactors)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          inArray(userFactors.id, [...ids]),
          eq(userFactors.userId, userId),
          eq(userFactors.kind, "passkey"),
          isNull(userFactors.revokedAt),
        ),
      )
      .returning({ id: userFactors.id });
    // Every id must be one of this sign-in's active passkeys; a stale page
    // or another sign-in's id stops the whole action.
    if (removed.length !== ids.length) throw new NotFound();
    removedIds = removed.map((r) => r.id);
  }

  const totp = await tx
    .update(userFactors)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userFactors.userId, userId),
        eq(userFactors.kind, "totp"),
        isNull(userFactors.revokedAt),
      ),
    )
    .returning({ id: userFactors.id });
  const codes = await tx
    .update(userBackupCodes)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        isNull(userBackupCodes.usedAt),
        isNull(userBackupCodes.revokedAt),
      ),
    )
    .returning({ id: userBackupCodes.id });

  // Every session of the sign-in. Better Auth reads the session table on
  // every request (no cookie cache), so each browser is signed out on its
  // next request. The sign-out hook in lib/auth.ts does not see a direct
  // delete, so the step-ups are ended here.
  const ended = await tx
    .delete(session)
    .where(eq(session.userId, userId))
    .returning({ id: session.id });
  await endStepUps({ userId }, tx);
  const recoveriesRevoked = await revokeOpenDeviceRecoveries(tx, userId, recoveryReason);

  return {
    removedIds,
    backupReset: totp.length > 0,
    codesRevoked: codes.length,
    sessionsEnded: ended.length,
    recoveriesRevoked,
  };
}

export async function someoneLeft(input: {
  session: SessionBinding;
  /** The passkeys to remove: ids of this sign-in's active passkeys. */
  removeFactorIds: readonly string[];
  request?: RequestMeta;
}): Promise<SomeoneLeftResult> {
  const { userId, sessionTokenHash } = input.session;
  const ids = deviceIds(input.removeFactorIds);
  if (!ids) return { ok: false, reason: "not_found" };

  const result = await unsafeDb
    .transaction(async (tx): Promise<SomeoneLeftResult & { removedIds?: string[] }> => {
      await lockFactors(tx, userId);
      const stepUp = await findLiveStepUp(tx, { sessionTokenHash, userId }, { touch: true });
      if (!stepUp) return { ok: false, reason: "needs_step_up" };

      const cleared = await clearSignIn(tx, userId, ids, "someone_left");
      await recordSecurityEvent(tx, {
        event: "someone_left",
        actorLabel: await actorLabelFor(tx, userId),
        userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: {
          viaFactorId: stepUp.factorId,
          devicesRemoved: cleared.removedIds.length,
          backupReset: cleared.backupReset,
          codesRevoked: cleared.codesRevoked,
          sessionsEnded: cleared.sessionsEnded,
          ...(cleared.recoveriesRevoked.length > 0
            ? { recoveriesRevoked: cleared.recoveriesRevoked.length }
            : {}),
        },
      });
      return {
        ok: true,
        removedDevices: cleared.removedIds.length,
        sessionsEnded: cleared.sessionsEnded,
        removedIds: cleared.removedIds,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof NotFound) return { ok: false as const, reason: "not_found" as const };
      throw error;
    });

  if (!result.ok) return result;
  await notifyDeviceChange({
    userId,
    kind: "signed_out",
    removedCount: result.removedDevices,
  });
  return { ok: true, removedDevices: result.removedDevices, sessionsEnded: result.sessionsEnded };
}

export type OperatorSignOutResult =
  | {
      ok: true;
      removedDevices: number;
      sessionsEnded: number;
      backupReset: boolean;
      codesRevoked: number;
    }
  | { ok: false; reason: "not_found" };

/**
 * O3's promise kept by the operator (the ops operation removeClinicDevices):
 * the devices named removed, every session ended, the backup and backup
 * codes reset, and any open link of the human route ended, in one
 * transaction, as "Someone left" does; then O3 tells the address healdesk
 * did it. The caller has the operator's fresh code and the call back, both
 * checked on apps/web before the signed request was sent.
 */
export async function operatorSignOut(input: {
  userId: string;
  removeFactorIds: readonly string[];
  /** The operator's address, frozen into the event. */
  operatorLabel: string;
  /** The clinic whose number was called, for the event. */
  clinicId: string;
  request?: RequestMeta;
}): Promise<OperatorSignOutResult> {
  const ids = deviceIds(input.removeFactorIds);
  if (!ids) return { ok: false, reason: "not_found" };

  const result = await unsafeDb
    .transaction(async (tx): Promise<OperatorSignOutResult> => {
      await lockFactors(tx, input.userId);
      const cleared = await clearSignIn(tx, input.userId, ids, "operator_signed_out");
      await recordSecurityEvent(tx, {
        event: "operator_signed_out",
        actorLabel: input.operatorLabel,
        userId: input.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: {
          clinicId: input.clinicId,
          calledBack: true,
          factorIds: cleared.removedIds,
          devicesRemoved: cleared.removedIds.length,
          backupReset: cleared.backupReset,
          codesRevoked: cleared.codesRevoked,
          sessionsEnded: cleared.sessionsEnded,
          recoveriesRevoked: cleared.recoveriesRevoked.length,
        },
      });
      return {
        ok: true,
        removedDevices: cleared.removedIds.length,
        sessionsEnded: cleared.sessionsEnded,
        backupReset: cleared.backupReset,
        codesRevoked: cleared.codesRevoked,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof NotFound) return { ok: false as const, reason: "not_found" as const };
      throw error;
    });

  if (!result.ok) return result;
  await notifyDeviceChange({
    userId: input.userId,
    kind: "signed_out",
    removedCount: result.removedDevices,
    source: "operator",
  });
  return result;
}

class NotFound extends Error {
  constructor() {
    super("A device to remove is not one of this sign-in's.");
    this.name = "NotFound";
  }
}

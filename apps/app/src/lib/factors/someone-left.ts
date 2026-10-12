import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { session } from "@/db/auth-schema";
import { userBackupCodes, userFactors } from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { notifyDeviceChange } from "@/lib/notices/device-changes";

import type { SessionBinding } from "./passkeys";
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
 * go-live needs the human route (a call to our published number), because a
 * link alone never adds one once patient data can exist (authority.ts). The
 * page says so before the button is pressed.
 */

export type SomeoneLeftResult =
  | { ok: true; removedDevices: number; sessionsEnded: number }
  | { ok: false; reason: "needs_step_up" | "not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function someoneLeft(input: {
  session: SessionBinding;
  /** The passkeys to remove: ids of this sign-in's active passkeys. */
  removeFactorIds: readonly string[];
  request?: RequestMeta;
}): Promise<SomeoneLeftResult> {
  const { userId, sessionTokenHash } = input.session;
  const ids = [...new Set(input.removeFactorIds)];
  if (ids.some((id) => !UUID.test(id)) || ids.length > 50) {
    return { ok: false, reason: "not_found" };
  }

  const result = await unsafeDb
    .transaction(async (tx): Promise<SomeoneLeftResult & { removedIds?: string[] }> => {
      const stepUp = await findLiveStepUp(tx, { sessionTokenHash, userId }, { touch: true });
      if (!stepUp) return { ok: false, reason: "needs_step_up" };

      let removedIds: string[] = [];
      if (ids.length > 0) {
        const removed = await tx
          .update(userFactors)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              inArray(userFactors.id, ids),
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

      // Every session of the sign-in, this one too. Better Auth reads the
      // session table on every request (no cookie cache), so each browser is
      // signed out on its next request. The sign-out hook in lib/auth.ts does
      // not see a direct delete, so the step-ups are ended here.
      const ended = await tx
        .delete(session)
        .where(eq(session.userId, userId))
        .returning({ id: session.id });
      await endStepUps({ userId }, tx);

      await recordSecurityEvent(tx, {
        event: "someone_left",
        actorLabel: await actorLabelFor(tx, userId),
        userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: {
          viaFactorId: stepUp.factorId,
          devicesRemoved: removedIds.length,
          backupReset: totp.length > 0,
          codesRevoked: codes.length,
          sessionsEnded: ended.length,
        },
      });
      return {
        ok: true,
        removedDevices: removedIds.length,
        sessionsEnded: ended.length,
        removedIds,
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

class NotFound extends Error {
  constructor() {
    super("A device to remove is not one of this sign-in's.");
    this.name = "NotFound";
  }
}

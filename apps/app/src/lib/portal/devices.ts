import { and, asc, count, eq, isNull } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { userBackupCodes, userFactors } from "@/db/schema";
import type { SessionBinding } from "@/lib/factors/passkeys";
import { findLiveStepUp } from "@/lib/factors/step-ups";

/**
 * Settings → Sign-in's devices (plan Part D3 and F2): each phone or computer
 * that can open patient details, by the name staff gave it, with when it was
 * added and last used, and which one this browser stepped up with; and
 * whether the authenticator-app backup is set, with how many backup codes are
 * left.
 *
 * Identity plane: factors belong to the clinic's one sign-in, not to a clinic,
 * and carry no patient data. Reading them never counts as activity on a
 * step-up.
 */
export type DeviceRow = {
  id: string;
  label: string;
  addedAt: Date;
  lastUsedAt: Date | null;
  /** The passkey this browser's live step-up was made with. */
  isThisSession: boolean;
};

export type SignInFactors = {
  devices: DeviceRow[];
  hasBackup: boolean;
  backupCodesLeft: number;
  /** A passkey step-up is live on this session now. */
  steppedUp: boolean;
};

export async function readSignInFactors(
  userId: string,
  session: SessionBinding | null,
): Promise<SignInFactors> {
  const rows = await unsafeDb
    .select({
      id: userFactors.id,
      kind: userFactors.kind,
      label: userFactors.deviceLabel,
      addedAt: userFactors.createdAt,
      lastUsedAt: userFactors.lastUsedAt,
    })
    .from(userFactors)
    .where(and(eq(userFactors.userId, userId), isNull(userFactors.revokedAt)))
    .orderBy(asc(userFactors.createdAt));
  const [codes] = await unsafeDb
    .select({ n: count() })
    .from(userBackupCodes)
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        isNull(userBackupCodes.usedAt),
        isNull(userBackupCodes.revokedAt),
      ),
    );
  const live = session ? await findLiveStepUp(unsafeDb, session, { touch: false }) : null;
  return {
    devices: rows
      .filter((r) => r.kind === "passkey")
      .map((r) => ({
        id: r.id,
        label: r.label ?? "A device",
        addedAt: r.addedAt,
        lastUsedAt: r.lastUsedAt,
        isThisSession: live?.factorId === r.id,
      })),
    hasBackup: rows.some((r) => r.kind === "totp"),
    backupCodesLeft: Number(codes?.n ?? 0),
    steppedUp: live !== null,
  };
}

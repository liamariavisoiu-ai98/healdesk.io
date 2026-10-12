import { and, eq } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { clinics, userFactors } from "@/db/schema";
import { sendEmail, type SendEmailOptions } from "@/lib/email/send";
import { ACCOUNT_REASON } from "@/lib/email/templates/context";
import { renderDeviceChanged, type DeviceChange } from "@/lib/email/templates/device_changed";
import { describeError, log } from "@/lib/log";
import { portalGrants } from "@/lib/portal/access";
import { withTenant } from "@/lib/tenant";

/**
 * The device email: O3 in Annex X5 of the funnel and portal plan, "A device
 * was added or removed". It goes to the sign-in's address when a passkey is
 * added (except the first, in the browser that paid, where the person adding
 * it is the person reading the inbox), when one is removed, when code entry
 * locks after wrong codes, and when "Someone left" signs everyone out.
 *
 * Sent straight, not through the outbox: factors belong to the user, not to
 * a clinic, and one sign-in can open several locations. The factor's row (or,
 * for a lockout, the user and the lock's end) keys the email, so a retry
 * inside Resend's window sends once. The device's name is read from its row
 * here; it is chosen by staff, so it stays out of logs and security events.
 *
 * Called after commit, so a change that rolls back sends nothing. It never
 * throws: no factor change fails because of its email.
 */
export async function notifyDeviceChange(
  change: {
    userId: string;
    kind: DeviceChange;
    factorId?: string;
    first?: boolean;
    /** For a lockout: when code entry unlocks. */
    lockedUntil?: Date;
    /** For "Someone left": how many devices it removed. */
    removedCount?: number;
  },
  options: SendEmailOptions = {},
): Promise<void> {
  if (change.kind === "added" && change.first) return;
  try {
    const [account] = await unsafeDb
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, change.userId))
      .limit(1);
    if (!account) return;

    let deviceName: string | undefined;
    if (change.factorId) {
      const [factor] = await unsafeDb
        .select({ label: userFactors.deviceLabel })
        .from(userFactors)
        .where(and(eq(userFactors.id, change.factorId), eq(userFactors.userId, change.userId)))
        .limit(1);
      deviceName = factor?.label ?? undefined;
    }

    const now = options.now ?? new Date();
    const lockedMinutes =
      change.kind === "locked" && change.lockedUntil
        ? Math.max(1, Math.round((change.lockedUntil.getTime() - now.getTime()) / 60_000))
        : undefined;
    const rendered = renderDeviceChanged(
      {
        change: change.kind,
        ...(deviceName ? { deviceName } : {}),
        changedAt: now.toISOString(),
        ...(lockedMinutes ? { lockedMinutes } : {}),
        ...(change.kind === "signed_out" ? { removedCount: change.removedCount ?? 0 } : {}),
      },
      {
        clinicName: null,
        audience: "patients",
        reason: ACCOUNT_REASON,
        raisedAt: now,
        timeZone: await timeZoneOf(change.userId),
      },
    );

    // The factor names an addition or a removal; a lockout is the user and
    // the moment the lock ends, one per lock.
    const keyed =
      change.factorId ?? `${change.userId}-${change.lockedUntil?.getTime() ?? now.getTime()}`;
    const result = await sendEmail(
      {
        to: account.email,
        kind: "device_changed",
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        phiClass: "none",
        idempotencyKey: `hd-device_changed-${keyed}-${change.kind}`,
      },
      options,
    );
    if (result.status === "failed") {
      log.warn("device email not delivered", { kind: change.kind, reason: result.reason });
    }
  } catch (error) {
    log.error("device email not sent", { kind: change.kind, error: describeError(error) });
  }
}

/** The clinic's own time, for "on Tuesday, October 6 at 2:32 PM EDT": the first clinic the sign-in opens. */
async function timeZoneOf(userId: string): Promise<string> {
  const [grant] = await portalGrants(userId);
  if (!grant) return "America/New_York";
  return withTenant({ clinicId: grant.clinicId, actor: { type: "system" } }, async (tx) => {
    const [row] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return row?.timezone ?? "America/New_York";
  });
}

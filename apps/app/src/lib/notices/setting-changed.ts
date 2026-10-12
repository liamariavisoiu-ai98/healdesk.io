import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { isAllowedDeviceName } from "@/lib/email/lint";
import type { SettingChangedField } from "@/lib/email/templates/setting_changed";
import { describeError, log } from "@/lib/log";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import type { TenantTx } from "@/lib/tenant";

import { enqueuePlanNotice } from "./plan-notices";

/**
 * The label a change carries when no passkey was live on the session: the
 * portal's SIGN_IN_ACTOR_LABEL (lib/portal/actor.ts), restated here so this
 * module does not pull the portal's request helpers into every writer of a
 * setting. tests/settings-screen.test.ts holds the two to one value. It is
 * not a device, so the email does not name it as one.
 */
export const NOT_A_DEVICE_LABEL = "the clinic's sign-in";

/**
 * O4, "Setting changed" (Annex X5), queued in the transaction that writes
 * the change and its clinic_settings_history row, keyed on that row so a
 * change is one email however the request is retried.
 *
 * Only for a change after the value was first set (plan Part D4): setting a
 * direct line the first time is part of setup, and needs neither a step-up
 * nor an email. A shortened transcript retention carries its days instead of
 * numbers (the Records card, lib/portal/settings.ts).
 *
 * The numbers are masked to their last four digits before they are stored:
 * the payload sits in the outbox until it is sent, and the email only has to
 * let the clinic recognise the number. It never throws and never breaks the
 * caller's transaction: the insert runs in a savepoint, so the change itself
 * is kept even if the email cannot be queued (an unset public origin in
 * development, say), and that is logged.
 */
export async function notifySettingChanged(
  tx: TenantTx,
  change: {
    field: SettingChangedField;
    before: string | null;
    after: string | null;
    /** A number of days kept (transcript retention) rather than a number to call. */
    days?: { before: number; after: number };
    /** For transcript retention: whether the nightly purge runs for this clinic (nightlyPurgeRuns). */
    purgeRuns?: boolean;
    /** The clinic_settings_history row the change wrote. */
    historyId: string;
    actorLabel: string;
    at: Date;
  },
): Promise<void> {
  try {
    if (publicOriginProblem()) {
      log.error("setting-changed email not queued: no public origin", {
        clinicId: tx.clinicId,
        field: change.field,
      });
      return;
    }
    await tx.db.transaction(async (savepoint) => {
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return;
      const card =
        change.field === "transfer_e164"
          ? "alerts"
          : change.field === "transcript_retention_days"
            ? "records"
            : "safety-net";
      // The device's name, unless it is the sign-in rather than a device, or
      // a name the payload allowlist would refuse ("maria@frontdesk", a long
      // run of digits): the sender treats a refused payload as final, so the
      // email goes without the name rather than not at all.
      const device = change.actorLabel.trim().slice(0, 60);
      const deviceName =
        device !== NOT_A_DEVICE_LABEL && isAllowedDeviceName(device) ? device : null;
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "setting_changed",
        `setting_changed:${change.historyId}`,
        {
          field: change.field,
          beforeMasked: maskPhone(change.before),
          afterMasked: maskPhone(change.after),
          ...(change.days ? { beforeDays: change.days.before, afterDays: change.days.after } : {}),
          ...(change.purgeRuns !== undefined ? { willPurgeTonight: change.purgeRuns } : {}),
          changedAt: change.at.toISOString(),
          ...(deviceName ? { deviceName } : {}),
          settingsUrl: publicUrl(`/c/${clinic.slug}/settings#${card}`),
        },
      );
    });
  } catch (error) {
    try {
      log.error("setting-changed email not queued", {
        clinicId: tx.clinicId,
        field: change.field,
        error: describeError(error),
      });
    } catch {
      // Nothing reaches the caller; see above.
    }
  }
}

/**
 * A number shown by its last four digits only: "(•••) •••-0177" for a US
 * number, "•••• 0177" for any other. Null stays null (the default).
 */
export function maskPhone(e164: string | null): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  const last = digits.slice(-4);
  return /^\+1\d{10}$/.test(e164) ? `(•••) •••-${last}` : `•••• ${last}`;
}

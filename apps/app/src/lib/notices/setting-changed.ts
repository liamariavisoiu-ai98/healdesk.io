import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { isAllowedDeviceName } from "@/lib/email/lint";
import type { ExportField, SettingChangedField } from "@/lib/email/templates/setting_changed";
import type { RuledSwitch, SwitchUnlock } from "@/lib/portal/switch-rules";
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
 * O4 for an export from the portal (plan Part D4, Annex X5): queued in the
 * transaction that produced the export, keyed on that export's own id so one
 * download is one email however the request is retried. What was exported
 * (the whole clinic's records, or one person's), when, and from which device;
 * never whose. Like notifySettingChanged it never throws and never breaks the
 * export: the insert runs in a savepoint and a failure is logged.
 */
export async function notifyRecordsExported(
  tx: TenantTx,
  exported: {
    field: ExportField;
    /** The export's own id, which nothing else carries: the dedupe key. */
    exportId: string;
    actorLabel: string;
    at: Date;
  },
): Promise<void> {
  try {
    if (publicOriginProblem()) {
      log.error("export email not queued: no public origin", {
        clinicId: tx.clinicId,
        field: exported.field,
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
      const device = exported.actorLabel.trim().slice(0, 60);
      const deviceName =
        device !== NOT_A_DEVICE_LABEL && isAllowedDeviceName(device) ? device : null;
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "setting_changed",
        `setting_changed:export:${exported.exportId}`,
        {
          field: exported.field,
          beforeMasked: null,
          afterMasked: null,
          changedAt: exported.at.toISOString(),
          ...(deviceName ? { deviceName } : {}),
          settingsUrl: publicUrl(`/c/${clinic.slug}/settings#sign-in`),
        },
      );
    });
  } catch (error) {
    try {
      log.error("export email not queued", {
        clinicId: tx.clinicId,
        field: exported.field,
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

/**
 * O4 for payment switches set back on their own (lib/portal/switch-resets.ts):
 * one email naming every switch reset by one lost fact, queued in the
 * transaction that reset them, keyed on the first history row it wrote.
 * Switch ids and the unlock code only, closed words the template turns into
 * the Settings page's sentences. Like notifySettingChanged it never throws:
 * the insert runs in a savepoint and a failure is logged, so the reset itself
 * always stands.
 */
export async function notifySwitchesReset(
  tx: TenantTx,
  reset: {
    switchIds: RuledSwitch[];
    code: SwitchUnlock;
    /** The dedupe key's own part: the first clinic_settings_history row the reset wrote. */
    key: string;
    at: Date;
    /** A Stripe disconnect Stripe did not confirm: the account is still connected. */
    stripeKept?: boolean;
  },
): Promise<void> {
  try {
    if (publicOriginProblem()) {
      log.error("payment reset email not queued: no public origin", { clinicId: tx.clinicId });
      return;
    }
    await tx.db.transaction(async (savepoint) => {
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return;
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "setting_changed",
        `setting_changed:reset:${reset.key}`,
        {
          field: "payment_switches_reset",
          beforeMasked: null,
          afterMasked: null,
          switchIds: reset.switchIds,
          code: reset.code,
          ...(reset.stripeKept ? { isStripeStillConnected: true } : {}),
          changedAt: reset.at.toISOString(),
          settingsUrl: publicUrl(`/c/${clinic.slug}/settings#payments`),
        },
      );
    });
  } catch (error) {
    try {
      log.error("payment reset email not queued", {
        clinicId: tx.clinicId,
        error: describeError(error),
      });
    } catch {
      // Nothing reaches the caller; see above.
    }
  }
}

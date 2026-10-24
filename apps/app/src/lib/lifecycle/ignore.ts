import { eq, sql } from "drizzle-orm";

import {
  LIFECYCLE_IGNORE_NOTES,
  lifecycleIgnoredClinics,
  type LifecycleIgnoreNote,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * The lifecycle watch's ignore list (lane P5d; the owner's decision of 24
 * October 2026): healdesk's own test accounts, which look like paying clinics
 * to the watch and were chased like one. An ignored clinic raises no
 * setup-window wave, owes no decision on Home and is left out of the digest's
 * Lifecycle block; it stays on the Clinics table, and its calendar, voice
 * and billing alerts still arrive, since none of those reads this list.
 *
 * One row per clinic an operator has ever set, flipped by `ignored` and never
 * deleted (drizzle/0118 gives the runtime role no DELETE). The reason is a
 * closed word, never free text.
 */

export { LIFECYCLE_IGNORE_NOTES, type LifecycleIgnoreNote };

/** The reasons, as the console prints them. */
export const IGNORE_NOTE_WORDS: Record<LifecycleIgnoreNote, string> = {
  internal_test_account: "Internal test account",
  healdesk_staff_account: "healdesk staff account",
  sales_demo_account: "Sales demo account",
};

export type LifecycleIgnore = {
  ignored: boolean;
  note: LifecycleIgnoreNote | null;
  setBy: string;
  setAt: Date;
};

/** The tenant's clinic's row, or null when no operator has ever set one. */
export async function readLifecycleIgnore(tx: TenantTx): Promise<LifecycleIgnore | null> {
  const [row] = await tx.db
    .select({
      ignored: lifecycleIgnoredClinics.ignored,
      note: lifecycleIgnoredClinics.note,
      setBy: lifecycleIgnoredClinics.setBy,
      setAt: lifecycleIgnoredClinics.setAt,
    })
    .from(lifecycleIgnoredClinics)
    .where(eq(lifecycleIgnoredClinics.clinicId, tx.clinicId))
    .limit(1);
  return row ?? null;
}

/** Whether the watch and its consumers leave the tenant's clinic out. */
export async function isLifecycleIgnored(tx: TenantTx): Promise<boolean> {
  return (await readLifecycleIgnore(tx))?.ignored === true;
}

/**
 * Set or clear the mark for the tenant's clinic, in the caller's transaction,
 * with the audit row; the caller records the security event. Turning it off
 * keeps the row, with its reason cleared and who turned it off.
 */
export async function writeLifecycleIgnore(
  tx: TenantTx,
  input: { ignored: boolean; note: LifecycleIgnoreNote | null; setBy: string; now: Date },
): Promise<LifecycleIgnore> {
  const values = {
    ignored: input.ignored,
    note: input.ignored ? input.note : null,
    setBy: input.setBy.slice(0, 200),
    setAt: input.now,
  };
  await tx.db
    .insert(lifecycleIgnoredClinics)
    .values({ clinicId: tx.clinicId, ...values })
    .onConflictDoUpdate({
      target: lifecycleIgnoredClinics.clinicId,
      set: {
        ignored: sql`excluded.ignored`,
        note: sql`excluded.note`,
        setBy: sql`excluded.set_by`,
        setAt: sql`excluded.set_at`,
      },
    });
  tx.audit.record({
    action: "update",
    resourceType: "lifecycle_ignored_clinics",
    resourceId: tx.clinicId,
    // `reason`, not `note`: the audit guard refuses a key named like a clinical note.
    metadata: { ignored: values.ignored, reason: values.note },
  });
  return values;
}

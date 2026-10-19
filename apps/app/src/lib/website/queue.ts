import { cleanWebsite } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { siteRereads } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import type { SiteRereadReason } from "./types";

/**
 * Asking for a clinic's website to be read again (plan Part B, "Re-reads"):
 * one queued row per clinic, which the site-reads job claims and sends to
 * apps/web's signed route (lib/website/job.ts). Written inside the caller's
 * tenant transaction, so a save that rolls back asks for nothing, and the
 * read itself happens later, outside any transaction.
 *
 * Kept apart from the store, which writes Knowledge, so the Knowledge and
 * setup writers can ask for a read without importing it back.
 */

/**
 * Which reason a queued read keeps when it is asked for again: a corrected
 * website before a missing profile, either before an operator's ask, and
 * all of them before the monthly check, which a read for any of them does
 * anyway. The misclassification check is last of all: every other read
 * raises the signal too (lib/website/store.ts), so it gives way to any of
 * them.
 */
const RANK: Readonly<Record<SiteRereadReason, number>> = {
  insurance: -1,
  drift: 0,
  ops: 1,
  missing: 2,
  corrected: 3,
};

/**
 * Queue a read of `website` for the clinic, or move the one already queued
 * on to it. Returns the queued read's id. A website that does not clean is
 * refused, never queued.
 */
export async function requestSiteReread(
  tx: TenantTx,
  input: { reason: SiteRereadReason; website: string; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const website = cleanWebsite(input.website);
  if (!website) throw new Error("A website re-read needs the clinic's website.");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [queued] = await tx.db
      .select({ id: siteRereads.id, reason: siteRereads.reason, website: siteRereads.website })
      .from(siteRereads)
      .where(and(eq(siteRereads.clinicId, tx.clinicId), eq(siteRereads.status, "queued")))
      .limit(1);
    if (queued) {
      const wins = RANK[input.reason] >= RANK[queued.reason];
      const moved = queued.website !== website;
      if (wins || moved) {
        await tx.db
          .update(siteRereads)
          .set({
            ...(wins ? { reason: input.reason } : {}),
            website,
            // A different website starts afresh: the old one's failures say
            // nothing about it, and the clinic is waiting for it now.
            ...(moved ? { attempts: 0, failure: null } : {}),
            runAfter: now,
          })
          .where(and(eq(siteRereads.id, queued.id), eq(siteRereads.status, "queued")));
      }
      return queued.id;
    }
    // ON CONFLICT DO NOTHING against the one-queued-per-clinic index: a
    // second request racing this one is the row the loop then finds, never
    // a unique violation that would roll back the caller's save.
    const [inserted] = await tx.db
      .insert(siteRereads)
      .values({
        clinicId: tx.clinicId,
        reason: input.reason,
        website,
        requestedAt: now,
        runAfter: now,
      })
      .onConflictDoNothing()
      .returning({ id: siteRereads.id });
    if (inserted) {
      tx.audit.record({
        action: "create",
        resourceType: "site_reread",
        resourceId: inserted.id,
        metadata: { reason: input.reason },
      });
      return inserted.id;
    }
  }
  throw new Error("A website re-read could not be queued.");
}

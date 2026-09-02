import { and, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { invitation, member } from "@/db/auth-schema";
import { clinicMemberships, clinics } from "@/db/schema";

import { recordSecurityEvent } from "./audit";

/**
 * Turning an accepted invitation into actual access.
 *
 * This is the step that was missing. Provisioning created the organization, the
 * clinic and the invitation; the Better Auth create hook let the signup through
 * when a matching invitation existed. But nothing ever wrote the two rows that
 * make the account usable — the org `member` row and the per-clinic grant — so
 * a user completed signup successfully and landed on a console with no clinics,
 * because `resolveTenantContext` joins through `clinic_memberships`.
 *
 * Three rows are written together, in one transaction, because a half-granted
 * account is worse than a failed one: it looks fine and does nothing.
 *
 *   1. `invitation.status = 'accepted'` — so the link cannot be reused, and so
 *      the ops console stops showing it as outstanding.
 *   2. `member` — Better Auth's org-level membership: billing, settings, team.
 *   3. `clinic_memberships` — the PHI grant, per location, which is the finer
 *      boundary and the one that actually gates patient data.
 *
 * Deliberately NOT idempotent-by-ignoring: re-accepting a used invitation must
 * fail, because that is a used token being replayed.
 */
export async function acceptInvitationFor(
  email: string,
  userId: string,
): Promise<{ organizationId: string; clinicIds: string[] } | null> {
  const normalized = email.toLowerCase();

  return unsafeDb.transaction(async (tx) => {
    // Re-read the invitation inside the transaction and claim it atomically.
    // The create hook checked one existed; between then and now another request
    // could have used it.
    const claimed = await tx
      .update(invitation)
      .set({ status: "accepted" })
      .where(
        and(
          eq(invitation.email, normalized),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      )
      .returning({
        id: invitation.id,
        organizationId: invitation.organizationId,
        role: invitation.role,
      });

    const invite = claimed[0];
    if (!invite) return null;

    await tx
      .insert(member)
      .values({
        id: crypto.randomUUID(),
        organizationId: invite.organizationId,
        userId,
        role: invite.role ?? "member",
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    // Every clinic under that organization. A single-site practice has one; a
    // three-location group has three, and the owner needs all of them.
    const locations = await tx
      .select({ id: clinics.id })
      .from(clinics)
      .where(eq(clinics.organizationId, invite.organizationId));

    for (const clinic of locations) {
      // clinic_memberships is FORCE RLS, so the tenant has to be declared
      // before the insert — one clinic at a time, since the GUC holds one id.
      await tx.execute(
        sql`select set_config('app.clinic_id', ${clinic.id}, true)`,
      );
      await tx
        .insert(clinicMemberships)
        .values({
          clinicId: clinic.id,
          userId,
          role: invite.role === "owner" ? "owner" : "front_desk",
        })
        .onConflictDoNothing();
    }

    await recordSecurityEvent(tx, {
      event: "invitation_accepted",
      actorLabel: normalized,
      organizationId: invite.organizationId,
      metadata: {
        invitationId: invite.id,
        clinicsGranted: locations.length,
      },
    });

    return {
      organizationId: invite.organizationId,
      clinicIds: locations.map((c) => c.id),
    };
  });
}

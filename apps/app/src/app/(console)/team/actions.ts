"use server";

import { randomUUID } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { unsafeDb } from "@/db";
import { invitation } from "@/db/auth-schema";
import { recordSecurityEvent } from "@/lib/audit";
import { INTERNAL_ORG_ID } from "@/lib/ops/internal-org";
import { requestMeta, requireSession } from "@/lib/session";

const INVITATION_TTL_DAYS = 7;

export type InviteState =
  | { status: "idle" }
  | { status: "sent"; email: string; link: string }
  | { status: "error"; message: string };

/**
 * Invite a colleague to the ops console.
 *
 * Sign-up is closed, so this is the only route to an account. The invitation
 * link is returned rather than emailed because SES isn't wired up yet — better
 * to hand the operator a link they can send themselves than to pretend an email
 * went out.
 *
 * Ops invitations expire in 7 days rather than the 14 a clinic gets: a
 * standing invitation to a console holding patient data is a credential lying
 * around.
 */
export async function inviteTeammate(
  _previous: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const session = await requireSession();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { status: "error", message: "That doesn't look like an email address." };
  }

  // Reuse an unexpired invitation rather than stacking duplicates — otherwise
  // repeated clicks leave several valid credentials for one person.
  const [existing] = await unsafeDb
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, email),
        eq(invitation.organizationId, INTERNAL_ORG_ID),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const id = existing?.id ?? randomUUID();

  if (!existing) {
    await unsafeDb.insert(invitation).values({
      id,
      organizationId: INTERNAL_ORG_ID,
      email,
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000),
      inviterId: session.userId,
      createdAt: new Date(),
    });
  }

  const meta = await requestMeta();
  await recordSecurityEvent(unsafeDb, {
    event: "ops_invitation_created",
    actorLabel: session.email,
    userId: session.userId,
    organizationId: INTERNAL_ORG_ID,
    ipAddress: meta.ipAddress ?? null,
    userAgent: meta.userAgent ?? null,
    metadata: { invitedEmail: email, reused: Boolean(existing) },
  });

  revalidatePath("/team");

  return {
    status: "sent",
    email,
    link: `/accept-invite?id=${id}`,
  };
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");

  await unsafeDb
    .update(invitation)
    .set({ status: "cancelled" })
    .where(eq(invitation.id, id));

  await recordSecurityEvent(unsafeDb, {
    event: "ops_invitation_revoked",
    actorLabel: session.email,
    userId: session.userId,
    organizationId: INTERNAL_ORG_ID,
    metadata: { invitationId: id },
  });

  revalidatePath("/team");
}

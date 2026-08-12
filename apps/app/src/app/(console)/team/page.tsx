import { and, desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { unsafeDb } from "@/db";
import { invitation, member, user } from "@/db/auth-schema";
import { requireSession } from "@/lib/session";
import { TenantAccessError } from "@/lib/tenant";

import { INTERNAL_ORG_ID } from "@/lib/ops/internal-org";

import { revokeInvitation } from "./actions";
import { InviteForm } from "./InviteForm";

/**
 * Ops team management.
 *
 * The only route to an account, since sign-up is closed. Without this page the
 * first operator is created by hand-inserting an invitation row, and the second
 * one cannot be created at all.
 */

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  try {
    await requireSession();
  } catch (error) {
    if (error instanceof TenantAccessError) redirect("/sign-in");
    throw error;
  }

  const [members, pending] = await Promise.all([
    unsafeDb
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, INTERNAL_ORG_ID))
      .orderBy(desc(member.createdAt)),

    unsafeDb
      .select({
        id: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, INTERNAL_ORG_ID),
          eq(invitation.status, "pending"),
        ),
      )
      .orderBy(desc(invitation.createdAt)),
  ]);

  const now = Date.now();

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Team</h1>
      <p className="mt-3 max-w-[62ch] text-sm text-[color:var(--color-muted)]">
        There is no public sign-up — an account exists only by invitation. Access
        to any individual clinic&apos;s patient data is granted separately, per
        clinic, so being on this list grants nothing on its own.
      </p>

      <section className="mt-10">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Invite someone
        </h2>
        <div className="mt-4">
          <InviteForm />
        </div>
      </section>

      {pending.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
            Pending invitations ({pending.length})
          </h2>
          <ul className="mt-4 divide-y divide-[color:var(--color-line)] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white">
            {pending.map((invite) => {
              const expired = invite.expiresAt.getTime() < now;
              return (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm"
                >
                  <span className="font-medium">{invite.email}</span>
                  <span
                    className={
                      expired
                        ? "text-[color:var(--color-red)]"
                        : "text-[color:var(--color-muted)]"
                    }
                  >
                    {expired
                      ? "expired"
                      : `expires ${invite.expiresAt.toISOString().slice(0, 10)}`}
                  </span>
                  <form action={revokeInvitation} className="ml-auto">
                    <input type="hidden" name="id" value={invite.id} />
                    <button
                      type="submit"
                      className="text-sm font-semibold text-[color:var(--color-muted)] underline"
                    >
                      Revoke
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="mt-12">
        <h2 className="text-sm font-bold tracking-[0.08em] uppercase">
          Members ({members.length})
        </h2>

        {members.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--color-muted)]">
            Nobody has accepted an invitation yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[color:var(--color-line)] overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-white">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-3 px-5 py-3.5 text-sm"
              >
                <span className="font-medium">{m.name}</span>
                <span className="text-[color:var(--color-muted)]">{m.email}</span>
                {!m.emailVerified ? (
                  <span className="rounded-full bg-[color:var(--color-red)]/10 px-2.5 py-1 text-[11px] font-bold text-[color:var(--color-red)] uppercase">
                    unverified
                  </span>
                ) : null}
                <span className="ml-auto text-[color:var(--color-muted)]">
                  {m.joinedAt.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

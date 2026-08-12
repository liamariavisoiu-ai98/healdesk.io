import { and, eq, gt } from "drizzle-orm";
import type { Metadata } from "next";

import { unsafeDb } from "@/db";
import { invitation, organization } from "@/db/auth-schema";

import { AcceptInviteForm } from "./AcceptInviteForm";

export const metadata: Metadata = {
  title: "Set up your account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Accepting an invitation.
 *
 * Without this page the whole purchase flow dead-ends: provisioning creates the
 * organization, the clinic and an invitation, but the buyer has no way to set a
 * password and reach anything.
 *
 * The invitation id is the credential. That is acceptable because it is a v4
 * UUID delivered to an address the clinic already controls, it expires in 14
 * days, and it grants exactly one thing — the ability to create an account for
 * the email it was issued to. It cannot be used to log in as anyone.
 *
 * The email is NOT taken from the query string. Reading it from the invitation
 * row is what stops someone pointing a valid invitation at an address of their
 * choosing.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;

  const invite = id ? await findValidInvitation(id) : undefined;

  if (!invite) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          This invitation isn&apos;t valid
        </h1>
        <p className="mt-3 text-[color:var(--color-muted)]">
          It may have expired, already been used, or the link may be incomplete.
          Invitations last 14 days.
        </p>
        <p className="mt-4 text-sm text-[color:var(--color-muted)]">
          Reply to your setup email and we&apos;ll send a new one.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-bold tracking-[0.14em] text-[color:var(--color-muted)] uppercase">
        {invite.organizationName}
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        Set up your account
      </h1>
      <p className="mt-3 mb-8 text-[color:var(--color-muted)]">
        Choose a password and you&apos;re in.
      </p>

      <AcceptInviteForm email={invite.email} />

      <p className="mt-8 text-xs text-[color:var(--color-muted)]">
        This account can reach patient data. Every access is logged.
      </p>
    </main>
  );
}

async function findValidInvitation(id: string) {
  // Cheap shape check first: a malformed id should not reach the database.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;

  const [row] = await unsafeDb
    .select({
      email: invitation.email,
      organizationName: organization.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(
      and(
        eq(invitation.id, id),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return row;
}

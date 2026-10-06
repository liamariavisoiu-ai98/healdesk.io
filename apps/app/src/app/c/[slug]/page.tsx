import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { portalGrants, requirePortal } from "@/lib/portal/access";

export const dynamic = "force-dynamic";

/**
 * The clinic's Home, as far as M2 goes: proof of who is signed in to which
 * clinic, and a way out. M3 builds the real Home (plan Part F1) on the same
 * guard.
 */

async function signOut(): Promise<void> {
  "use server";
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export default async function ClinicHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const portal = await requirePortal(slug);
  const clinic = (await portalGrants(portal.userId)).find((g) => g.clinicId === portal.clinicId);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold">{clinic?.name}</h1>
      <p className="text-muted mt-3">You're signed in.</p>
      <form action={signOut} className="mt-8">
        <button type="submit" className="border-line rounded-full border px-6 py-3 text-sm font-bold">
          Sign out
        </button>
      </form>
    </main>
  );
}

import { redirect } from "next/navigation";

import { currentUserId, portalGrants } from "@/lib/portal/access";

export const dynamic = "force-dynamic";

/**
 * `/`: the portal's front door (plan Part F). Signed in, it goes straight to
 * the clinic; with more than one clinic on one address, it lists them;
 * signed out, it goes to /sign-in.
 */
export default async function Home() {
  const userId = await currentUserId();
  if (!userId) redirect("/sign-in");
  const grants = await portalGrants(userId);
  if (grants.length === 1) redirect(`/c/${grants[0]!.slug}`);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      {grants.length === 0 ? (
        <>
          <h1 className="text-2xl font-semibold">No clinic is linked to this sign-in.</h1>
          <p className="text-muted mt-3">If that's unexpected, email hello@healdesk.io and we'll sort it out.</p>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-semibold">Choose a clinic</h1>
          <ul className="mt-6 grid gap-2">
            {grants.map((g) => (
              <li key={g.clinicId}>
                <a href={`/c/${g.slug}`} className="border-line block rounded-xl border bg-white px-4 py-3 font-semibold">
                  {g.name}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

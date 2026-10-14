import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { unsafeDb } from "@/db";
import { auth } from "@/lib/auth";

/**
 * The clinic portal's door (plan Part D4).
 *
 * Every portal page and server action calls `requirePortal(slug)` itself,
 * never once in a layout: a layout does not re-run on client navigation and
 * never runs for a route handler.
 */

/** Who is asking, about which clinic. v1 has one sign-in per clinic and no roles. */
export type PortalContext = {
  userId: string;
  clinicId: string;
  clinicSlug: string;
};

export type PortalGrant = { clinicId: string; slug: string; name: string };

/**
 * The clinics a user may open, through `app_user_clinic_grants` (0043): active
 * memberships in the user's own organisations, nothing else. A definer
 * function, because clinic_memberships forces row-level security and the
 * question is asked before any tenant is known.
 */
export async function portalGrants(userId: string): Promise<PortalGrant[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; slug: string; name: string }>(
    sql`select clinic_id, slug, name from app_user_clinic_grants(${userId})`,
  );
  return result.rows.map((r) => ({ clinicId: r.clinic_id, slug: r.slug, name: r.name }));
}

/** This request's Better Auth session, read once per render. */
const currentSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/** The signed-in user's id, or null. Deduplicated across one render. */
export const currentUserId = cache(async (): Promise<string | null> => {
  const result = await currentSession();
  return result?.user?.id ?? null;
});

/**
 * The session's token, or null: the bearer value of the session cookie, which
 * Better Auth never rotates while the session lives. Step-ups and WebAuthn
 * challenges refer to the session only by its SHA-256
 * (lib/factors/step-ups.ts), so this never leaves the request.
 */
export const currentSessionToken = cache(async (): Promise<string | null> => {
  const result = await currentSession();
  return result?.session?.token ?? null;
});

/**
 * The signed-in user's context on clinic `slug`.
 *
 * - No session: off to /sign-in, for any slug, so the redirect says nothing
 *   about whether a clinic exists.
 * - Signed in without a grant on this slug: "not found", exactly like a slug
 *   that does not exist, so the portal cannot be used to list clinics.
 *
 * Membership is the whole check: the clinic's one sign-in can do everything.
 * Patient pages call `requirePatientPage` (patient-page.ts) instead, which
 * calls this and then asks for a passkey step-up.
 */
export async function requirePortal(slug: string): Promise<PortalContext> {
  const userId = await currentUserId();
  if (!userId) redirect(`/sign-in?next=${encodeURIComponent(`/c/${slug}`)}`);
  const grant = (await portalGrants(userId)).find((g) => g.slug === slug);
  if (!grant) notFound();
  return { userId, clinicId: grant.clinicId, clinicSlug: grant.slug };
}

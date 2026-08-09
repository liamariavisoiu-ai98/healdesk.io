import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";

import { unsafeDb } from "@/db";
import { clinicMemberships, clinics } from "@/db/schema";

import type { ActorContext, RequestContext } from "./audit";
import { auth } from "./auth";
import { TenantAccessError, type TenantContext } from "./tenant";

/**
 * Session → tenant resolution.
 *
 * Turns "who is making this request" into "which clinic may they touch", which
 * is the input `withTenant()` needs. Access is an explicit row in
 * clinic_memberships, never inferred from an org role — so the question
 * "who could read this record on 3 March?" stays answerable with a SELECT.
 */

export type AuthenticatedSession = {
  userId: string;
  email: string;
  name: string;
};

/**
 * React `cache()` dedupes this across a single render pass, so a layout and the
 * page inside it don't each hit the session store.
 */
export const requireSession = cache(async (): Promise<AuthenticatedSession> => {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) throw new TenantAccessError("Not signed in.");

  return {
    userId: result.user.id,
    email: result.user.email,
    name: result.user.name ?? result.user.email,
  };
});

export type AccessibleClinic = {
  id: string;
  slug: string;
  name: string;
  role: string;
};

/** Clinics this user currently holds an unrevoked grant for. */
export async function listAccessibleClinics(
  userId: string,
): Promise<AccessibleClinic[]> {
  return unsafeDb
    .select({
      id: clinics.id,
      slug: clinics.slug,
      name: clinics.name,
      role: clinicMemberships.role,
    })
    .from(clinicMemberships)
    .innerJoin(clinics, eq(clinics.id, clinicMemberships.clinicId))
    .where(
      and(
        eq(clinicMemberships.userId, userId),
        isNull(clinicMemberships.revokedAt),
      ),
    );
}

/**
 * Resolve a clinic slug into a tenant context, verifying access first.
 *
 * This check runs on every page and route handler, never once in a layout:
 * layouts don't re-run on client navigation and never run for route handlers,
 * so a layout-only check protects nothing.
 */
export async function resolveTenantContext(
  clinicSlug: string,
): Promise<TenantContext> {
  const session = await requireSession();

  const [row] = await unsafeDb
    .select({
      clinicId: clinics.id,
      role: clinicMemberships.role,
    })
    .from(clinics)
    .innerJoin(
      clinicMemberships,
      and(
        eq(clinicMemberships.clinicId, clinics.id),
        eq(clinicMemberships.userId, session.userId),
        isNull(clinicMemberships.revokedAt),
      ),
    )
    .where(eq(clinics.slug, clinicSlug))
    .limit(1);

  if (!row) {
    // Same error whether the clinic doesn't exist or the user simply lacks
    // access — don't let this endpoint enumerate clinic slugs.
    throw new TenantAccessError("No access to this clinic.");
  }

  const actor: ActorContext = {
    type: "user",
    userId: session.userId,
    // Frozen into audit_log.actorLabel: if the account is later deleted, the
    // audit row still says who it was.
    label: session.email,
  };

  return {
    clinicId: row.clinicId,
    actor,
    request: await requestMeta(),
  };
}

/** Request metadata for the audit trail. Never contains PHI. */
export async function requestMeta(): Promise<RequestContext> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");

  return {
    requestId: h.get("x-request-id") ?? randomUUID(),
    ipAddress: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}

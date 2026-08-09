import { randomUUID } from "node:crypto";

import {
  CURRENT_BAA_VERSION,
  getBaaDocument,
  getPlan,
  getPlatform,
  hashBaaText,
  isSpecialtyId,
  NO_PLATFORM_ID,
  supportsVerifiedAttribution,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { invitation, organization, user } from "@/db/auth-schema";
import { baaAcceptances, clinicMemberships, clinics } from "@/db/schema";

import { recordSecurityEvent } from "./audit";
import type { RequestContext } from "./audit";

/**
 * Turning a completed checkout into an account.
 *
 * This is the one legitimate caller of `unsafeDb` besides Better Auth and
 * migrations: provisioning happens before a tenant exists, so there is no
 * clinic to scope it to. It follows the sequence the RLS policies require —
 * insert the clinic first (that table is not FORCEd), then declare the tenant,
 * then write everything that is.
 *
 * ## Why this creates an invitation rather than a user
 *
 * Sign-up is closed (src/lib/auth.ts): an open registration form on a system
 * holding patient records is a defect. So checkout provisions the org and the
 * clinic, then invites the buyer. They set a password from the invite link, and
 * Better Auth's create hook finds the pending invitation and allows the account.
 *
 * A consequence worth noting: the BAA is accepted during checkout, before the
 * user record exists. That is why baa_acceptances.userId is nullable and the
 * accepting person's name and email are frozen into their own columns.
 */

/** Well-known inviter for self-serve signups, where no human is inviting. */
const SYSTEM_USER_ID = "usr_system_healdesk";
const SYSTEM_USER_EMAIL = "system@healdesk.io";
const INVITATION_TTL_DAYS = 14;

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

export type ProvisionRequest = {
  clinicName: string;
  specialty: string;
  /** Platform id from @healdesk/catalog, including "none". */
  platform: string;
  attributionMode: "estimated" | "verified";
  /** Required when attributionMode is "estimated" — it is the whole input. */
  averageTreatmentValueUsd?: number;
  plan: string;
  timezone?: string;

  contactName: string;
  contactEmail: string;
  contactTitle?: string;

  baaVersion: string;
  baaAccepted: boolean;
};

export type ProvisionResult = {
  organizationId: string;
  clinicId: string;
  clinicSlug: string;
  invitationId: string;
  /** Present so the caller can send the invite email; never logged. */
  invitedEmail: string;
};

export function validateProvisionRequest(
  input: unknown,
): asserts input is ProvisionRequest {
  const body = input as Partial<ProvisionRequest> | null;
  if (!body || typeof body !== "object") {
    throw new ProvisioningError("Invalid request body.");
  }

  if (!body.clinicName?.trim()) {
    throw new ProvisioningError("Clinic name is required.", "clinicName");
  }
  if (body.clinicName.length > 120) {
    throw new ProvisioningError("Clinic name is too long.", "clinicName");
  }
  if (!isSpecialtyId(body.specialty)) {
    throw new ProvisioningError("Unknown specialty.", "specialty");
  }

  const platform = getPlatform(body.platform ?? "");
  if (!platform) {
    throw new ProvisioningError("Unknown platform.", "platform");
  }
  if (!getPlan(body.plan ?? "")) {
    throw new ProvisioningError("Unknown plan.", "plan");
  }

  if (body.attributionMode !== "estimated" && body.attributionMode !== "verified") {
    throw new ProvisioningError("Invalid attribution mode.", "attributionMode");
  }

  // Verified attribution needs something to connect to. Catching this here
  // rather than at the wizard means the API can't be talked into a state the
  // UI would never produce.
  if (
    body.attributionMode === "verified" &&
    !supportsVerifiedAttribution(platform)
  ) {
    throw new ProvisioningError(
      `Verified attribution needs a system to read from; ${platform.name} has none.`,
      "attributionMode",
    );
  }

  // Estimated attribution is the default path, and this value is its only
  // input. Without it the first monthly report would have nothing to say.
  if (body.attributionMode === "estimated") {
    const value = body.averageTreatmentValueUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ProvisioningError(
        "Average treatment value is required for estimated attribution.",
        "averageTreatmentValueUsd",
      );
    }
    if (value > 1_000_000) {
      throw new ProvisioningError(
        "Average treatment value looks wrong.",
        "averageTreatmentValueUsd",
      );
    }
  }

  if (!body.contactName?.trim()) {
    throw new ProvisioningError("Your name is required.", "contactName");
  }
  if (!isEmail(body.contactEmail)) {
    throw new ProvisioningError("A valid email is required.", "contactEmail");
  }

  if (body.baaAccepted !== true) {
    throw new ProvisioningError(
      "The business associate agreement must be accepted.",
      "baaAccepted",
    );
  }
  if (!getBaaDocument(body.baaVersion ?? "")) {
    throw new ProvisioningError("Unknown agreement version.", "baaVersion");
  }
  if (body.baaVersion !== CURRENT_BAA_VERSION) {
    // Someone left a tab open across a revision. Make them re-read it.
    throw new ProvisioningError(
      "The agreement has been updated. Please review it again.",
      "baaVersion",
    );
  }
}

export async function provisionClinic(
  request: ProvisionRequest,
  context: RequestContext = {},
): Promise<ProvisionResult> {
  const email = request.contactEmail.trim().toLowerCase();
  const document = getBaaDocument(request.baaVersion)!;
  const platform = getPlatform(request.platform)!;

  await ensureSystemUser();

  const baseSlug = slugify(request.clinicName);

  // Retry on slug collision rather than checking first. Under RLS a
  // check-then-insert cannot work anyway — with the tenant set to the clinic
  // we are about to create, a SELECT for an existing slug returns nothing — and
  // check-then-insert was always a race regardless. Letting the unique index
  // arbitrate is both correct under concurrency and simpler.
  for (let attempt = 0; ; attempt += 1) {
    const slug =
      attempt === 0 ? baseSlug : `${baseSlug}-${randomUUID().slice(0, 6)}`;
    try {
      return await provisionOnce({
        request,
        context,
        email,
        document,
        platform,
        slug,
      });
    } catch (error) {
      if (attempt < 4 && isUniqueViolation(error)) continue;
      throw error;
    }
  }
}

async function provisionOnce({
  request,
  context,
  email,
  document,
  platform,
  slug,
}: {
  request: ProvisionRequest;
  context: RequestContext;
  email: string;
  document: { version: string; text: string };
  platform: { id: string };
  slug: string;
}): Promise<ProvisionResult> {
  const organizationId = `org_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

  /**
   * The clinic id is generated here rather than by the database, so the tenant
   * can be declared BEFORE the row exists.
   *
   * Without this, provisioning cannot work as the runtime role at all: the
   * clinics policy is `id = app_current_clinic_id()`, so an insert with no
   * tenant set is refused, and even with a tenant set the RETURNING clause is
   * checked against the SELECT policy. Choosing the id up front satisfies both,
   * and keeps provisioning inside a declared tenant like every other write —
   * rather than handing the application owner-level credentials to work around
   * its own isolation.
   */
  const clinicId = randomUUID();

  const result = await unsafeDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);

    await tx.insert(organization).values({
      id: organizationId,
      name: request.clinicName.trim(),
      slug: `${slug}-org`,
      createdAt: new Date(),
    });

    await tx.insert(clinics).values({
      id: clinicId,
      organizationId,
      slug,
      name: request.clinicName.trim(),
      specialty: request.specialty,
      timezone: request.timezone ?? "America/New_York",
      bookingProvider: request.platform === NO_PLATFORM_ID ? null : platform.id,
      attributionMode: request.attributionMode,
      averageTreatmentValueUsd:
        request.averageTreatmentValueUsd?.toFixed(2) ?? null,
      plan: request.plan,
      // Always synthetic at creation, whatever the buyer selected. Moving a
      // clinic to 'production' requires a signed BAA and is a deliberate,
      // separate act — until then the database refuses PHI writes entirely
      // (drizzle/0004_baa_gate.sql).
      dataClassification: "synthetic",
    });

    await tx.insert(baaAcceptances).values({
      organizationId,
      // The user does not exist yet; the frozen columns below carry the record.
      userId: null,
      documentVersion: document.version,
      documentHash: hashBaaText(document.text),
      acceptedByName: request.contactName.trim(),
      acceptedByEmail: email,
      acceptedByTitle: request.contactTitle?.trim() || null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });

    const invitationId = randomUUID();
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await tx.insert(invitation).values({
      id: invitationId,
      organizationId,
      email,
      role: "owner",
      status: "pending",
      expiresAt,
      inviterId: SYSTEM_USER_ID,
      createdAt: new Date(),
    });

    await recordSecurityEvent(tx, {
      event: "clinic_provisioned",
      actorLabel: email,
      organizationId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      metadata: {
        clinicSlug: slug,
        specialty: request.specialty,
        platform: request.platform,
        plan: request.plan,
        attributionMode: request.attributionMode,
        baaVersion: document.version,
      },
    });

    return { clinicId, invitationId };
  });

  return {
    organizationId,
    clinicId: result.clinicId,
    clinicSlug: slug,
    invitationId: result.invitationId,
    invitedEmail: email,
  };
}

/**
 * Better Auth's invitation table requires an inviter, and a self-serve signup
 * has no human doing the inviting. A named system principal is more honest than
 * loosening the schema — the audit trail then says exactly who issued it.
 */
async function ensureSystemUser(): Promise<void> {
  const [existing] = await unsafeDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, SYSTEM_USER_ID))
    .limit(1);

  if (existing) return;

  await unsafeDb
    .insert(user)
    .values({
      id: SYSTEM_USER_ID,
      name: "healdesk (system)",
      email: SYSTEM_USER_EMAIL,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Grant the first membership once the invited owner accepts.
 *
 * Separate from provisioning because it happens later, after the user record
 * exists. clinic_memberships IS forced, so this declares the tenant first.
 */
export async function grantOwnerMembership(
  clinicId: string,
  userId: string,
): Promise<void> {
  await unsafeDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);
    await tx
      .insert(clinicMemberships)
      .values({ clinicId, userId, role: "owner" })
      .onConflictDoNothing();
  });
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clinic"
  );
}

/**
 * 23505 — the unique index arbitrating a slug or org-slug collision.
 *
 * Walks the cause chain: Drizzle wraps driver errors in its own, so the
 * Postgres code sits on `error.cause` rather than the error itself. Checking
 * only the top level silently disables the retry, which is exactly the bug this
 * comment exists to stop someone reintroducing.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
  );
}

import { randomUUID } from "node:crypto";

import {
  currentBaaTemplate,
  getPlan,
  getPlatform,
  isSpecialtyId,
  NO_PLATFORM_ID,
  supportsVerifiedAttribution,
} from "@healdesk/catalog";
import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { invitation, organization, user } from "@/db/auth-schema";
import { clinics, provisioningAttempts } from "@/db/schema";

import { bindAgreement } from "./agreements";
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
 * ## Why provisioning does not record the BAA
 *
 * It already happened. The agreement is signed BEFORE payment, on its own
 * endpoint, because a business associate may not receive patient data without a
 * written contract — so it cannot be a side effect of a payment webhook that
 * may or may not arrive. By the time we reach here the signature exists; this
 * only binds it to the organization that payment just created.
 *
 * That is also why baa_acceptances.userId is nullable: the buyer signed before
 * any user record existed, and their name and email are frozen into their own
 * columns on the acceptance row.
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

  /**
   * Landline/toll-free vs VoIP, from discovery question B.
   *
   * Optional, and defaults to "unknown" rather than to a guess: it decides
   * whether the clinic's published number can be text-enabled at all, and an
   * assumed "landline" would surface as a failed provisioning weeks later.
   */
  phoneSystemType?: "landline" | "voip" | "unknown";

  /**
   * The agreement signed BEFORE payment, from POST /api/agreements.
   *
   * Provisioning no longer records the acceptance itself — by the time we get
   * here the buyer has already signed, and re-recording it would produce a
   * second row with a later timestamp and a different rendered document. This
   * id binds the existing signature to the organization payment just created.
   */
  agreementId: string;

  /**
   * What makes a repeated delivery a no-op. See drizzle/0021.
   *
   * ⚠️ Stamped SERVER-SIDE by apps/web from the verified Stripe event — never
   * taken from a browser. The HMAC on this request authenticates apps/web, not
   * the buyer, so a key chosen by the client would let anyone who guessed one
   * receive another clinic's organizationId, clinicId and invitationId in the
   * replay response. A dedupe key that echoes prior results is an object
   * reference oracle if it is attacker-controlled.
   */
  idempotencyKey: string;
};

export type ProvisionResult = {
  organizationId: string;
  clinicId: string;
  clinicSlug: string;
  invitationId: string;
  /** Present so the caller can send the invite email; never logged. */
  invitedEmail: string;
  /**
   * True when this key had already been provisioned and nothing was written.
   *
   * The caller MUST NOT re-send the invite email on a replay. Stripe retries
   * for up to three days, so a flapping webhook would otherwise mail the same
   * clinic owner an invitation every few hours — all pointing at the same
   * still-valid link.
   */
  replayed: boolean;
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

  if (
    body.phoneSystemType !== undefined &&
    !["landline", "voip", "unknown"].includes(body.phoneSystemType)
  ) {
    throw new ProvisioningError(
      "Invalid phone system type.",
      "phoneSystemType",
    );
  }

  // Required, and never defaulted to a fresh uuid. A generated fallback would
  // make every delivery unique and silently restore the duplicate-account bug
  // this field exists to remove — with no error anywhere to notice it by.
  if (!body.idempotencyKey?.trim()) {
    throw new ProvisioningError(
      "An idempotency key is required.",
      "idempotencyKey",
    );
  }
  if (body.idempotencyKey.length > 255) {
    throw new ProvisioningError("Idempotency key is too long.", "idempotencyKey");
  }

  // No `baaAccepted: true` flag any more, deliberately. A boolean sent by the
  // caller is a claim; an agreement id is a row that already exists, signed,
  // with its own text and hash. The second is checkable and the first is not.
  if (!isUuid(body.agreementId ?? "")) {
    throw new ProvisioningError(
      "A signed business associate agreement is required before an account can be created.",
      "agreementId",
    );
  }
}

export async function provisionClinic(
  request: ProvisionRequest,
  context: RequestContext = {},
): Promise<ProvisionResult> {
  const email = request.contactEmail.trim().toLowerCase();
  const platform = getPlatform(request.platform)!;

  // The counsel gate, which until now was only ever a claim.
  //
  // baa.ts has always documented that "provisioning refuses" an unapproved
  // template, and nothing enforced it — the flag reached the checkout UI as a
  // banner and stopped there. A safeguard that exists only in a docstring is
  // worse than none, because it gets relied on.
  //
  // It is a no-op today: the current template is approved. It exists for the
  // next draft, so a revision in progress cannot be signed into a live account
  // by anyone who forgets what the flag was for.
  const template = currentBaaTemplate();
  if (!template.approvedByCounsel) {
    throw new Error(
      `BAA template ${template.version} is not counsel-approved. Refusing to ` +
        `provision a clinic against it: the signature would not create a ` +
        `business associate relationship, and the account would be handling ` +
        `PHI without one.`,
    );
  }

  // Fast path: a delivery we have already fully provisioned. Cheap, and it
  // keeps the common retry off the slug loop entirely. It is NOT the safety
  // property — the unique index inside the transaction is, because two
  // concurrent deliveries can both miss this read.
  const seen = await unsafeDb
    .select({
      organizationId: provisioningAttempts.organizationId,
      clinicId: provisioningAttempts.clinicId,
      clinicSlug: provisioningAttempts.clinicSlug,
      invitationId: provisioningAttempts.invitationId,
    })
    .from(provisioningAttempts)
    .where(eq(provisioningAttempts.idempotencyKey, request.idempotencyKey))
    .limit(1);

  if (seen[0]) {
    return { ...seen[0], invitedEmail: email, replayed: true };
  }

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
      return await provisionOnce({ request, context, email, platform, slug });
    } catch (error) {
      if (attempt < 4 && isSlugCollision(error)) continue;
      throw error;
    }
  }
}

async function provisionOnce({
  request,
  context,
  email,
  platform,
  slug,
}: {
  request: ProvisionRequest;
  context: RequestContext;
  email: string;
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

  const invitationId = randomUUID();

  const result = await unsafeDb.transaction(async (tx) => {
    // The claim goes FIRST, inside this transaction, with every id it will
    // report already decided above.
    //
    // Inside, because that is what makes it safe: Postgres's unique index gives
    // mutual exclusion between concurrent deliveries for free, and a provision
    // that fails halfway rolls the claim back with everything else. A claim in
    // its own transaction — or a status/lease column — would leave a committed
    // claim behind a failed provision, and then every retry would see the key
    // taken, report success, and the customer who paid could never be given an
    // account. Silently, which is the worst part.
    await tx.insert(provisioningAttempts).values({
      idempotencyKey: request.idempotencyKey,
      organizationId,
      clinicId,
      clinicSlug: slug,
      invitationId,
    });

    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);

    await tx.insert(organization).values({
      id: organizationId,
      name: request.clinicName.trim(),
      slug: `${slug}-org`,
      createdAt: new Date(),
    });

    // Bind the agreement they already signed, rather than recording a new one —
    // and do it BEFORE the clinic row, because the clinic needs the
    // covered-entity determination out of the signed document.
    //
    // If this fails the whole provision fails, and that is the correct
    // behaviour: an account whose agreement could not be attached is an account
    // we cannot lawfully send patient data to. Better to fail the webhook and
    // let Stripe retry than to create a clinic with a dangling contract.
    const signed = await bindAgreement(tx, request.agreementId, organizationId);
    if (!signed) {
      throw new ProvisioningError(
        "That agreement could not be attached — it may already belong to another account.",
        "agreementId",
      );
    }

    await tx.insert(clinics).values({
      id: clinicId,
      organizationId,
      slug,
      name: request.clinicName.trim(),
      specialty: request.specialty,
      timezone: request.timezone ?? "America/New_York",
      bookingProvider: request.platform === NO_PLATFORM_ID ? null : platform.id,
      phoneSystemType: request.phoneSystemType ?? "unknown",
      attributionMode: request.attributionMode,
      averageTreatmentValueUsd:
        request.averageTreatmentValueUsd?.toFixed(2) ?? null,
      plan: request.plan,
      // Taken from the signed agreement, never re-asked. This one determination
      // decides the contract, the consent standard, the state-law exposure and
      // the TCPA defence, so it must be the answer that is actually in the
      // document — `null` where the buyer said they did not know.
      isCoveredEntity: signed.isCoveredEntity ?? null,
      // Always synthetic at creation, whatever the buyer selected. Moving a
      // clinic to 'production' requires a signed BAA and is a deliberate,
      // separate act — until then the database refuses PHI writes entirely
      // (drizzle/0004_baa_gate.sql).
      dataClassification: "synthetic",
    });

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
        agreementId: request.agreementId,
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
    replayed: false,
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
 * The slug indexes, and ONLY the slug indexes.
 *
 * This used to match any 23505, which was fine while a slug collision was the
 * only unique constraint provisioning could hit. It stopped being fine the
 * moment `provisioning_attempts` gained one: a duplicate Stripe delivery raises
 * 23505 on the idempotency key, a bare code check reads that as a slug
 * collision, and the loop below retries five times with fresh random slugs —
 * every one of them colliding on the same key — before throwing. The mechanism
 * added to PREVENT duplicate provisioning would have become a five-deep retry
 * storm ending in a 500 that Stripe then retries for three days.
 *
 * So the allowlist is the safety property, not a tidy-up. Note `organization`
 * carries BOTH a table constraint and a unique index on slug (0000_init.sql:207
 * and :300) and either may be the one Postgres reports.
 *
 * Still walks the cause chain: Drizzle wraps driver errors in its own, so the
 * code and constraint sit on `error.cause` rather than the error itself.
 */
const SLUG_CONSTRAINTS: ReadonlySet<string> = new Set([
  "clinics_slug_idx",
  "organization_slug_unique",
  "organization_slug_uidx",
]);

function isSlugCollision(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: string; constraint?: string };
    if (e.code === "23505") {
      // An unnamed 23505 is deliberately NOT retried. Retrying an unknown
      // unique violation by changing the slug cannot fix it, and the previous
      // behaviour of trying anyway is what this allowlist exists to stop.
      return e.constraint !== undefined && SLUG_CONSTRAINTS.has(e.constraint);
    }
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

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

import { randomUUID } from "node:crypto";

import {
  agreementKindOfVersion,
  type AgreementKind,
  type BillingInterval,
  CHANNELS,
  currentBaaTemplate,
  getDpaTemplate,
  getPlan,
  getPlatform,
  isBillingInterval,
  isSpecialtyId,
  NO_PLATFORM_ID,
  regimeFor,
  type RegulatoryRegime,
  supportsVerifiedAttribution, emptyOnboarding } from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Transaction } from "@/db";
import { member, organization, user } from "@/db/auth-schema";
import {
  baaAcceptances,
  checkoutIntents,
  clinicChannels,
  clinicMemberships,
  clinics,
  entitlements,
  provisioningAttempts,
} from "@/db/schema";

import { bindAgreement } from "./agreements";
import { agreementKindSufficient } from "./agreements/kind";
import { AuditRecorder } from "./audit";
import { seedAgentConfig } from "./onboarding/agent-config";
import { addRecipient } from "./reporting/recipients";
import { recordSecurityEvent } from "./audit";
import type { RequestContext } from "./audit";
import { seedEntitlements } from "./billing/entitlements";
import { replayParkedBillingEvents } from "./billing/events";
import { setupDeadline } from "./clinic/setup-window";

/**
 * Turning a completed checkout into a clinic.
 *
 * This is the one legitimate caller of `unsafeDb` besides Better Auth and
 * migrations: provisioning happens before a tenant exists, so there is no
 * clinic to scope it to. It follows the sequence the RLS policies require —
 * insert the clinic first (that table is not FORCEd), then declare the tenant,
 * then write everything that is.
 *
 * ## Why nobody is invited to sign in
 *
 * A clinic never signs in, because there is nothing for a clinic to sign in to.
 * The clinic-facing console was removed on 7 September, and the one thing we
 * ever ask a clinic to do in a browser — hand over booking credentials — now
 * happens through a single-use link that needs no account at all (see
 * lib/email/connect-link.ts).
 *
 * So provisioning used to end by writing a Better Auth `invitation` row, which
 * the provision route then mailed as "choose a password". That is an invitation
 * into a product with nothing behind the login. The mild failure is a confused
 * customer setting a credential they can never use; the real one is a live
 * password on a system holding patient records, created for no purpose, never
 * used, and therefore never noticed and never rotated. The fewest credentials
 * that can exist is the security property here, so the invitation is not
 * written and the account it would have created is never made.
 *
 * Gone with it is `ensureSystemUser()`, which existed for exactly one reason:
 * Better Auth's invitation table requires an inviterId and a self-serve
 * purchase has no human doing the inviting, so every provision upserted a
 * `usr_system_healdesk` row to name as the inviter. No invitation, no inviter.
 * Databases provisioned before this change still carry that row; nothing
 * authenticates as it and nothing reads it, and clearing it out is a migration
 * rather than a code path.
 *
 * The buyer still receives everything the purchase owes them, by email: their
 * signed agreement as a PDF (sent by signAgreement, before payment, from
 * lib/email/agreement-copy.ts) and — only when they have a booking system to
 * connect — the single-use connect link.
 *
 * The alternative considered was keeping the invitation dormant "in case a
 * console comes back". Rejected: a pending invitation is a live credential with
 * a 14-day fuse and no product behind it, and it accrues one per sale. If a
 * clinic-facing surface is ever built, issuing invitations at that point is a
 * far smaller job than auditing the ones issued in the meantime.
 *
 * ## Why the organization row stays
 *
 * `clinics.organizationId` is NOT NULL and references `organization`, and an
 * agreement binds to an organization id. It remains a data concept with nobody
 * logging into it. Removing Better Auth's tables is a different and much larger
 * change than declining to write one row.
 *
 * ## Why provisioning does not record the BAA
 *
 * It already happened. The agreement is signed BEFORE payment, on its own
 * endpoint, because a business associate may not receive patient data without a
 * written contract — so it cannot be a side effect of a payment webhook that
 * may or may not arrive. By the time we reach here the signature exists; this
 * only binds it to the organization that payment just created.
 *
 * That is also why baa_acceptances.userId is nullable, and why it now stays
 * null forever: the buyer signed before any user record existed, and since the
 * invitation went away no user record is ever created. Their name and email are
 * frozen into their own columns on the acceptance row, which is the whole
 * reason that evidence survives having no account to hang off.
 */

/**
 * What goes in `provisioning_attempts.invitation_id` now that no invitation is
 * created. The column is NOT NULL (drizzle/0021) and dropping it is a migration
 * this change does not own, so the ledger still needs a value.
 *
 * A constant nil uuid rather than a fresh `randomUUID()`: a random one is
 * indistinguishable from a real invitation id, so anyone reading the ledger
 * later would reasonably try to look it up and conclude the invitation had been
 * deleted. All-zeroes cannot be mistaken for anything, and it makes the eventual
 * `DROP COLUMN` obviously safe to write.
 */
const NO_INVITATION = "00000000-0000-0000-0000-000000000000";

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
  /**
   * Phase two (revenue attribution is fenced out of v1). Optional since the
   * funnel plan stopped asking: absent means "estimated", the column default,
   * and the value below is kept only when a caller still sends it.
   */
  attributionMode?: "estimated" | "verified";
  averageTreatmentValueUsd?: number;
  plan: string;
  /**
   * Monthly or annual. Defaults to "month" when absent, which is what every
   * caller that predates annual pricing sends.
   */
  billingInterval?: BillingInterval;
  timezone?: string;

  /**
   * The Stripe ids from the completed Session, stamped by apps/web from the
   * verified event like `idempotencyKey`. They are how every later lifecycle
   * event — renewal, failed card, cancellation — finds this clinic again, and
   * their presence is what decides the initial billing status: with a
   * subscription to wait on the clinic starts `provisioning` and the first
   * `invoice.paid` activates it; without one (the no-Stripe dev path) nothing
   * will ever arrive to do that, so it starts `active`.
   */
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;

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
   * Whether the clinic's number rings at the practice first ("conditional")
   * or comes straight to us ("always"). Decides what counts as recovered
   * revenue, so it is asked at checkout and confirmed at onboarding; when
   * absent the column default applies and the onboarding step stays open.
   */
  callRouting?: "conditional" | "always";

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
   * receive another clinic's organizationId and clinicId in the replay
   * response. A dedupe key that echoes prior results is an object reference
   * oracle if it is attacker-controlled.
   */
  idempotencyKey: string;
};

/** What provisioning also does when the purchase came through a checkout intent. */
export type ProvisionOptions = {
  /** Consumed in the same transaction, so an intent provisions one clinic. */
  intentRef?: string;
};

export type ProvisionResult = {
  organizationId: string;
  clinicId: string;
  clinicSlug: string;
  /** The clinic's one sign-in, on a genuine creation (design D3). */
  ownerUserId?: string;
  /**
   * True when this key had already been provisioned and nothing was written.
   *
   * Still reported, and still load-bearing, even though provisioning no longer
   * sends mail of its own: it is what lets the caller answer 200 rather than
   * 201, and it is the flag anything added here later must consult before it
   * does something a customer can perceive. Stripe redelivers for up to three
   * days, so on this path "already done" happens routinely rather than rarely.
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
  if (
    body.billingInterval !== undefined &&
    !isBillingInterval(body.billingInterval)
  ) {
    throw new ProvisioningError("Invalid billing interval.", "billingInterval");
  }
  // Shape only. Whether they name a real customer is Stripe's business; the
  // partial unique indexes on entitlements refuse a second clinic on the same
  // subscription, which is the property that matters.
  for (const field of ["stripeCustomerId", "stripeSubscriptionId"] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new ProvisioningError(`Invalid ${field}.`, field);
    }
    if (typeof value === "string" && value.length > 255) {
      throw new ProvisioningError(`${field} is too long.`, field);
    }
  }

  if (
    body.attributionMode !== undefined &&
    body.attributionMode !== "estimated" &&
    body.attributionMode !== "verified"
  ) {
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

  // Optional now (design 4.2): the funnel plan stopped asking, because the
  // monthly revenue report it fed is phase two. Still checked when sent.
  if (body.averageTreatmentValueUsd !== undefined) {
    const value = body.averageTreatmentValueUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ProvisioningError(
        "Average treatment value must be a positive number.",
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
    body.callRouting !== undefined &&
    !["conditional", "always"].includes(body.callRouting as string)
  ) {
    throw new ProvisioningError("Invalid call routing.", "callRouting");
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
  options: ProvisionOptions = {},
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
    })
    .from(provisioningAttempts)
    .where(eq(provisioningAttempts.idempotencyKey, request.idempotencyKey))
    .limit(1);

  if (seen[0]) {
    return { ...seen[0], replayed: true };
  }

  // Which paper the clinic is under, and whether it may be provisioned
  // against it (plan Part L), decided before anything is written.
  const agreement = await agreementForProvisioning(request);

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
      return await provisionOnce({ request, context, options, email, platform, slug, agreement });
    } catch (error) {
      if (attempt < 4 && isSlugCollision(error)) continue;
      throw error;
    }
  }
}

async function provisionOnce({
  request,
  context,
  options,
  email,
  platform,
  slug,
  agreement,
}: {
  request: ProvisionRequest;
  context: RequestContext;
  options: ProvisionOptions;
  email: string;
  platform: { id: string };
  slug: string;
  agreement: ProvisionedAgreement;
}): Promise<ProvisionResult> {
  let ownerUserId = "";
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

  await unsafeDb.transaction(async (tx) => {
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
      invitationId: NO_INVITATION,
    });

    await tx.execute(sql`select set_config('app.clinic_id', ${clinicId}, true)`);

    await tx.insert(organization).values({
      id: organizationId,
      name: request.clinicName.trim(),
      slug: `${slug}-org`,
      createdAt: new Date(),
    });

    // Bind the agreement they already signed, rather than recording a new one —
    // and do it BEFORE the clinic row, which takes its covered-entity
    // determination and agreement kind from that same signed row (read by
    // agreementForProvisioning before this transaction opened).
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
      callRouting: request.callRouting ?? "conditional",
      callRoutingConfirmedAt: request.callRouting ? new Date() : null,
      // Every step open; the ones checkout already answered are stamped below.
      onboarding: {
        ...emptyOnboarding(),
        ...(request.callRouting ? { call_routing_chosen: new Date().toISOString() } : {}),
        ...(request.phoneSystemType && request.phoneSystemType !== "unknown"
          ? { phone_type_confirmed: new Date().toISOString() }
          : {}),
        ...(agreement.isCoveredEntity !== null
          ? { covered_entity_confirmed: new Date().toISOString() }
          : {}),
      },
      attributionMode: request.attributionMode ?? "estimated",
      averageTreatmentValueUsd:
        request.averageTreatmentValueUsd?.toFixed(2) ?? null,
      plan: request.plan,
      // Taken from the signed agreement, never re-asked. This one determination
      // decides the contract, the consent standard, the state-law exposure and
      // the TCPA defence, so it must be the answer that is actually in the
      // document — `null` where the buyer said they did not know, and false
      // under a DPA, which only a practice outside HIPAA signs.
      isCoveredEntity: agreement.isCoveredEntity,
      // The gate columns (drizzle/0048): the specialty's regime and the kind of
      // the agreement just bound, which the PHI gate reads with the line above.
      // Written here, on insert; the runtime role cannot update either.
      regulatoryRegime: agreement.regime,
      agreementKind: agreement.kind,
      // Always synthetic at creation, whatever the buyer selected. Moving a
      // clinic to 'production' requires a signed BAA and is a deliberate,
      // separate act — until then the database refuses PHI writes entirely
      // (drizzle/0004_baa_gate.sql).
      dataClassification: "synthetic",
    });

    // What the clinic may use, in the same transaction as the clinic itself:
    // a clinic with no entitlements row is one the agent cannot answer for
    // and the webhook cannot find, so the two must not be able to exist apart.
    // Allowances and channels are copied from the catalog HERE, at the moment
    // of sale, for the reasons in lib/billing/entitlements.ts.
    const plan = getPlan(request.plan)!;
    const billingStatus = await seedEntitlements(tx, clinicId, {
      plan,
      interval: request.billingInterval ?? "month",
      stripeCustomerId: request.stripeCustomerId,
      stripeSubscriptionId: request.stripeSubscriptionId,
    });

    // What was sold stays on record beside what is billed (plan_code follows
    // the channels in service once the plan starts), and the setup window
    // ends on the clinic's own calendar: the 30th day after today.
    await tx
      .update(entitlements)
      .set({
        boughtPlanId: plan.id,
        setupDeadlineAt: setupDeadline(new Date(), request.timezone ?? "America/New_York"),
      })
      .where(eq(entitlements.clinicId, clinicId));

    // One row per channel the package includes: where each stands, from
    // setting up to live, and what the price steps up by (contracts §2).
    const bought = CHANNELS.filter((channel) => plan.channels[channel]);
    if (bought.length > 0) {
      await tx.insert(clinicChannels).values(bought.map((channel) => ({ clinicId, channel })));
    }

    // The clinic's one sign-in (plan C2, design D3): the address that bought
    // it, as the owner, with no password and no invitation. Created directly
    // rather than through Better Auth, whose create hook admits only invited
    // addresses; the payment is the invitation.
    ownerUserId = await ensureOwner(tx, {
      email,
      name: request.contactName.trim(),
      organizationId,
      clinicId,
      context,
    });

    // The intent that carried this purchase is spent here, inside the same
    // transaction, so one intent makes one clinic however Stripe redelivers.
    if (options.intentRef) {
      const consumed = await tx
        .update(checkoutIntents)
        .set({
          consumedAt: sql`now()`,
          stripeSubscriptionId: request.stripeSubscriptionId ?? null,
          provisionedClinicId: clinicId,
          provisionedUserId: ownerUserId,
        })
        .where(and(eq(checkoutIntents.ref, options.intentRef), isNull(checkoutIntents.consumedAt)))
        .returning({ ref: checkoutIntents.ref });
      if (consumed.length === 0) {
        throw new ProvisioningError("That purchase has already been set up.", "ref");
      }
    }

    // The agent's default words, from the specialty, so onboarding starts
    // from something the clinic can correct rather than from a blank.
    const provisioningTx = {
      db: tx,
      clinicId,
      audit: new AuditRecorder(clinicId, { type: "service", serviceName: "provisioning" }),
    };
    await seedAgentConfig(provisioningTx, request.specialty, request.clinicName.trim());
    // The buyer is the first recipient of the monthly report; the clinic can
    // point it at a front-desk inbox later from the console.
    await addRecipient(provisioningTx, {
      email: request.contactEmail,
      label: request.contactName.trim() || undefined,
      addedBy: "provisioning",
    });
    await provisioningTx.audit.flush(tx);

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
        billingInterval: request.billingInterval ?? "month",
        billingStatus,
        attributionMode: request.attributionMode,
        agreementId: request.agreementId,
        agreementKind: agreement.kind,
        regulatoryRegime: agreement.regime,
      },
    });

  });

  // The first invoice may have beaten this provisioning to the webhook —
  // Stripe does not order deliveries — and dead-lettered while no clinic
  // matched its ids. Now one does. Replayed AFTER the transaction above has
  // committed, because the replay opens its own tenant transaction and must
  // be able to see the row; and never thrown from, because the clinic exists
  // and a replay that fails again is back on the queue with its error.
  await replayParkedBillingEvents({
    customerId: request.stripeCustomerId,
    subscriptionId: request.stripeSubscriptionId,
  });

  // Every id was decided before the transaction opened, so there is nothing to
  // read back out of it — that is the same property the idempotency claim
  // depends on (it is written first, naming ids that do not exist yet).
  return {
    organizationId,
    clinicId,
    clinicSlug: slug,
    ownerUserId,
    replayed: false,
  };
}

/** The agreement a clinic is provisioned under, as read from the signed row. */
type ProvisionedAgreement = {
  kind: AgreementKind;
  regime: RegulatoryRegime;
  /** The determination that goes on the clinic row: the signed answer under a BAA, false under a DPA. */
  isCoveredEntity: boolean | null;
};

/**
 * Read the signed agreement before anything is written, and refuse a clinic
 * its agreement cannot cover (plan Part L, "Hand-offs").
 *
 * The kind comes from the row's own version (`agreementKindOfVersion`, the
 * mirror of the generated `baa_acceptances.agreement_kind`), never from the
 * request. A DPA is provisioned only under a released DPA template: the bound
 * row's own template, as the plan asks, where the BAA gate above still reads
 * the current BAA template until plan C15 changes it. A DPA is signed only by
 * a practice outside HIPAA, so it must name this specialty and record no
 * covered answer but "No", and the clinic is stored as not covered. Last, the
 * kind must cover the specialty's regime with that answer, by the rule the PHI
 * gate applies (app_agreement_kind_sufficient, drizzle/0048): a BAA at a
 * veterinary practice, or a DPA at a practice HIPAA always reaches, never
 * becomes an account.
 */
async function agreementForProvisioning(request: ProvisionRequest): Promise<ProvisionedAgreement> {
  // validateProvisionRequest has already refused it on the route; this keeps
  // a direct caller from reaching regimeFor() with an id it would throw on.
  if (!isSpecialtyId(request.specialty)) {
    throw new ProvisioningError("Unknown specialty.", "specialty");
  }
  const [row] = await unsafeDb
    .select({ version: baaAcceptances.documentVersion, variables: baaAcceptances.variables })
    .from(baaAcceptances)
    .where(eq(baaAcceptances.id, request.agreementId))
    .limit(1);
  if (!row) {
    throw new ProvisioningError(
      "That agreement could not be attached — it may already belong to another account.",
      "agreementId",
    );
  }

  const kind = agreementKindOfVersion(row.version);
  const regime = regimeFor(request.specialty);
  const signed = (row.variables ?? {}) as { isCoveredEntity?: unknown; specialty?: unknown };

  let isCoveredEntity: boolean | null;
  if (kind === "dpa") {
    if (getDpaTemplate(row.version)?.approvedByCounsel !== true) {
      throw new Error(
        `Data protection agreement ${row.version} is not released. Refusing to provision a ` +
          `clinic against it: nothing may be signed under an unreleased template.`,
      );
    }
    if (signed.specialty !== request.specialty) {
      throw new ProvisioningError(
        "The signed agreement was written for a different kind of practice.",
        "specialty",
      );
    }
    if (signed.isCoveredEntity !== undefined && signed.isCoveredEntity !== false) {
      throw new ProvisioningError(
        "A data protection agreement is only for a practice outside HIPAA.",
        "agreementId",
      );
    }
    isCoveredEntity = false;
  } else {
    isCoveredEntity = typeof signed.isCoveredEntity === "boolean" ? signed.isCoveredEntity : null;
  }

  if (!agreementKindSufficient(regime, kind, isCoveredEntity)) {
    throw new ProvisioningError(
      kind === "baa"
        ? "A veterinary practice signs the data protection agreement, not the business associate agreement."
        : "This practice signs the business associate agreement, not the data protection agreement.",
      "agreementId",
    );
  }
  return { kind, regime, isCoveredEntity };
}

/**
 * Find or create the user for the buying address, and make it the owner of
 * the new clinic. An address that already has a clinic keeps its one user,
 * so one sign-in opens both.
 */
async function ensureOwner(
  tx: Transaction,
  input: { email: string; name: string; organizationId: string; clinicId: string; context: RequestContext },
): Promise<string> {
  const now = new Date();
  await tx
    .insert(user)
    .values({
      id: `usr_${randomUUID().replace(/-/g, "")}`,
      name: input.name || input.email,
      email: input.email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: user.email });
  const [owner] = await tx.select({ id: user.id }).from(user).where(eq(user.email, input.email)).limit(1);
  if (!owner) throw new Error("The owner's user could not be found after it was written.");

  await tx.insert(member).values({
    id: `mem_${randomUUID().replace(/-/g, "")}`,
    organizationId: input.organizationId,
    userId: owner.id,
    role: "owner",
    createdAt: now,
  });
  await tx.insert(clinicMemberships).values({ clinicId: input.clinicId, userId: owner.id, role: "owner" });
  await recordSecurityEvent(tx, {
    event: "role_granted",
    actorLabel: "provisioning",
    userId: owner.id,
    organizationId: input.organizationId,
    ipAddress: input.context.ipAddress ?? null,
    userAgent: input.context.userAgent ?? null,
    metadata: { role: "owner" },
  });
  return owner.id;
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

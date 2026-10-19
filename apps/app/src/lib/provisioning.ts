import { randomUUID } from "node:crypto";

import {
  agreementKindOfVersion,
  agreementPlatformFor,
  type AgreementKind,
  type CalendarAccount,
  CHANNELS,
  getBaaTemplate,
  getPlan,
  getPlatform,
  isBookingSystemId,
  isSpecialtyId,
  NO_PLATFORM_ID,
  platforms,
  regimeFor,
  type RegulatoryRegime,
  templateReadsCalendarAccount,
  emptyOnboarding,
} from "@healdesk/catalog";
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
import { agreementKindSufficient, agreementTemplateReleased } from "./agreements/kind";
import { recordAgreementTerms, signedCalendarTerms } from "./booking/elections";
import { log } from "./log";
import { AuditRecorder } from "./audit";
import { seedAgentConfig } from "./onboarding/agent-config";
import { addRecipient } from "./reporting/recipients";
import { recordSecurityEvent } from "./audit";
import type { RequestContext } from "./audit";
import { seedEntitlements } from "./billing/entitlements";
import { replayParkedBillingEvents } from "./billing/events";
import { clinicIdForStripe } from "./billing/resolve";
import { setupDeadline } from "./clinic/setup-window";
import { seedSetup, type SetupSeed } from "./setup/seed";
import { recordWelcomeOwed } from "./setup/welcome-email";

/**
 * Turning a completed checkout into a clinic.
 *
 * This is the one legitimate caller of `unsafeDb` besides Better Auth and
 * migrations: provisioning happens before a tenant exists, so there is no
 * clinic to scope it to. It follows the sequence the RLS policies require —
 * insert the clinic first (that table is not FORCEd), then declare the tenant,
 * then write everything that is.
 *
 * ## How the clinic signs in, and why nobody is invited
 *
 * The clinic signs in to its portal (plan Part D1) with its one email address.
 * Provisioning finds or creates the user for the buying address and makes it
 * the owner of the new clinic, in the clinic's own transaction (`ensureOwner`,
 * below). That user has no password and no invitation: every sign-in is a
 * single-use link (lib/sign-in/links.ts, and `startLinkSession` in
 * lib/auth.ts), the first handed only to the browser that paid, at /welcome
 * (lib/checkout/welcome.ts), and every later one mailed to the address, the
 * welcome email's "Continue setup" link among them. Patient pages ask for the
 * device's passkey on top.
 *
 * Provisioning used to end by writing a Better Auth `invitation` row instead,
 * which the provision route mailed as "choose a password", into a clinic
 * console that was later deleted. A pending invitation is a live credential
 * with a 14-day fuse, one per sale, and a password on a system holding patient
 * records is one more credential to guess, phish or forget to rotate. The
 * fewest credentials that can exist is the security property here, so no
 * invitation is written, no password can be set (lib/auth.ts), and the only
 * way in is a link to the clinic's own address.
 *
 * Gone with it is `ensureSystemUser()`, which existed for exactly one reason:
 * Better Auth's invitation table requires an inviterId and a self-serve
 * purchase has no human doing the inviting, so every provision upserted a
 * `usr_system_healdesk` row to name as the inviter. No invitation, no inviter.
 * Databases provisioned before this change still carry that row; nothing
 * authenticates as it and nothing reads it, and clearing it out is a migration
 * rather than a code path.
 *
 * The buyer receives what the purchase owes them by email: their signed
 * agreement as a PDF (sent at signing, before payment, from
 * lib/email/agreement-copy.ts) and the welcome email (B1), which the provision
 * route sends once this transaction has committed.
 *
 * The spec's three roles are deferred, so there is nobody else to invite: one
 * shared sign-in per clinic. If roles come back, an invitation is issued then,
 * to a named address, and the hooks in lib/auth.ts turn an accepted one into a
 * membership.
 *
 * ## Why the organization row stays
 *
 * `clinics.organizationId` is NOT NULL and references `organization`, and an
 * agreement binds to an organization id. It remains a data concept: the owner
 * is its `member`, but what opens a clinic is the `clinic_memberships` row
 * written beside it. Removing Better Auth's tables is a different and much
 * larger change than declining to write one row.
 *
 * ## Why provisioning does not record the BAA
 *
 * It already happened. The agreement is signed BEFORE payment, on its own
 * endpoint, because a business associate may not receive patient data without a
 * written contract — so it cannot be a side effect of a payment webhook that
 * may or may not arrive. By the time we reach here the signature exists; this
 * only binds it to the organization that payment just created.
 *
 * That is also why baa_acceptances.userId is nullable, and why a signing's row
 * keeps it null: the buyer signed before provisioning created their user. Their
 * name and email are frozen into their own columns on the acceptance row, so
 * the evidence never depends on the account.
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

// The request provisioning takes, its error and its validation live in the
// catalog since 14 October 2026 (packages/catalog/src/provision-request.ts),
// because apps/web holds a purchase to them before payment.
import { ProvisioningError, type ProvisionRequest } from "@healdesk/catalog";
export { ProvisioningError, validateProvisionRequest, type ProvisionRequest } from "@healdesk/catalog";

/** What provisioning also does when the purchase came through a checkout intent. */
export type ProvisionOptions = {
  /** Consumed in the same transaction, so an intent provisions one clinic. */
  intentRef?: string;
  /**
   * healdesk's own fictional demo clinic (owner decision Q6, plan §2.6): its
   * entitlements start `demo`, with no Stripe ids, so draft calendar terms
   * count on it (app_clinic_is_demo) and the Google verification video can
   * run before the calendar documents are released. Only
   * scripts/demo-clinic.ts passes it. It is an option, not a field of
   * ProvisionRequest, so /api/provision, which builds its options itself and
   * never from the body, cannot reach it; a demo clinic is never a purchase,
   * has no subscription, and never goes live (ops goLive refuses one).
   */
  demo?: boolean;
  /**
   * What the setup wizard starts from (plan C2): the funnel's booking answers
   * and the website read, from the intent. Absent for a purchase from before
   * intents, which still gets the defaults and the never-say list.
   */
  setup?: SetupSeed;
  /**
   * Stripe's hosted page for the paid first invoice, which holds the
   * setup-fee receipt, as the invoice.paid relay passed it. Kept on the
   * intent it pays for, so the welcome email (B1) links it on every attempt.
   */
  firstInvoiceUrl?: string | null;
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
  /**
   * A replay found by the Stripe customer alone: the clinic exists for this
   * customer under another subscription, so a second subscription was paid
   * for one practice. The caller tells ops (duplicate_subscription); nothing
   * is made for it.
   */
  duplicateSubscription?: boolean;
};

export async function provisionClinic(
  request: ProvisionRequest,
  context: RequestContext = {},
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const email = request.contactEmail.trim().toLowerCase();

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

  if (
    options.demo &&
    (options.intentRef || request.stripeCustomerId || request.stripeSubscriptionId)
  ) {
    throw new ProvisioningError(
      "A demo clinic is not a purchase: it has no checkout intent and no Stripe subscription.",
    );
  }

  // An existing clinic for the subscription or the customer is a replay too
  // (plan C1). The key above is the subscription id on the Stripe path, but
  // a second subscription for the same customer carries a new key, and
  // without this it would make a second clinic for a practice that already
  // has one. Checked again under a lock inside the transaction, for two
  // deliveries racing past this read.
  const existing = await clinicForStripe(request);
  if (existing) return existing;

  // Which paper the clinic is under, and whether it may be provisioned
  // against it (plan Part L), decided before anything is written: the
  // approval gate on the signed row's own version, and where that row says
  // the practice's bookings live (plan C15).
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
      return await provisionOnce({ request, context, options, email, slug, agreement });
    } catch (error) {
      if (error instanceof StripePurchaseProvisioned) {
        const replay = await clinicForStripe(request);
        if (replay) return replay;
      }
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
  slug,
  agreement,
}: {
  request: ProvisionRequest;
  context: RequestContext;
  options: ProvisionOptions;
  email: string;
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
    // One provisioning at a time per Stripe customer, and the customer-level
    // replay asked again under that lock (see clinicForStripe): two
    // deliveries for two subscriptions of one customer would otherwise both
    // pass the read before the transaction and make two clinics. Before the
    // tenant is declared, because app_clinic_for_stripe looks across tenants
    // only while none is (drizzle/0028).
    if (request.stripeCustomerId || request.stripeSubscriptionId) {
      const purchaseKey = request.stripeCustomerId ?? request.stripeSubscriptionId!;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`provision:stripe:${purchaseKey}`}, 0))`,
      );
      const found = await tx.execute<{ clinic_id: string | null }>(
        sql`select app_clinic_for_stripe(${request.stripeCustomerId ?? null}::text, ${request.stripeSubscriptionId ?? null}::text) as clinic_id`,
      );
      if (found.rows[0]?.clinic_id) throw new StripePurchaseProvisioned();
    }

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
      // Where the practice's bookings live, as the agreement it signed says,
      // not as the purchase says (plan C15; agreementForProvisioning).
      bookingProvider: agreement.bookingProvider,
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
      // The gate columns (drizzle/0051): the specialty's regime and the kind of
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

    // A purchase that names another booking system than its agreement is
    // provisioned as signed, not refused (plan C15): what the practice signed
    // is what the clinic runs under, and a refusal here comes after payment,
    // leaving a customer charged with no account. It is recorded, because the
    // checkout's own check before payment (agreementMismatch) refuses such a
    // purchase, so one that reaches here came another way: a request from
    // before checkout intents, or a fault.
    if (agreement.platformMismatch) {
      await recordSecurityEvent(tx, {
        event: "provision_platform_mismatch",
        actorLabel: "provisioning",
        organizationId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        metadata: {
          clinicId,
          clinicSlug: slug,
          agreementId: request.agreementId,
          purchasePlatform: request.platform,
          signedPlatform: agreement.platformMismatch.signedPlatform,
          bookingProvider: agreement.bookingProvider,
        },
      });
    }

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
      demo: options.demo === true,
    });

    // What was sold stays on record beside what is billed (plan_code follows
    // the channels in service once the plan starts), and the setup window
    // ends on the clinic's own calendar: the 30th day after today. A demo
    // clinic bought nothing, so it has no setup window to close it at.
    await tx
      .update(entitlements)
      .set({
        boughtPlanId: plan.id,
        setupDeadlineAt: options.demo
          ? null
          : setupDeadline(new Date(), request.timezone ?? "America/New_York"),
      })
      .where(eq(entitlements.clinicId, clinicId));

    // One row per channel the package includes: where each stands, from
    // setting up to live, and what the price steps up by (contracts §2).
    // Meta Chat includes website chat, but a practice that told the funnel it
    // has no website gets no website row: the wizard and Home would otherwise
    // list a step it can never finish. Billing reads the rows in service, so
    // the missing row costs it nothing (catalog planForChannels).
    const noWebsite = options.setup?.website === null;
    const bought = CHANNELS.filter(
      (channel) => plan.channels[channel] && !(channel === "web" && noWebsite && plan.chatProduct === "metachat"),
    );
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
          firstInvoiceUrl: options.firstInvoiceUrl ?? null,
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
    // The location's first calendar terms are the calendar clause its
    // agreement carries, from BAA 1.3.0 on and in the DPA: recorded as its
    // `agreement` election, sequence 1 (plan §2.6, §3.4(c), C15), so the
    // terms in effect (calendarTermsFor) are what the practice signed rather
    // than a request for an election. A signature before 1.3.0 carries none,
    // and the location books by request until the practice records an
    // election (plan §2.8). The election guard (app_calendar_election_guard)
    // checks the row against the bound acceptance again, and refuses it for
    // any location but the one this signature sets up.
    if (agreement.calendarTerms) {
      await recordAgreementTerms(provisioningTx, request.agreementId);
    }
    // The buyer is the first recipient of the monthly report; the clinic can
    // point it at a front-desk inbox later from the console.
    await addRecipient(provisioningTx, {
      email: request.contactEmail,
      label: request.contactName.trim() || undefined,
      addedBy: "provisioning",
    });
    // The setup wizard's starting point (plan C2): settings from the funnel's
    // answers, knowledge from the website read, the read kept as the drift
    // baseline, and the never-say list's clinical defaults. The welcome email
    // (B1) goes after commit, from the provision route.
    // One booking system for the clinic (design record §6, A1): the wizard's
    // settings take the booking system and the Google account the agreement
    // was signed with, as clinics.booking_provider does, and a funnel answer
    // that differs from them is recorded rather than seeded.
    const settled = settleSetupSeed(options.setup ?? {}, agreement);
    if (settled.differs && !agreement.platformMismatch) {
      await recordSecurityEvent(tx, {
        event: "provision_platform_mismatch",
        actorLabel: "provisioning",
        organizationId,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        metadata: {
          clinicId,
          clinicSlug: slug,
          agreementId: request.agreementId,
          purchaseBookingSystem: options.setup?.bookingSystem ?? null,
          signedBookingSystem: settled.seed.bookingSystem ?? null,
          bookingProvider: agreement.bookingProvider,
        },
      });
    }
    await seedSetup(provisioningTx, {
      specialty: request.specialty,
      seed: settled.seed,
      callRouting: request.callRouting,
    });
    // The welcome email is owed from this commit on: its ledger row is
    // written here, so a send that never runs after commit (the process
    // exits, its first read fails) still leaves a row the hourly backstop
    // finds and sends (X1.4, "state is written first").
    await recordWelcomeOwed(provisioningTx);
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
        ...(options.demo ? { demo: true } : {}),
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

/**
 * The setup wizard's seed, settled against the signed agreement (design
 * record §6, A1). The funnel's answers seed the wizard's settings, and the
 * agreement settles clinics.booking_provider; the two must name one booking
 * system, and where they differ the signed one wins, as it does for the clinic
 * row:
 *
 * - a document that reads the calendar answers (BAA 1.3.0 on, the DPA) gives
 *   the booking system and the kind of Google account it was signed with;
 * - an earlier document names a platform: the funnel's booking system is
 *   kept when that platform is its own (it is the finer answer), the signed
 *   booking system is taken when the row names one, and otherwise none is
 *   seeded and the wizard asks.
 *
 * `differs` says the funnel's booking-system answer was not the one settled.
 */
function settleSetupSeed(
  seed: SetupSeed,
  agreement: ProvisionedAgreement,
): { seed: SetupSeed; differs: boolean } {
  const settled: SetupSeed = { ...seed };
  if (agreement.calendarTerms && isBookingSystemId(agreement.bookingProvider)) {
    settled.bookingSystem = agreement.bookingProvider;
    if (agreement.calendarAccount) settled.calendarAccount = agreement.calendarAccount;
  } else if (isBookingSystemId(agreement.bookingProvider)) {
    settled.bookingSystem = agreement.bookingProvider;
  } else if (
    seed.bookingSystem &&
    agreementPlatformFor(seed.bookingSystem) !== (agreement.bookingProvider ?? NO_PLATFORM_ID)
  ) {
    delete settled.bookingSystem;
  }
  return {
    seed: settled,
    differs: seed.bookingSystem !== undefined && settled.bookingSystem !== seed.bookingSystem,
  };
}

/** The agreement a clinic is provisioned under, as read from the signed row. */
type ProvisionedAgreement = {
  kind: AgreementKind;
  regime: RegulatoryRegime;
  /** The determination that goes on the clinic row: the signed answer under a BAA, false under a DPA. */
  isCoveredEntity: boolean | null;
  /**
   * What goes in clinics.booking_provider: the booking system the agreement
   * names (an id of BOOKING_SYSTEMS, as an election records it), or, where
   * it names only a phase-two platform, that platform, null for none
   * (signedBookingSystem).
   */
  bookingProvider: string | null;
  /** The platform the agreement names, when the purchase names another. The agreement's wins. */
  platformMismatch: { signedPlatform: string } | null;
  /** The kind of Google account the agreement was signed with, where it reads one (1.3.0 on, the DPA). */
  calendarAccount: CalendarAccount | null;
  /**
   * Whether the agreement carries the location's first calendar terms: it
   * chose its calendar clause from the booking system and the kind of Google
   * account, as BAA 1.3.0 on and the DPA do.
   */
  calendarTerms: boolean;
};

/**
 * Read the signed agreement before anything is written, and refuse a clinic
 * its agreement cannot cover (plan Part L, "Hand-offs"; plan C15).
 *
 * The kind comes from the row's own version (`agreementKindOfVersion`, the
 * mirror of the generated `baa_acceptances.agreement_kind`), never from the
 * request, and so does the approval gate: the row is put in force only under
 * a version that may be (agreementTemplateReleased), a BAA go-live accepts
 * (isBaaVersionAcceptable: released, and no older than the floor) or a
 * released DPA. Until plan C15 the BAA gate asked whether the CURRENT
 * template was approved, which let through a row signed under any other
 * version, a draft or a superseded one, while the current one was released.
 *
 * A DPA is signed only by a practice outside HIPAA, so it must name this
 * specialty and record no covered answer but "No", and the clinic is stored
 * as not covered. Then the kind must cover the specialty's regime with that
 * answer, by the rule the PHI gate applies (app_agreement_kind_sufficient,
 * drizzle/0051): a BAA at a veterinary practice, or a DPA at a practice HIPAA
 * always reaches, never becomes an account. Last, where the row says the
 * practice's bookings live (signedBookingSystem), which the clinic takes in
 * place of the purchase's answer.
 *
 * Every refusal is a ProvisioningError, the release gate's included: the row
 * never changes, so a retry meets the same answer, and the route's 422 marks
 * a paid purchase failed and tells ops, where a 500 would have Stripe retry
 * it for three days while the buyer waits.
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
  if (!agreementTemplateReleased(row.version)) {
    throw new ProvisioningError(
      kind === "dpa"
        ? `Version ${row.version} of the data protection agreement is not released, so no ` +
            `account can be made under it.`
        : `Version ${row.version} of the business associate agreement can't be used for a new ` +
            `account: it is not released, or a later version has replaced it.`,
      "agreementId",
    );
  }
  const regime = regimeFor(request.specialty);
  const signed = (row.variables ?? {}) as Record<string, unknown>;

  let isCoveredEntity: boolean | null;
  if (kind === "dpa") {
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

  const booking = signedBookingSystem(kind, row.version, signed);
  let bookingProvider = booking.bookingProvider;
  let platformMismatch: ProvisionedAgreement["platformMismatch"] = null;
  if (booking.platform === null) {
    // A row that names no platform this catalogue can read back, which is
    // not one signing writes: the purchase's own answer is recorded, as it
    // was before plan C15, and the gap is logged (plan §3.4(b)).
    log.warn("signed agreement names no known platform; recorded the purchase's platform", {
      agreementId: request.agreementId,
    });
    bookingProvider = request.platform === NO_PLATFORM_ID ? null : request.platform;
  } else if (booking.platform !== request.platform) {
    platformMismatch = { signedPlatform: booking.platform };
  }
  return {
    kind,
    regime,
    isCoveredEntity,
    bookingProvider,
    platformMismatch,
    calendarAccount: booking.calendarAccount,
    calendarTerms: booking.calendarTerms,
  };
}

/**
 * Where a signed agreement says the practice's bookings live, and whether it
 * carries calendar terms for the location it sets up (plan §3.4, C15). Read
 * off the signed row alone: it is what the practice agreed to, where the
 * purchase is only what was sent with it.
 *
 * - A document that chose its calendar clause from the two calendar answers
 *   (templateReadsCalendarAccount: BAA 1.3.0 on, and the DPA, which takes
 *   the same clauses) names the booking system itself. The row must hold
 *   both answers and the one calendar clause it was signed with, a clause
 *   for the kind of Google account signed (signedCalendarTerms, which
 *   recordAgreementTerms reads too); anything else is refused here, before a
 *   row is written, rather than inside provisioning's transaction. The
 *   clause need not be the one the catalogue would select today: a booking
 *   system reclassified after signing leaves the signed clause in force, and
 *   recordAgreementTerms records it as signed and logs the difference. Its
 *   platform is the booking system's own (agreementPlatformFor), which is
 *   what a purchase of it names.
 * - An earlier document names a phase-two platform: the one signing kept
 *   (`platformId`, since plan C3), else the one whose name it rendered
 *   (`connectedPlatform`, null for none). The booking system the buyer
 *   answered, which signing has kept beside it since plan C3, is the finer
 *   answer ("Google Calendar only" and "No booking system yet" both name no
 *   platform) and is recorded when that platform is its own; otherwise the
 *   platform is, null for none, as provisioning has always recorded it.
 *   `platform` is null when the row names nothing this catalogue knows.
 */
function signedBookingSystem(
  kind: AgreementKind,
  version: string,
  signed: Record<string, unknown>,
): {
  calendarTerms: boolean;
  bookingProvider: string | null;
  platform: string | null;
  calendarAccount: CalendarAccount | null;
} {
  const template = kind === "baa" ? getBaaTemplate(version) : undefined;
  if (kind === "dpa" || (template !== undefined && templateReadsCalendarAccount(template))) {
    const terms = signedCalendarTerms(signed);
    if (terms.status !== "signed") {
      throw new ProvisioningError(
        "The signed agreement does not record the calendar terms it was signed with.",
        "agreementId",
      );
    }
    return {
      calendarTerms: true,
      bookingProvider: terms.bookingSystem,
      platform: agreementPlatformFor(terms.bookingSystem),
      calendarAccount: terms.calendarAccount,
    };
  }

  const platform = namedPlatform(signed);
  if (platform === null) {
    return { calendarTerms: false, bookingProvider: null, platform: null, calendarAccount: null };
  }
  const answered = signed.bookingSystem;
  if (isBookingSystemId(answered) && agreementPlatformFor(answered) === platform) {
    return { calendarTerms: false, bookingProvider: answered, platform, calendarAccount: null };
  }
  return {
    calendarTerms: false,
    bookingProvider: platform === NO_PLATFORM_ID ? null : platform,
    platform,
    calendarAccount: null,
  };
}

/** The phase-two platform a document before BAA 1.3.0 names, or null when its row names none we know. */
function namedPlatform(signed: Record<string, unknown>): string | null {
  if (typeof signed.platformId === "string" && getPlatform(signed.platformId)) {
    return signed.platformId;
  }
  if (signed.connectedPlatform === null) return NO_PLATFORM_ID;
  const named = platforms.find(
    (p) => p.id !== NO_PLATFORM_ID && p.name === signed.connectedPlatform,
  );
  return named?.id ?? null;
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

/** Thrown inside the transaction when the Stripe purchase already has its clinic: rolled back, then answered as a replay. */
class StripePurchaseProvisioned extends Error {
  constructor() {
    super("A clinic already exists for this Stripe customer or subscription.");
    this.name = "StripePurchaseProvisioned";
  }
}

/**
 * The clinic already made for this purchase's Stripe subscription or
 * customer, as a replay, or null (plan C1: "an existing clinic for the
 * subscription or customer is a replay").
 *
 * The subscription first, then the customer, through the definer lookup
 * billing events use (lib/billing/resolve.ts): it returns one id and nothing
 * else about the clinic. A clinic found only by the customer, while this
 * request names a subscription, is a second subscription paid for one
 * practice: still a replay, so nothing is made and nothing customer-visible
 * happens again, but flagged so the route tells ops. The demo clinic has no
 * Stripe ids and never reaches this.
 */
async function clinicForStripe(request: ProvisionRequest): Promise<ProvisionResult | null> {
  const subscriptionId = request.stripeSubscriptionId ?? null;
  const customerId = request.stripeCustomerId ?? null;
  if (!subscriptionId && !customerId) return null;
  const bySubscription = subscriptionId ? await clinicIdForStripe(null, subscriptionId) : null;
  const clinicId = bySubscription ?? (customerId ? await clinicIdForStripe(customerId, null) : null);
  if (!clinicId) return null;
  const [row] = await unsafeDb
    .select({
      organizationId: provisioningAttempts.organizationId,
      clinicSlug: provisioningAttempts.clinicSlug,
    })
    .from(provisioningAttempts)
    .where(eq(provisioningAttempts.clinicId, clinicId))
    .limit(1);
  if (!row) {
    // Every provisioned clinic has its ledger row; one without is not ours
    // to answer for, and making a second clinic would be worse than asking.
    throw new ProvisioningError(
      "This Stripe customer already has a clinic that provisioning did not make. Ops must finish it by hand.",
      "stripeCustomerId",
    );
  }
  log.info("provisioning replayed for an existing Stripe purchase", {
    clinicId,
    reason: bySubscription ? "subscription" : "customer",
  });
  return {
    organizationId: row.organizationId,
    clinicId,
    clinicSlug: row.clinicSlug,
    replayed: true,
    ...(bySubscription === null && subscriptionId ? { duplicateSubscription: true } : {}),
  };
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


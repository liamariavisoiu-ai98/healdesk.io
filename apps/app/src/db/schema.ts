import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  type AgreementKind,
  type BillingInterval,
  type BookingSystemId,
  type CalendarAccount,
  type Channel,
  CHANNELS,
  type OnboardingState,
  type RegulatoryRegime,
} from "@healdesk/catalog";

import type { OpeningHours } from "../lib/clinic/opening-hours";
import type { SealedPayload } from "../lib/crypto/envelope";
import { NOTICE_KINDS } from "../lib/email/kinds";
import { DEVICE_LABEL_MAX } from "../lib/factors/device";

import { organization, user } from "./auth-schema";

/**
 * ⚠️  PHI BOUNDARY — read docs/hipaa-compliance.md before touching this file.
 *
 * Several tables here hold protected health information: a caller's phone
 * number attached to a treatment inquiry is PHI, and so is anything read back
 * out of a clinic's EMR or POS. Real patient data must not reach a clinic whose
 * `dataClassification` is 'production' without a signed BAA — enforced by a
 * database trigger, not by memory. See drizzle/0004_baa_gate.sql.
 *
 * ---
 *
 * The model answers one question incumbents structurally cannot:
 *
 *     which recovered call became booked, showed, and collected revenue?
 *
 * That is a join across four systems the clinic already runs — the ad platform,
 * the booking system, check-in, and the point-of-sale. Each stage carries its
 * own `*ExternalId` so a row can be traced back to its source independently,
 * which is what makes the reconciliation auditable rather than inferred.
 *
 * See docs/prd.md → "The gap to own".
 */

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

export const channelEnum = pgEnum("channel", [
  "voice",
  "sms",
  "web_chat",
  "instagram_dm",
  "whatsapp",
  "web_form",
]);

/**
 * The ways a contact reaches us that the clinic would otherwise have lost.
 *
 * This replaced a single `is_recovered_missed_call` boolean, which counted only
 * the last of these and therefore UNDERSTATED the product: a call at 9pm that
 * the agent answered live was, by that definition, not recovered — even though
 * nobody at the clinic was ever going to pick it up.
 *
 * Each value is a distinct, observable fact at the moment the call arrives, so
 * none of them requires a judgement call later:
 *
 *   after_hours          — outside the clinic's own opening hours.
 *   line_busy            — their line was already engaged; a simultaneous call.
 *   rang_unanswered      — rang at the clinic, nobody picked up, we took it live.
 *   missed_call_callback — it rang out, and we called the number back.
 *
 * Null means none of these applied. See conversations.recoveryReason.
 */
/**
 * How the clinic's calls reach us — and therefore what "recovered" means.
 *
 * This is the fact the whole recovered-revenue figure rests on, and it is a
 * property of the clinic's phone configuration, not of any single call.
 *
 *   conditional — their published number rings at the clinic FIRST and forwards
 *                 to us on no-answer or busy. Every call we answer is therefore
 *                 one their receptionist did not, whatever time of day it is.
 *                 This is the normal setup and the one the product is sold on.
 *
 *   always      — we are the primary answerer; calls come straight to us. The
 *                 AI is not taking the call "instead of" anyone, so answering it
 *                 during staffed hours is the service working, not revenue
 *                 recovered. Only calls nobody at the clinic could have taken —
 *                 outside opening hours — or callbacks we placed ourselves count.
 *
 * Getting this wrong in the "always" direction would count every single call as
 * recovered, which would inflate the one number a clinic judges us on to the
 * point of meaninglessness.
 */
export const callRoutingEnum = pgEnum("call_routing", [
  "conditional",
  "always",
]);

export const recoveryReasonEnum = pgEnum("recovery_reason", [
  "after_hours",
  "line_busy",
  "rang_unanswered",
  "missed_call_callback",
]);

export const conversationOutcomeEnum = pgEnum("conversation_outcome", [
  "booked",
  "qualified_no_booking",
  "price_shopper",
  "escalated_to_human",
  "spam",
  "abandoned",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "confirmed",
  "showed",
  "no_show",
  "cancelled",
  "rescheduled",
]);

/**
 * Gate on real patient data. A clinic starts 'synthetic' and only moves to
 * 'production' once its BAA is signed — at which point the trigger in
 * drizzle/0004_baa_gate.sql starts allowing PHI writes.
 */
export const dataClassificationEnum = pgEnum("data_classification", [
  "synthetic",
  "production",
]);

/** Per-location PHI access. Deliberately finer-grained than Better Auth's org roles. */
export const clinicRoleEnum = pgEnum("clinic_role", [
  "owner",
  "admin",
  "clinician",
  "front_desk",
  "billing",
  "read_only",
]);

export const actorTypeEnum = pgEnum("actor_type", [
  "user", // a signed-in human
  "service", // an internal job: reconciliation, retention sweep, seed
  "connector", // an outbound integration acting for the clinic
  "agent", // the voice/SMS agent inside a conversation
  "system", // the database or platform itself
]);

export const connectionStatusEnum = pgEnum("connection_status", [
  "pending",
  "active",
  "degraded",
  "revoked",
  "error",
]);

/**
 * How this clinic's recovered revenue is calculated.
 *
 *   estimated — from the clinic's own average treatment value. No integration,
 *               so nothing blocks the purchase. The default.
 *   verified  — read from actual settled sales through a read-only connection.
 *
 * Reports must state which one produced the number. An estimate presented as a
 * measurement is the dishonesty this product exists to replace.
 */
export const attributionModeEnum = pgEnum("attribution_mode", [
  "estimated",
  "verified",
]);

/**
 * What kind of phone line the clinic publishes.
 *
 * Asked at onboarding because it decides whether the clinic's own number can be
 * text-enabled: a carrier will text-enable a landline or toll-free number, but
 * NOT a VoIP number — and a large share of clinics publish RingCentral, Nextiva
 * or Dialpad. Call forwarding works either way, so voice is unaffected; it is
 * the SMS reminder fallback that silently has nowhere to go.
 *
 * "unknown" is the honest default and a common real answer. Most owners do not
 * know what their phone system is, and guessing produces a confident wrong
 * value that surfaces as a failed provisioning weeks later.
 */
export const phoneSystemTypeEnum = pgEnum("phone_system_type", [
  "landline",
  "voip",
  "unknown",
]);

// -----------------------------------------------------------------------------
// Tenancy
// -----------------------------------------------------------------------------

/**
 * A LOCATION, and the root of every PHI query.
 *
 * `organization` (Better Auth) is the customer account — billing, invites,
 * settings. A clinic is one of its physical locations. Single-site clinics are
 * an org with one row here; a three-location group is one org with three, which
 * an org-as-tenant model could not represent.
 *
 * The PHI blast radius is deliberately smaller than the billing entity: a
 * front-desk hire at the Scottsdale location gets Scottsdale only. HIPAA
 * §164.502(b) minimum-necessary wants exactly that.
 */
export const clinics = pgTable(
  "clinics",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * RESTRICT, not cascade: deleting a billing account must never be a path to
     * deleting patient records. It refuses instead.
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),

    /** Route segment: /c/[slug]. Globally unique so routing needs no org lookup. */
    slug: text("slug").notNull(),

    name: text("name").notNull(),
    /** Matches an id in apps/web's specialty catalogue where they overlap. */
    specialty: text("specialty").notNull(),
    timezone: text("timezone").notNull().default("America/New_York"),

    /** From the purchase-flow picker. "none" is a first-class answer, not a gap. */
    bookingProvider: text("booking_provider"),
    posProvider: text("pos_provider"),

    /**
     * Landline/toll-free vs VoIP. Gates whether the text-back number can be
     * provisioned against the clinic's own published line. See the enum.
     */
    phoneSystemType: phoneSystemTypeEnum("phone_system_type")
      .notNull()
      .default("unknown"),

    /**
     * Whether their line rings at the clinic before it reaches us.
     *
     * Decides what counts as recovered — see the enum. Defaults to
     * "conditional" because that is what the onboarding wizard configures and
     * what the product is sold on, and because the alternative default would
     * silently mark a clinic's entire call volume as recovered.
     */
    callRouting: callRoutingEnum("call_routing").notNull().default("conditional"),

    /**
     * When the clinic's own front desk is open, in `timezone` above.
     *
     * The input to `recovery_reason = 'after_hours'`. Ingestion cannot decide
     * that a 9pm call would have been missed without knowing the clinic shuts
     * at 5 — and that is the single largest category of genuinely recovered
     * contacts, so leaving it uncollected quietly understates every report.
     *
     * NULL means not yet collected, and it is not the same as "closed". Nothing
     * may infer hours from a default: a clinic wrongly assumed to close at 5
     * would have its 6pm calls claimed as recovered when its own staff answered
     * them, which overstates in the one number a clinic checks us on. Where
     * this is null, ingestion records no after-hours reason at all.
     *
     * Shape is validated by parseOpeningHours() in lib/clinic/opening-hours.ts
     * rather than by the column, because a check constraint over JSON is hard
     * to read and harder to change. See that file for the format.
     */
    openingHours: jsonb("opening_hours").$type<OpeningHours>(),

    attributionMode: attributionModeEnum("attribution_mode")
      .notNull()
      .default("estimated"),

    /**
     * What one booked appointment is typically worth here, in USD.
     *
     * This is the entire input to estimated attribution, which is the default
     * path — so it is asked during checkout rather than inferred. Inferring it
     * from a specialty average would produce a confident number about a
     * specific clinic derived from none of its data.
     */
    averageTreatmentValueUsd: numeric("average_treatment_value_usd", {
      precision: 12,
      scale: 2,
    }),

    /**
     * Package id from @healdesk/catalog, as sold. Kept for the overview and the
     * report; the row that actually decides what the clinic may use is
     * `entitlements.planCode`, which moves with plan changes from Stripe while
     * this records what was bought at checkout.
     */
    plan: text("plan"),

    /**
     * ⚠️ Whether this clinic is a HIPAA covered entity at all.
     *
     * Cash-pay med spas that never bill insurance electronically are NOT
     * covered entities — which means no BAA, and the loss of five separate
     * legal defences at once. Determined at onboarding, not assumed.
     * See docs/hipaa-compliance.md.
     */
    isCoveredEntity: boolean("is_covered_entity"),
    baaSignedAt: timestamp("baa_signed_at", { withTimezone: true }),

    /**
     * The regime of the clinic's specialty when it was provisioned
     * (`regimeFor` in @healdesk/catalog): 'hipaa', 'hipaa-if-covered' or
     * 'non-hipaa'. With `agreementKind` and `isCoveredEntity` it is what
     * app_agreement_kind_sufficient() reads (drizzle/0051) to decide whether
     * the agreement in force covers this clinic's data, which the PHI gate
     * asks on every write. A gate column: provisioning writes it on insert and
     * the runtime role holds no UPDATE on it, so a later edit of `specialty`
     * does not move it.
     */
    regulatoryRegime: text("regulatory_regime").$type<RegulatoryRegime>(),
    /**
     * The kind of data agreement the clinic is under, 'baa' or 'dpa', taken at
     * provisioning from the bound acceptance's version and moved afterwards
     * only by app_supersede_agreement(), from a DPA to a BAA (drizzle/0051).
     * A gate column like `regulatoryRegime`. Null only on a clinic created
     * before 0051 whose organisation held no bound agreement, which the PHI
     * gate treats as it always has.
     */
    agreementKind: text("agreement_kind").$type<AgreementKind>(),

    /**
     * The retention clocks, in days, per clinic. Two, because the two kinds
     * of data have different value and different risk:
     *
     *   media   — transcript references. Pure liability after the dispute
     *             window closes; 90 days by default. (No audio is kept.)
     *   records — the conversation, appointment and transaction rows. 90
     *             days by default too, because the BAA says "healdesk keeps
     *             transcripts and conversation records for 90 days"
     *             (TRANSCRIPT_RETENTION_DAYS in @healdesk/catalog). It was
     *             730 until 0048, for a year-over-year revenue report that
     *             is phase two, and a default the agreement contradicts is
     *             wrong for every clinic that keeps it.
     *
     * Consent records, suppressions and contact attempts are NOT on either
     * clock: they are the evidence that a call was lawful and that an
     * opt-out was honoured, and deleting evidence is not a privacy control.
     * The purge job (lib/retention/purge.ts) is the only reader.
     */
    retentionMediaDays: integer("retention_media_days").notNull().default(90),
    retentionRecordDays: integer("retention_record_days").notNull().default(90),

    // --- Onboarding: the road from payment to the first answered call. ---
    /**
     * `{ [OnboardingStep]: ISO timestamp | null }` from @healdesk/catalog.
     * Seeded with every step null at provisioning. Kept on the clinic row
     * rather than in a table so the ops overview (a SECURITY DEFINER over
     * clinics only) can show open steps without a second privileged reader.
     */
    onboarding: jsonb("onboarding").$type<OnboardingState>().notNull().default({}),
    /** Who bills the clinic for its main line; decides the forwarding codes. */
    carrier: text("carrier"),
    /** The Synthflow-issued number the clinic forwards to, E.164. */
    synthflowNumberE164: text("synthflow_number_e164"),
    /**
     * The clinic's own published number, E.164. A forwarded call that arrives
     * carrying THIS as its caller ID has lost the caller: the carrier
     * substituted the forwarding line. The forwarding test checks for it.
     */
    publishedPhoneE164: text("published_phone_e164"),
    /**
     * The forwarding test: an operator opens a short window; the first call to
     * arrive inside it is the test, and what was observed about it is written
     * to forwarding_test_observed and stamps test_call_passed when it passed.
     */
    forwardingTestUntil: timestamp("forwarding_test_until", { withTimezone: true }),
    forwardingTestObserved: jsonb("forwarding_test_observed").$type<ForwardingTestObservation>(),
    /**
     * Stripe Connect (Standard) account for deposits into the clinic's own
     * Stripe. An account id, never a key: the platform's own secret authorises
     * calls on its behalf.
     */
    stripeConnectAccountId: text("stripe_connect_account_id"),
    stripeConnectConnectedAt: timestamp("stripe_connect_connected_at", { withTimezone: true }),
    /**
     * The Meta front door (Messenger, Instagram, WhatsApp): off by default,
     * switched on per clinic by an operator once the clinic has accepted the
     * pattern's named residual risk. See lib/meta/front-door.ts.
     */
    metaFrontDoorEnabled: boolean("meta_front_door_enabled").notNull().default(false),

    // --- Booking mode and the requirement set (0040). ---
    /**
     * How a request becomes an appointment. `desk_confirms` (the default): the
     * practice's human decides on the single-use page. `direct`: the voice
     * agent books a calendar slot on the call itself. Direct is representable
     * only while a recorded, unwithdrawn election of the direct-booking
     * addendum exists — a CHECK in 0040, not a code path, so a forgotten
     * guard cannot switch a clinic to direct by accident.
     */
    bookingMode: text("booking_mode").$type<BookingMode>().notNull().default("desk_confirms"),
    directBookingElectedAt: timestamp("direct_booking_elected_at", { withTimezone: true }),
    directBookingElectedByLabel: text("direct_booking_elected_by_label"),
    directBookingClauseVersion: text("direct_booking_clause_version"),
    /**
     * SHA-256 of the addendum text as elected, so "what exactly did they agree
     * to" stays answerable after the catalogue text moves on. Inline bytea for
     * the reason booking_requests.tokenHash is: the shared helper is declared
     * further down this file and a const is not hoisted.
     */
    directBookingClauseHash: customType<{ data: Buffer }>({ dataType: () => "bytea" })("direct_booking_clause_hash"),
    directBookingWithdrawnAt: timestamp("direct_booking_withdrawn_at", { withTimezone: true }),
    /**
     * Stamped by the ops op setClinicTimezone. NULL means `timezone` is still
     * the provisioning default: a guess, not an answer the clinic gave.
     */
    timezoneConfirmedAt: timestamp("timezone_confirmed_at", { withTimezone: true }),
    /**
     * The booking-field ids (from @healdesk/catalog) the assistant collects
     * for this practice; NULL means the specialty defaults apply. Minimum
     * necessary: exactly these, and nothing clinical.
     */
    bookingRequirements: jsonb("booking_requirements").$type<string[]>(),
    bookingRequirementsConfirmedAt: timestamp("booking_requirements_confirmed_at", { withTimezone: true }),
    /** Who settled the set: the practice on its setup link, an operator on the call, or the defaults when the link expired. */
    bookingRequirementsSource: text("booking_requirements_source").$type<BookingRequirementsSource>(),

    /** When call_routing stopped being the column default and became an answer. */
    callRoutingConfirmedAt: timestamp("call_routing_confirmed_at", { withTimezone: true }),
    /** Denormalised from agent_configs.approved_at so the overview can read it. */
    agentApprovedAt: timestamp("agent_approved_at", { withTimezone: true }),
    /** When app_mark_clinic_production() ran. */
    wentLiveAt: timestamp("went_live_at", { withTimezone: true }),

    // --- Offboarding: the BAA's return-or-destroy clause, as dates. ---
    /** The clinic left (subscription deleted, or an operator ended it). */
    offboardingStartedAt: timestamp("offboarding_started_at", { withTimezone: true }),
    /** The export was produced and handed over; destruction may proceed after destroy_after. */
    exportDeliveredAt: timestamp("export_delivered_at", { withTimezone: true }),
    /** Hard-delete of every PHI row is allowed from this instant. */
    destroyAfter: timestamp("destroy_after", { withTimezone: true }),
    /** The destruction ran. The clinic row and its audit trail remain; nothing else does. */
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),

    // --- Billing across locations and the deposit account (0043). ---
    /**
     * The clinic that holds the subscription this location is billed on. NULL
     * means the clinic is its own billing clinic, which is every clinic bought
     * at checkout. A location added from the portal points here, so its usage
     * counts against the pooled allowance of the billing clinic and its
     * billing notices go to that clinic's owners. RESTRICT, not cascade: a
     * billing clinic cannot be deleted out from under its locations.
     */
    billingClinicId: uuid("billing_clinic_id").references((): AnyPgColumn => clinics.id, {
      onDelete: "restrict",
    }),
    /**
     * When the Stripe Connect account was disconnected (by the clinic, an
     * operator, or Stripe's deauthorisation event). Kept after the account id
     * is cleared, so "why did deposits stop" has a date to point at.
     */
    stripeConnectDisconnectedAt: timestamp("stripe_connect_disconnected_at", { withTimezone: true }),

    /** The BAA gate, made mechanical. See drizzle/0004_baa_gate.sql. */
    dataClassification: dataClassificationEnum("data_classification")
      .notNull()
      .default("synthetic"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("clinics_slug_idx").on(t.slug),
    index("clinics_org_idx").on(t.organizationId),
    index("clinics_billing_clinic_idx")
      .on(t.billingClinicId)
      .where(sql`${t.billingClinicId} is not null`),
    check(
      "clinics_billing_clinic_not_self",
      sql`${t.billingClinicId} is null or ${t.billingClinicId} <> ${t.id}`,
    ),
    check(
      "clinics_regulatory_regime_check",
      sql`${t.regulatoryRegime} is null or ${t.regulatoryRegime} in ('hipaa', 'hipaa-if-covered', 'non-hipaa')`,
    ),
    check(
      "clinics_agreement_kind_check",
      sql`${t.agreementKind} is null or ${t.agreementKind} in ('baa', 'dpa')`,
    ),
    // A specialty HIPAA always reaches never holds a DPA, whatever else is true.
    check(
      "clinics_dpa_never_hipaa",
      sql`${t.agreementKind} is distinct from 'dpa' or ${t.regulatoryRegime} is distinct from 'hipaa'`,
    ),
  ],
);

/**
 * Who may touch one location's PHI.
 *
 * Deliberately SEPARATE from Better Auth's `member` table, which answers a
 * different question: `member` is org-level (billing, invites, settings); this
 * is per-location PHI access. An org admin running billing for three sites does
 * not automatically need Scottsdale's call transcripts.
 *
 * Grants are explicit rows rather than derived from `member.role`, because
 * "who could read this patient's record on 3 March?" has to be answerable with
 * a SELECT — not inferred from role logic that has since changed.
 *
 * revokedAt rather than DELETE for the same reason: access history is itself an
 * audit artifact (§164.308(a)(3)(ii)(C), termination procedures).
 */
export const clinicMemberships = pgTable(
  "clinic_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: clinicRoleEnum("role").notNull().default("front_desk"),

    grantedBy: text("granted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    /** Drives "/" → last clinic for multi-location staff. Not security-relevant. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique: one ACTIVE grant per (clinic, user). Revoked rows may repeat.
    uniqueIndex("clinic_memberships_active_idx")
      .on(t.clinicId, t.userId)
      .where(sql`${t.revokedAt} is null`),
    index("clinic_memberships_user_idx")
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// -----------------------------------------------------------------------------
// Credential vault
// -----------------------------------------------------------------------------

/**
 * Per-clinic third-party credentials, encrypted at the application layer.
 *
 * Ciphertext is AES-256-GCM; the data key is wrapped by a KMS key. The AAD is
 * bound to {clinicId, id} — without that binding, anyone who can write to this
 * table could copy clinic A's ciphertext into clinic B's row and the app would
 * decrypt it happily. See src/lib/crypto/envelope.ts.
 *
 * Not pgcrypto: that decrypts server-side, so the key travels through SQL and
 * lands in pg_stat_activity and query logs.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    /** "boulevard" | "ghl" | "stripe" | "square" | "bandwidth" | ... */
    provider: text("provider").notNull(),

    status: connectionStatusEnum("status").notNull().default("pending"),

    /** Encrypted credential bag. Never selected into application code directly. */
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    /** Lets us re-wrap on key rotation without re-encrypting the payload. */
    keyVersion: text("key_version").notNull(),
    aadVersion: integer("aad_version").notNull().default(1),

    /**
     * What this connection can actually do, snapshotted at connect time.
     * Rendered verbatim in the console so "unsupported" never displays as zero.
     */
    capabilities: jsonb("capabilities").$type<Record<string, boolean>>(),

    /** Non-secret identifiers: location id, site id, merchant id. */
    metadata: jsonb("metadata"),

    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * The lawful basis on which PHI (a name, a service, a time) may reach this
     * vendor: its own business associate agreement with us, or the practice's
     * own account under the practice's own agreement. NULL means there is
     * none, and a connection with none is never written to. Written only by
     * the audited ops op setConnectionPhiBasis.
     */
    phiBasis: text("phi_basis").$type<PhiBasis>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("provider_connections_clinic_provider_idx").on(
      t.clinicId,
      t.provider,
    ),
    index("provider_connections_status_idx").on(t.clinicId, t.status),
  ],
);

// -----------------------------------------------------------------------------
// REMOVED — the ad-click stage (`ad_interactions`), dropped in 0017
// -----------------------------------------------------------------------------
//
// There used to be an `ad_interactions` table here holding gclid/fbclid click
// ids, joined to `conversations.ad_interaction_id`, so a booking could be traced
// back to the ad that produced it and pushed to Meta or Google.
//
// That capability is out of scope entirely — not deferred, not a paid add-on.
// The join was the problem, not the table: a row linking a patient's phone call
// to a Meta click id is person-level health data by the FTC's reading, and it is
// the exact fact pattern behind GoodRx ($1.5M) and BetterHelp ($7.8M). The 2024
// HBNR amendment makes the unauthorised *disclosure itself* the reportable
// breach, so the exposure needed no hack to trigger — and Meta's Business Tools
// Terms §1.h bans health data outright, meaning a lawful transmission could
// still have broken the clinic's own Meta contract.
//
// What replaces it is narrower and keeps the data inside the clinic: revenue is
// reconciled from the POS money event and reported back to the clinic itself.
// See src/lib/attribution — despite the name, nothing there leaves for an ad
// network, and it must stay that way.
//
// Do not reintroduce a click-id column without counsel. See
// docs/research-conclusions.md Part 3.

// -----------------------------------------------------------------------------
// Stage 1 — the conversation  ⚠️ PHI
// -----------------------------------------------------------------------------

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    /** ⚠️ PHI. Never logged. E.164. */
    phone: text("phone"),
    email: text("email"),
    fullName: text("full_name"),

    /** Id in the clinic's own EMR/CRM, so we reconcile without owning identity. */
    externalContactId: text("external_contact_id"),
    /** Which system that id belongs to — a clinic will have a POS and Stripe. */
    externalSource: text("external_source"),

    isReturning: boolean("is_returning").notNull().default(false),

    /**
     * IANA timezone for quiet-hours. Set at ingestion from the clinic's own
     * timezone (a caller rang a local clinic), refined later if a better
     * source exists. canContact() REFUSES outbound contact when this is
     * null: the quiet-hours check fails closed, never open.
     */
    timezone: text("timezone"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("contacts_clinic_phone_idx").on(t.clinicId, t.phone),
    // Partial: NULLs are distinct in Postgres, so an unqualified unique index
    // here would neither prevent duplicates nor support ON CONFLICT.
    uniqueIndex("contacts_external_idx")
      .on(t.clinicId, t.externalSource, t.externalContactId)
      .where(sql`${t.externalContactId} is not null`),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id),

    channel: channelEnum("channel").notNull(),

    /**
     * Why this contact would have been lost without us — or null if it wouldn't.
     *
     * On a CONDITIONALLY forwarded line — the normal setup — every call we
     * answer is one the clinic's own receptionist let ring out or was too busy
     * to take. So every one of them is recovered, and this column records which
     * of those things happened rather than whether it happened at all.
     *
     * Null therefore means one specific thing: the clinic routes ALL calls to us
     * (clinics.callRouting = 'always'), and this one arrived during staffed
     * hours. Nobody was passed over, so nothing was recovered — the service
     * simply worked.
     *
     * Each value is a fact recorded at ingestion, never inferred afterwards.
     * That ordering matters: `after_hours` depends on the clinic's own opening
     * hours, which the ingesting layer knows and the monthly report does not.
     *
     * ⚠️ A call that was answered and simply didn't book is still recovered.
     * Whether it CONVERTED is a separate question — see classifyBooking() in
     * lib/voice/ingest.ts. Conflating the two would understate the agent's
     * reach and overstate its close rate at the same time.
     */
    recoveryReason: recoveryReasonEnum("recovery_reason"),

    outcome: conversationOutcomeEnum("outcome"),
    treatmentInterest: text("treatment_interest"),

    /**
     * ⚠️ PHI. Behind an S3-compatible URL, never a platform blob API —
     * apps/app stays portable. Transcript only: by decision of 21 September
     * 2026 no audio recording is kept anywhere the product can reach (the
     * `recording_uri` column was dropped in 0038, and the vendor's own
     * recording storage is switched off in its console — launch guide,
     * Synthflow card). A voice is an identifier on its own; a transcript is
     * smaller, searchable, and enough for a dispute.
     */
    transcriptUri: text("transcript_uri"),

    /**
     * Proof the required disclosure played before any audio reached
     * transcription. Non-nullable in practice for voice; see src/lib/compliance.
     */
    disclosurePlayedAt: timestamp("disclosure_played_at", {
      withTimezone: true,
    }),
    /** The caller asked not to be transcribed; the agent takes a message instead. */
    recordingOptOut: boolean("recording_opt_out").notNull().default(false),

    /** Seconds from inbound ring to agent answer. The speed-to-lead metric. */
    responseLatencySeconds: integer("response_latency_seconds"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /**
     * The voice platform's own call id.
     *
     * Idempotency for ingestion. Voice vendors retry webhooks, and a call
     * counted twice inflates the one figure the clinic judges us on — twice.
     */
    externalCallId: text("external_call_id"),
  },
  (t) => [
    index("conversations_clinic_idx").on(t.clinicId, t.startedAt),
    // Partial: NULLs are distinct in Postgres, so an unqualified unique index
    // would neither prevent duplicates nor support ON CONFLICT.
    uniqueIndex("conversations_external_call_idx")
      .on(t.clinicId, t.externalCallId)
      .where(sql`${t.externalCallId} is not null`),
    // Clinic-first: under RLS every query carries clinic_id, so a lookup by FK
    // alone would index-scan then re-filter. That's the common path, not the rare one.
    index("conversations_contact_idx").on(t.clinicId, t.contactId),
  ],
);

// -----------------------------------------------------------------------------
// Stage 3 — booked and showed  ⚠️ PHI
// -----------------------------------------------------------------------------

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    /** The conversation that produced the booking. Null for walk-ins. */
    conversationId: uuid("conversation_id").references(() => conversations.id),

    externalAppointmentId: text("external_appointment_id"),
    /** Which system that id belongs to. */
    externalSource: text("external_source"),

    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    treatment: text("treatment"),
    providerName: text("provider_name"),

    depositUsd: numeric("deposit_usd", { precision: 12, scale: 2 }),
    /**
     * Where the deposit stands. "pending_front_desk" is the fallback path: the
     * agent said the desk will call to collect, and the desk owes the call.
     * "pending_link" is a Stripe Connect payment link awaiting payment.
     */
    depositStatus: text("deposit_status").$type<DepositStatus>().notNull().default("none"),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /**
     * The stage incumbents cannot see. Populated by reading check-in back OUT
     * of the booking system, not by writing into it.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),

    /**
     * Set ONLY when a sync reads this appointment back out of the clinic's own
     * booking system. Never set by the agent.
     *
     * report.ts joins bookings to this table so that "a booking" means a real
     * appointment row rather than an outcome label the agent set on its way out
     * of the call. Once healdesk writes appointment rows itself — which it must,
     * because for a clinic with no booking software nobody else will — that join
     * stops proving anything, since we would be corroborating our own claim.
     * This column is what restores the distinction.
     *
     * Null means one of two things, and the report should not conflate them:
     * we booked it and no sync has seen it yet, or the clinic runs no booking
     * software and none ever will.
     */
    externalConfirmedAt: timestamp("external_confirmed_at", {
      withTimezone: true,
    }),

    /**
     * The calendar write (0040): whether this appointment was also written
     * into the clinic's own booking system, and how that went.
     *
     *   none     — nothing attempted (no writable connection, or none agreed)
     *   writing  — in flight; a second confirm must not start another
     *   written  — the vendor holds it; externalAppointmentId is its uid
     *   failed   — the vendor said no. Never retried automatically.
     *   unknown  — timeout or network. Retried only after a read-back finds
     *              nothing under this request's key.
     *
     * externalConfirmedAt above stays null regardless: it is set only when a
     * sync reads the appointment back out, which keeps the report's meaning.
     */
    calendarWriteStatus: text("calendar_write_status").$type<CalendarWriteStatus>().notNull().default("none"),
    calendarWrittenAt: timestamp("calendar_written_at", { withTimezone: true }),
    /** A short vendor status for the desk page — never a name or a number. */
    calendarWriteError: text("calendar_write_error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("appointments_clinic_idx").on(t.clinicId, t.scheduledFor),
    index("appointments_confirmed_idx")
      .on(t.clinicId, t.externalConfirmedAt)
      .where(sql`${t.externalConfirmedAt} is not null`),
    index("appointments_conversation_idx").on(t.clinicId, t.conversationId),
    uniqueIndex("appointments_external_idx")
      .on(t.clinicId, t.externalSource, t.externalAppointmentId)
      .where(sql`${t.externalAppointmentId} is not null`),
  ],
);

// -----------------------------------------------------------------------------
// Stage 4 — collected  ⚠️ PHI (procedure + amount tied to a person)
// -----------------------------------------------------------------------------

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id),
    /**
     * Null when the row can't be tied to a visit. Deliberately nullable: an
     * unattributed sale is a data-quality signal we surface, not a row we drop.
     */
    appointmentId: uuid("appointment_id").references(() => appointments.id),

    externalTransactionId: text("external_transaction_id"),
    /** "stripe" | "square" | "boulevard" | ... — a clinic will have several. */
    externalSource: text("external_source"),

    amountUsd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
    lineItems: jsonb("line_items"),

    /**
     * When the money was actually taken. Compared against
     * appointments.scheduledFor to decide whether payment implies attendance —
     * a deposit paid at booking proves nothing about showing up.
     */
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("transactions_clinic_idx").on(t.clinicId, t.collectedAt),
    index("transactions_appointment_idx").on(t.clinicId, t.appointmentId),
    uniqueIndex("transactions_external_idx")
      .on(t.clinicId, t.externalSource, t.externalTransactionId)
      .where(sql`${t.externalTransactionId} is not null`),
  ],
);

// -----------------------------------------------------------------------------
// The agent's own words — per clinic, approved, audited
// -----------------------------------------------------------------------------

/**
 * What the agent says for this clinic: the greeting, the services it may
 * name with their price ranges, the hours it quotes, and where it escalates.
 * Not PHI, but said aloud on recorded calls, so every edit is audited and the
 * clinic approves a version before go-live. The AI disclosure is NOT stored
 * here — lib/compliance/disclosure.ts prepends it and nothing in this row can
 * remove it. Text is screened by findClinicalContent() before it is written.
 */
export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    /** Spoken after the disclosure. Mentions the clinic by name. */
    greeting: text("greeting").notNull(),
    /** What callers can book, with a price range the clinic approved. */
    services: jsonb("services").$type<AgentService[]>().notNull().default([]),
    /** E.164 of the human line to transfer to, or null to take a message. */
    escalationPhone: text("escalation_phone"),
    /** When a human is reachable on that line, in the clinic's own words. */
    escalationHours: text("escalation_hours"),
    /** Anything else the agent may say, e.g. parking, new-patient policy. */
    notes: text("notes"),
    /**
     * The clinic's deposit rule, as the agent must state it. Null means no
     * deposit is mentioned. With Stripe Connect unavailable the only
     * collection path is the front desk, and the agent says so on the call.
     */
    depositPolicy: jsonb("deposit_policy").$type<DepositPolicy>(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByLabel: text("approved_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_configs_clinic_idx").on(t.clinicId)],
);

export type AgentService = {
  name: string;
  /** Whole dollars; null means "quote on the call is not allowed, offer a consult". */
  priceFromUsd: number | null;
  priceToUsd: number | null;
  /** Minutes, for scheduling. */
  durationMinutes: number | null;
};

// -----------------------------------------------------------------------------
// Report delivery — who gets the monthly email, and proof of what was sent
// -----------------------------------------------------------------------------

export const reportRecipients = pgTable(
  "report_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    label: text("label"),
    addedBy: text("added_by").notNull(),
    /** Set when the address bounced or asked to stop; never sent to again. */
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("report_recipients_clinic_email_idx").on(t.clinicId, t.email)],
);

/**
 * The ledger's kinds: the four the report mailers have always written, then
 * every outbox kind, because each send from the outbox (billing_notices)
 * writes one ledger row per recipient (Annex X3 of
 * docs/design/funnel-onboarding-portal-2026-10-06.md). Built from the kind
 * registry like the outbox's own CHECK, so a kind added there widens both.
 */
export const REPORT_DELIVERY_KINDS = [
  "monthly",
  "weekly",
  "alert",
  "renewal",
  ...NOTICE_KINDS,
] as const;
export type ReportDeliveryKind = (typeof REPORT_DELIVERY_KINDS)[number];

/**
 * What Resend's webhook last said about one message. `bounced` means a
 * PERMANENT bounce: the relay records a transient or undetermined one as
 * `delayed`, because the one decision this column drives, whether the
 * clinic's address is undeliverable, must not be taken on a soft bounce.
 */
export const DELIVERY_STATUSES = [
  "sent",
  "delivered",
  "bounced",
  "complained",
  "suppressed",
  "delayed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * One row per (clinic, kind, period, recipient). The unique index is what
 * makes a re-run a conflict rather than a second email. Since the email
 * platform (Annex X3) it is the ledger of every email to a clinic: an outbox
 * send uses the notice's id as the period key, and the row's id travels as
 * the `delivery` tag so Resend's webhook can find it again.
 */
export const reportDeliveries = pgTable(
  "report_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** A report kind ("monthly" | "weekly" | "alert" | "renewal") or an outbox kind. */
    kind: text("kind").$type<ReportDeliveryKind>().notNull(),
    /**
     * e.g. "2026-08" for monthly, "2026-W37" for weekly, an event id for
     * alerts, the billing_notices row id for an outbox send.
     */
    periodKey: text("period_key").notNull(),
    recipient: text("recipient").notNull(),
    /** "sent" | "skipped" | "failed": what the API said when we sent. */
    status: text("status").notNull(),
    messageId: text("message_id"),
    reason: text("reason"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** What the mail provider reported afterwards, through the webhook relay. Null until then. */
    deliveryStatus: text("delivery_status").$type<DeliveryStatus>(),
    /** When the provider's event happened (the event's own timestamp, not ours). */
    deliveryAt: timestamp("delivery_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("report_deliveries_once_idx").on(t.clinicId, t.kind, t.periodKey, t.recipient),
    check("report_deliveries_kind_check", sql`${t.kind} in (${sqlList(REPORT_DELIVERY_KINDS)})`),
    check(
      "report_deliveries_delivery_status_check",
      sql`${t.deliveryStatus} is null or ${t.deliveryStatus} in (${sqlList(DELIVERY_STATUSES)})`,
    ),
  ],
);

/**
 * The ops log: one row per alert notifyOps raised (I1 in Annex X5), with no
 * clinic_id column because ops alerts are ours, not a tenant's. Two jobs:
 *
 *   - dedupe. Identical alerts, the same event about the same ids, within an
 *     hour, are one email: a later one bumps `repeats` instead of mailing
 *     again. Every process (web tier, worker, voice) shares the answer, which
 *     an in-memory map could not give, and the free plan's 100 emails a day
 *     cannot be spent on one stuck notice;
 *   - the state row I1 keys on. A kind with no clinic keeps its state on its
 *     own row and uses that row's id in Resend's idempotency key (Annex X3).
 *
 * `fields` holds ids, counts and categories only, as lib/log.ts allows them;
 * never an address, a name or free text.
 */
export const opsAlerts = pgTable(
  "ops_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** An OPS_EVENTS name (lib/ops/notify.ts). */
    event: text("event").notNull(),
    /** The ids and categories that make two alerts "the same", serialised. */
    dedupeKey: text("dedupe_key").notNull(),
    fields: jsonb("fields")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last time the same alert was raised again inside its window. */
    lastRaisedAt: timestamp("last_raised_at", { withTimezone: true }).notNull().defaultNow(),
    repeats: integer("repeats").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    messageId: text("message_id"),
    lastError: text("last_error"),
  },
  (t) => [
    index("ops_alerts_dedupe_idx").on(t.event, t.dedupeKey, t.raisedAt),
    check("ops_alerts_event_check", sql`${t.event} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check("ops_alerts_dedupe_key_check", sql`char_length(${t.dedupeKey}) <= 400`),
  ],
);

export type OpsAlertRow = typeof opsAlerts.$inferSelect;

/**
 * Resend's daily count, one row per UTC day, as its `x-resend-daily-quota`
 * response header last reported it. The header counts every email the
 * account sent that day, apps/web's included, so the highest value seen is
 * the day's count. The free plan stops at 100 a day, sign-in links and
 * urgent alerts included, so notifyOps fires once at 70 (`alerted_at`) and
 * the 07:00 ops digest (I2) reads the count from here.
 */
export const emailDailyQuota = pgTable(
  "email_daily_quota",
  {
    /** The UTC calendar day, which is Resend's quota day. */
    day: date("day").primaryKey(),
    used: integer("used").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    /** When notifyOps was told the count reached 70. Set once per day. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
  },
  (t) => [check("email_daily_quota_used_check", sql`${t.used} >= 0`)],
);

// -----------------------------------------------------------------------------
// Incidents — the BAA's two clocks, as rows with deadlines
// -----------------------------------------------------------------------------

/** What the forwarding test saw. Facts from the call; no caller in it. */
export type ForwardingTestObservation = {
  arrivedAt: string;
  conversationId: string;
  callerIdPreserved: boolean;
  /** Which forward condition fired, where the carrier told us. */
  condition: "busy" | "no_answer" | "all" | "unknown";
};

export type DepositStatus = "none" | "pending_front_desk" | "pending_link" | "paid" | "waived";

/** See appointments.calendarWriteStatus. */
export type CalendarWriteStatus = "none" | "writing" | "written" | "failed" | "unknown";

/** See clinics.bookingMode. */
export type BookingMode = "desk_confirms" | "direct";
export type BookingRequirementsSource = "practice" | "operator" | "defaults";
/** See providerConnections.phiBasis. */
export type PhiBasis = "vendor_baa" | "practice_account";

export type DepositPolicy = {
  required: boolean;
  amountUsd: number | null;
  /** How it is collected. "front_desk" until Stripe Connect is enabled for the clinic. */
  collection: "front_desk" | "stripe_connect";
};

export const incidentClassEnum = pgEnum("incident_class", [
  "security_incident",
  "improper_use_or_disclosure",
  "breach",
  "service_complaint",
]);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    class: incidentClassEnum("class").notNull(),
    /** What happened, in words with no patient in them. Ids only. */
    summary: text("summary").notNull(),
    /** A conversation id, never its transcript. */
    conversationId: uuid("conversation_id"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
    /**
     * From the class: 5 business days, or 5 calendar days for a breach, and
     * 24 hours for a breach at a clinic that is not a covered entity (the
     * BAA's state-law clause: "immediately following discovery").
     */
    notifyBy: timestamp("notify_by", { withTimezone: true }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedHow: text("notified_how"),
    /**
     * For a breach at a non-covered clinic, a second clock 30 days from
     * discovery: California's deadline for the clinic, as owner of the data,
     * to notify the people affected (Cal. Civ. Code 1798.82(a)(2)(A)), the
     * strictest owner clock among the states. 60 days until 3 October 2026.
     * Named for the FTC Health Breach Notification Rule, which on a closer
     * reading (1 October 2026) does not reach a clinic's booking records:
     * 16 CFR 318.2 covers vendors of personal health records. The name is
     * kept; see lib/incidents/incidents.ts.
     */
    ftcNotifyBy: timestamp("ftc_notify_by", { withTimezone: true }),
    openedBy: text("opened_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incidents_clinic_idx").on(t.clinicId, t.discoveredAt),
    index("incidents_open_idx").on(t.notifyBy).where(sql`${t.resolvedAt} is null`),
  ],
);

/**
 * Human touches on an account: the day-7 call, the first-win call, a note.
 * One screen shows every human contact so the second call knows about the
 * first. Configuration-plane prose, PHI-scanned on the way in like an
 * incident summary; never a patient.
 */
export const clinicTouches = pgTable(
  "clinic_touches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    touchedAt: timestamp("touched_at", { withTimezone: true }).notNull().defaultNow(),
    byLabel: text("by_label").notNull(),
    /** call | email | note */
    kind: text("kind").$type<"call" | "email" | "note">().notNull(),
    summary: text("summary").notNull(),
    outcome: text("outcome"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clinic_touches_clinic_idx").on(t.clinicId, t.touchedAt)],
);

/**
 * A booking REQUEST: not a booking. The person gave a first name, a number
 * the practice can call and a preferred day or time, on a call or a Meta
 * thread, and the assistant did not book it — because the clinic runs manual
 * booking mode, or (v1, not built yet) has "Auto-confirm bookings" off, or
 * its calendar connection is broken. The request is written here (the PHI
 * side), the practice's desk is emailed a single-use link with no patient in
 * it, and a human decides. On a Meta thread the person may hear back on the
 * channel they used, inside Meta's 24-hour window only — that the practice
 * has their request, never a time.
 *
 * `sender_id` is the platform's opaque id for the person, kept only to
 * address that one follow-up message. The token hash is the desk's
 * credential, exactly like a connection link.
 */
export const bookingRequests = pgTable(
  "booking_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    // Cascade: offboarding deletes contacts, and the app role has no DELETE
    // here on purpose. Referential actions run as the table owner, so the
    // request goes with the person it was about.
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /**
     * Where the request came from. The desk has the final say on every
     * request; whether the assistant takes a request or books directly is
     * the clinic's booking mode (clinics.booking_mode).
     */
    channel: text("channel").$type<"voice" | "meta">().notNull().default("meta"),
    /** The call the request was taken on, for voice. */
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** messenger | instagram | whatsapp; null for a voice request. */
    platform: text("platform").$type<"messenger" | "instagram" | "whatsapp">(),
    /** The page / account / number id the message arrived on (meta only). */
    externalId: text("external_id"),
    senderId: text("sender_id"),
    connectionId: uuid("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    /** Free text as the person put it, PHI-scanned for clinical content. */
    preferredWindow: text("preferred_window").notNull(),
    /**
     * Up to two more windows, same cleaning as the primary. Asked for, never
     * required: a request with only a primary is still complete. Frozen after
     * insert like the primary (0040 trigger); the cap is a CHECK.
     */
    alternativeWindows: text("alternative_windows").array().notNull().default(sql`'{}'::text[]`),
    /** The service asked for, on a voice call only: the phone is inside the boundary, a Meta thread is not. */
    treatment: text("treatment"),
    /**
     * `{ [BookingFieldId]: string }` — the practice's requirement set as
     * collected, limited to catalogue ids, each value screened for clinical
     * content. Written at creation (voice); updatable while the request is
     * open. A service collected after creation lands in
     * `collected_fields.service` because `treatment` is frozen — readers
     * prefer `treatment ?? collected_fields.service`.
     */
    collectedFields: jsonb("collected_fields").$type<Record<string, string>>().notNull().default({}),
    /**
     * The transition table is the 0040 trigger, not this union:
     *   requested    → accepted, rescheduling, confirmed, declined, expired
     *   accepted     → rescheduling, confirmed, expired
     *   rescheduling → confirmed, declined, expired
     * and the three terminal states go nowhere.
     */
    status: text("status").$type<"requested" | "accepted" | "rescheduling" | "confirmed" | "declined" | "expired">().notNull().default("requested"),
    tokenHash: customType<{ data: Buffer }>({ dataType: () => "bytea" })("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deskNotifiedAt: timestamp("desk_notified_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByLabel: text("decided_by_label"),
    /** The practice's own note back to itself; never sent to the person. */
    deskNote: text("desk_note"),
    /** Set when the desk confirmed a slot; the appointment row is the booking. */
    confirmedFor: timestamp("confirmed_for", { withTimezone: true }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    /**
     * The fourth decision — "propose other times". Up to three slots (a
     * CHECK), offered by the desk or read from the calendar, which the desk
     * then goes through with the person by phone itself (healdesk places no
     * calls). Replaceable while `rescheduling`,
     * frozen once terminal. A row cannot be `rescheduling` with nothing to
     * choose from or no deadline (CHECK, 0040).
     */
    proposedSlots: jsonb("proposed_slots").$type<ProposedSlot[]>().notNull().default([]),
    /** LEAST(expires_at, now() + 72h, the earliest proposed slot). expires_at itself stays frozen. */
    rescheduleExpiresAt: timestamp("reschedule_expires_at", { withTimezone: true }),
    /** Who turned this request into an appointment. Frozen after insert. */
    bookedVia: text("booked_via").$type<BookedVia>().notNull().default("desk"),
    /**
     * The vendor's call id when the agent booked directly on the call. Unique
     * per clinic (partial index), which is what makes the direct-booking
     * route idempotent on a retried tool call. Frozen after insert.
     */
    vendorCallId: text("vendor_call_id"),
    /** The person's last inbound message on the thread — the start of Meta's 24-hour window. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("booking_requests_token_idx").on(t.tokenHash),
    index("booking_requests_clinic_idx").on(t.clinicId, t.createdAt),
    uniqueIndex("booking_requests_vendor_call_idx")
      .on(t.clinicId, t.vendorCallId)
      .where(sql`${t.vendorCallId} is not null`),
    // The thread a Meta request lives on, for the window check.
    index("booking_requests_thread_idx").on(t.clinicId, t.platform, t.senderId),
  ],
);

/** One offered time on a `rescheduling` request. `label` is the clinic-zone rendering the person hears. */
export type ProposedSlot = { at: string; label: string; source: "calendar" | "desk" };
/** See bookingRequests.bookedVia. 0041 dropped 'callback' from the CHECK: healdesk places no calls. */
export type BookedVia = "desk" | "agent_direct";

/**
 * The half-collected request: what the person has said so far on one thread,
 * so the assistant can ask for the missing piece across messages without
 * remembering any of the conversation. Overwritten per message, deleted when
 * the request is created, and swept after a day. 0041 dropped the callback
 * consent and WhatsApp opt-in columns: v1 asks neither question.
 */
export const metaBookingDrafts = pgTable(
  "meta_booking_drafts",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    senderId: text("sender_id").notNull(),
    externalId: text("external_id").notNull(),
    firstName: text("first_name"),
    phone: text("phone"),
    preferredWindow: text("preferred_window"),
    alternativeWindows: text("alternative_windows").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clinicId, t.platform, t.senderId] })],
);

// -----------------------------------------------------------------------------
// Audit — required for HIPAA
// -----------------------------------------------------------------------------

/**
 * Every PHI access — read as well as write. Required by §164.312(b), and the
 * first thing an auditor asks for. Append-only by grant, not just convention:
 * drizzle/0003_grants.sql withholds UPDATE and DELETE from the runtime role.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * NOT NULL, unlike the first draft. Every row here is a PHI access, and PHI
     * is always clinic-scoped — which is what lets the RLS policy be a plain
     * clinic_id match with no escape hatch. Identity-plane events (sign-in,
     * role change, invite) have no clinic and live in security_events.
     */
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),

    actorType: actorTypeEnum("actor_type").notNull(),

    /** Set iff actorType = 'user'. SET NULL on delete — see actorLabel. */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Set iff actorType in ('service','agent'): "pos-reconciler", "voice-agent". */
    actorServiceName: text("actor_service_name"),
    /** Set iff actorType = 'connector'. Which credential acted. */
    actorConnectionId: uuid("actor_connection_id").references(
      () => providerConnections.id,
      { onDelete: "set null" },
    ),

    /**
     * Immutable snapshot of who this was AT THE TIME. Denormalised on purpose:
     * the FK above goes null when a user is deleted, and an audit row reading
     * "accessed by: nobody" is worthless. A staff work email is business contact
     * data, safe to store — a patient identifier never goes here.
     */
    actorLabel: text("actor_label").notNull(),

    /** read | create | update | delete | export | decrypt */
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    /** Bulk reads record ids here rather than N rows. Capped in src/lib/audit.ts. */
    resourceIds: jsonb("resource_ids").$type<string[]>(),
    resultCount: integer("result_count"),

    /** Correlates every audit row produced by one HTTP request. */
    requestId: uuid("request_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    /** ⚠️ Metadata ONLY. Guarded at runtime by assertNoPhi() in src/lib/audit.ts. */
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_log_clinic_idx").on(t.clinicId, t.occurredAt),
    index("audit_log_resource_idx").on(t.clinicId, t.resourceType, t.resourceId),
    index("audit_log_actor_idx").on(t.clinicId, t.actorUserId, t.occurredAt),
    index("audit_log_request_idx").on(t.requestId),
    check(
      "audit_log_actor_shape",
      sql`
        (actor_type = 'user'      and actor_user_id       is not null) or
        (actor_type in ('service','agent') and actor_service_name is not null) or
        (actor_type = 'connector' and actor_connection_id is not null) or
        (actor_type = 'system')
      `,
    ),
  ],
);

/**
 * Click-through BAA acceptances.
 *
 * Self-serve acquisition only works if the business-associate agreement is
 * click-through — if signing needs a lawyer on a call, the funnel isn't
 * automated. That makes the acceptance record the artifact that has to hold up
 * later, so it captures more than a boolean:
 *
 *   - WHICH version was accepted, and its hash, so "what did they actually
 *     agree to" survives the document being revised
 *   - WHO accepted, by name and email frozen at the time
 *   - WHEN, from WHERE, and with which user agent
 *
 * Deliberately outside the tenant plane: acceptance happens during signup,
 * before a clinic exists to scope it to. It carries no PHI — a clinic owner's
 * name and work email are business contact data.
 */
export const baaAcceptances = pgTable(
  "baa_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Null until payment succeeds and the organization exists.
     *
     * The agreement is signed BEFORE payment — that is the whole point, since a
     * business associate may not receive patient data without one, and we would
     * rather hold a signed agreement for a deal that never closed than take
     * money for an account that has no agreement behind it. So the row is
     * written at signature and bound to an organization afterwards.
     */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    /** Nullable: the accepting user may be created in the same transaction. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

    /** Template version, e.g. "0.0.0-draft". Matches BAA_TEMPLATES in @healdesk/catalog. */
    documentVersion: text("document_version").notNull(),
    /** SHA-256 of renderedText. The link between the record and the document. */
    documentHash: text("document_hash").notNull(),

    /**
     * Which kind of agreement the row is: 'dpa' when the version is in the
     * DPA's namespace ("dpa/1.0.0"), 'baa' for every other version. GENERATED
     * ALWAYS from the version, like `retentionEligibleAt`, so no writer can
     * label a signature with a kind its document does not have; a CHECK in
     * 0051 keeps any other namespace out of `documentVersion`.
     * `agreementKindOfVersion` in @healdesk/catalog is the TypeScript mirror,
     * and tests/agreement-kinds.test.ts runs both over the same versions.
     */
    agreementKind: text("agreement_kind")
      .$type<AgreementKind>()
      .notNull()
      .generatedAlwaysAs(sql`case when document_version like 'dpa/%' then 'dpa' else 'baa' end`),

    /**
     * The exact document this person was shown, rendered.
     *
     * Stored in full rather than reconstructed on demand. Re-rendering from the
     * template and variables would be smaller, but it silently changes the
     * answer if the template is ever edited in place — and "we can regenerate
     * something similar" is not what a court asks for. This column is the
     * evidence; documentHash proves it hasn't been touched.
     */
    renderedText: text("rendered_text").notNull(),
    /** The substitution values, so the render can be independently reproduced. */
    variables: jsonb("variables").$type<Record<string, unknown>>().notNull(),

    /**
     * The label on the button they clicked.
     *
     * Frozen because enforceability turns on what the assent action said, and
     * marketing copy changes. "I agree to the Business Associate Agreement" and
     * "Continue" are very different facts about the same click.
     */
    assentLabel: text("assent_label").notNull(),

    /** Frozen at acceptance — the FK above may go null. */
    acceptedByName: text("accepted_by_name").notNull(),
    acceptedByEmail: text("accepted_by_email").notNull(),
    acceptedByTitle: text("accepted_by_title"),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** When the acceptance was attached to a paid organization. */
    boundAt: timestamp("bound_at", { withTimezone: true }),

    /**
     * When the agreement stopped being in effect. Null while it still is.
     *
     * This is the second half of the retention clock, and the half everyone
     * forgets. 45 CFR 164.530(j)(2) requires six years "from the date of its
     * creation or the date when it last was in effect, whichever is later" —
     * for a BAA, "last in effect" is termination, so a clinic that stays three
     * years owes nine years from signature. Retention computed from
     * acceptedAt alone marks live contracts as expired.
     *
     * Write-once: see drizzle/0025. Clearing or backdating this column moves
     * the retention clock, so no code path may.
     */
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),

    /**
     * When the counterparty's own copy of the signed agreement was delivered.
     *
     * A HIPAA contract the other party cannot produce is a bad position to be
     * in, so the delivery is a recorded fact rather than an assumption.
     */
    copySentAt: timestamp("copy_sent_at", { withTimezone: true }),
    /**
     * SHA-256 of the exact PDF that was sent — not of renderedText.
     *
     * The two should agree in content, but the thing the clinic holds is the
     * PDF, and "what did they actually receive" is the question a dispute
     * asks. Constrained to 64 lowercase hex, and null exactly when
     * copySentAt is null: a date with no hash proves nothing and a hash with
     * no date is unanchored.
     */
    copyDocumentSha256: text("copy_document_sha256"),

    /**
     * The six-year floor: greatest(acceptedAt, terminatedAt) + 6 years.
     *
     * GENERATED ALWAYS, computed by Postgres, because a retention date any
     * code path can write is a retention date somebody can set to a convenient
     * value. There is no INSERT and no UPDATE — from the app role, the
     * migrator, psql or a future service — that can move it.
     *
     * ⚠️ It is a FLOOR, not a deletion schedule, and while terminatedAt is
     * null it is a floor computed from creation alone: the real eligibility
     * date of a live agreement is not yet knowable. Never render it raw — the
     * admin console reads it through the retention state `searchAgreements`
     * derives in lib/agreements/search.ts, which refuses to call a live
     * agreement eligible for anything, and
     * lib/agreements/retention.ts holds the same rule for a caller that wants
     * it as a query. Nothing in this system auto-deletes a BAA.
     */
    retentionEligibleAt: timestamp("retention_eligible_at", {
      withTimezone: true,
    })
      .notNull()
      // Six years is added in UTC on purpose. `timestamptz + interval` is
      // STABLE (it depends on the session TimeZone), and Postgres refuses a
      // non-immutable generation expression outright — so the naive form does
      // not merely drift, it will not create. See drizzle/0025.
      .generatedAlwaysAs(
        sql`(((greatest(accepted_at, coalesce(terminated_at, accepted_at)) at time zone 'UTC') + interval '6 years') at time zone 'UTC')`,
      ),
  },
  (t) => [
    index("baa_acceptances_org_idx").on(t.organizationId, t.acceptedAt),
    index("baa_acceptances_version_idx").on(t.documentVersion),
    // Signed but never paid for. Read by ops to follow up, and by the retention
    // sweep — an unbound acceptance is a live legal record, not junk, but it
    // should not accumulate for ever either.
    index("baa_acceptances_unbound_idx")
      .on(t.acceptedAt)
      .where(sql`${t.organizationId} is null`),
    // Only a terminated agreement can ever become eligible for review, so the
    // index carries that rule rather than leaving it to whoever writes the
    // next query.
    index("baa_acceptances_retention_idx")
      .on(t.retentionEligibleAt)
      .where(sql`${t.terminatedAt} is not null`),
    check(
      "baa_acceptances_terminated_after_accepted",
      sql`${t.terminatedAt} is null or ${t.terminatedAt} >= ${t.acceptedAt}`,
    ),
    check(
      "baa_acceptances_copy_evidence_complete",
      sql`(${t.copySentAt} is null) = (${t.copyDocumentSha256} is null)`,
    ),
    check(
      "baa_acceptances_copy_hash_format",
      sql`${t.copyDocumentSha256} is null or ${t.copyDocumentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check("baa_acceptances_agreement_kind_check", sql`${t.agreementKind} in ('baa', 'dpa')`),
    // A namespaced version is a DPA's; no other namespace may be stored, so
    // the generated kind can never call an unknown document a BAA.
    check(
      "baa_acceptances_version_namespace",
      sql`${t.documentVersion} not like '%/%' or ${t.documentVersion} like 'dpa/%'`,
    ),
  ],
);

/**
 * The identity plane's log: sign-in, sign-out, failed attempts, role changes,
 * invitations, BAA acceptance. Separate from audit_log because these events
 * have no clinic to scope them by — which is exactly why audit_log.clinicId can
 * be NOT NULL and its RLS policy can have no escape hatch.
 */
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Nullable: a failed sign-in has no known user. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Frozen snapshot, same reasoning as audit_log.actorLabel. */
    actorLabel: text("actor_label").notNull(),

    /** sign_in | sign_out | sign_in_failed | role_granted | baa_accepted | ... */
    event: text("event").notNull(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("security_events_user_idx").on(t.userId, t.occurredAt),
    index("security_events_event_idx").on(t.event, t.occurredAt),
  ],
);

// -----------------------------------------------------------------------------
// Sync state
// -----------------------------------------------------------------------------

export const syncStatusEnum = pgEnum("sync_status", [
  "running",
  "ok",
  "partial",
  "failed",
]);

/**
 * Where each sync got to, and what it could not reach.
 *
 * The cursor is what makes delta sync possible, and delta sync is not an
 * optimisation here — PatientNow allows 1,000 requests a DAY, so a nightly
 * full poll exhausts one clinic's entire budget. Re-reading a window already
 * known good is a bug, not merely waste.
 *
 * `notes` carries what the run could not do: a page dropped to a rate limit, a
 * platform that cannot backfill. Silence would render as complete.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),

    /** appointments | sales | contacts */
    resource: text("resource").notNull(),
    status: syncStatusEnum("status").notNull().default("running"),

    /**
     * High-water mark: everything up to here is known good. The next run starts
     * from it, minus a small overlap, because platforms backdate edits.
     */
    cursorAt: timestamp("cursor_at", { withTimezone: true }),
    /** Opaque page cursor, when a run stops mid-resource. */
    pageCursor: text("page_cursor"),

    itemsSeen: integer("items_seen").notNull().default(0),
    itemsWritten: integer("items_written").notNull().default(0),

    /** Verbatim limitations. Never summarised away. */
    notes: jsonb("notes").$type<string[]>(),
    error: text("error"),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("sync_runs_clinic_idx").on(t.clinicId, t.resource, t.startedAt),
    // Finding the last good cursor is the hot path on every run.
    index("sync_runs_cursor_idx")
      .on(t.connectionId, t.resource, t.cursorAt)
      .where(sql`${t.status} in ('ok', 'partial')`),
  ],
);

/**
 * Inbound webhooks, stored raw before anything is done with them.
 *
 * Store-then-process, for three reasons. Platforms time out fast — Mindbody
 * gives 10 seconds — so acknowledging quickly and working later is the only way
 * to avoid pointless retries. Mindbody also guarantees neither ordering nor
 * exactly-once delivery, so every provider is treated that way. And when a
 * payload turns out to be misparsed, the original is still here.
 *
 * `deliveryId` is uniquely indexed per clinic: at-least-once delivery means the
 * same event WILL arrive twice, and the database is the only place that can
 * arbitrate that reliably.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),

    /** The platform's own delivery id. */
    deliveryId: text("delivery_id").notNull(),
    /** Whether the signature verified. Unverified payloads are kept, not acted on. */
    signatureValid: boolean("signature_valid").notNull(),

    /** ⚠️ May contain PHI. Reaped on a retention schedule. */
    rawPayload: text("raw_payload").notNull(),

    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
    attempts: integer("attempts").notNull().default(0),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("webhook_events_delivery_idx").on(
      t.clinicId,
      t.provider,
      t.deliveryId,
    ),
    index("webhook_events_unprocessed_idx")
      .on(t.clinicId, t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const exceptionKindEnum = pgEnum("exception_kind", [
  "unmatched_sale",
  "unmatched_appointment",
  "ambiguous_match",
  "missing_arrival",
]);

/**
 * Money and visits we could not reconcile.
 *
 * This table is the honesty mechanism. Anything the matcher cannot place lands
 * here rather than being excluded from a total that then looks smaller than
 * reality — a report that quietly under-counts is the failure this product
 * exists to replace.
 *
 * Sorted by amount at risk in the console, because that is the order someone
 * should work through them.
 */
export const reconciliationExceptions = pgTable(
  "reconciliation_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    kind: exceptionKindEnum("kind").notNull(),
    /** Stable hash of the underlying facts, so a re-run updates rather than duplicates. */
    fingerprint: text("fingerprint").notNull(),

    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "cascade",
    }),

    amountAtRiskUsd: numeric("amount_at_risk_usd", {
      precision: 12,
      scale: 2,
    }),
    /** Plain sentence for the console. Never contains a patient identifier. */
    summary: text("summary").notNull(),

    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** auto | manual — set when a later run matches it after all. */
    resolvedBy: text("resolved_by"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("reconciliation_exceptions_fingerprint_idx").on(
      t.clinicId,
      t.fingerprint,
    ),
    index("reconciliation_exceptions_open_idx")
      .on(t.clinicId, t.amountAtRiskUsd)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

// -----------------------------------------------------------------------------
// Consent and suppression  ⚠️ PHI
// -----------------------------------------------------------------------------

export const contactChannelEnum = pgEnum("contact_channel", [
  "voice",
  "sms",
]);

/**
 * What kind of permission we hold.
 *
 * The distinction is not academic. Under the TCPA an artificial-voice call —
 * which FCC 24-17 confirms an AI voice is — needs prior express consent, and
 * anything promotional needs prior express *written* consent. Reactivating a
 * lapsed patient is very likely marketing.
 */
export const consentTypeEnum = pgEnum("consent_type", [
  /** Gave us the number for this purpose. Enough for treatment-related contact. */
  "express",
  /** Signed/checkbox agreement naming marketing. Required for promotional contact. */
  "express_written",
  /**
   * The clinic asserts consent it obtained itself. Recorded distinctly because
   * it is only as good as their record-keeping, and in a dispute the burden is
   * on us to produce it.
   */
  "clinic_asserted",
]);

/**
 * The consent ledger.
 *
 * This is the single artifact that decides a TCPA case. Statutory damages run
 * $500–1,500 per call with no cap and a ready-made class, so the question is
 * never "did we mean well" but "can you produce the consent, its source, and
 * the exact words they agreed to".
 *
 * Hence exactWording: "they ticked a box" is not a defence. The text shown at
 * the time is.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    /** ⚠️ PHI. E.164. */
    phone: text("phone").notNull(),
    channel: contactChannelEnum("channel").notNull(),
    consentType: consentTypeEnum("consent_type").notNull(),

    /** web_form | inbound_call | sms_reply | intake | clinic_import */
    source: text("source").notNull(),
    /** Verbatim text the person agreed to. Not a summary of it. */
    exactWording: text("exact_wording").notNull(),
    /** Recording or screenshot, behind an S3-compatible URL. */
    evidenceUri: text("evidence_uri"),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set on revocation. Rows are never deleted — the history is the point. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("consent_clinic_phone_idx").on(t.clinicId, t.phone, t.channel),
    index("consent_active_idx")
      .on(t.clinicId, t.phone)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * Do-not-contact.
 *
 * Deliberately separate from consent revocation, and deliberately stronger. A
 * suppression is unconditional: it outranks every consent record, applies
 * across channels by default, and is never expired or cleaned up.
 *
 * Two rules encoded by the shape:
 *
 *   - `channel` is NULLABLE, and null means EVERY channel. Someone who says
 *     "stop calling me" has not invited a text instead.
 *   - Nothing here is ever deleted. Re-consent creates a new consent record; it
 *     does not erase the record of them having asked us to stop.
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    /** ⚠️ PHI. E.164. */
    phone: text("phone").notNull(),
    /** NULL = all channels. The default, and the safe reading of "stop". */
    channel: contactChannelEnum("channel"),

    /** stop_reply | verbal_request | complaint | manual | national_dnc */
    reason: text("reason").notNull(),
    /** What they actually said, where we have it. */
    note: text("note"),

    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("suppression_lookup_idx").on(t.clinicId, t.phone)],
);

/**
 * Every outbound attempt, whether or not it connected.
 *
 * Exists to enforce the frequency caps the healthcare exemption depends on —
 * at most 1 per day and 3 per week per patient. Those caps are conditions of
 * the exemption, not guidance: exceed them and the exemption simply does not
 * apply, and the call needed consent it may not have.
 *
 * Logged before the attempt, so a crash mid-send counts against the cap rather
 * than silently allowing a retry storm.
 */
export const contactAttempts = pgTable(
  "contact_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    /** ⚠️ PHI. E.164. */
    phone: text("phone").notNull(),
    channel: contactChannelEnum("channel").notNull(),
    /** reminder | missed_call_callback | reactivation | transactional */
    purpose: text("purpose").notNull(),

    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("contact_attempts_window_idx").on(
      t.clinicId,
      t.phone,
      t.attemptedAt,
    ),
  ],
);

/**
 * Background jobs, and whether they are switched on.
 *
 * Every job here defaults to **disabled**. That is the point of the table: a
 * monthly report job that starts running the moment it is deployed would send
 * mail to whatever half-configured clinics happen to exist, and "we'll remember
 * to turn it off" is not a control. Ops turns each one on deliberately, from
 * the console, once there are real tenants to run it for.
 *
 * Also holds the outcome of the last run, so a job that has been silently
 * failing for three weeks is visible rather than merely quiet.
 *
 * No clinic_id — these are platform-wide, and deliberately outside the tenant
 * plane. Ops-only: see the grants in the accompanying migration.
 */
export const scheduledJobs = pgTable("scheduled_jobs", {
  /** Stable identifier used in code, e.g. "monthly-report". */
  name: text("name").primaryKey(),

  enabled: boolean("enabled").notNull().default(false),
  /** Human description of cadence. The runner owns the actual schedule. */
  cadence: text("cadence").notNull(),

  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunStatus: text("last_run_status"),
  /** Short summary — counts and errors, never PHI. */
  lastRunNote: text("last_run_note"),
  /** Guards against two runners picking up the same job at once. */
  runningSince: timestamp("running_since", { withTimezone: true }),

  updatedBy: text("updated_by").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Idempotency ledger for provisioning. See drizzle/0021.
 *
 * Keyed on the Stripe Checkout Session id, because that is what stays stable
 * across a webhook retry — the event id changes per delivery, so it would
 * dedupe deliveries while still letting one purchase provision twice.
 *
 * Identity-plane: no clinic_id, no RLS, and no foreign keys. The claim row is
 * written before the organization it names exists, so an FK would fire on every
 * first-time provision.
 */
export const provisioningAttempts = pgTable("provisioning_attempts", {
  /** Never accepted from a browser — see the column comment in 0021. */
  idempotencyKey: text("idempotency_key").primaryKey(),

  /** The result, stored so a replay answers without re-reading RLS-hidden rows. */
  organizationId: text("organization_id").notNull(),
  /**
   * Deliberately not called `clinic_id`: it is a stored result, not a tenant
   * key, and the RLS drift test requires a policy on every table that has a
   * column by that name. See drizzle/0021.
   */
  clinicId: uuid("provisioned_clinic_id").notNull(),
  clinicSlug: text("clinic_slug").notNull(),
  invitationId: uuid("invitation_id").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Postgres `bytea`, as a Buffer.
 *
 * drizzle-orm 0.45 has no first-class bytea column, and node-postgres already
 * hands back a Buffer for one, so the mapping is the identity in both
 * directions. Declared here rather than storing hex in a text column: a text
 * column would accept a 43-character base64url token as readily as a digest,
 * and connection_links is built on that distinction.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The one-time link a clinic uses to hand us booking credentials.
 *
 * There is no clinic-facing login anywhere in this product — healdesk is a
 * service, not software a clinic operates (docs/launch-plan.md, "Login? None").
 * So the entire grant happens through a link in an email: they click it, follow
 * the wizard for their platform, paste one credential, and are done forever.
 *
 * Which makes a row here the whole authentication story for a route that writes
 * a credential. Three properties carry it, and all three are enforced by
 * drizzle/0024_connection_links.sql rather than by this file:
 *
 *   1. `tokenHash` is SHA-256 of what we mailed — never the token. A check
 *      constraint pins it to 32 bytes, so the refactor that "simplifies" this
 *      into storing the token fails the INSERT instead of quietly turning every
 *      row into a working link.
 *   2. `usedAt` is set exactly once, by a conditional UPDATE, and a trigger
 *      refuses any later write to a consumed row. The app role has no DELETE.
 *   3. RLS is ENABLED and FORCEd like every tenant table — which means the
 *      anonymous holder cannot read their own link until the tenant has been
 *      declared from the token's clinic. See lib/connections/links.ts.
 *
 * ⚠️ No PHI, ever. This surface renders a clinic name and a set of platform
 * steps. Nothing patient-level reaches it, by construction: no column here can
 * carry any.
 */
export const connectionLinks = pgTable(
  "connection_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * No cascade, matching audit_log rather than the PHI tables. A record that
     * a credential was granted must not be erasable by deleting the clinic it
     * describes; Postgres refuses the clinic delete instead.
     */
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),

    /** SHA-256(token). Selected only to match on; never returned to a caller. */
    tokenHash: bytea("token_hash").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** See CONNECTION_LINK_TTL_DAYS in lib/connections/links.ts for the default. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    /** NULL means unused. The single-use flag; see property 2 above. */
    usedAt: timestamp("used_at", { withTimezone: true }),

    /**
     * What the link is for. `connect` hands us a booking credential; `setup`
     * confirms the booking requirement set (0040). Resolution and consumption
     * both filter on it, so a token issued for one cannot be spent on the
     * other — a mismatch resolves to nothing, the same anti-oracle rule as an
     * unknown token. Set at issue, never updated (the UPDATE grant is used_at
     * and consumed_ip only).
     */
    purpose: text("purpose").$type<"connect" | "setup" | "meta" | "whatsapp">().notNull().default("connect"),

    /**
     * The ops user who issued it, as an immutable snapshot rather than an FK —
     * for the reason audit_log denormalises actorLabel: a record of who granted
     * access is worthless the moment it can read "nobody".
     */
    issuedBy: text("issued_by"),

    /**
     * Where it was redeemed from. `inet`, so a malformed forwarded-for header
     * would abort the transaction — links.ts validates before it ever gets
     * here and stores NULL instead, because refusing a clinic's credential over
     * a strange proxy header is the wrong trade.
     */
    consumedIp: inet("consumed_ip"),
  },
  (t) => [
    uniqueIndex("connection_links_token_hash_idx").on(t.tokenHash),
    index("connection_links_clinic_idx").on(t.clinicId, t.createdAt),
  ],
);

/**
 * The administrator's second factor. Exactly one row, forever.
 *
 * There is one administrator, identified by HEALDESK_ADMIN_EMAIL, and no user
 * store behind them — no invitations, no team, no roles. So this table is not
 * "TOTP secrets keyed by user"; it is the single secret belonging to the single
 * operator, and the primary key is a constant with a CHECK pinning it to 1. A
 * second row is not a state this design has an opinion about, so the database
 * refuses to represent it rather than leaving two secrets for a later reader to
 * choose between.
 *
 * Four properties, all enforced by drizzle/0026_admin_totp.sql rather than here:
 *
 *   1. **The secret is never stored in the clear.** `secretCiphertext` holds the
 *      whole sealed envelope from lib/crypto/envelope.ts — AES-256-GCM under a
 *      wrapped data key — and a CHECK constraint demands the object carry an
 *      `authTag`, so the refactor that "simplifies" this into storing the base32
 *      secret fails the INSERT instead of silently turning the table into a
 *      list of working authenticators. Same reasoning as connection_links'
 *      `octet_length(token_hash) = 32`.
 *   2. **A used step stays used.** `lastUsedStep` only ever moves forward, by a
 *      conditional UPDATE and by a trigger that refuses a smaller value. That is
 *      what makes a code single-use: an intercepted six digits is worthless for
 *      the remaining seconds of its own window.
 *   3. **The application cannot disenrol.** No DELETE for the app role, and
 *      column-scoped UPDATE covering only `lastUsedStep` and
 *      `recoveryCodeHashes`. Nothing reachable from a request can replace the
 *      secret or clear the enrolment; doing that deliberately takes the migrator
 *      role and a human. An application that could re-enrol on demand is an
 *      application whose second factor an attacker can simply re-point.
 *   4. **Recovery codes are digests.** Never the codes. They are ours, 50 bits
 *      of randomness each, so SHA-256 is the right primitive and not a password
 *      hash — see lib/ops/admin-totp.ts for why that also buys single-use.
 *
 * ⚠️ No PHI, ever, and no clinic_id: this is identity plane, like
 * security_events and provisioning_attempts, so there is no RLS and no tenant
 * for one to scope by.
 */
export const adminTotp = pgTable(
  "admin_totp",
  {
    /**
     * Always 1. The CHECK in the migration is what makes that true; the default
     * is what makes every writer here able to ignore it.
     */
    id: smallint("id").primaryKey().default(1),

    /**
     * The sealed secret, as the whole `SealedPayload` from envelope.ts.
     *
     * One jsonb column rather than the six that provider_connections spreads it
     * across, and the difference is deliberate: those six exist so a rotation
     * job can scan `key_version` across thousands of rows. There is one row
     * here. What matters instead is that the parts cannot be written apart from
     * one another — a half-updated envelope is an unopenable secret and a
     * locked-out administrator — so they move as one value.
     */
    secretCiphertext: jsonb("secret_ciphertext").$type<SealedPayload>().notNull(),

    enrolledAt: timestamp("enrolled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    /**
     * The highest TOTP step already spent, as a number.
     *
     * `mode: "number"` rather than bigint-as-string because a step is
     * `floor(unixSeconds / 30)` — about 5.8e7 today and 1.4e8 when the sun
     * expands. It will not reach Number.MAX_SAFE_INTEGER, and a string here
     * would make every comparison in admin-totp.ts a place to get a coercion
     * wrong. bigint in Postgres anyway, because the column outlives the reason.
     */
    lastUsedStep: bigint("last_used_step", { mode: "number" })
      .notNull()
      .default(0),

    /** SHA-256 hex of each unspent recovery code. Never the codes themselves. */
    recoveryCodeHashes: text("recovery_code_hashes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("admin_totp_is_a_singleton", sql`${t.id} = 1`)],
);

// -----------------------------------------------------------------------------
// Billing
// -----------------------------------------------------------------------------

/**
 * Where a clinic is in its paid life. See lib/billing/state-machine.ts for the
 * edges; only that module writes this column.
 *
 *   demo          a sales demo, never charged; the one state with no Stripe ids
 *   provisioning  checkout completed, first invoice not yet paid
 *   active        paid up
 *   past_due      a renewal failed; inside the grace window
 *   suspended     grace ran out, or a chargeback landed; service withheld
 *   paused        Stripe paused collection at the clinic's request
 *   canceling     cancel_at_period_end set; serving out the paid period
 *   canceled      the subscription ended
 *   purged        data destroyed after the retention period; terminal
 */
export const billingStatusEnum = pgEnum("billing_status", [
  "demo",
  "provisioning",
  "active",
  "past_due",
  "suspended",
  "paused",
  "canceling",
  "canceled",
  "purged",
]);

export type BillingStatus = (typeof billingStatusEnum.enumValues)[number];

/** Which channels the agent may answer on. Keys match the catalog's `Channel`. */
export type ChannelsEnabled = Record<Channel, boolean>;

/** Who asked for a status change. Support acts through the ops console. */
export type BillingActor = "system" | "client" | "support";

/**
 * What one clinic is entitled to right now, and how far into it they are.
 *
 * One row per clinic, keyed on the clinic rather than on a Stripe id, because
 * a clinic can exist without Stripe (the no-Stripe dev path, a demo) but a
 * subscription cannot exist without a clinic. The Stripe ids are how a webhook
 * finds its way back here — see `app_clinic_for_stripe()` in drizzle/0028 —
 * and each is unique where present so two clinics can never claim one
 * subscription.
 *
 * `includedVoiceMinutes` and `includedChatConversations` are copied from the
 * catalog at seed time and again on every plan change rather than read from
 * the catalog at query time: the catalog describes what is SOLD today, this
 * row describes what THIS clinic was sold, and a price-book edit must not
 * silently change an existing customer's allowance mid-period.
 *
 * `usedVoiceMinutes` is numeric because the vendor bills in fractional
 * minutes; `usedChatConversations` is a count. Both reset to zero when a
 * renewal invoice is paid (lib/billing/entitlements.ts → resetUsage), so the
 * allowance lines up with what was invoiced — and, for an annual clinic only,
 * once a month inside the invoiced year (→ rollAllowancePeriod, driven by the
 * billing sweep job), because the allowance is sold per month and Stripe
 * sends no monthly invoice to reset it on. `currentPeriodStart`/`End` is that
 * window, not necessarily the invoiced period.
 *
 * Tenant plane: it has a clinic_id and is RLS'd like every other. DELETE is
 * withheld from the runtime role — a clinic's billing history ends in
 * `purged`, not in a missing row.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),

    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),

    /** Package id from @healdesk/catalog. */
    planCode: text("plan_code").notNull(),
    billingInterval: text("billing_interval").$type<BillingInterval>().notNull(),
    status: billingStatusEnum("status").notNull().default("provisioning"),

    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /** Set when a payment fails; service continues until it passes. */
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),

    channelsEnabled: jsonb("channels_enabled")
      .$type<ChannelsEnabled>()
      .notNull()
      .default({ web: false, meta: false, voice: false }),
    includedVoiceMinutes: integer("included_voice_minutes").notNull().default(0),
    includedChatConversations: integer("included_chat_conversations")
      .notNull()
      .default(0),
    usedVoiceMinutes: numeric("used_voice_minutes", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    usedChatConversations: integer("used_chat_conversations")
      .notNull()
      .default(0),

    /**
     * `allow` meters overage to Stripe; `hard_cap` stops answering at the
     * allowance. Allow by default: a clinic whose agent goes silent on the
     * 1,001st conversation has a worse month than one with an overage line.
     */
    overageMode: text("overage_mode")
      .$type<"allow" | "hard_cap">()
      .notNull()
      .default("allow"),

    /** When the forwarded-to Synthflow number may be released after a cancel. */
    numberReleaseAt: timestamp("number_release_at", { withTimezone: true }),

    /**
     * What has actually been paid towards setup, from the first invoice. The
     * input to `setupFeeDeltaUsd` on an upgrade; a clinic that paid $497 owes
     * $500 more for a $997 package, not $997.
     */
    setupFeePaidUsd: numeric("setup_fee_paid_usd", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    // --- 0043: usage alerts, locations, the paid period and refunds. ---
    /** Whether the 80% and 100% allowance emails are sent. The owner's switch. */
    usageAlertsEnabled: boolean("usage_alerts_enabled").notNull().default(true),
    /**
     * Locations on the subscription: the package item's quantity. Allowances
     * above stay per-location numbers; the pooled allowance is
     * `included × locations`, computed where usage is counted.
     */
    locations: integer("locations").notNull().default(1),
    /**
     * When the first invoice (the setup fee) was paid. Not a refund clock:
     * both refund windows run from the plan start (`planStartedAt`).
     */
    firstPaidAt: timestamp("first_paid_at", { withTimezone: true }),
    /**
     * End of the paid licensed period, from the latest paid invoice's package
     * line. The renewal date, which on an annual plan is NOT the allowance
     * window above.
     */
    paidThrough: timestamp("paid_through", { withTimezone: true }),
    /** The last invoice that was paid; a late payment_failed for it is stale and ignored. */
    lastPaidInvoiceId: text("last_paid_invoice_id"),
    /** The unpaid invoice and its Stripe-hosted pay link, while one is open. */
    openInvoiceId: text("open_invoice_id"),
    openInvoiceUrl: text("open_invoice_url"),
    /** Snapshot of the subscription's metered items' price lookup keys. */
    meteredPriceKeys: text("metered_price_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Stripe's `cancel_at`, when a cancellation is scheduled for a date. */
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    // setup_fee_refunded_at and setup_fee_refunded_usd were dropped by
    // drizzle/0050: the setup fee is never refundable (owner, 6 October 2026),
    // so nothing may ever record a refund of it.
    firstPeriodRefundedAt: timestamp("first_period_refunded_at", { withTimezone: true }),

    // --- 0044: the deferred start and the setup window (funnel and portal
    // contracts). Null on every row written before it. ---
    /** When the first plan invoice was paid: the monthly plan has started. */
    planStartedAt: timestamp("plan_started_at", { withTimezone: true }),
    /**
     * The package bought at checkout. `planCode` follows the package Stripe
     * bills, which matches the channels in service until every bought channel
     * is; this stays what was sold, and the metered rates stay its.
     */
    boughtPlanId: text("bought_plan_id"),
    /**
     * The end of the setup window: the end of the 30th day after purchase,
     * set at provisioning and extended only by ops. A clinic with no live
     * channel by then is closed by a job, and its setup fee is not refunded.
     */
    setupDeadlineAt: timestamp("setup_deadline_at", { withTimezone: true }),

    // --- 0050: the Stripe build (packages B, C and D). Null on every row
    // written before it. ---
    /**
     * When the plan-start worker's Stripe update went through: the package
     * price replaced the $0 placeholder. The plan has STARTED once this or
     * `planStartedAt` is set (`hasPlanStarted` in lib/billing/entitlements.ts),
     * because the paid date alone would leave the minutes between Stripe's
     * update and its invoice.paid looking like "not started", and a step-up
     * or a cancellation decided in that gap would act on the placeholder.
     */
    planStartAppliedAt: timestamp("plan_start_applied_at", { withTimezone: true }),
    /**
     * The first plan invoice, stamped when it is paid. The refunds read its
     * package line, so a later invoice can never be mistaken for it.
     */
    firstPlanInvoiceId: text("first_plan_invoice_id"),
    /**
     * One Stripe mutation of the subscription at a time per billing clinic.
     * The plan-start, step-up, close-setup and cancel-now workers and the
     * plan-change, extra-location, auto-renew and refund actions each claim
     * it with a conditional UPDATE and release it once their outcome is
     * written, so two of them can never each read the subscription, decide,
     * and overwrite the other's change. A claim whose holder died is taken
     * over once `until` has passed.
     */
    stripeMutationLeaseUntil: timestamp("stripe_mutation_lease_until", { withTimezone: true }),
    stripeMutationLeaseOwner: text("stripe_mutation_lease_owner"),
    /**
     * An extra location being added: the request, the location count it
     * makes, and when Stripe charged for it. Set before the charge and
     * cleared once the location's clinic exists, so a failure after the
     * charge is resumed from where it stopped instead of charged again.
     */
    pendingLocationRequestId: text("pending_location_request_id"),
    pendingLocationCount: integer("pending_location_count"),
    pendingLocationChargedAt: timestamp("pending_location_charged_at", { withTimezone: true }),
    /**
     * What the open invoice above asks for, in cents, beside its URL: the
     * Billing screen reads the database only (lib/billing/summary.ts), and
     * "pay the open invoice" needs its amount as well as its link.
     */
    openInvoiceAmountCents: integer("open_invoice_amount_cents"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("entitlements_stripe_customer_idx")
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),
    uniqueIndex("entitlements_stripe_subscription_idx")
      .on(t.stripeSubscriptionId)
      .where(sql`${t.stripeSubscriptionId} is not null`),
    check(
      "entitlements_interval_check",
      sql`${t.billingInterval} in ('month', 'year')`,
    ),
    check(
      "entitlements_overage_mode_check",
      sql`${t.overageMode} in ('allow', 'hard_cap')`,
    ),
    check("entitlements_locations_check", sql`${t.locations} >= 1`),
    // A lease is a holder and an expiry together: an expiry with no holder
    // could never be released by anyone, and a holder with no expiry would
    // never lapse.
    check(
      "entitlements_stripe_mutation_lease_check",
      sql`(${t.stripeMutationLeaseUntil} is null) = (${t.stripeMutationLeaseOwner} is null) and (${t.stripeMutationLeaseOwner} is null or char_length(${t.stripeMutationLeaseOwner}) between 1 and 120)`,
    ),
    // A pending location is a request and the count it makes, set together;
    // it can be charged only while it is pending; the count is at least two
    // (the clinic itself plus the new one); and the request id is an opaque
    // token, because it rides into Stripe metadata and idempotency keys.
    check(
      "entitlements_pending_location_check",
      sql`(${t.pendingLocationRequestId} is null) = (${t.pendingLocationCount} is null) and (${t.pendingLocationChargedAt} is null or ${t.pendingLocationRequestId} is not null) and (${t.pendingLocationCount} is null or ${t.pendingLocationCount} >= 2) and (${t.pendingLocationRequestId} is null or ${t.pendingLocationRequestId} ~ '^[A-Za-z0-9_-]{1,64}$')`,
    ),
  ],
);

export type Entitlements = typeof entitlements.$inferSelect;
export type NewEntitlements = typeof entitlements.$inferInsert;

/**
 * Every billing status change, append-only.
 *
 * `entitlements.status` says where a clinic is; this says how it got there and
 * who moved it. Support asking "why is this clinic suspended" gets a row with a
 * reason and the Stripe event that caused it, not a guess from the current
 * state. Append-only by grant (drizzle/0028), like audit_log: a history the
 * application can rewrite is not a history.
 *
 * `fromStatus` is null exactly once per clinic — the seed row written at
 * provisioning, when there was no prior state.
 */
export const billingTransitions = pgTable(
  "billing_transitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    fromStatus: billingStatusEnum("from_status"),
    toStatus: billingStatusEnum("to_status").notNull(),

    actor: text("actor").$type<BillingActor>().notNull(),
    /** Short, machine-readable: "invoice.paid", "dispute", "authentication_required". */
    reason: text("reason").notNull(),
    /** The Stripe event that caused this, when one did. */
    stripeEventId: text("stripe_event_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("billing_transitions_clinic_idx").on(t.clinicId, t.createdAt),
    check(
      "billing_transitions_actor_check",
      sql`${t.actor} in ('system', 'client', 'support')`,
    ),
  ],
);

export type BillingTransition = typeof billingTransitions.$inferSelect;

export type BillingEventOutcome =
  | "processed"
  | "ignored"
  | "failed"
  | "dead_letter";

/**
 * Every Stripe event delivered to us, keyed on Stripe's event id.
 *
 * Two jobs in one table. It is the DEDUPE LEDGER: Stripe delivers at least
 * once, the primary key makes the second delivery a no-op, and the stored
 * outcome is what a replay answers with. And it is the DEAD-LETTER QUEUE: an
 * event that fails `MAX_FAILURES` times is parked here with its error and its
 * full payload, acknowledged to Stripe so the endpoint stays enabled, and
 * waits for a person. See lib/billing/events.ts.
 *
 * Identity-plane, like provisioning_attempts: the row is written BEFORE the
 * clinic is known, because resolving the clinic is one of the steps that can
 * fail and the failure has to be recorded somewhere. So there is no RLS, and
 * the resolved clinic is deliberately not called `clinic_id` — the drift test
 * demands a policy on every column by that name, and a policy here would hide
 * the very rows support needs to see. See the column comment in drizzle/0029.
 *
 * `payload` is the verified event as Stripe sent it. It carries the buyer's
 * email and the clinic's name — business contact data, the same thing Stripe
 * already holds — and never PHI: nothing patient-level is ever put in Stripe
 * metadata (apps/web/src/lib/billing.ts).
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    stripeEventId: text("stripe_event_id").primaryKey(),
    type: text("type").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),

    /** A stored result, not a tenant key. See the table comment. */
    resolvedClinicId: uuid("resolved_clinic_id"),

    /** Null while in flight. A null that persists means the process died mid-event. */
    outcome: text("outcome").$type<BillingEventOutcome>(),
    /** How many attempts have thrown. At MAX_FAILURES the event is dead-lettered. */
    failures: integer("failures").notNull().default(0),
    /** The last error's name and message. Never the payload, never PHI. */
    error: text("error"),

    payload: jsonb("payload").notNull(),
  },
  (t) => [
    check(
      "billing_events_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in ('processed', 'ignored', 'failed', 'dead_letter')`,
    ),
    // The dead-letter queue is a query, and this is the index it runs on.
    index("billing_events_attention_idx")
      .on(t.outcome, t.receivedAt)
      .where(sql`${t.outcome} in ('failed', 'dead_letter')`),
  ],
);

export type BillingEvent = typeof billingEvents.$inferSelect;

// -----------------------------------------------------------------------------
// The Stripe launch (drizzle/0043): purchase, sign-in, usage, notices, deposits
// -----------------------------------------------------------------------------

/**
 * What the buyer filled in before Stripe Checkout, validated exactly as
 * provisioning would validate it. Business contact data of a clinic buyer,
 * never PHI.
 */
export type CheckoutIntentPayload = {
  clinicName: string;
  specialty: string;
  platform: string;
  plan: string;
  billingInterval: BillingInterval;
  contactName: string;
  /** Lowercased. */
  contactEmail: string;
  contactTitle?: string;
  /**
   * Only when the purchase asked. The four-step funnel asks neither: which
   * calls reach AYA is the wizard's question (step 2.2), and an answer stored
   * here would reach provisioning as the clinic's confirmed choice.
   */
  phoneSystemType?: "landline" | "voip" | "unknown";
  callRouting?: "conditional" | "always";
  agreementId: string;
  /**
   * The covered-entity answer the purchase was checked against the signed
   * agreement with (true, false, or null for "Not sure"). Provisioning takes
   * the determination from the agreement itself, never from here.
   */
  isCoveredEntity?: boolean | null;
  /**
   * The funnel's answers (plan Part A3), absent on an intent from before it:
   * where bookings live today, and the kind of Google account they would go
   * into, which together select the agreement's calendar terms; and the
   * website, or null for a practice with none (which is never sold website
   * chat). The read of that website is in its own column.
   */
  bookingSystem?: BookingSystemId;
  calendarAccount?: CalendarAccount;
  website?: string | null;
  /** The buyer's browser time zone: the fallback for the clinic's own. */
  timezone?: string;
};

/** Whether the website was read at checkout: read, tried and failed, or there was none. */
export const CHECKOUT_PROFILE_STATUSES = ["read", "failed", "none"] as const;
export type CheckoutProfileStatus = (typeof CHECKOUT_PROFILE_STATUSES)[number];

/**
 * A purchase waiting on its first paid invoice.
 *
 * apps/web stores nothing, so before it creates a Checkout Session it hands
 * the validated purchase form to apps/app, which keeps it here and returns an
 * opaque `ref`. Stripe then carries the ref and the terms of that press of
 * Pay (`{ app, ref, plan, billingInterval, attempt }`) and nothing about the
 * buyer, which is what removes the "paid, then provisioning refused the form"
 * case and the buyer's details from Stripe metadata (design D1), and what
 * lets provisioning refuse a payment for terms the intent no longer has.
 *
 * Identity plane: no clinic exists yet, so there is no clinic_id and no RLS.
 * The provisioned clinic is a stored result, deliberately not called
 * `clinic_id` (see provisioning_attempts). Purged by the billing-housekeeping
 * job once expired and unconsumed, or 90 days after it was consumed.
 */
export const checkoutIntents = pgTable(
  "checkout_intents",
  {
    ref: uuid("ref").primaryKey().defaultRandom(),
    payload: jsonb("payload").$type<CheckoutIntentPayload>().notNull(),
    agreementId: uuid("agreement_id").notNull(),
    contactEmail: text("contact_email").notNull(),
    plan: text("plan").notNull(),
    billingInterval: text("billing_interval").$type<BillingInterval>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set by the app from the database clock: now() + 14 days. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    provisionedClinicId: uuid("provisioned_clinic_id"),
    /** When the paying browser was handed its one-time sign-in link. */
    handoffIssuedAt: timestamp("handoff_issued_at", { withTimezone: true }),
    /**
     * The website read at checkout (plan Part B), validated on the way in,
     * and whether there was one: 'read', 'failed' (we tried; setup asks three
     * questions instead) or 'none' (no website, or none given).
     */
    profile: jsonb("profile"),
    profileStatus: text("profile_status").$type<CheckoutProfileStatus>().notNull().default("none"),
    /**
     * The setup request whose link opened this purchase, while purchases are
     * by invitation. Unique: one intent per setup link, which a cancelled and
     * retried payment reuses, and which a second purchase cannot.
     */
    inviteRef: text("invite_ref").unique(),
    /** How many times Pay was pressed for this intent; each press is one Checkout Session. */
    attempt: integer("attempt").notNull().default(0),
    /** The Checkout Session of the latest attempt, expired when another replaces it. */
    openSessionId: text("open_session_id"),
    /**
     * SHA-256 of the nonce cookie set on the paying browser. /welcome hands the
     * sign-in link only to the browser that holds the nonce.
     */
    nonceHash: bytea("nonce_hash"),
    /** The owner's sign-in, created at provisioning (design D3). */
    provisionedUserId: text("provisioned_user_id"),
    /** Provisioning refused this intent: /welcome says so instead of waiting. */
    provisionFailedAt: timestamp("provision_failed_at", { withTimezone: true }),
  },
  (t) => [
    check("checkout_intents_interval_check", sql`${t.billingInterval} in ('month', 'year')`),
    check(
      "checkout_intents_profile_status_check",
      sql`${t.profileStatus} in (${sqlList(CHECKOUT_PROFILE_STATUSES)})`,
    ),
    check(
      "checkout_intents_nonce_hash_length",
      sql`${t.nonceHash} is null or octet_length(${t.nonceHash}) = 32`,
    ),
    index("checkout_intents_expires_idx").on(t.expiresAt),
  ],
);

export type CheckoutIntent = typeof checkoutIntents.$inferSelect;

/**
 * A SQL `'a', 'b'` list from a TypeScript constant, for CHECKs that must match
 * the type. The values are our own literals, never input; a quote in one is
 * refused rather than escaped.
 */
function sqlList(values: readonly string[]) {
  for (const v of values) {
    if (!/^[a-z0-9_]+$/.test(v)) throw new Error(`sqlList: ${v} is not a plain identifier`);
  }
  return sql.raw(values.map((v) => `'${v}'`).join(", "));
}

export const SIGN_IN_LINK_PURPOSES = ["checkout", "welcome", "sign_in", "invite"] as const;
export type SignInLinkPurpose = (typeof SIGN_IN_LINK_PURPOSES)[number];

/**
 * Single-use sign-in links: the only way into the clinic portal (design D4).
 *
 * The connection_links rules, on the identity plane: `token_hash` is
 * SHA-256 of what was sent and a CHECK pins it to 32 bytes, so storing the
 * token itself fails the INSERT; `used_at` is set once by a conditional
 * UPDATE and a trigger refuses any later write to a consumed row; the
 * runtime role has no DELETE and may UPDATE only `used_at` and
 * `consumed_ip`. Old links are not purged — they simply expire.
 *
 * `source_ref` makes one source mint at most one link of a purpose (one
 * checkout, one handoff), by a partial unique index.
 */
export const signInLinks = pgTable(
  "sign_in_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    purpose: text("purpose").$type<SignInLinkPurpose>().notNull(),
    /** e.g. the sha256 hex of the checkout intent ref. Never a raw id. */
    sourceRef: text("source_ref"),
    /**
     * A path on this app. The CHECK refuses a protocol-relative `//host`, any
     * backslash and any control character, because browsers (WHATWG URL
     * parsing) turn `/\\host` and `/<TAB>/host` into `//host`. It is a
     * backstop, not the guard: whoever fills this from user input (a `?next=`)
     * must still validate it as a same-origin path before inserting.
     */
    redirectTo: text("redirect_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    consumedIp: inet("consumed_ip"),
    /** Who issued it: a service name or an actor label, as a snapshot. */
    issuedBy: text("issued_by"),
  },
  (t) => [
    uniqueIndex("sign_in_links_token_hash_idx").on(t.tokenHash),
    uniqueIndex("sign_in_links_source_idx")
      .on(t.purpose, t.sourceRef)
      .where(sql`${t.sourceRef} is not null`),
    index("sign_in_links_user_idx").on(t.userId, t.createdAt),
    check("sign_in_links_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check(
      "sign_in_links_purpose_check",
      sql`${t.purpose} in (${sqlList(SIGN_IN_LINK_PURPOSES)})`,
    ),
    check(
      "sign_in_links_redirect_check",
      sql`${t.redirectTo} is null or (${t.redirectTo} like '/%' and ${t.redirectTo} not like '//%' and ${t.redirectTo} !~ '[\\\\[:cntrl:]]')`,
    ),
    check("sign_in_links_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "sign_in_links_consumed_ip_check",
      sql`${t.consumedIp} is null or ${t.usedAt} is not null`,
    ),
  ],
);

export type SignInLink = typeof signInLinks.$inferSelect;

export type DepositUncollectable = "book_and_flag" | "hold_and_alert" | "decline_and_alert";

/**
 * Per-clinic switches the portal edits (design D9): deposits, Pause AI and
 * the direct line. A table of its own so an edit here never clears agent
 * approval and needs no clinics column grant. A missing row means the
 * defaults (lib/billing/settings.ts); writers upsert. Tenant plane.
 */
export const clinicSettings = pgTable(
  "clinic_settings",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),
    depositsEnabled: boolean("deposits_enabled").notNull().default(false),
    bookVoiceWithoutDeposit: boolean("book_voice_without_deposit").notNull().default(true),
    bookChatWithoutDeposit: boolean("book_chat_without_deposit").notNull().default(false),
    depositUncollectable: text("deposit_uncollectable")
      .$type<DepositUncollectable>()
      .notNull()
      .default("book_and_flag"),
    depositHoldMinutes: integer("deposit_hold_minutes").notNull().default(60),
    aiPausedAt: timestamp("ai_paused_at", { withTimezone: true }),
    aiPausedByLabel: text("ai_paused_by_label"),
    /**
     * When a pause ends by itself ("for 1 hour", "until tomorrow 8 am"). Read
     * only while `aiPausedAt` is set, and null then means until someone turns
     * AYA back on.
     */
    aiPausedUntil: timestamp("ai_paused_until", { withTimezone: true }),
    /**
     * A clinic line that does NOT forward back to us: where every degradation
     * path sends a caller (CLAUDE.md, "Failure"). E.164.
     */
    directLineE164: text("direct_line_e164"),
    directLineSetAt: timestamp("direct_line_set_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "clinic_settings_uncollectable_check",
      sql`${t.depositUncollectable} in ('book_and_flag', 'hold_and_alert', 'decline_and_alert')`,
    ),
    check(
      "clinic_settings_hold_minutes_check",
      sql`${t.depositHoldMinutes} between 30 and 1440`,
    ),
    check(
      "clinic_settings_direct_line_check",
      sql`${t.directLineE164} is null or ${t.directLineE164} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
  ],
);

export type ClinicSettingsRow = typeof clinicSettings.$inferSelect;

export type UsageMeter = "voice_minutes" | "chat_conversations";
export type UsageSource = "voice_call" | "meta" | "web_chat";

/**
 * The usage ledger: one row per billed call or chat conversation, the source
 * of truth behind the entitlements counters (design D10). The tenant is the
 * BILLING clinic whose allowance was used; `location_clinic_id` says which
 * location answered. `source_ref` is a sha256 hex, never a raw vendor id, and
 * the unique index makes a redelivered webhook a no-op. Append-only apart
 * from the three Stripe reporting columns.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    locationClinicId: uuid("location_clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    meter: text("meter").$type<UsageMeter>().notNull(),
    source: text("source").$type<UsageSource>().notNull(),
    sourceRef: text("source_ref").notNull(),
    quantity: integer("quantity").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** The allowance window this counted against. */
    windowStart: timestamp("window_start", { withTimezone: true }),
    /** Pooled allowance (included × locations) when it was counted. */
    included: integer("included").notNull(),
    usedBefore: integer("used_before").notNull(),
    /** Units of this event past the pooled allowance: what overage bills. */
    overAllowance: integer("over_allowance").notNull().default(0),
    stripeReportedAt: timestamp("stripe_reported_at", { withTimezone: true }),
    stripeReportAttempts: integer("stripe_report_attempts").notNull().default(0),
    stripeReportError: text("stripe_report_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("usage_events_source_idx").on(t.clinicId, t.meter, t.source, t.sourceRef),
    index("usage_events_window_idx").on(t.clinicId, t.windowStart),
    index("usage_events_unreported_idx")
      .on(t.clinicId, t.occurredAt)
      .where(sql`${t.overAllowance} > 0 and ${t.stripeReportedAt} is null`),
    check("usage_events_meter_check", sql`${t.meter} in ('voice_minutes', 'chat_conversations')`),
    check("usage_events_source_check", sql`${t.source} in ('voice_call', 'meta', 'web_chat')`),
    check("usage_events_quantity_check", sql`${t.quantity} > 0`),
    check("usage_events_over_check", sql`${t.overAllowance} >= 0`),
  ],
);

export type UsageEvent = typeof usageEvents.$inferSelect;

export type ChatThreadChannel = "messenger" | "instagram" | "whatsapp" | "web_chat";

/**
 * One person's thread on one channel, for counting chat conversations (owner
 * decision 3): a conversation starts at their first message and ends when 24
 * hours pass with no message from them. `party_ref` is sha256 hex of the
 * platform sender id; `conversation_id` is regenerated when a new
 * conversation starts. Tenant plane.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChatThreadChannel>().notNull(),
    partyRef: text("party_ref").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    conversationStartedAt: timestamp("conversation_started_at", { withTimezone: true }).notNull(),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }).notNull(),
    conversationsCount: integer("conversations_count").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.channel, t.partyRef] }),
    check(
      "chat_threads_channel_check",
      sql`${t.channel} in ('messenger', 'instagram', 'whatsapp', 'web_chat')`,
    ),
  ],
);

/**
 * Meta message ids already handled, so a redelivered webhook is skipped
 * entirely (no second answer, no second count). sha256 hex of the message id;
 * purged after 7 days by the billing-housekeeping job. Tenant plane.
 */
export const metaInboundMessages = pgTable(
  "meta_inbound_messages",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    platform: text("platform").$type<"messenger" | "instagram" | "whatsapp">().notNull(),
    messageRef: text("message_ref").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.platform, t.messageRef] }),
    index("meta_inbound_messages_received_idx").on(t.receivedAt),
    check(
      "meta_inbound_messages_platform_check",
      sql`${t.platform} in ('messenger', 'instagram', 'whatsapp')`,
    ),
  ],
);

/**
 * The outbox's kinds: the keys of the registry in lib/email/kinds.ts (Annex
 * X3), which also says how each is sent. F0's name and export are kept, so
 * every reader of this list reads the registry.
 */
export const BILLING_NOTICE_KINDS = NOTICE_KINDS;
export type BillingNoticeKind = (typeof BILLING_NOTICE_KINDS)[number];

/**
 * The billing-email outbox (design D12). Handlers INSERT a notice inside
 * their tenant transaction, deduplicated on (clinic, kind, dedupe_key); a
 * sender delivers it outside any transaction to the owners and billing
 * contacts of the billing clinic. `payload` carries no PHI: cents, ISO dates,
 * Stripe-hosted invoice URLs, plan ids, meter names, location counts.
 */
export const billingNotices = pgTable(
  "billing_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BillingNoticeKind>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sendAfter: timestamp("send_after", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    recipientsCount: integer("recipients_count"),
  },
  (t) => [
    uniqueIndex("billing_notices_dedupe_idx").on(t.clinicId, t.kind, t.dedupeKey),
    index("billing_notices_pending_idx")
      .on(t.sendAfter)
      .where(sql`${t.sentAt} is null`),
    check(
      "billing_notices_kind_check",
      // Built from the list, so a kind added there changes this CHECK and
      // drizzle-kit generates the migration, instead of the INSERT failing at
      // runtime inside the Stripe event's transaction.
      sql`${t.kind} in (${sqlList(BILLING_NOTICE_KINDS)})`,
    ),
  ],
);

export type BillingNotice = typeof billingNotices.$inferSelect;

/**
 * Overage on annual plans, invoiced once per closed allowance month (monthly
 * plans report to Stripe's meters instead). One row per window; tenant plane.
 */
export const overageInvoices = pgTable(
  "overage_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    voiceUnits: integer("voice_units").notNull().default(0),
    chatUnits: integer("chat_units").notNull().default(0),
    voiceRateCents: integer("voice_rate_cents").notNull().default(0),
    chatRateCents: integer("chat_rate_cents").notNull().default(0),
    amountCents: integer("amount_cents").notNull().default(0),
    status: text("status").$type<"pending" | "invoiced" | "failed" | "skipped">().notNull(),
    stripeInvoiceId: text("stripe_invoice_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("overage_invoices_window_idx").on(t.clinicId, t.windowStart),
    check(
      "overage_invoices_status_check",
      sql`${t.status} in ('pending', 'invoiced', 'failed', 'skipped')`,
    ),
  ],
);

export type OverageInvoice = typeof overageInvoices.$inferSelect;

/**
 * What a billing request asks Stripe to do: swap the $0 placeholder for the
 * package price (`plan_start`), add a channel's price (`step_up`), close an
 * account whose 30-day setup window ran out with nothing live
 * (`close_setup`), or cancel at once after a first-period refund
 * (`cancel_now`).
 */
export const BILLING_REQUEST_KINDS = ["plan_start", "step_up", "close_setup", "cancel_now"] as const;
export type BillingRequestKind = (typeof BILLING_REQUEST_KINDS)[number];

/** Why it was recorded: a channel's first answer, a waiting channel's 30 days, the setup deadline, an operator, or the hourly reconcile. */
export const BILLING_REQUEST_REASONS = [
  "first_answer",
  "waiting",
  "deadline",
  "ops",
  "reconcile",
] as const;
export type BillingRequestReason = (typeof BILLING_REQUEST_REASONS)[number];

/** How a finished request ended. A pending one has no outcome. */
export const BILLING_REQUEST_OUTCOMES = ["done", "skipped", "dead_letter"] as const;
export type BillingRequestOutcome = (typeof BILLING_REQUEST_OUTCOMES)[number];

/** The channel a step_up adds; every other kind carries "-", so the unique key still holds. */
export type BillingRequestChannelKey = Channel | "-";

/**
 * The billing-request ledger (drizzle/0050, build decision BD1): what the
 * engine has asked Stripe to do, recorded in the same transaction as the
 * event that asked (a channel's first answer, the reconcile, an operator),
 * and carried out afterwards by a worker that calls Stripe outside any
 * transaction.
 *
 * Why a table and not a queue job: a pg-boss send is not part of the
 * caller's transaction, so a crash between the commit and the send would
 * lose a plan start for good and leave the clinic answering on the $0 line.
 * Here the row commits or rolls back with the first answer itself.
 *
 * Rows live on the BILLING clinic. The recorders go through the definer
 * `app_record_billing_request`, which resolves the billing clinic from the
 * caller's tenant, so a location's transaction can record one and every
 * claim, outcome and re-arm then runs in the billing clinic's tenant. One row
 * per (clinic, kind, channel): a second request for the same thing is a
 * no-op, and a finished one is re-armed rather than inserted again, which
 * also bounds a clinic to six rows.
 *
 * The worker claims a row by a conditional UPDATE that sets a short
 * `lease_until` and counts the attempt, then writes the outcome
 * conditionally on the attempt it claimed. The runtime role may SELECT and
 * INSERT, UPDATE only those worker columns, and never DELETE: this is billing
 * evidence, kept through offboarding. Tenant plane, no PHI.
 */
export const billingRequests = pgTable(
  "billing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BillingRequestKind>().notNull(),
    channelKey: text("channel_key").$type<BillingRequestChannelKey>().notNull().default("-"),
    reason: text("reason").$type<BillingRequestReason>().notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** While set and in the future, a worker holds the row. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** A closed code and a short reason, never a Stripe payload or an exception's text. */
    lastError: text("last_error"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    outcome: text("outcome").$type<BillingRequestOutcome>(),
    /** A snake_case code: already_started, cancel_pending, live_channel, no_change… */
    outcomeReason: text("outcome_reason"),
  },
  (t) => [
    uniqueIndex("billing_requests_key_idx").on(t.clinicId, t.kind, t.channelKey),
    // The drainer's question, "what is due", runs on pending rows only.
    index("billing_requests_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.doneAt} is null`),
    check("billing_requests_kind_check", sql`${t.kind} in (${sqlList(BILLING_REQUEST_KINDS)})`),
    check(
      "billing_requests_channel_check",
      sql`${t.channelKey} = '-' or ${t.channelKey} in (${sqlList(CHANNELS)})`,
    ),
    // A step-up names the channel it adds, and nothing else names one.
    check(
      "billing_requests_step_up_channel_check",
      sql`(${t.kind} = 'step_up') = (${t.channelKey} <> '-')`,
    ),
    check(
      "billing_requests_reason_check",
      sql`${t.reason} in (${sqlList(BILLING_REQUEST_REASONS)})`,
    ),
    check("billing_requests_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "billing_requests_last_error_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 300`,
    ),
    check(
      "billing_requests_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in (${sqlList(BILLING_REQUEST_OUTCOMES)})`,
    ),
    // Finished means an outcome, and only a finished request has one.
    check("billing_requests_done_check", sql`(${t.doneAt} is null) = (${t.outcome} is null)`),
    check(
      "billing_requests_outcome_reason_check",
      sql`${t.outcomeReason} is null or ${t.outcomeReason} ~ '^[a-z_]{1,40}$'`,
    ),
  ],
);

export type BillingRequest = typeof billingRequests.$inferSelect;

export type DepositPaymentStatus =
  | "creating"
  | "open"
  | "paid"
  | "expired"
  | "failed"
  | "cancelled"
  | "refunded";

/**
 * A hosted deposit link on the clinic's own connected Stripe account (design
 * D14). `id` is THE opaque reference sent to Stripe: no treatment name, no
 * patient detail ever reaches Stripe. Carries the BAA gate trigger because a
 * row is tied to an appointment. Tenant plane.
 */
export const depositPayments = pgTable(
  "deposit_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    channel: text("channel").$type<"web" | "meta">().notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    stripeAccountId: text("stripe_account_id").notNull(),
    checkoutSessionId: text("checkout_session_id").unique(),
    status: text("status").$type<DepositPaymentStatus>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    lastEventId: text("last_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deposit_payments_appointment_idx").on(t.clinicId, t.appointmentId),
    // One live link per appointment (drizzle/0050): a retried booking turn or
    // a second request for the same appointment gets the open session back
    // (createDepositLink) instead of a second link the patient could also pay.
    uniqueIndex("deposit_payments_open_appointment_idx")
      .on(t.clinicId, t.appointmentId)
      .where(sql`${t.status} in ('creating', 'open') and ${t.appointmentId} is not null`),
    check("deposit_payments_channel_check", sql`${t.channel} in ('web', 'meta')`),
    check("deposit_payments_amount_check", sql`${t.amountCents} > 0`),
    check(
      "deposit_payments_status_check",
      sql`${t.status} in ('creating', 'open', 'paid', 'expired', 'failed', 'cancelled', 'refunded')`,
    ),
  ],
);

export type DepositPayment = typeof depositPayments.$inferSelect;

/**
 * Dedupe and dead-letter ledger for the Stripe Connect webhook, like
 * billing_events but WITHOUT a payload: Connect events on a clinic's account
 * carry its patients' payer details, which have no business in our database.
 * Identity plane; the resolved clinic is a stored result, not `clinic_id`.
 */
export const stripeConnectEvents = pgTable(
  "stripe_connect_events",
  {
    stripeEventId: text("stripe_event_id").primaryKey(),
    type: text("type").notNull(),
    account: text("account").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    outcome: text("outcome").$type<BillingEventOutcome>(),
    failures: integer("failures").notNull().default(0),
    error: text("error"),
    resolvedClinicId: uuid("resolved_clinic_id"),
  },
  (t) => [
    check(
      "stripe_connect_events_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in ('processed', 'ignored', 'failed', 'dead_letter')`,
    ),
    index("stripe_connect_events_attention_idx")
      .on(t.outcome, t.receivedAt)
      .where(sql`${t.outcome} in ('failed', 'dead_letter')`),
  ],
);

/**
 * Where a Connect callback sends the browser back to (drizzle/0050): the
 * portal's Settings, the setup wizard, or the neutral page an operator's link
 * lands on. Never /admin.
 */
export const STRIPE_CONNECT_RETURN_TO = ["settings", "setup", "ops"] as const;
export type StripeConnectReturnTo = (typeof STRIPE_CONNECT_RETURN_TO)[number];

/**
 * Single-use Stripe Connect OAuth state. Stores SHA-256 of the state, never
 * the state. Identity plane: the callback arrives with no tenant, and this
 * row is how it learns one.
 *
 * The clinic column is `target_clinic_id`, not `clinic_id`: the RLS drift
 * test demands a FORCEd policy on every table with a column by that name, and
 * a tenant policy would hide the row from the very callback that has to read
 * it before any tenant is known (the provisioning_attempts precedent).
 */
export const stripeConnectStates = pgTable(
  "stripe_connect_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    clinicId: uuid("target_clinic_id").notNull(),
    userId: text("user_id"),
    returnTo: text("return_to").$type<StripeConnectReturnTo>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    check("stripe_connect_states_hash_length", sql`octet_length(${t.stateHash}) = 32`),
    check(
      "stripe_connect_states_return_check",
      sql`${t.returnTo} in (${sqlList(STRIPE_CONNECT_RETURN_TO)})`,
    ),
  ],
);

// -----------------------------------------------------------------------------
// The funnel and portal contracts (drizzle/0044): channels, their events, and
// the days a clinic is closed
// -----------------------------------------------------------------------------

/** The one thing a channel ready on our side is waiting for the clinic to do. */
export const CHANNEL_WAITING_ON = [
  "setup",
  "forwarding",
  "snippet",
  "meta_connect",
  "whatsapp_payment_method",
] as const;
export type ChannelWaitingOn = (typeof CHANNEL_WAITING_ON)[number];

/**
 * One row per channel the clinic bought, written at provisioning. The channel
 * is the catalog's (`CHANNELS`: web, meta, voice), because billing steps up by
 * those three: Meta is one row for Instagram, Messenger and WhatsApp.
 *
 * The row is the channel's state now; `channel_events` is how it got there.
 * `enabled` is the Settings On/Off. `ready_at` is when it was ready on our
 * side, `waiting_on` the clinic's one outstanding action meanwhile, `live_at`
 * when it went live, and `first_answer_at` its first answered patient
 * conversation: the day its price joins the plan. lib/channels/state.ts turns
 * a row into a status word.
 *
 * The runtime role cannot DELETE a row or move its key, so a channel in
 * service never drops out of the price by losing it. Tenant plane, no PHI.
 */
export const clinicChannels = pgTable(
  "clinic_channels",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<Channel>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    waitingOn: text("waiting_on").$type<ChannelWaitingOn>(),
    liveAt: timestamp("live_at", { withTimezone: true }),
    firstAnswerAt: timestamp("first_answer_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.channel] }),
    check("clinic_channels_channel_check", sql`${t.channel} in (${sqlList(CHANNELS)})`),
    check(
      "clinic_channels_waiting_on_check",
      sql`${t.waitingOn} is null or ${t.waitingOn} in (${sqlList(CHANNEL_WAITING_ON)})`,
    ),
  ],
);

export type ClinicChannelRow = typeof clinicChannels.$inferSelect;

export const CHANNEL_EVENT_KINDS = [
  "ready",
  "waiting",
  "live",
  "first_answer",
  "paused",
  "resumed",
  "turned_off",
  "turned_on",
] as const;
export type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

/**
 * What happened to a clinic's channels, append-only: ready on our side,
 * waiting on the clinic (and for what), live, the first answer, the header's
 * pause and resume, and the Settings switch.
 *
 * It is billing evidence. The plan starts on the clinic's first
 * `first_answer` and each later channel's price joins on its own, so the
 * partial unique index below makes the database, not the engine's memory,
 * the reason a channel's first answer is recorded once. A pause is
 * clinic-wide, so `paused` and `resumed` may name no channel; every other
 * kind names one.
 *
 * `actor` is 'system', 'ops', or the label of the device whose passkey did it.
 * `detail` holds ids, ISO dates and counts, never conversation content. The
 * runtime role may SELECT and INSERT, nothing else. Tenant plane, no PHI.
 */
export const channelEvents = pgTable(
  "channel_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<Channel>(),
    kind: text("kind").$type<ChannelEventKind>().notNull(),
    waitingOn: text("waiting_on").$type<ChannelWaitingOn>(),
    actor: text("actor"),
    detail: jsonb("detail")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_events_first_answer_idx")
      .on(t.clinicId, t.channel)
      .where(sql`${t.kind} = 'first_answer'`),
    index("channel_events_clinic_idx").on(t.clinicId, t.occurredAt),
    check(
      "channel_events_channel_check",
      sql`${t.channel} is null or ${t.channel} in (${sqlList(CHANNELS)})`,
    ),
    check("channel_events_kind_check", sql`${t.kind} in (${sqlList(CHANNEL_EVENT_KINDS)})`),
    check(
      "channel_events_waiting_on_check",
      sql`${t.waitingOn} is null or ${t.waitingOn} in (${sqlList(CHANNEL_WAITING_ON)})`,
    ),
    check(
      "channel_events_channel_required",
      sql`${t.channel} is not null or ${t.kind} in ('paused', 'resumed')`,
    ),
  ],
);

export type ChannelEvent = typeof channelEvents.$inferSelect;

/**
 * Whole local days the clinic is closed (a holiday, a training day), on top
 * of its weekly hours, which stay in `clinics.opening_hours`. `closed_on` is
 * a date in the clinic's own time zone; lib/clinic/closures.ts reads it. The
 * runtime role may add a day, relabel it and remove it, never move it.
 * Tenant plane, no PHI.
 */
export const clinicClosures = pgTable(
  "clinic_closures",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    closedOn: date("closed_on", { mode: "string" }).notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.closedOn] }),
    check(
      "clinic_closures_label_check",
      sql`${t.label} is null or char_length(${t.label}) <= 80`,
    ),
  ],
);

// -----------------------------------------------------------------------------
// The portal's second factors and step-up (drizzle/0047). Identity plane, like
// sign_in_links: a factor belongs to the clinic's one sign-in, not to a clinic,
// and is read before any tenant is known, so no clinic_id and no RLS.
// -----------------------------------------------------------------------------

export const USER_FACTOR_KINDS = ["passkey", "totp"] as const;
export type UserFactorKind = (typeof USER_FACTOR_KINDS)[number];

/**
 * The second factors of one sign-in (plan Part D3): a passkey per phone or
 * computer, named by the person adding it, and at most one authenticator-app
 * secret as the backup. One sign-in is shared by a clinic's staff, so the
 * device a passkey lives on is the only "who" there is: step_ups snapshots
 * the label and the access log records it.
 *
 * Each kind has its own columns and a CHECK refuses the other kind's: a
 * passkey row is a WebAuthn credential (id, COSE public key, signature
 * counter, transports, whether it is synced), a TOTP row a sealed secret
 * (envelope.ts, bound to this row's id) and the last time step spent.
 *
 * The runtime role may move only `counter`, `last_step`, `last_used_at` and
 * `revoked_at`, never DELETE, and a trigger freezes a revoked row and refuses
 * a counter or step going backwards (app_user_factor_no_rewrite).
 */
export const userFactors = pgTable(
  "user_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<UserFactorKind>().notNull(),
    /** Chosen by the person. Required for passkeys; the TOTP backup has none. */
    deviceLabel: text("device_label"),
    /** base64url, as the browser reports it. */
    credentialId: text("credential_id"),
    /** The COSE-encoded public key, exactly as registered. */
    publicKey: bytea("public_key"),
    /** The authenticator's signature counter; synced passkeys keep it at 0. */
    counter: bigint("counter", { mode: "number" }),
    transports: text("transports").array(),
    /** Synced to the platform's keychain at registration (a "multi-device" passkey). */
    backedUp: boolean("backed_up"),
    /** The base32 TOTP secret, sealed. Never stored or logged in the clear. */
    secretSealed: jsonb("secret_sealed").$type<SealedPayload>(),
    /** The highest RFC 6238 time step already accepted: the replay guard. */
    lastStep: bigint("last_step", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_factors_credential_id_idx")
      .on(t.credentialId)
      .where(sql`${t.credentialId} is not null`),
    uniqueIndex("user_factors_one_totp_idx")
      .on(t.userId)
      .where(sql`${t.kind} = 'totp' and ${t.revokedAt} is null`),
    index("user_factors_user_idx").on(t.userId, t.createdAt),
    check("user_factors_kind_check", sql`${t.kind} in (${sqlList(USER_FACTOR_KINDS)})`),
    check(
      "user_factors_passkey_columns",
      sql`${t.kind} <> 'passkey' or (${t.credentialId} is not null and ${t.publicKey} is not null and ${t.counter} is not null and ${t.deviceLabel} is not null and ${t.backedUp} is not null and ${t.secretSealed} is null and ${t.lastStep} is null)`,
    ),
    check(
      "user_factors_totp_columns",
      sql`${t.kind} <> 'totp' or (${t.secretSealed} is not null and ${t.lastStep} is not null and ${t.credentialId} is null and ${t.publicKey} is null and ${t.counter} is null and ${t.transports} is null and ${t.backedUp} is null)`,
    ),
    check(
      "user_factors_device_label_check",
      sql`${t.deviceLabel} is null or (char_length(${t.deviceLabel}) between 1 and ${sql.raw(String(DEVICE_LABEL_MAX))} and ${t.deviceLabel} = btrim(${t.deviceLabel}) and ${t.deviceLabel} !~ '[[:cntrl:]]')`,
    ),
    // A length check, not a regex bound: Postgres caps {m,n} at 255. 1364 is
    // base64url of WebAuthn's longest credential id, 1023 bytes.
    check(
      "user_factors_credential_id_format",
      sql`${t.credentialId} is null or (${t.credentialId} ~ '^[A-Za-z0-9_-]+$' and char_length(${t.credentialId}) <= 1364)`,
    ),
    check("user_factors_counter_check", sql`${t.counter} is null or ${t.counter} >= 0`),
    check("user_factors_last_step_check", sql`${t.lastStep} is null or ${t.lastStep} >= 0`),
  ],
);

export type UserFactor = typeof userFactors.$inferSelect;

/**
 * Backup codes for the authenticator app (plan Part D3): ten per set, shown
 * once, stored as SHA-256 of the normalised code. A code is spent by one
 * conditional UPDATE of `used_at`; a new set revokes the old set's unspent
 * codes rather than deleting them, so "which code was used, and when" keeps
 * an answer. The runtime role has no DELETE and may UPDATE `used_at` and
 * `revoked_at` only, and a spent or revoked code is frozen.
 */
export const userBackupCodes = pgTable(
  "user_backup_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    codeHash: bytea("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("user_backup_codes_live_idx")
      .on(t.userId, t.codeHash)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
    check("user_backup_codes_hash_length", sql`octet_length(${t.codeHash}) = 32`),
  ],
);

export const WEBAUTHN_CHALLENGE_PURPOSES = ["register", "authenticate"] as const;
export type WebauthnChallengePurpose = (typeof WEBAUTHN_CHALLENGE_PURPOSES)[number];

/**
 * Why this session may add a passkey, decided before the browser is asked to
 * make one (plan Part D3): the sign-in's first passkey before any of its
 * clinics has gone live, a passkey step-up on this session, or a code from
 * the authenticator app or a backup code.
 */
export const PASSKEY_ENROL_BASES = ["first_passkey", "step_up", "code"] as const;
export type PasskeyEnrolBasis = (typeof PASSKEY_ENROL_BASES)[number];

/**
 * WebAuthn challenges, single-use: consumed by one conditional UPDATE of
 * `used_at` (`used_at IS NULL AND expires_at > now()`), the sign_in_links
 * pattern, so one ceremony's response can be verified once. Each is bound to
 * the session that asked for it (SHA-256 of its Better Auth token, as in
 * step_ups), so a response lifted from one browser cannot step up another.
 * A registration carries the basis it was allowed on. Five minutes at most,
 * pinned by a CHECK. The runtime role may UPDATE `used_at` only, never DELETE.
 */
export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionTokenHash: bytea("session_token_hash").notNull(),
    purpose: text("purpose").$type<WebauthnChallengePurpose>().notNull(),
    /** base64url, exactly as the options handed to the browser carry it. */
    challenge: text("challenge").notNull(),
    enrolBasis: text("enrol_basis").$type<PasskeyEnrolBasis>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("webauthn_challenges_challenge_idx").on(t.challenge),
    index("webauthn_challenges_user_idx").on(t.userId, t.createdAt),
    check(
      "webauthn_challenges_purpose_check",
      sql`${t.purpose} in (${sqlList(WEBAUTHN_CHALLENGE_PURPOSES)})`,
    ),
    check(
      "webauthn_challenges_basis_check",
      sql`(${t.purpose} = 'register') = (${t.enrolBasis} is not null) and (${t.enrolBasis} is null or ${t.enrolBasis} in (${sqlList(PASSKEY_ENROL_BASES)}))`,
    ),
    check(
      "webauthn_challenges_challenge_format",
      sql`${t.challenge} ~ '^[A-Za-z0-9_-]{16,128}$'`,
    ),
    check(
      "webauthn_challenges_session_hash_length",
      sql`octet_length(${t.sessionTokenHash}) = 32`,
    ),
    check(
      "webauthn_challenges_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
  ],
);

/**
 * Passkey step-ups (plan Part D2): this session proved, with this device's
 * passkey, that someone holding the device is here. Patient pages and
 * sensitive changes ask for one that has been active in the last 15 minutes
 * and is at most 8 hours old (lib/portal/step-up.ts).
 *
 * Bound to the Better Auth session by SHA-256 of its token, never the token:
 * the token is the cookie's bearer value, and Better Auth 1.6 never rotates
 * it (`disableSessionRefresh`, and a refresh would only move `expires_at`),
 * so the hash is stable for the session's fourteen days. A step-up outlives
 * its session only as a record: once the session row is gone no request can
 * present the token again, and sign-out revokes it besides (lib/auth.ts).
 *
 * `device_label` is a snapshot, so the access log still names the device
 * after it is renamed or removed. The runtime role may UPDATE
 * `last_activity_at` and `revoked_at` only, never DELETE; a revoked row is
 * frozen, activity never moves backwards, and a CHECK keeps it inside the
 * eight hours.
 */
export const stepUps = pgTable(
  "step_ups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionTokenHash: bytea("session_token_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    factorId: uuid("factor_id")
      .notNull()
      .references(() => userFactors.id, { onDelete: "cascade" }),
    deviceLabel: text("device_label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("step_ups_session_idx")
      .on(t.sessionTokenHash)
      .where(sql`${t.revokedAt} is null`),
    index("step_ups_factor_idx").on(t.factorId),
    index("step_ups_user_idx").on(t.userId, t.createdAt),
    check("step_ups_session_hash_length", sql`octet_length(${t.sessionTokenHash}) = 32`),
    check(
      "step_ups_activity_window",
      sql`${t.lastActivityAt} >= ${t.createdAt} and ${t.lastActivityAt} <= ${t.createdAt} + interval '8 hours'`,
    ),
  ],
);

/**
 * Wrong second-factor codes, counted per sign-in so a lockout survives a
 * restart and holds across instances (plan Part D3). attempt-limit.ts is
 * in-memory and per process, which is right for what it bounds and wrong for
 * this. Five wrong codes (authenticator or backup) within fifteen minutes
 * lock code entry for fifteen minutes; a right code clears the count.
 */
export const factorLockouts = pgTable(
  "factor_lockouts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    failures: integer("failures").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("factor_lockouts_failures_check", sql`${t.failures} >= 0`)],
);

/** Tables carrying a clinic_id, and therefore requiring RLS. Asserted by tests. */
export const TENANT_SCOPED_TABLES = [
  "clinic_memberships",
  "provider_connections",
  "contacts",
  "conversations",
  "appointments",
  "transactions",
  "audit_log",
  "consent_records",
  "suppressions",
  "contact_attempts",
  "sync_runs",
  "webhook_events",
  "reconciliation_exceptions",
  "connection_links",
  "entitlements",
  "billing_transitions",
  "agent_configs",
  "report_recipients",
  "report_deliveries",
  "incidents",
  "clinic_touches",
  "booking_requests",
  "meta_booking_drafts",
  "clinic_settings",
  "usage_events",
  "chat_threads",
  "meta_inbound_messages",
  "billing_notices",
  "overage_invoices",
  "deposit_payments",
  "clinic_channels",
  "channel_events",
  "clinic_closures",
  "billing_requests",
] as const;

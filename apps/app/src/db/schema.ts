import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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

import type { BillingInterval, Channel, OnboardingState } from "@healdesk/catalog";

import type { OpeningHours } from "../lib/clinic/opening-hours";
import type { SealedPayload } from "../lib/crypto/envelope";

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
     * The retention clocks, in days, per clinic. Two, because the two kinds
     * of data have different value and different risk:
     *
     *   media   — transcript and recording references. Pure liability after
     *             the dispute window closes; 90 days by default.
     *   records — the conversation, appointment and transaction rows the
     *             revenue report is built from. Two years by default, so a
     *             year-over-year comparison is possible and no longer.
     *
     * Consent records, suppressions and contact attempts are NOT on either
     * clock: they are the evidence that a call was lawful and that an
     * opt-out was honoured, and deleting evidence is not a privacy control.
     * The purge job (lib/retention/purge.ts) is the only reader.
     */
    retentionMediaDays: integer("retention_media_days").notNull().default(90),
    retentionRecordDays: integer("retention_record_days").notNull().default(730),

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
     * ⚠️ PHI. A voice recording is an identifier on its own. Behind an
     * S3-compatible URL, never a platform blob API — apps/app stays portable.
     */
    transcriptUri: text("transcript_uri"),
    recordingUri: text("recording_uri"),

    /**
     * Proof the required disclosure played before any audio reached
     * transcription. Non-nullable in practice for voice; see src/lib/compliance.
     */
    disclosurePlayedAt: timestamp("disclosure_played_at", {
      withTimezone: true,
    }),
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
 * One row per (clinic, kind, period, recipient). The unique index is what
 * makes a re-run a conflict rather than a second email.
 */
export const reportDeliveries = pgTable(
  "report_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** "monthly" | "weekly" | "alert" | "renewal" */
    kind: text("kind").notNull(),
    /** e.g. "2026-08" for monthly, "2026-W37" for weekly, an event id for alerts. */
    periodKey: text("period_key").notNull(),
    recipient: text("recipient").notNull(),
    /** "sent" | "skipped" | "failed" */
    status: text("status").notNull(),
    messageId: text("message_id"),
    reason: text("reason"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("report_deliveries_once_idx").on(t.clinicId, t.kind, t.periodKey, t.recipient),
  ],
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
    /** From the class: 5 business days, or 5 calendar days for a breach. */
    notifyBy: timestamp("notify_by", { withTimezone: true }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifiedHow: text("notified_how"),
    /** For non-covered clinics, the FTC Health Breach Notification Rule clock when it applies. */
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
 * A booking REQUEST from the Meta front door: not a booking. The person gave
 * a first name, a callback number and a preferred day or time in a channel
 * that cannot carry a confirmation, so the request is written here (the PHI
 * side), the practice's desk is emailed a single-use link with no patient in
 * it, and a human accepts or declines. Either way the person hears back on
 * the channel they used — that the practice has their request, never a time.
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
    /** messenger | instagram | whatsapp */
    platform: text("platform").$type<"messenger" | "instagram" | "whatsapp">().notNull(),
    /** The page / account / number id the message arrived on. */
    externalId: text("external_id").notNull(),
    senderId: text("sender_id").notNull(),
    connectionId: uuid("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    /** Free text as the person put it, PHI-scanned for clinical content. */
    preferredWindow: text("preferred_window").notNull(),
    status: text("status").$type<"requested" | "accepted" | "declined" | "expired">().notNull().default("requested"),
    tokenHash: customType<{ data: Buffer }>({ dataType: () => "bytea" })("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deskNotifiedAt: timestamp("desk_notified_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByLabel: text("decided_by_label"),
    /** The practice's own note back to itself; never sent to the person. */
    deskNote: text("desk_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("booking_requests_token_idx").on(t.tokenHash),
    index("booking_requests_clinic_idx").on(t.clinicId, t.createdAt),
  ],
);

/**
 * The half-collected request: what the person has said so far on one thread,
 * so the assistant can ask for the missing piece across messages without
 * remembering any of the conversation. Overwritten per message, deleted when
 * the request is created, and swept after a day.
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

export type ChatChannelChoice = "web" | "meta";

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
    /** Only set for a "Web OR Meta" package; which one the buyer picked. */
    chatChannelChoice: text("chat_channel_choice").$type<ChatChannelChoice>(),

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
     * 1,501st conversation has a worse month than one with an overage line.
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
      "entitlements_chat_choice_check",
      sql`${t.chatChannelChoice} is null or ${t.chatChannelChoice} in ('web', 'meta')`,
    ),
    check(
      "entitlements_overage_mode_check",
      sql`${t.overageMode} in ('allow', 'hard_cap')`,
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
] as const;

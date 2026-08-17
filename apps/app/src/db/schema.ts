import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

    /** Billing plan slug: "core" | "growth" | "multi". */
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
// Stage 1 — the click (ad platform)
// -----------------------------------------------------------------------------

export const adInteractions = pgTable(
  "ad_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),

    platform: text("platform").notNull(),
    /** Platform's own click id — gclid, fbclid. */
    externalClickId: text("external_click_id"),
    campaignId: text("campaign_id"),
    adsetId: text("adset_id"),

    costUsd: numeric("cost_usd", { precision: 12, scale: 2 }),

    landingPage: text("landing_page"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ad_interactions_clinic_idx").on(t.clinicId, t.occurredAt),
    index("ad_interactions_click_idx").on(t.clinicId, t.externalClickId),
  ],
);

// -----------------------------------------------------------------------------
// Stage 2 — the conversation  ⚠️ PHI
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

    adInteractionId: uuid("ad_interaction_id").references(
      () => adInteractions.id,
    ),

    channel: channelEnum("channel").notNull(),
    /** True when this is the automatic callback of a number that rang out. */
    isRecoveredMissedCall: boolean("is_recovered_missed_call")
      .notNull()
      .default(false),

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
  },
  (t) => [
    index("conversations_clinic_idx").on(t.clinicId, t.startedAt),
    // Clinic-first: under RLS every query carries clinic_id, so a lookup by FK
    // alone would index-scan then re-filter. That's the common path, not the rare one.
    index("conversations_contact_idx").on(t.clinicId, t.contactId),
    index("conversations_ad_idx").on(t.clinicId, t.adInteractionId),
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

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /**
     * The stage incumbents cannot see. Populated by reading check-in back OUT
     * of the booking system, not by writing into it.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("appointments_clinic_idx").on(t.clinicId, t.scheduledFor),
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

    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    /** Nullable: the accepting user may be created in the same transaction. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),

    /** e.g. "2026-08-01". Matches a document in packages/legal. */
    documentVersion: text("document_version").notNull(),
    /** SHA-256 of the exact text shown, so a later edit can't be mistaken for what was signed. */
    documentHash: text("document_hash").notNull(),

    /** Frozen at acceptance — the FK above may go null. */
    acceptedByName: text("accepted_by_name").notNull(),
    acceptedByEmail: text("accepted_by_email").notNull(),
    acceptedByTitle: text("accepted_by_title"),

    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),

    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("baa_acceptances_org_idx").on(t.organizationId, t.acceptedAt),
    index("baa_acceptances_version_idx").on(t.documentVersion),
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

/** Tables carrying a clinic_id, and therefore requiring RLS. Asserted by tests. */
export const TENANT_SCOPED_TABLES = [
  "clinic_memberships",
  "provider_connections",
  "ad_interactions",
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
] as const;

import {
  boolean,
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

/**
 * ⚠️  PHI BOUNDARY — read docs/hipaa-compliance.md before touching this file.
 *
 * Several tables here hold protected health information: a caller's phone
 * number attached to a treatment inquiry is PHI, and so is anything read back
 * out of a clinic's EMR or POS. Do not point this schema at real patient data
 * until a BAA is in place with every vendor in the path.
 *
 * ---
 *
 * The model exists to answer one question incumbents structurally cannot:
 *
 *     which recovered call became booked, showed, and collected revenue?
 *
 * That is a join across four systems the clinic already runs — the ad platform,
 * the booking system, check-in, and the point-of-sale. Each stage below carries
 * its own `*ExternalId` so a row can be traced back to its source system
 * independently, which is what makes the reconciliation auditable rather than
 * inferred.
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

// -----------------------------------------------------------------------------
// Tenancy
// -----------------------------------------------------------------------------

export const clinics = pgTable("clinics", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Matches an id in apps/web's specialty catalogue where they overlap. */
  specialty: text("specialty").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),

  /** e.g. "mindbody" | "vagaro" | "boulevard" | "zenoti" | "ghl". */
  bookingProvider: text("booking_provider"),
  posProvider: text("pos_provider"),

  /** Signed BAA is a hard gate on processing this clinic's PHI. */
  baaSignedAt: timestamp("baa_signed_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

    /** "meta" | "google" | "tiktok" | ... */
    platform: text("platform").notNull(),
    /** Platform's own click id — gclid, fbclid. The anchor for feeding results back. */
    externalClickId: text("external_click_id"),
    campaignId: text("campaign_id"),
    adsetId: text("adset_id"),

    /** Attributed spend for this interaction, USD. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 2 }),

    landingPage: text("landing_page"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("ad_interactions_clinic_idx").on(table.clinicId, table.occurredAt),
    index("ad_interactions_click_idx").on(table.externalClickId),
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

    /** ⚠️ PHI. Encrypt at rest; never log. E.164. */
    phone: text("phone"),
    email: text("email"),
    fullName: text("full_name"),

    /** Id in the clinic's own EMR/CRM, so we can reconcile without owning identity. */
    externalContactId: text("external_contact_id"),

    /** True once this contact has ever transacted — drives reactivation targeting. */
    isReturning: boolean("is_returning").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contacts_clinic_phone_idx").on(table.clinicId, table.phone),
    uniqueIndex("contacts_external_idx").on(
      table.clinicId,
      table.externalContactId,
    ),
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

    /** Set when the conversation can be traced to a paid click. */
    adInteractionId: uuid("ad_interaction_id").references(
      () => adInteractions.id,
    ),

    channel: channelEnum("channel").notNull(),
    /** True when this is the automatic callback of a number that rang out. */
    isRecoveredMissedCall: boolean("is_recovered_missed_call")
      .notNull()
      .default(false),

    outcome: conversationOutcomeEnum("outcome"),
    /** Treatment the caller asked about — drives per-treatment attribution. */
    treatmentInterest: text("treatment_interest"),

    /**
     * ⚠️ PHI. Transcripts and recordings are identifiers on their own.
     * Store the recording behind an S3-compatible URL, not a platform-specific
     * blob API — apps/app must stay portable off Vercel.
     */
    transcriptUri: text("transcript_uri"),
    recordingUri: text("recording_uri"),

    /** Seconds from inbound ring to agent answer. The speed-to-lead metric. */
    responseLatencySeconds: integer("response_latency_seconds"),

    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("conversations_clinic_idx").on(table.clinicId, table.startedAt),
    index("conversations_contact_idx").on(table.contactId),
    index("conversations_ad_idx").on(table.adInteractionId),
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

    /** Id in Mindbody/Vagaro/Boulevard/etc. This is the write-side handle. */
    externalAppointmentId: text("external_appointment_id"),

    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    treatment: text("treatment"),
    providerName: text("provider_name"),

    depositUsd: numeric("deposit_usd", { precision: 12, scale: 2 }),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    /**
     * The stage incumbents cannot see. Populated by reading check-in back out
     * of the booking system, not by writing into it.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("appointments_clinic_idx").on(table.clinicId, table.scheduledFor),
    index("appointments_conversation_idx").on(table.conversationId),
    uniqueIndex("appointments_external_idx").on(
      table.clinicId,
      table.externalAppointmentId,
    ),
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
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    /**
     * Null when the POS row can't be tied to a specific visit. Keeping it
     * nullable is deliberate: an unattributed sale is a data-quality signal we
     * want visible, not a row we silently drop.
     */
    appointmentId: uuid("appointment_id").references(() => appointments.id),

    /** Id in the POS. The read-side handle that closes the loop. */
    externalTransactionId: text("external_transaction_id"),

    amountUsd: numeric("amount_usd", { precision: 12, scale: 2 }).notNull(),
    /** Line items as the POS reported them, for per-treatment revenue. */
    lineItems: jsonb("line_items"),

    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("transactions_clinic_idx").on(table.clinicId, table.collectedAt),
    index("transactions_appointment_idx").on(table.appointmentId),
    uniqueIndex("transactions_external_idx").on(
      table.clinicId,
      table.externalTransactionId,
    ),
  ],
);

// -----------------------------------------------------------------------------
// Audit — required for HIPAA
// -----------------------------------------------------------------------------

/**
 * Every read or write of PHI, appended here. Required for audit-ready intake
 * and consent documentation, and the first thing an auditor asks for.
 * Append-only by convention — never UPDATE or DELETE.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id").references(() => clinics.id),

    /** User id, service name, or "system". */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),

    ipAddress: text("ip_address"),
    /** Metadata only — never the PHI itself. */
    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_log_clinic_idx").on(table.clinicId, table.occurredAt),
    index("audit_log_resource_idx").on(table.resourceType, table.resourceId),
  ],
);

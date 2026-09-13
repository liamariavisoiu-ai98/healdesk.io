import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The marketing schema.
 *
 * Three tables, and the rule that governs all of them: NOTHING here may ever
 * describe a patient. A lead is a clinic owner who unlocked the demo or
 * claimed a bot — their work email, their clinic's public website, which
 * specialty they run. That is business contact data. The moment a column
 * could hold a patient's name, condition or appointment, it belongs in
 * apps/app behind row-level security, not here. `tests/leads.test.ts` asserts
 * the column list against a denylist so that rule outlives this comment.
 *
 * ## Why the rate-limit counters live in the same database
 *
 * The in-memory limiter this replaces was per-instance: on Vercel every cold
 * start got a fresh map, so the real ceiling was the configured limit times
 * however many instances happened to be warm. A shared store fixes that, and a
 * table in a database we already need is one fewer vendor than Redis. The
 * counter is a single atomic upsert, so two instances racing at the limit
 * cannot both pass.
 */

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** As typed, for display and for the delivery address. */
    email: text("email").notNull(),
    /** Lower-cased and trimmed; the identity of the lead. */
    emailNormalized: text("email_normalized").notNull(),
    phone: text("phone"),
    clinicName: text("clinic_name"),
    website: text("website"),
    /** SpecialtyId from @healdesk/catalog, when known. */
    specialty: text("specialty"),
    /** Segment from the prospecting pipeline, when the lead came from a campaign. */
    segment: text("segment"),
    /** The `c=` parameter on a cold-email link, verbatim, or null for organic. */
    sourceCampaign: text("source_campaign"),
    /** "business" | "consumer" — from isBusinessEmail() at first contact. */
    leadScore: text("lead_score"),
    isBusinessEmail: boolean("is_business_email"),
    /**
     * Whether the person ticked the marketing checkbox. Unlocking the demo is
     * the service they asked for and is never consent to marketing; that is a
     * separate, default-unticked box, and this column records only that box.
     */
    marketingConsent: boolean("marketing_consent").notNull().default(false),
    /** Version tag of the notice shown at the moment of consent. */
    consentNoticeVersion: text("consent_notice_version"),
    /** The exact wording shown beside the checkbox when it was ticked. */
    consentText: text("consent_text"),
    consentAt: timestamp("consent_at", { withTimezone: true }),
    /** Signed token for the personalised-bot page; null until a claim is made. */
    claimToken: text("claim_token"),
    /** Where they came from, host only — never a full URL with query params. */
    referrerHost: text("referrer_host"),
    unlockCount: integer("unlock_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("leads_email_normalized_idx").on(t.emailNormalized),
    uniqueIndex("leads_claim_token_idx")
      .on(t.claimToken)
      .where(sql`${t.claimToken} is not null`),
  ],
);

/**
 * Append-only. Funnel instrumentation writes here as well as to the analytics
 * vendor, so the numbers survive a vendor change and can be joined to the
 * lead's segment. Payloads carry ids and enum values, never free text.
 */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").$type<Record<string, string | number | boolean>>(),
  },
  (t) => [index("lead_events_lead_id_at_idx").on(t.leadId, t.at)],
);

/** Fixed-window counters. See src/lib/rate-limit.ts for the atomic upsert. */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowMs: integer("window_ms").notNull(),
});

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;

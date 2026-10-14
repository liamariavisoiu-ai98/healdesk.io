import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  type AgreementKind,
  AGREEMENT_TERMINATION_REASONS,
  type AgreementTerminationReason,
  ASSISTANT_LANGUAGES,
  ASSISTANT_TONES,
  type AssistantLanguage,
  type AssistantTone,
  type BillingInterval,
  type BookingSync,
  BOOKING_DETAILS,
  BOOKING_SYSTEMS,
  type BookingDetail,
  type BookingSystemId,
  CALENDAR_ACCOUNTS,
  type CalendarAccount,
  type CalendarClauseId,
  type CalendarTermsKind,
  type Channel,
  CHANNELS,
  type ClinicProfile,
  COVERAGE_MODES,
  type CoverageModeId,
  type OnboardingState,
  type RegulatoryRegime,
  type ServicePriceKind,
  TRANSCRIPT_RETENTION_DAYS_OPTIONS,
  type TranscriptRetentionDays,
} from "@healdesk/catalog";

import type { OpeningHours } from "../lib/clinic/opening-hours";
import type { SealedPayload } from "../lib/crypto/envelope";
import { LEDGER_DIRECT_KINDS } from "../lib/email/direct-kinds";
import { NOTICE_KINDS, PACKAGE_NOTICE_KINDS, type NoticeKind } from "../lib/email/kinds";
import { DEVICE_LABEL_MAX } from "../lib/factors/device";
import {
  SETTINGS_HISTORY_FIELDS,
  SETUP_SCREEN_OUTCOMES,
  SETUP_SCREENS,
  type SettingsHistoryField,
  type SetupScreenId,
  type SetupScreenOutcome,
} from "../lib/setup/screen-ids";

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
 * Issues `clinics.client_number`. Declared here so drizzle-kit creates it;
 * 0057 sets where it starts (after the clinics that existed then) and makes
 * the column its owner.
 */
export const clinicsClientNumberSeq = pgSequence("clinics_client_number_seq", {
  increment: 1,
  minValue: 1,
  maxValue: 2147483647,
  startWith: 1,
  cache: 1,
});

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

    /**
     * The clinic's client number: 1, 2, 3… in the order clinics were created,
     * so a customer's second location gets the next number, not a sibling of
     * the first. It labels every credential sealed for the clinic (the
     * `healdesk:clinic` key of the KMS encryption context), which is why it
     * can never change: a ciphertext sealed under one number does not open
     * under another. Issued by `clinics_client_number_seq` through the column
     * default, never named by a writer: a trigger accepts at insert only the
     * number the default just drew and refuses any change after, for every
     * role, and the runtime role holds no UPDATE on it (drizzle/0057).
     */
    clientNumber: integer("client_number")
      .notNull()
      .default(sql`nextval('clinics_client_number_seq')`),

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
     * clock: a suppression is a "stop", and has to outlast the rows it
     * stopped. They go with the person when the person is erased
     * (lib/patient-rights/erasure.ts), and with the rest of the clinic's
     * data when it is destroyed at offboarding (lib/offboarding,
     * drizzle/0058). The purge job (lib/retention/purge.ts) is the only
     * reader of the two clocks.
     *
     * The record clock is never below a day (a CHECK below), and the
     * practice may shorten it, but app_purge_booking_requests runs on the
     * clock in force: for a day after a shortening, the longer clock it
     * replaced (the two columns below). The runtime role writes the clock, so
     * without that day it could shorten the clock, purge decided requests on
     * it and put it back in one transaction.
     */
    retentionMediaDays: integer("retention_media_days").notNull().default(90),
    retentionRecordDays: integer("retention_record_days").notNull().default(90),
    /**
     * The record clock's last shortening: the clock in force just before it
     * and when it happened. Written only by the clinics_record_clock trigger
     * (booking_request_destruction migration); the runtime role has no UPDATE
     * on either column, and a new clinic carries neither.
     */
    retentionRecordDaysPrevious: integer("retention_record_days_previous"),
    retentionRecordDaysShortenedAt: timestamp("retention_record_days_shortened_at", { withTimezone: true }),

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

    // --- Offboarding: each agreement's return-or-destroy clause, as dates. ---
    // offboarding_started_at, destroy_after, export_delivered_at and
    // destroyed_at are the database's: the runtime role has no UPDATE on
    // them, a new clinic cannot carry them (the clinics_insert_guard
    // trigger), and only app_start_offboarding(), app_mark_export_delivered()
    // and app_mark_clinic_destroyed() write them, from the database's clock,
    // because app_destruction_due() reads them as the floor under the
    // deletes (booking_request_destruction and destruction_clock
    // migrations). Which day the data goes is the rule of the agreement the
    // service ended under (destructionPlan in lib/offboarding).
    // app_mark_clinic_destroyed() also waits for the rows destruction deletes
    // to be gone, so destroyed_at is never a destruction that did not run.
    /** The service ended: Stripe's end of the subscription (clamped to the week before it was processed), or when an operator ended it. */
    offboardingStartedAt: timestamp("offboarding_started_at", { withTimezone: true }),
    /** The export reached the practice: the operator's record of the handover, never its production. */
    exportDeliveredAt: timestamp("export_delivered_at", { withTimezone: true }),
    /** Thirty days after the start, the thirty days every agreement counts; destructionPlan says what is due when. */
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

    // --- The setup wizard (0056): the practice as the clinic confirms it. ---
    /**
     * The location's street address, as the clinic writes it: what AYA
     * tells a caller who asks where the practice is, and where the time zone
     * was read from. Business contact data, never a patient's.
     */
    address: text("address"),
    /**
     * The practice's website, host and path without the scheme (catalog
     * `cleanWebsite`), or null when it has none. Seeded from the purchase.
     */
    website: text("website"),
    /**
     * The website as read at checkout (plan Part B), screened again under the
     * specialty bought: the setup wizard's starting point and the drift
     * check's baseline (plan Part B, "Re-reads"). Null when there was no
     * website or the read failed. Business data, never patient information.
     */
    siteProfile: jsonb("site_profile").$type<ClinicProfile>(),

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
    uniqueIndex("clinics_client_number_idx").on(t.clientNumber),
    check("clinics_client_number_positive", sql`${t.clientNumber} > 0`),
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
    check("clinics_retention_record_days_positive", sql`${t.retentionRecordDays} >= 1`),
    check(
      "clinics_address_check",
      sql`${t.address} is null or (char_length(${t.address}) between 1 and 300 and ${t.address} !~ '[[:cntrl:]]')`,
    ),
    check(
      "clinics_website_check",
      sql`${t.website} is null or (char_length(${t.website}) between 4 and 200 and ${t.website} !~ '[[:space:][:cntrl:]]')`,
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
 * decrypt it happily. See src/lib/crypto/envelope.ts. What the seal is bound
 * to never moves: a trigger refuses any change of `id`, `clinic_id` or
 * `provider`, for every role (drizzle/0057), the provider being half of the
 * KMS lock label each credential's data key is wrapped under
 * (lib/connections/store.ts).
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
    /**
     * The envelope's version (envelope.ts): 2 for every seal since lock labels,
     * whose data key opens only under the row's label; 1 for one sealed before,
     * opened without a label. The column default is never what a seal writes.
     */
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

    // --- The Google Calendar connection (0057). ---
    /**
     * Which Google account this is: sha256 hex of "google:" + the ID token's
     * `sub`. The raw sub is never stored. The live-account index below lets
     * one Google account be live on one clinic at a time, across tenants.
     */
    accountRef: text("account_ref"),
    /**
     * When a definitive failure (access removed at Google, the calendar gone)
     * was first seen; cleared by a reconnect. Kept on a revoked row, so the
     * clinic is still told once.
     */
    brokenAt: timestamp("broken_at", { withTimezone: true }),
    /** When the clinic and ops were told about `brokenAt`: the watch claims it once. */
    brokenAlertedAt: timestamp("broken_alerted_at", { withTimezone: true }),
    /** Consecutive transient probe failures. Three in a row degrade the connection. */
    transientFailures: smallint("transient_failures").notNull().default(0),

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
    // One live connection per Google account, whichever clinic it is on: a
    // second location connecting the same account is refused (owner decision
    // Q7). A revoked row frees the account.
    uniqueIndex("provider_connections_google_account_live_idx")
      .on(t.provider, t.accountRef)
      .where(sql`${t.accountRef} is not null and ${t.status} <> 'revoked'`),
    // One clinic per Meta Page, Instagram account or WhatsApp number while
    // its connection is not revoked (drizzle/0066): with two, the webhook
    // routed every message to the older clinic, whose staff and records
    // then held another practice's patients. A revoked row frees the asset.
    // On the asset's id alone, across the three Meta providers: the router
    // (app_meta_channel) matches an id under any meta-% provider, so the
    // same id under two providers would route as ambiguously as under one.
    uniqueIndex("provider_connections_meta_asset_live_idx")
      .on(sql`(${t.metadata} ->> 'externalId')`)
      .where(sql`${t.provider} like 'meta-%' and ${t.status} <> 'revoked'`),
    check(
      "provider_connections_account_ref_check",
      sql`${t.accountRef} is null or ${t.accountRef} ~ '^[0-9a-f]{64}$'`,
    ),
    check("provider_connections_transient_failures_check", sql`${t.transientFailures} >= 0`),
    // An alert stamp with no breakage would hide the next breakage's alert.
    check(
      "provider_connections_alert_needs_break",
      sql`${t.brokenAlertedAt} is null or ${t.brokenAt} is not null`,
    ),
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
     * ⚠️ PHI when set. No longer written: by the owner's decision of 13
     * October 2026 a transcript is emailed to the clinic when its
     * conversation ends (lib/conversations/transcript-email.ts) and healdesk
     * keeps neither the transcript nor a link to one, so every new row has
     * null here. BAA 1.4.0 and the DPA describe no stored transcript (13
     * October 2026); the column, and the retention purge that clears it,
     * stay until the spec that still describes one changes. No audio is kept
     * either (21 September 2026; `recording_uri` was dropped in 0038).
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
    // The target of record_amendments' (clinic_id, conversation_id) key, which
    // is what keeps an amendment on a record of its own clinic (drizzle/0064).
    unique("conversations_clinic_id_unique").on(t.clinicId, t.id),
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

    // --- Healdesk's own bookings and the Google write (0057). ---
    /** Minutes the booking occupies, 5–480. NULL is read as 30 by the overlap guard. */
    durationMinutes: smallint("duration_minutes"),
    /**
     * Who made this booking through healdesk: the assistant, or staff
     * confirming a request on a location whose calendar terms let healdesk
     * write. Set at insert and never changed (a trigger). Non-null is what
     * makes the row occupy time for the overlap guard; a phase-two vendor
     * row, or a desk confirmation where nothing is written, leaves it NULL.
     */
    bookingOrigin: text("booking_origin").$type<BookingOrigin>(),
    /** When the current `writing` claim was taken: a claim older than two minutes is stuck. */
    calendarWriteClaimedAt: timestamp("calendar_write_claimed_at", { withTimezone: true }),
    /** Calendar write attempts so far; the desk path stops claiming at five. */
    calendarWriteAttempts: smallint("calendar_write_attempts").notNull().default(0),
    /** The fencing token of the current claim, so a reclaimed attempt and a slow one cannot both record. */
    calendarWriteLease: uuid("calendar_write_lease"),
    /**
     * The key the Google event id is derived from: "hold:" + the slot hold's
     * id when the assistant held the time, otherwise the request's id.
     * Written once (migration B).
     */
    calendarEventKey: text("calendar_event_key"),
    /**
     * The Google calendar a healdesk booking occupies and is written to: the
     * location's own (its connection's metadata.calendarId, `primary` by
     * default) or a named provider's (clinic_providers.calendar_id). The
     * overlap guard keys on the clinic and this calendar; a healdesk booking
     * with none occupies every calendar of its location. Written at insert
     * and never changed (migration B).
     */
    calendarId: text("calendar_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "appointments_duration_check",
      sql`${t.durationMinutes} is null or ${t.durationMinutes} between 5 and 480`,
    ),
    check(
      "appointments_booking_origin_check",
      sql`${t.bookingOrigin} is null or ${t.bookingOrigin} in ('assistant', 'desk')`,
    ),
    check("appointments_calendar_write_attempts_check", sql`${t.calendarWriteAttempts} >= 0`),
    check(
      "appointments_calendar_event_key_check",
      sql`${t.calendarEventKey} is null or ${t.calendarEventKey} ~ '^(hold:)?[0-9a-f-]{36}$'`,
    ),
    check(
      "appointments_calendar_id_check",
      sql`${t.calendarId} is null or (char_length(${t.calendarId}) between 1 and 255 and ${t.calendarId} !~ '[[:space:][:cntrl:]]')`,
    ),
    index("appointments_clinic_idx").on(t.clinicId, t.scheduledFor),
    index("appointments_confirmed_idx")
      .on(t.clinicId, t.externalConfirmedAt)
      .where(sql`${t.externalConfirmedAt} is not null`),
    index("appointments_conversation_idx").on(t.clinicId, t.conversationId),
    uniqueIndex("appointments_external_idx")
      .on(t.clinicId, t.externalSource, t.externalAppointmentId)
      .where(sql`${t.externalAppointmentId} is not null`),
    // The target of record_amendments' (clinic_id, appointment_id) key, which
    // is what keeps an amendment on a record of its own clinic (drizzle/0064).
    unique("appointments_clinic_id_unique").on(t.clinicId, t.id),
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
     * The clinic's default deposit, for a service that sets none of its own
     * (AgentService.depositUsd). Null means no default. Whether a deposit is
     * then asked for, and how, is lib/billing/deposits.ts depositDecision:
     * deposits switched on, a connected Stripe account, and the channel.
     */
    depositPolicy: jsonb("deposit_policy").$type<DepositPolicy>(),
    // --- Knowledge (0056): what the setup wizard and Knowledge edit. Each is
    // screened by findClinicalContent before it is written, except never-say,
    // which is clinical on purpose (lib/setup/knowledge.ts). ---
    /** The promotions box: what AYA offers when "Mention promotions" is on. Empty by default. */
    promotions: text("promotions"),
    /** Quick answers, question and answer, for temporary things like parking during building work. */
    quickAnswers: jsonb("quick_answers").$type<KnowledgeAnswer[]>().notNull().default([]),
    /** Phrases AYA must never use: the clinical defaults at provisioning, then the clinic's. */
    neverSay: jsonb("never_say").$type<string[]>().notNull().default([]),
    /** The one thing patients ask most, and the clinic's answer (wizard 1.4). */
    mostAsked: jsonb("most_asked").$type<KnowledgeAnswer>(),
    /** The practice's policies, one per entry: cancellations, late arrivals, payment. */
    policies: jsonb("policies").$type<string[]>().notNull().default([]),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByLabel: text("approved_by_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_configs_clinic_idx").on(t.clinicId)],
);

export type AgentService = {
  name: string;
  /**
   * Dollars, to the cent; null means "quote on the call is not allowed, offer
   * a consult". An exact price has both ends equal, a "from" price no top, a
   * range both, a per-unit price the price of one unit.
   */
  priceFromUsd: number | null;
  priceToUsd: number | null;
  /** Minutes, for scheduling. */
  durationMinutes: number | null;
  /**
   * How the menu states the price (catalog SERVICE_PRICE_KINDS), from 0056.
   * Absent on a service written before it, which reads as exact when both
   * ends are equal, as a "from" price when there is no top, and as a range
   * otherwise (lib/setup/prices.ts, which also keeps it, the unit and the
   * deposit through the ops console's form).
   */
  priceKind?: ServicePriceKind | null;
  /** What a per-unit price is per ("unit", "syringe"); only with `per_unit`. */
  unit?: string | null;
  /**
   * The deposit this service asks for, in dollars, 0 to 10,000 (BD27; the
   * spec sets deposits per service). 0 means none, even when the clinic has a
   * default; null or absent means the clinic default, `deposit_policy`.
   * lib/billing/deposits.ts effectiveDepositUsd reads it.
   */
  depositUsd?: number | null;
};

/** A question and the clinic's answer: a quick answer, or the most-asked question. */
export type KnowledgeAnswer = { question: string; answer: string };

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
  // The link emails sent to a clinic's address (lib/email/direct-kinds.ts):
  // the welcome email (B1) keeps its once-per-clinic state here, because its
  // single-use link may never be stored in an outbox payload.
  ...LEDGER_DIRECT_KINDS,
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
/** See appointments.bookingOrigin. */
export type BookingOrigin = "assistant" | "desk";

/** See clinics.bookingMode. */
export type BookingMode = "desk_confirms" | "direct";
export type BookingRequirementsSource = "practice" | "operator" | "defaults";
/** See providerConnections.phiBasis. */
export type PhiBasis = "vendor_baa" | "practice_account";

export type DepositPolicy = {
  required: boolean;
  amountUsd: number | null;
  /**
   * Ignored since BD27: how a deposit is collected follows from the channel
   * and the clinic's deposit switches. Kept so existing rows still parse.
   */
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
     * From the class: discovery plus 24 hours for a breach, a security
     * incident and an improper use or disclosure, at every clinic, or the
     * state-law "immediately following discovery" for a breach at a clinic
     * that is not a covered entity, if that is ever earlier; two business
     * days to a first reply for a service complaint. The 24 hours is
     * healdesk's internal target, unpublished: it meets every agreement's
     * deadline (60 calendar days at most in BAA 1.2.2 and the 1.3.0 and DPA
     * drafts since 9 October 2026; five days in 1.2.1 and before). Set when the
     * incident is opened: rows opened before 7 October 2026 keep the five-day
     * clocks they were opened with (lib/incidents/incidents.ts).
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
    // NO ACTION, not the cascade it had until the
    // booking_request_destruction migration: the app role may DELETE
    // contacts and re-point appointments and calls, so with a cascade it
    // could delete a person, put them back under the same id and put a
    // decided request back with another decision. A person cannot be deleted
    // while a request names them. Requests are deleted first, only through
    // SECURITY DEFINER functions scoped to their tenant, each bound to state
    // the app role cannot write: app_erase_contacts takes the people's own
    // requests and the people in the same call, app_destroy_booking_requests
    // needs offboarding stamped thirty days ago by the database, and
    // app_purge_booking_requests the request's own frozen dates and the
    // record clock in force. A request's id and token hash are kept after it
    // is deleted (bookingRequestKeys), so it never comes back.
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    /**
     * Where the request came from. The desk has the final say on every
     * request; whether the assistant takes a request or books directly is
     * the clinic's booking mode (clinics.booking_mode).
     */
    channel: text("channel").$type<"voice" | "meta" | "web_chat">().notNull().default("meta"),
    /** The call or web chat the request was taken on. */
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
    /**
     * The booking this request produced. NO ACTION, not the SET NULL it had
     * until the booking_request_destruction migration: a confirmed request
     * must keep its appointment (CHECK, 0039) and a decided one cannot be
     * rewritten (trigger, 0041), so SET NULL could only ever fail, and fail
     * as "cannot be re-decided". An appointment a request points at cannot be
     * deleted until the request is; the request goes first, through the
     * functions named on contactId above.
     */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
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
    // The target of record_amendments' (clinic_id, booking_request_id) key,
    // which is what keeps an amendment on a record of its own clinic (0064).
    unique("booking_requests_clinic_id_unique").on(t.clinicId, t.id),
  ],
);

/** One offered time on a `rescheduling` request. `label` is the clinic-zone rendering the person hears. */
export type ProposedSlot = { at: string; label: string; source: "calendar" | "desk" };
/** See bookingRequests.bookedVia. 0041 dropped 'callback' from the CHECK: healdesk places no calls. */
export type BookedVia = "desk" | "agent_direct";

/**
 * The id and token hash of every booking request ever written, kept after
 * the request is deleted, so a request is written once
 * (booking_request_destruction migration). The runtime role keeps INSERT on
 * booking_requests and the no-rewrite trigger is BEFORE UPDATE only, so
 * without this a request that destruction, erasure or the purge deleted could
 * be put back under the same id and the same desk link with another
 * decision. A BEFORE INSERT trigger on booking_requests, SECURITY DEFINER,
 * writes both here and refuses a request whose id or token hash is already
 * here. It is written at insert, not at delete, so a re-insert racing the
 * delete that frees the id finds it taken all the same. The runtime role
 * holds no privilege here at all. No clinic, no person: a random id and a
 * digest of a random token, which identify nobody.
 */
export const bookingRequestKeys = pgTable(
  "booking_request_keys",
  {
    id: uuid("id").primaryKey(),
    tokenHash: customType<{ data: Buffer }>({ dataType: () => "bytea" })("token_hash").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("booking_request_keys_token_idx").on(t.tokenHash)],
);

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
     * Who ended the agreement, and why: AGREEMENT_TERMINATION_REASONS in
     * @healdesk/catalog, recorded with `terminatedAt` by the console's
     * termination (BAA 1.3.0 clause 17 ¶3 refunds only two of them). Null
     * while the agreement is in effect, and on an ending recorded before
     * drizzle/0066 or by app_supersede_agreement(), which replaces an
     * agreement rather than ending the Services. Write-once, and only in the
     * write that records the termination (the transition guard, 0066).
     */
    terminationReason: text("termination_reason").$type<AgreementTerminationReason>(),

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
      "baa_acceptances_termination_reason_check",
      sql`${t.terminationReason} is null or (${t.terminatedAt} is not null and ${t.terminationReason} in (${sqlList(AGREEMENT_TERMINATION_REASONS)}))`,
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
 *   - Re-consent creates a new consent record; it does not erase the record
 *     of them having asked us to stop. The runtime role cannot delete a row
 *     (0010). Two things do: the person's own erasure, which takes their
 *     number from here with everything else (app_erase_contact_evidence,
 *     lib/patient-rights/erasure.ts), and destruction at offboarding, which
 *     takes the clinic's (lib/offboarding).
 *
 * An erasure no longer writes a row here. It kept the number "so the request
 * itself is honoured" until 8 October 2026 (BAA 1.3.0 release gate 6); v1
 * contacts no one first, so there is no outbound list for a number to stay
 * on, and the request is recorded in erasure_requests without it.
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

/** The operator's record that a subcontractor deleted what it held about the person. */
export type ErasureVendorStamp = { at: string; by: string; how: string };

/**
 * Who asked for a deletion, an amendment or a correction: a closed set, so
 * nothing typed is stored with the record or in its audit row, both of which
 * outlive the person (erasure_requests_requested_by_check,
 * record_amendments_requested_by_check). Only the practice asks; the other
 * two say whose request it passed on.
 */
export const PATIENT_REQUESTERS = [
  "practice",
  "person_via_practice",
  "representative_via_practice",
] as const;
export type PatientRequester = (typeof PATIENT_REQUESTERS)[number];

/**
 * A person's deletion request, recorded without the person (BAA 1.3.0 clause
 * 4(c): "only a record of the request, for no longer than it needs one to make
 * sure the information stays deleted"; the DPA's item c; release gate 6).
 *
 * Who asked, from a closed set (PATIENT_REQUESTERS), when the request
 * reached healdesk and the deadline it set, when the deletion ran, the counts
 * it deleted, and the operator's stamp for each subcontractor step
 * (ERASURE_VENDOR_STEPS in lib/patient-rights/erasure.ts). No telephone
 * number, no email address, no name, and nothing typed.
 *
 * `restore_refs` is the one thing that points at the person: keyed references
 * (lib/identifier-ref.ts) to the numbers, addresses and messaging threads the
 * deletion found, kept only so `reapplyErasures` can delete the person again
 * from a database restored to a point before the deletion. Nothing else reads
 * them, and nothing reads this table for a contact decision. They are emptied
 * BACKUP_RETENTION_DAYS after the deletion, when the last backup that could
 * bring the person back has expired, and the row goes then too unless a
 * subcontractor step is still outstanding, in which case it stays, holding
 * nothing about the person, until the operator stamps it. The hourly expiry
 * does both (expireErasureRecords, through app_expire_erasure_records), by
 * the database's clock: the runtime role can neither empty the references
 * nor delete a row, and a guard refuses an early emptying from any role. It
 * runs in the worker, which a restore keeps stopped, so a restore in
 * progress keeps the references it needs.
 * `erased_at` is the database's clock at the insert (a trigger), so the
 * expiry cannot be put off by the writer. Destruction deletes the clinic's
 * rows with the rest of its data.
 */
export const erasureRequests = pgTable(
  "erasure_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /**
     * Who asked, as one of PATIENT_REQUESTERS (lib/patient-rights/requesters.ts):
     * the practice, the person through the practice, or a legal
     * representative through the practice. A closed set, so nothing typed is
     * stored: a name typed here would outlive the deletion it records.
     */
    requestedBy: text("requested_by").$type<PatientRequester>().notNull(),
    /** When the request reached healdesk: the deadline runs from here. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** Ten business days after receivedAt: the deletion here and every subcontractor step are due by then. */
    dueBy: timestamp("due_by", { withTimezone: true }).notNull(),
    /** When the deletion ran, by the database's clock (erasure_requests_stamp). */
    erasedAt: timestamp("erased_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** What the deletion removed, table by table: counts only. */
    deleted: jsonb("deleted").$type<Record<string, number>>().notNull().default({}),
    /** Keyed references to what the deletion found, for a restore only; emptied at expiry. */
    restoreRefs: text("restore_refs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Each subcontractor step the operator has stamped, by step id. */
    vendorSteps: jsonb("vendor_steps")
      .$type<Record<string, ErasureVendorStamp>>()
      .notNull()
      .default({}),
  },
  (t) => [
    index("erasure_requests_clinic_idx").on(t.clinicId, t.erasedAt),
    check(
      "erasure_requests_requested_by_check",
      sql`${t.requestedBy} in ('practice', 'person_via_practice', 'representative_via_practice')`,
    ),
    check("erasure_requests_received_check", sql`${t.receivedAt} <= ${t.erasedAt}`),
    check("erasure_requests_due_check", sql`${t.dueBy} > ${t.receivedAt}`),
    // No bound on how many: a deletion records every reference it found, and
    // a cap the survey could exceed would roll the deletion back with it,
    // every time, past the ten business days (review of 12 October 2026).
    check("erasure_requests_refs_check", sql`array_position(${t.restoreRefs}, null) is null`),
    check(
      "erasure_requests_vendor_steps_check",
      sql`jsonb_typeof(${t.vendorSteps}) = 'object' and (${t.vendorSteps} - 'retell') = '{}'::jsonb`,
    ),
  ],
);

/**
 * What an amendment is appended to: a record healdesk does not rewrite on
 * Practice's word. A booking request and a conversation must stay as they
 * were made. An appointment is the booking as the calendar and the desk
 * hold it, which a sync or a reschedule may move, so a correction of its
 * service, practitioner or time is appended beside it rather than written
 * over what the calendar says.
 */
export const AMENDMENT_TARGET_KINDS = ["booking_request", "conversation", "appointment"] as const;
export type AmendmentTargetKind = (typeof AMENDMENT_TARGET_KINDS)[number];

/**
 * An amendment Practice directed to a record that must stay as it was made
 * (BAA 1.3.0 clause 14(b), 45 CFR 164.526(c)(1); the DPA's Clients' requests
 * clause; release gate 8, PT-17). A booking request's facts never change (the
 * no-rewrite trigger, 0039 and 0041), a conversation is the record of what
 * was said, and an appointment is the booking as the clinic's calendar holds
 * it, so none is edited on Practice's word: the amendment is appended beside
 * it and linked to it, and every later export of the record, and every
 * screen of healdesk's that shows it, carries it
 * (lib/patient-rights/amendments.ts).
 *
 * `amendment` is Practice's words about a patient: PHI, so tenant RLS and the
 * BAA gate. Each target is a foreign key that carries clinic_id with the
 * record's id, so an amendment can only point at a record of its own clinic.
 * Append-only (drizzle/0064): the runtime role may INSERT and SELECT, no role
 * may UPDATE, `recorded_at` is the database's clock at the insert, and the
 * foreign keys have no delete action, so an amendment leaves only with the
 * record it amends, inside the functions that delete that record (erasure,
 * the purge, destruction).
 */
export const recordAmendments = pgTable(
  "record_amendments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").$type<AmendmentTargetKind>().notNull(),
    /** Set exactly when target_kind is 'booking_request'. */
    bookingRequestId: uuid("booking_request_id"),
    /** Set exactly when target_kind is 'conversation'. */
    conversationId: uuid("conversation_id"),
    /** Set exactly when target_kind is 'appointment'. */
    appointmentId: uuid("appointment_id"),
    /** The amendment as Practice directed it. PHI. Never logged, audited or echoed back. */
    amendment: text("amendment").notNull(),
    /**
     * Who asked, as one of PATIENT_REQUESTERS: chosen, never typed, so no
     * name outlives the person in this row or its audit row.
     */
    requestedBy: text("requested_by").$type<PatientRequester>().notNull(),
    /** When Practice directed it; never after recorded_at. */
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** Who appended it: the operator's address, or (M5) the portal member. */
    recordedBy: text("recorded_by").notNull(),
    /** When it was appended, by the database's clock (record_amendments_guard). */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    index("record_amendments_request_idx")
      .on(t.clinicId, t.bookingRequestId)
      .where(sql`${t.bookingRequestId} is not null`),
    index("record_amendments_conversation_idx")
      .on(t.clinicId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    index("record_amendments_appointment_idx")
      .on(t.clinicId, t.appointmentId)
      .where(sql`${t.appointmentId} is not null`),
    // Composite, so an amendment cannot point at another clinic's record, and
    // no delete action, so a record cannot go while an amendment of it stays.
    foreignKey({
      name: "record_amendments_booking_request_fk",
      columns: [t.clinicId, t.bookingRequestId],
      foreignColumns: [bookingRequests.clinicId, bookingRequests.id],
    }),
    foreignKey({
      name: "record_amendments_conversation_fk",
      columns: [t.clinicId, t.conversationId],
      foreignColumns: [conversations.clinicId, conversations.id],
    }),
    foreignKey({
      name: "record_amendments_appointment_fk",
      columns: [t.clinicId, t.appointmentId],
      foreignColumns: [appointments.clinicId, appointments.id],
    }),
    check(
      "record_amendments_target_kind_check",
      sql`${t.targetKind} in ('booking_request', 'conversation', 'appointment')`,
    ),
    check(
      "record_amendments_target_check",
      sql`(${t.targetKind} = 'booking_request' and ${t.bookingRequestId} is not null and ${t.conversationId} is null and ${t.appointmentId} is null)
        or (${t.targetKind} = 'conversation' and ${t.conversationId} is not null and ${t.bookingRequestId} is null and ${t.appointmentId} is null)
        or (${t.targetKind} = 'appointment' and ${t.appointmentId} is not null and ${t.bookingRequestId} is null and ${t.conversationId} is null)`,
    ),
    check(
      "record_amendments_amendment_check",
      sql`char_length(btrim(${t.amendment})) between 1 and 4000`,
    ),
    // No telephone number or email address in the words: an amendment can sit
    // on someone else's record, where a person's deletion would never find
    // it (lib/patient-rights/amendments.ts, AMENDMENT_IDENTIFIER_PATTERNS,
    // which the writer applies first). A record's id and an ISO date and time
    // are taken out before the digits are counted.
    check(
      "record_amendments_identifier_check",
      sql`regexp_replace(regexp_replace(${t.amendment}, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){9,}'
        and ${t.amendment} !~ '[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}'`,
    ),
    check(
      "record_amendments_requested_by_check",
      sql`${t.requestedBy} in ('practice', 'person_via_practice', 'representative_via_practice')`,
    ),
    check(
      "record_amendments_recorded_by_check",
      sql`char_length(btrim(${t.recordedBy})) between 1 and 320`,
    ),
    check("record_amendments_requested_check", sql`${t.requestedAt} <= ${t.recordedAt}`),
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
     * confirms the booking requirement set (0040); `meta` and `whatsapp`
     * connect those channels (0049); `calendar` connects the location's
     * Google Calendar and records its calendar elections (0057). Resolution
     * and consumption both filter on it, so a token issued for one cannot be
     * spent on another — a mismatch resolves to nothing, the same anti-oracle
     * rule as an unknown token. Set at issue, never updated (the UPDATE grant
     * is used_at and consumed_ip only, and the no-rewrite trigger freezes it).
     */
    purpose: text("purpose")
      .$type<"connect" | "setup" | "meta" | "whatsapp" | "calendar">()
      .notNull()
      .default("connect"),

    // --- Calendar links (0057). Set at issue and frozen, like `purpose`. ---
    /** The lower-cased addresses the link was mailed to. Evidence of who could hold it. */
    sentTo: text("sent_to").array(),
    /**
     * `recipients`: the practice's calendar contacts. `owner`: the practice
     * owner only, for the two calendar links that need the owner — a change
     * of Google account, and confirming an election that widens what reaches
     * Google. Every other purpose is `recipients`.
     */
    audience: text("audience").$type<"recipients" | "owner">().notNull().default("recipients"),
    /** An owner's change link: any Google account may connect through it. */
    allowsAccountChange: boolean("allows_account_change").notNull().default(false),
    /** An owner's confirm link: the widening election it asks the owner to accept. */
    pendingElection: jsonb("pending_election").$type<PendingCalendarElection>(),

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
    // The target of the (clinic, link) keys on calendar_elections and
    // google_oauth_states (0057, below its banner), which keep an election or
    // a Google sign-in on a link of its own clinic.
    unique("connection_links_clinic_link_unique").on(t.clinicId, t.id),
    check("connection_links_audience_check", sql`${t.audience} in ('recipients', 'owner')`),
    // Only a calendar link has an owner audience, an account change or a
    // pending election; every other purpose keeps 0024's plain shape.
    check(
      "connection_links_calendar_only_flags",
      sql`${t.purpose} = 'calendar' or (${t.audience} = 'recipients' and not ${t.allowsAccountChange} and ${t.pendingElection} is null)`,
    ),
    check(
      "connection_links_account_change_owner",
      sql`not ${t.allowsAccountChange} or ${t.audience} = 'owner'`,
    ),
    check(
      "connection_links_pending_election_owner",
      sql`${t.pendingElection} is null or (${t.audience} = 'owner' and jsonb_typeof(${t.pendingElection}) = 'object')`,
    ),
  ],
);

/**
 * The widening election an owner confirm link carries (plan §2.6): what the
 * holder of a recipients link asked for, which the owner accepts only if the
 * document still renders to the same version and hash (the confirm page's
 * check, plan §4.1). The election guard (drizzle/0057) holds a row recorded
 * through the link to its booking system, account kind and version. It
 * cannot compare the hash: the stored text carries the name the owner types
 * when confirming, so its hash is known only then.
 */
export type PendingCalendarElection = {
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  documentVersion: string;
  documentHash: string;
};

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
    /** Whether the 90% and 100% allowance emails are sent (catalog USAGE_ALERT_PERCENT). The owner's switch. */
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
    /**
     * A plan change in flight (review fix, 7 October 2026): the request it was
     * started under, the package and the interval it moves to. Set under the
     * Stripe mutation lease before anything is charged and cleared in the
     * transaction that applies it, exactly as pending_location_* are. Without
     * it a change whose Stripe response was lost left the bought package
     * unchanged, and the clinic's retry, which carries a fresh request id,
     * charged the setup-fee difference a second time. A retry now adopts the
     * pending request and finds its own charge.
     */
    pendingPlanChangeRequestId: text("pending_plan_change_request_id"),
    pendingPlanChangePlanId: text("pending_plan_change_plan_id"),
    pendingPlanChangeInterval: text("pending_plan_change_interval").$type<BillingInterval>(),
    /**
     * When the subscription state last applied from Stripe was read (review
     * fix): customer.subscription.updated applies the live subscription it
     * retrieved before its transaction, and two deliveries can commit in the
     * opposite order to their reads. Compared and set under the row lock, so a
     * snapshot read before the one already applied is skipped instead of
     * overwriting it.
     */
    stripeSubscriptionSyncedAt: timestamp("stripe_subscription_synced_at", { withTimezone: true }),

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
    // A pending plan change is a request, a package and an interval, set together.
    check(
      "entitlements_pending_plan_change_check",
      sql`(${t.pendingPlanChangeRequestId} is null) = (${t.pendingPlanChangePlanId} is null) and (${t.pendingPlanChangeRequestId} is null) = (${t.pendingPlanChangeInterval} is null) and (${t.pendingPlanChangeInterval} is null or ${t.pendingPlanChangeInterval} in ('month', 'year')) and (${t.pendingPlanChangeRequestId} is null or ${t.pendingPlanChangeRequestId} ~ '^[A-Za-z0-9_-]{1,64}$')`,
    ),
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
    /**
     * Stripe's hosted page for the paid first invoice, where the setup-fee
     * receipt is, as the invoice.paid relay passed it to provisioning (0056).
     * The welcome email (B1) links it on every attempt: plan C4, and contracts
     * §3, under which no separate receipt goes for the welcome's invoice. Null
     * on a purchase that did not come through Stripe's relay.
     */
    firstInvoiceUrl: text("first_invoice_url"),
  },
  (t) => [
    check("checkout_intents_interval_check", sql`${t.billingInterval} in ('month', 'year')`),
    check(
      "checkout_intents_first_invoice_url_check",
      sql`${t.firstInvoiceUrl} is null or (char_length(${t.firstInvoiceUrl}) <= 500 and ${t.firstInvoiceUrl} ~ '^https://invoice\\.stripe\\.com/[!-~]+$')`,
    ),
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
     * Who last changed Auto-confirm (autoConfirmBookings, below with the
     * setup wizard's columns) and when; the two travel together (migration A,
     * drizzle/0057). The database reads Auto-confirm itself in
     * app_calendar_write_permitted: it gates only the assistant's own
     * bookings, never a staff confirmation.
     */
    autoConfirmChangedAt: timestamp("auto_confirm_changed_at", { withTimezone: true }),
    autoConfirmChangedByLabel: text("auto_confirm_changed_by_label"),
    /**
     * A clinic line that does NOT forward back to us: where every degradation
     * path sends a caller (CLAUDE.md, "Failure"). E.164.
     */
    directLineE164: text("direct_line_e164"),
    directLineSetAt: timestamp("direct_line_set_at", { withTimezone: true }),

    // --- The setup wizard and Settings (0056). Every column carries the
    // spec's default ("Every switch in the portal"), so a missing row and a
    // fresh row mean the same thing. lib/setup/settings.ts reads and writes
    // them; lib/billing/settings.ts keeps the deposit, pause and direct-line
    // columns above. ---
    /** How AYA speaks on every channel. */
    tone: text("tone").$type<AssistantTone>().notNull().default("warm"),
    /** Said after the locked AI line on a call; null means the default, built from the clinic's name. */
    phoneGreeting: text("phone_greeting"),
    /** The first line in chat and DMs after the locked AI line; null means the default. */
    chatGreeting: text("chat_greeting"),
    /** The languages AYA answers in. It answers in the caller's language and stays in it. */
    languages: text("languages")
      .array()
      .$type<AssistantLanguage[]>()
      .notNull()
      .default(sql`'{en}'::text[]`),
    /** On lets AYA suggest complementary treatments during a booking (phone and website chat only). */
    suggestAddOns: boolean("suggest_add_ons").notNull().default(false),
    /** Whether the promotions box is used in conversation (phone and website chat only). */
    mentionPromotions: boolean("mention_promotions").notNull().default(true),
    /**
     * Auto-confirm (contracts §6): on, a booking AYA takes is booked; off,
     * every booking is a request staff approve. Provisioning sets it from the
     * booking system: off where that system does not read Google Calendar.
     * The calendar backend's `setAutoConfirm` is its writer from Settings,
     * behind a step-up; the effective mode also needs a healthy calendar,
     * terms that allow writing and the owner's kill switch.
     */
    autoConfirmBookings: boolean("auto_confirm_bookings").notNull().default(true),
    /** Book into one shared calendar, or against a named provider's own. */
    bookingDetail: text("booking_detail").$type<BookingDetail>().notNull().default("generic"),
    /**
     * "Where do bookings live today?", as the funnel asked it and the wizard
     * corrects it. What the clinic told us; its calendar terms come from the
     * signed agreement and its elections, never from here.
     */
    bookingSystem: text("booking_system").$type<BookingSystemId>(),
    /** "Which Google account will bookings go into?", as the funnel asked it. */
    calendarAccount: text("calendar_account").$type<CalendarAccount>(),
    /**
     * "A number patients can call for urgent help": what AYA gives someone
     * reporting a complication or an urgent symptom, after 911. E.164.
     */
    urgentHelpE164: text("urgent_help_e164"),
    /** A veterinary practice's emergency referral number, which its urgent reply gives. E.164. */
    vetReferralE164: text("vet_referral_e164"),
    /** On lets the voice agent transfer a caller to a real number during opening hours. */
    transferLiveCalls: boolean("transfer_live_calls").notNull().default(false),
    /** Where a live transfer goes; null means the direct line. E.164. */
    transferE164: text("transfer_e164"),
    /** The daily summary email, at the start of each working day. */
    dailySummary: boolean("daily_summary").notNull().default(true),
    /**
     * Which calls reach AYA: the single source (plan Part F2). Seeded from
     * clinics.call_routing for clinics made before it; while the readers on
     * call_routing remain, the wizard writes both (lib/setup/settings.ts).
     */
    coverageMode: text("coverage_mode")
      .$type<CoverageModeId>()
      .notNull()
      .default("overflow_after_hours"),
    /** How long transcripts and conversation records are kept: 90 days, or shortened to 30 or 7. */
    transcriptRetentionDays: integer("transcript_retention_days")
      .$type<TranscriptRetentionDays>()
      .notNull()
      .default(90),

    /**
     * Settings → Channels: Instagram, Messenger and WhatsApp, each On or Off
     * on its own (spec, "Every switch in the portal"; 0061). On by default,
     * so a platform answers once it is connected. The webhook skips a
     * message on a platform switched Off (app_meta_channel), and the Meta
     * channel's own clinic_channels.enabled is kept On while any connected
     * platform's switch is On, and Off once none is, by their one writer,
     * lib/channels/meta-platforms.ts.
     * Beneath the operator's front door (clinics.meta_front_door_enabled),
     * never instead of it.
     */
    instagramEnabled: boolean("instagram_enabled").notNull().default(true),
    messengerEnabled: boolean("messenger_enabled").notNull().default(true),
    whatsappEnabled: boolean("whatsapp_enabled").notNull().default(true),

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
    check(
      "clinic_settings_auto_confirm_stamp_check",
      sql`(${t.autoConfirmChangedAt} is null) = (${t.autoConfirmChangedByLabel} is null)`,
    ),
    check("clinic_settings_tone_check", sql`${t.tone} in (${sqlList(ASSISTANT_TONES)})`),
    check(
      "clinic_settings_greetings_check",
      sql`(${t.phoneGreeting} is null or char_length(${t.phoneGreeting}) between 1 and 300) and (${t.chatGreeting} is null or char_length(${t.chatGreeting}) between 1 and 300)`,
    ),
    check(
      "clinic_settings_languages_check",
      sql`cardinality(${t.languages}) between 1 and ${sql.raw(String(ASSISTANT_LANGUAGES.length))} and ${t.languages} <@ array[${sqlList(ASSISTANT_LANGUAGES)}]::text[]`,
    ),
    check(
      "clinic_settings_booking_detail_check",
      sql`${t.bookingDetail} in (${sqlList(BOOKING_DETAILS)})`,
    ),
    check(
      "clinic_settings_booking_system_check",
      sql`${t.bookingSystem} is null or ${t.bookingSystem} in (${sqlList(BOOKING_SYSTEMS.map((b) => b.id))})`,
    ),
    check(
      "clinic_settings_calendar_account_check",
      sql`${t.calendarAccount} is null or ${t.calendarAccount} in (${sqlList(CALENDAR_ACCOUNTS)})`,
    ),
    check(
      "clinic_settings_numbers_check",
      sql`(${t.urgentHelpE164} is null or ${t.urgentHelpE164} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.vetReferralE164} is null or ${t.vetReferralE164} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.transferE164} is null or ${t.transferE164} ~ '^\\+[1-9][0-9]{6,14}$')`,
    ),
    check(
      "clinic_settings_coverage_mode_check",
      sql`${t.coverageMode} in (${sqlList(COVERAGE_MODES)})`,
    ),
    check(
      "clinic_settings_retention_check",
      sql`${t.transcriptRetentionDays} in (${sql.raw(TRANSCRIPT_RETENTION_DAYS_OPTIONS.join(", "))})`,
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
 * location answered. `source_ref` is an identifierRef (lib/identifier-ref.ts:
 * a keyed HMAC, never a raw vendor id), and
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
 * hours pass with no message from them. `party_ref` is the identifierRef of
 * the platform sender id (a keyed HMAC: a WhatsApp id is a phone number, which
 * a plain hash would not hide); `conversation_id` is regenerated when a new
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
    /**
     * The conversation whose first reply has carried the channel's opening
     * line, metaChannelGreeting() on Meta (BAA 1.3.0: the first reply in each
     * conversation says that it is an AI assistant and that the channel is
     * not secure). A reply in any other conversation is a first reply and
     * opens with it; null means none has gone out. Written only once that
     * reply has been sent, in the transaction it was sent in, so a reply
     * dropped outside Meta's window leaves it owed (lib/meta/greeting.ts,
     * drizzle/0055).
     */
    greetedConversationId: uuid("greeted_conversation_id"),
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
 * entirely (no second answer, no second count). The identifierRef of the
 * message id;
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
 * The kinds lib/billing/notices.ts enqueues: Package C's and D's, the
 * registry's kinds whose owner is a package (lib/email/kinds.ts, Annex X3).
 * F0's name and export are kept, so lib/billing's payload map and its
 * compile-time check read this list. The plan's own kinds (the setup
 * reminder, the setup closure, the calendar emails) are enqueued by
 * lib/notices/plan-notices.ts against their own payload map; the outbox's
 * CHECK below covers both, from `NOTICE_KINDS`.
 */
export const BILLING_NOTICE_KINDS = PACKAGE_NOTICE_KINDS;
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
    kind: text("kind").$type<NoticeKind>().notNull(),
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
      // Built from the registry, so a kind added there changes this CHECK and
      // drizzle-kit generates the migration, instead of the INSERT failing at
      // runtime inside the Stripe event's transaction. Every kind, the plan's
      // and the packages', since 0056.
      sql`${t.kind} in (${sqlList(NOTICE_KINDS)})`,
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
    /**
     * The price of one STARTED BLOCK of 100 units on each meter, never a
     * per-minute or per-conversation rate: overage is billed in blocks since
     * 6 October 2026, so amount_cents is ceil(units / 100) times this, per
     * meter (lib/billing/annual-overage.ts). 0 for a meter the package does
     * not sell.
     */
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
    /**
     * How many times the row has been re-armed (review fix). Re-arming resets
     * `attempts` for the backoff and the dead-letter count, so the attempt
     * number alone would repeat, and with it the idempotency keys Stripe still
     * holds a cached failure under. The keys and the lease owner carry the
     * epoch too, so a re-armed request always reaches Stripe afresh.
     */
    epoch: integer("epoch").notNull().default(0),
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
    check("billing_requests_epoch_check", sql`${t.epoch} >= 0`),
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
// The setup wizard (drizzle/0056): where a clinic is in it, and the changes
// to where calls go that it and Settings record
// -----------------------------------------------------------------------------

/**
 * The setup wizard's progress, one row per screen a clinic has left (plan
 * Part E): answered (`done`) or skipped, when, and from which device. The
 * wizard resumes on the first screen of the clinic's own list with no row,
 * so a clinic that stops at step three comes back to step three, whoever
 * signs in. Setup answers about the practice, no patient data. Tenant plane;
 * the runtime role may change a row's outcome, never move it, and it goes
 * with the clinic's data at destruction.
 */
export const clinicSetupScreens = pgTable(
  "clinic_setup_screens",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    screen: text("screen").$type<SetupScreenId>().notNull(),
    outcome: text("outcome").$type<SetupScreenOutcome>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** The device whose passkey was live, or the sign-in's own label. Never a person's name. */
    actorLabel: text("actor_label").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.screen] }),
    check("clinic_setup_screens_screen_check", sql`${t.screen} in (${sqlList(SETUP_SCREENS)})`),
    check(
      "clinic_setup_screens_outcome_check",
      sql`${t.outcome} in (${sqlList(SETUP_SCREEN_OUTCOMES)})`,
    ),
    check(
      "clinic_setup_screens_actor_check",
      sql`char_length(${t.actorLabel}) between 1 and 200`,
    ),
  ],
);

export type ClinicSetupScreenRow = typeof clinicSetupScreens.$inferSelect;

/**
 * Before and after, for every change to a setting that decides where calls
 * and urgent callers go, how long records are kept, or whether AYA books on
 * its own (plan Part D4: "record before/after values in
 * clinic_settings_history"). Append-only: the runtime role may INSERT and
 * SELECT, nothing else. The values are the clinic's own numbers, a day count
 * or a flag, never anything about a patient. Kept at destruction with the
 * audit log, as the record of who sent calls where.
 */
export const clinicSettingsHistory = pgTable(
  "clinic_settings_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    field: text("field").$type<SettingsHistoryField>().notNull(),
    beforeValue: text("before_value"),
    afterValue: text("after_value"),
    /** The device whose passkey was live, or the sign-in's own label, or a service. */
    actorLabel: text("actor_label").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("clinic_settings_history_clinic_idx").on(t.clinicId, t.changedAt),
    check(
      "clinic_settings_history_field_check",
      sql`${t.field} in (${sqlList(SETTINGS_HISTORY_FIELDS)})`,
    ),
    check(
      "clinic_settings_history_values_check",
      sql`(${t.beforeValue} is null or char_length(${t.beforeValue}) <= 64) and (${t.afterValue} is null or char_length(${t.afterValue}) <= 64)`,
    ),
    check(
      "clinic_settings_history_actor_check",
      sql`char_length(${t.actorLabel}) between 1 and 200`,
    ),
  ],
);

export type ClinicSettingsHistoryRow = typeof clinicSettingsHistory.$inferSelect;

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

// -----------------------------------------------------------------------------
// Google Calendar (drizzle/0057): calendar terms per location, the OAuth
// state, slot holds and named providers
// -----------------------------------------------------------------------------

export const CALENDAR_ELECTION_SOURCES = ["agreement", "calendar_link", "portal"] as const;
export type CalendarElectionSource = (typeof CALENDAR_ELECTION_SOURCES)[number];

/**
 * One location's calendar terms, from `electedAt` on: which of the three
 * calendar clauses governs its Google Calendar (covered, uncovered, or not
 * used), anchored to the organisation's agreement in effect (plan §2.6,
 * owner decision 3). The newest row of a location under that agreement
 * decides; nothing falls back to an older one.
 *
 * Contract evidence, not PHI, so no BAA gate. Append-only for every role:
 * app_calendar_election_guard (drizzle/0057) assigns `sequence`, checks the
 * row against the agreement, and refuses any UPDATE or DELETE. It also holds
 * the rules on who may record what: an `agreement` row only for the
 * location set up at signing; a released document and a booking sync as the
 * database's own copies of the catalogue say (a draft counts only for a demo
 * clinic); an unspent, unexpired link of this location, sent to whom the row
 * says; and an election that widens what reaches Google needs the practice
 * owner, through an owner-audience link or the owner's own sign-in. Kept
 * through offboarding and destruction, like the agreement.
 */
export const calendarElections = pgTable(
  "calendar_elections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** RESTRICT: a location's calendar terms outlive nothing that could delete them. */
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    /** The organisation's agreement in effect when the row was recorded. */
    agreementId: uuid("agreement_id")
      .notNull()
      .references(() => baaAcceptances.id, { onDelete: "restrict" }),
    /**
     * 1, 2, 3… per location, assigned by the guard trigger from the newest
     * row; whatever a writer passes is replaced (hence the placeholder
     * default). Two elections racing for one number meet the unique index,
     * and the loser retries.
     */
    sequence: integer("sequence").notNull().default(0),
    source: text("source").$type<CalendarElectionSource>().notNull(),
    termsKind: text("terms_kind").$type<CalendarTermsKind>().notNull(),
    clauseId: text("clause_id").$type<CalendarClauseId>().notNull(),
    calendarAccount: text("calendar_account").$type<CalendarAccount>().notNull(),
    /**
     * Derived from the booking system (bookingSyncFor), never chosen; for an
     * election the guard holds it to app_booking_system_live(), and for an
     * `agreement` row the signed clause fixes it through the kind.
     */
    bookingSync: text("booking_sync").$type<BookingSync>().notNull(),
    /** The booking system the election names (booking-systems.ts), "none" included. */
    bookingSystem: text("booking_system").$type<BookingSystemId>().notNull(),
    /** The agreement's version for an `agreement` row; the election document's otherwise. */
    documentVersion: text("document_version").notNull(),
    /** SHA-256 hex of that document. For an election, of `renderedText` (the guard checks). */
    documentHash: text("document_hash").notNull(),
    /**
     * Whether that document was released for use when the row was recorded:
     * for an election, what app_calendar_election_released() says of the
     * version then, not what the writer says. Never upgraded: a draft row
     * stays a draft when the catalogue releases the version, and counts only
     * for a demo clinic.
     */
    documentReleased: boolean("document_released").notNull(),
    /** The practice owner accepted it, through an owner link or the owner's own sign-in. */
    ownerConfirmed: boolean("owner_confirmed").notNull().default(false),
    /** The election as accepted, rendered by the server. NULL for an `agreement` row, whose text is the agreement's. */
    renderedText: text("rendered_text"),
    /** The name (and title) the person typed, or the signatory's for an `agreement` row. */
    electedByLabel: text("elected_by_label").notNull(),
    /** The portal user, for a `portal` row. No foreign key: the record outlives the user. */
    electedByUserId: text("elected_by_user_id"),
    /**
     * The calendar link it was recorded through, for a `calendar_link` row:
     * one of this location's own. The foreign key is (clinic_id, link_id) to
     * connection_links (clinic_id, id), written by hand in drizzle/0057,
     * because drizzle-kit emits a new table's foreign keys before the unique
     * constraint they need on an existing one.
     */
    linkId: uuid("link_id"),
    /** That link's `sent_to`, copied: who could have held it. */
    linkSentTo: text("link_sent_to").array(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    electedAt: timestamp("elected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Unique, and descending because "the newest row" is the only read.
    uniqueIndex("calendar_elections_clinic_sequence_idx").on(t.clinicId, t.sequence.desc()),
    check("calendar_elections_sequence_check", sql`${t.sequence} >= 1`),
    check(
      "calendar_elections_source_check",
      sql`${t.source} in ('agreement', 'calendar_link', 'portal')`,
    ),
    check(
      "calendar_elections_terms_kind_check",
      sql`${t.termsKind} in ('covered', 'uncovered', 'not_used')`,
    ),
    check(
      "calendar_elections_clause_check",
      sql`${t.clauseId} = 'google-calendar-' || replace(${t.termsKind}, '_', '-')`,
    ),
    check(
      "calendar_elections_account_check",
      sql`${t.calendarAccount} in ('workspace_baa', 'workspace_no_baa', 'personal')`,
    ),
    check("calendar_elections_sync_check", sql`${t.bookingSync} in ('live', 'manual')`),
    check(
      "calendar_elections_booking_system_check",
      sql`${t.bookingSystem} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check("calendar_elections_version_check", sql`btrim(${t.documentVersion}) <> ''`),
    check("calendar_elections_hash_check", sql`${t.documentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "calendar_elections_label_check",
      sql`char_length(btrim(${t.electedByLabel})) between 2 and 200`,
    ),
    // The kind follows from the sync and the account, exactly as
    // calendarTermsKind() derives it: manual is not used; live is covered
    // only with Google's BAA.
    check(
      "calendar_elections_kind_consistent",
      sql`(${t.bookingSync} = 'manual' and ${t.termsKind} = 'not_used')
        or (${t.bookingSync} = 'live' and ${t.calendarAccount} = 'workspace_baa' and ${t.termsKind} = 'covered')
        or (${t.bookingSync} = 'live' and ${t.calendarAccount} <> 'workspace_baa' and ${t.termsKind} = 'uncovered')`,
    ),
    check(
      "calendar_elections_link_shape",
      sql`(${t.source} = 'calendar_link') = (${t.linkId} is not null)`,
    ),
    check(
      "calendar_elections_portal_shape",
      sql`(${t.source} = 'portal') = (${t.electedByUserId} is not null)`,
    ),
    check(
      "calendar_elections_rendered_shape",
      sql`(${t.source} = 'agreement') = (${t.renderedText} is null)`,
    ),
    // The signed agreement decides only a location's first calendar terms,
    // and only for a released, signed document nobody had to confirm.
    check(
      "calendar_elections_agreement_shape",
      sql`${t.source} <> 'agreement' or (${t.sequence} = 1 and ${t.documentReleased} and not ${t.ownerConfirmed})`,
    ),
    check(
      "calendar_elections_sent_to_shape",
      sql`${t.linkSentTo} is null or ${t.linkId} is not null`,
    ),
  ],
);

export type CalendarElectionRow = typeof calendarElections.$inferSelect;

export const GOOGLE_OAUTH_INITIATED_VIA = ["calendar_link", "portal"] as const;
export type GoogleOauthInitiatedVia = (typeof GOOGLE_OAUTH_INITIATED_VIA)[number];
/** Where the callback lands: the link page, the portal's Settings, or the setup wizard. Never a URL. */
export const GOOGLE_OAUTH_RETURN_TO = ["calendar_link", "portal", "wizard"] as const;
export type GoogleOauthReturnTo = (typeof GOOGLE_OAUTH_RETURN_TO)[number];

/**
 * Single-use Google OAuth state (plan §4.3-4.4): one row per sign-in started,
 * stored as SHA-256 of the state, bound to the browser that started it by
 * SHA-256 of a cookie, and recording which version of the Google data-use
 * notice the person accepted, with its hash and when. Consumed once, by a
 * conditional UPDATE of `used_at`; app_google_oauth_state_no_rewrite freezes
 * everything else and a consumed row entirely.
 *
 * Identity plane, like stripe_connect_states: the callback reads the row
 * before any tenant is known, so the clinic is `target_clinic_id` and there
 * is no RLS. Not PHI. Purged after a day.
 */
export const googleOauthStates = pgTable(
  "google_oauth_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    targetClinicId: uuid("target_clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    initiatedVia: text("initiated_via").$type<GoogleOauthInitiatedVia>().notNull(),
    /**
     * The calendar link the sign-in started from, for `calendar_link`: one of
     * the target clinic's own. The foreign key is (target_clinic_id, link_id)
     * to connection_links (clinic_id, id), written by hand in drizzle/0057 for
     * the reason calendar_elections.link_id's is. Foreign keys are checked
     * past row-level security, which this identity-plane table needs.
     */
    linkId: uuid("link_id"),
    /** The portal user who started it, for `portal`: the callback's actor. */
    userId: text("user_id"),
    returnTo: text("return_to").$type<GoogleOauthReturnTo>().notNull(),
    /** SHA-256 of the cookie set on the browser that started the sign-in. */
    browserBindingHash: bytea("browser_binding_hash").notNull(),
    /** The Google data-use notice accepted before the redirect, and its hash. */
    disclosureVersion: text("disclosure_version").notNull(),
    disclosureSha256: bytea("disclosure_sha256").notNull(),
    disclosureAcceptedAt: timestamp("disclosure_accepted_at", { withTimezone: true }).notNull(),
    /** Leave it to the default: a time in the future is refused (the state's life runs from it). */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * At most 15 minutes after `created_at`. Write both from one clock (the
     * database's, `now() + interval`), or skew between two clocks can trip
     * the CHECK.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    consumedIp: inet("consumed_ip"),
  },
  (t) => [
    index("google_oauth_states_created_idx").on(t.createdAt),
    check("google_oauth_states_hash_length", sql`octet_length(${t.stateHash}) = 32`),
    check("google_oauth_states_binding_length", sql`octet_length(${t.browserBindingHash}) = 32`),
    check("google_oauth_states_disclosure_length", sql`octet_length(${t.disclosureSha256}) = 32`),
    check(
      "google_oauth_states_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '15 minutes'`,
    ),
    check(
      "google_oauth_states_initiated_check",
      sql`${t.initiatedVia} in ('calendar_link', 'portal')`,
    ),
    check(
      "google_oauth_states_return_check",
      sql`${t.returnTo} in ('calendar_link', 'portal', 'wizard')`,
    ),
    // A link's sign-in returns to the link page; the portal's to the portal.
    check(
      "google_oauth_states_link_shape",
      sql`(${t.initiatedVia} = 'calendar_link') = (${t.linkId} is not null)
        and (${t.initiatedVia} = 'calendar_link') = (${t.returnTo} = 'calendar_link')`,
    ),
    check(
      "google_oauth_states_portal_shape",
      sql`(${t.initiatedVia} = 'portal') = (${t.userId} is not null)`,
    ),
    check(
      "google_oauth_states_consumed_ip_check",
      sql`${t.consumedIp} is null or ${t.usedAt} is not null`,
    ),
  ],
);

export const SLOT_HOLD_CHANNELS = ["voice", "web_chat", "meta"] as const;
export type SlotHoldChannel = (typeof SLOT_HOLD_CHANNELS)[number];
/**
 * held → writing | reserved | released | expired; reserved → converted |
 * released | expired; writing → converted | released | unknown; unknown →
 * converted | released. converted, released and expired are final
 * (app_slot_hold_transition, drizzle/0057).
 */
export const SLOT_HOLD_STATUSES = [
  "held",
  "reserved",
  "writing",
  "unknown",
  "converted",
  "released",
  "expired",
] as const;
export type SlotHoldStatus = (typeof SLOT_HOLD_STATUSES)[number];

/**
 * Time the assistant is holding on one clinic's calendar (plan §7): a
 * 60-second hold while a caller gives their details, a booking being written
 * to Google, a write whose outcome is not yet known, or a deposit
 * reservation. Each blocks only while its own clock runs — `expires_at` for a
 * held row, `blocks_until` for the rest, both read with clock_timestamp() —
 * so nothing blocks indefinitely, even with the calendar watch off.
 *
 * Overlap is the database's to refuse: the guard trigger takes the clinic's
 * calendar lock and refuses (23P01) a hold that overlaps another holder's
 * live hold or a live healdesk appointment, and appointments carry the same
 * guard. The transition trigger keeps the states, the frozen time and the
 * write-once fields, and refuses a move into `writing` unless the terms, the
 * connection and Auto-confirm allow the assistant to write.
 *
 * PHI-adjacent (a time tied to a call, a contact and a request): tenant RLS
 * and the BAA gate. No ISO times in audit rows. The foreign keys may be set
 * to NULL in any state, so erasing a person never fails on a hold. A hold
 * that still blocks cannot be deleted, by any role: only spent holds are
 * purged, so a delete never frees time the hold's own clock still claims. An
 * erasure lets the person's holds go first and then deletes them
 * (clearHoldsForErasure, lib/booking/holds.ts).
 */
export const slotHolds = pgTable(
  "slot_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<SlotHoldChannel>().notNull(),
    /**
     * holderRefOf (lib/booking/holds.ts): a keyed HMAC of the holder key (e.g.
     * "retell:" + the call id), 64 hex. Rows placed before 12 October 2026
     * carry its plain sha256. Never the raw key.
     */
    holderRef: text("holder_ref").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    durationMinutes: smallint("duration_minutes").notNull(),
    /** starts_at + duration_minutes, stored for the overlap query (a CHECK keeps them equal). */
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").$type<SlotHoldStatus>().notNull().default("held"),
    /**
     * The Google calendar the time is held on: the location's own (its
     * connection's metadata.calendarId, `primary` for the account's main
     * calendar) or a named provider's. The overlap guard keys on the clinic
     * and this calendar (addendum, named providers). No default: a hold that
     * left it out would quietly key the guard on `primary`. Never changes
     * (migration B).
     */
    calendarId: text("calendar_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The `held` window only: 60 seconds by the database clock, two minutes at most. */
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp() + interval '60 seconds'`),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    bookingRequestId: uuid("booking_request_id").references(() => bookingRequests.id, {
      onDelete: "set null",
    }),
    /** Set once, on a converted hold, to the appointment it became. */
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    /** The writer's fencing token; written once. */
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    /** When the one Google insert was attempted; written once. */
    insertAttemptedAt: timestamp("insert_attempted_at", { withTimezone: true }),
    /** How long a writing, unknown or reserved hold blocks; written once. */
    blocksUntil: timestamp("blocks_until", { withTimezone: true }),
    /** When an `unknown` write is next read back. */
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    checkAttempts: smallint("check_attempts").notNull().default(0),
    /** A short code: superseded, slot_taken, calendar_broken, record_conflict… Never free text. */
    outcomeReason: text("outcome_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live hold, and one write in flight, per holder.
    uniqueIndex("slot_holds_holder_held_idx")
      .on(t.clinicId, t.holderRef)
      .where(sql`${t.status} = 'held'`),
    uniqueIndex("slot_holds_holder_writing_idx")
      .on(t.clinicId, t.holderRef)
      .where(sql`${t.status} in ('writing', 'unknown')`),
    index("slot_holds_live_idx")
      .on(t.clinicId, t.startsAt)
      .where(sql`${t.status} in ('held', 'reserved', 'writing', 'unknown')`),
    index("slot_holds_unknown_due_idx")
      .on(t.nextCheckAt)
      .where(sql`${t.status} = 'unknown'`),
    index("slot_holds_lease_idx")
      .on(t.leaseUntil)
      .where(sql`${t.status} = 'writing'`),
    index("slot_holds_reserved_idx")
      .on(t.blocksUntil)
      .where(sql`${t.status} = 'reserved'`),
    index("slot_holds_request_idx")
      .on(t.bookingRequestId)
      .where(sql`${t.bookingRequestId} is not null`),
    check("slot_holds_channel_check", sql`${t.channel} in ('voice', 'web_chat', 'meta')`),
    check("slot_holds_holder_ref_check", sql`${t.holderRef} ~ '^[0-9a-f]{64}$'`),
    check("slot_holds_duration_check", sql`${t.durationMinutes} between 5 and 480`),
    check(
      "slot_holds_ends_check",
      sql`${t.endsAt} = ${t.startsAt} + make_interval(mins => ${t.durationMinutes})`,
    ),
    check(
      "slot_holds_status_check",
      sql`${t.status} in ('held', 'reserved', 'writing', 'unknown', 'converted', 'released', 'expired')`,
    ),
    check(
      "slot_holds_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '2 minutes'`,
    ),
    // Nothing blocks for more than a day: the longest deposit reservation
    // (1,440 minutes) plus slack for the claim.
    check(
      "slot_holds_blocks_until_check",
      sql`${t.blocksUntil} is null or ${t.blocksUntil} <= ${t.createdAt} + interval '1450 minutes'`,
    ),
    check("slot_holds_check_attempts_check", sql`${t.checkAttempts} >= 0`),
    check(
      "slot_holds_calendar_id_check",
      sql`char_length(${t.calendarId}) between 1 and 255 and ${t.calendarId} !~ '[[:space:][:cntrl:]]'`,
    ),
    check(
      "slot_holds_outcome_reason_check",
      sql`${t.outcomeReason} is null or ${t.outcomeReason} ~ '^[a-z0-9_]{1,40}$'`,
    ),
    // State shapes. The nullable foreign keys are left out on purpose, so
    // erasure can null them in any state.
    check(
      "slot_holds_held_shape",
      sql`${t.status} <> 'held' or (${t.insertAttemptedAt} is null and ${t.blocksUntil} is null
        and ${t.leaseToken} is null and ${t.leaseUntil} is null and ${t.nextCheckAt} is null)`,
    ),
    check(
      "slot_holds_reserved_shape",
      sql`${t.status} <> 'reserved' or (${t.blocksUntil} is not null and ${t.insertAttemptedAt} is null)`,
    ),
    check(
      "slot_holds_writing_shape",
      sql`${t.status} <> 'writing' or (${t.leaseToken} is not null and ${t.leaseUntil} is not null
        and ${t.insertAttemptedAt} is not null and ${t.blocksUntil} is not null)`,
    ),
    check(
      "slot_holds_unknown_shape",
      sql`${t.status} <> 'unknown' or (${t.insertAttemptedAt} is not null and ${t.blocksUntil} is not null
        and ${t.nextCheckAt} is not null)`,
    ),
  ],
);

export type SlotHoldRow = typeof slotHolds.$inferSelect;

/**
 * A named provider at one location, for the spec's provider-specific
 * booking ("Booking detail: Named provider"): their display name and the
 * Google calendar their availability lives in, one calendar per provider,
 * on the Google account the location connected. Which calendar ids are
 * acceptable (owned by that account, and for covered terms inside its own
 * domain) is checked by the library that saves them (C8); the database keeps
 * one active provider per calendar. Deactivated rather than deleted, so a
 * hold or a booking that names a provider keeps its row.
 *
 * Tenant RLS and the BAA gate (a provider beside a booking says whose
 * patient someone is). Whether a location books by provider at all is the
 * funnel's `clinic_settings.booking_detail`.
 */
export const clinicProviders = pgTable(
  "clinic_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** As the clinic names them, and as the assistant may say it. */
    displayName: text("display_name").notNull(),
    /** A Google calendar id on the location's connected account ("primary" included). */
    calendarId: text("calendar_id").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of clinic_provider_services' (clinic_id, provider_id) key,
    // which is what keeps a mapping inside its own clinic. A table constraint
    // rather than an index, so it exists when that foreign key is added.
    unique("clinic_providers_clinic_id_unique").on(t.clinicId, t.id),
    uniqueIndex("clinic_providers_active_calendar_idx")
      .on(t.clinicId, t.calendarId)
      .where(sql`${t.active}`),
    check(
      "clinic_providers_display_name_check",
      sql`char_length(btrim(${t.displayName})) between 1 and 80 and ${t.displayName} !~ '[[:cntrl:]]'`,
    ),
    check(
      "clinic_providers_calendar_id_check",
      sql`char_length(${t.calendarId}) between 1 and 255 and ${t.calendarId} !~ '[[:space:][:cntrl:]]'`,
    ),
  ],
);

/**
 * Which services a named provider offers: the spec's service-to-provider
 * mapping. `service_key` is the service as the clinic's own list names it
 * (agent_configs.services[].name), trimmed and lower-cased — the
 * case-insensitive match the booking path uses to find a service's
 * duration. A mapping is a fact: replaced by deleting and inserting, never
 * edited. Tenant RLS and the BAA gate, like the provider.
 */
export const clinicProviderServices = pgTable(
  "clinic_provider_services",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id").notNull(),
    serviceKey: text("service_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.serviceKey] }),
    // Composite, so a mapping cannot point at another clinic's provider.
    foreignKey({
      name: "clinic_provider_services_provider_fk",
      columns: [t.clinicId, t.providerId],
      foreignColumns: [clinicProviders.clinicId, clinicProviders.id],
    }).onDelete("cascade"),
    // "Who offers this service here?" is the booking path's read.
    index("clinic_provider_services_service_idx").on(t.clinicId, t.serviceKey),
    check(
      "clinic_provider_services_key_check",
      sql`${t.serviceKey} = lower(btrim(${t.serviceKey})) and char_length(${t.serviceKey}) between 1 and 120`,
    ),
  ],
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
  "calendar_elections",
  "slot_holds",
  "clinic_providers",
  "clinic_provider_services",
  "clinic_setup_screens",
  "clinic_settings_history",
  "erasure_requests",
  "record_amendments",
] as const;

// -----------------------------------------------------------------------------
// The transcript outbox (the owner's decisions of 13 October 2026)
// -----------------------------------------------------------------------------

/**
 * Where an emailed transcript stands. The first four hold the sealed copy;
 * the last three are a receipt without it (drizzle/0072): `delivered` (the
 * clinic's mail server took it), `expired` (not delivered 30 days after it
 * was queued) and `unconfirmed` (SES accepted it and nothing answered for
 * 72 hours).
 */
export const TRANSCRIPT_EMAIL_STATUSES = [
  "open",
  "pending",
  "sent",
  "bounced",
  "delivered",
  "expired",
  "unconfirmed",
] as const;
export type TranscriptEmailStatus = (typeof TRANSCRIPT_EMAIL_STATUSES)[number];

/** The statuses that are a receipt: the copy is gone, and the row never changes again (drizzle/0072). */
export const TRANSCRIPT_EMAIL_FINAL_STATUSES = ["delivered", "expired", "unconfirmed"] as const satisfies readonly TranscriptEmailStatus[];

/**
 * A conversation's transcript on its way to the clinic, and the only copy
 * healdesk holds of it. A transcript is emailed when its conversation ends
 * (lib/conversations/transcript-outbox.ts); this row is what lets a failed
 * send be retried, and a bounced one sent again, instead of lost.
 *
 * ⚠️ PHI, and sealed: `sealed` is the transcript's turns, envelope-encrypted
 * under the KMS key with the clinic's lock label (login `transcript`) and
 * this row's id in the AAD, so a copied row opens nowhere else. Tenant RLS,
 * forced, and the BAA gate (drizzle/0069). The copy is set to NULL the
 * moment SES reports the clinic's mail server took the email (`delivered`),
 * and otherwise at the latest 30 days after the row was queued (`expired`,
 * `destroy_after`), or 72 hours after a send SES accepted and nothing
 * answered for (`unconfirmed`), the owner's decision of 14 October 2026
 * (drizzle/0072, whose trigger holds both clocks to the database's). What
 * stays is a receipt without the words: whether, and when, the transcript
 * reached the clinic. The row goes with its conversation (erasure, the
 * record clock, destruction), through the foreign key's cascade.
 *
 * `open` is a web chat still going (lib/chat/web-chat.ts): the only state of
 * its conversation healdesk holds, sealed the same way and rewritten at each
 * message, and due to be sent once the visitor has been quiet until
 * `next_attempt_at`, or at once when they end it. Only an open row's copy may
 * change, and only while it stays open (drizzle/0071); any other copy changes
 * only to NULL, as its row becomes a receipt, and never back (drizzle/0072).
 * A call is queued `pending` when it ends.
 *
 * Never stored here: the clinic's address (read at each send, from the
 * sign-in), and anything SES says beyond a status and its own reason.
 */
export const transcriptEmails = pgTable(
  "transcript_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull(),
    /**
     * The sealed transcript (lib/crypto/envelope.ts), or NULL once the row is
     * a receipt: exactly when the status is delivered, expired or unconfirmed.
     */
    sealed: jsonb("sealed").$type<SealedPayload>(),
    status: text("status").$type<TranscriptEmailStatus>().notNull().default("pending"),
    /** Sends tried, accepted or not. */
    attempts: integer("attempts").notNull().default(0),
    /** When the next send may start; moved forward as a lease while one is in flight. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** SES's reason for the last failure or bounce: a status line, never the email. */
    lastError: text("last_error"),
    /** SES's message id for the last accepted send, which its delivery events name. */
    sesMessageId: text("ses_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /**
     * The 30-day cap: created_at plus 30 days, set by the trigger and never
     * moved. A copy not delivered by then is deleted and the row expired.
     */
    destroyAfter: timestamp("destroy_after", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    uniqueIndex("transcript_emails_conversation_idx").on(t.conversationId),
    index("transcript_emails_due_idx").on(t.clinicId, t.nextAttemptAt).where(sql`${t.status} in ('open', 'pending', 'bounced')`),
    index("transcript_emails_destroy_idx").on(t.clinicId, t.destroyAfter).where(sql`${t.sealed} is not null`),
    index("transcript_emails_unconfirmed_idx").on(t.clinicId, t.sentAt).where(sql`${t.status} = 'sent'`),
    uniqueIndex("transcript_emails_ses_message_idx").on(t.sesMessageId).where(sql`${t.sesMessageId} is not null`),
    // Composite, so a transcript can only belong to a conversation of its own
    // clinic; it goes when the conversation goes.
    foreignKey({
      name: "transcript_emails_conversation_fk",
      columns: [t.clinicId, t.conversationId],
      foreignColumns: [conversations.clinicId, conversations.id],
    }).onDelete("cascade"),
    check(
      "transcript_emails_status_check",
      sql`${t.status} in ('open', 'pending', 'sent', 'bounced', 'delivered', 'expired', 'unconfirmed')`,
    ),
    // A receipt holds no copy, and only a receipt (drizzle/0072).
    check(
      "transcript_emails_sealed_check",
      sql`(${t.status} in ('delivered', 'expired', 'unconfirmed')) = (${t.sealed} is null)`,
    ),
    check("transcript_emails_attempts_check", sql`${t.attempts} >= 0`),
    check("transcript_emails_last_error_check", sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`),
    check("transcript_emails_destroy_check", sql`${t.destroyAfter} > ${t.createdAt}`),
    check(
      "transcript_emails_sent_check",
      sql`(${t.status} in ('open', 'pending', 'expired')) or (${t.sentAt} is not null and ${t.sesMessageId} is not null)`,
    ),
  ],
);

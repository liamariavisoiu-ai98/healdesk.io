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
  CHECKOUT_PROFILE_STATUSES,
  type CheckoutProfileStatus,
  type ClinicProfile,
  COVERAGE_MODES,
  type CoverageModeId,
  type OnboardingState,
  type RegulatoryRegime,
  SERVICE_PRICE_KINDS,
  type ServicePriceKind,
  TRANSCRIPT_RETENTION_DAYS_OPTIONS,
  type TranscriptRetentionDays,
} from "@healdesk/catalog";

import type { OpeningHours } from "../lib/clinic/opening-hours";
import {
  DOCUMENT_REF_MAX,
  PLATFORM_ACTIONS,
  PLATFORM_SUBJECTS,
  type PlatformAction,
  type PlatformSubject,
} from "../lib/compliance/subjects";
import type { SealedPayload } from "../lib/crypto/envelope";
import { LEDGER_DIRECT_KINDS } from "../lib/email/direct-kinds";
import { NOTICE_KINDS, PACKAGE_NOTICE_KINDS, type NoticeKind } from "../lib/email/kinds";
import {
  AUDIT_REVIEW_KINDS,
  AUDIT_REVIEW_STATUSES,
  PRACTICE_RESULT_STATUSES,
  PRACTICE_RUN_REASONS,
  PRACTICE_RUN_STATUSES,
  PRACTICE_SECTIONS,
  type AuditReviewKind,
  type AuditReviewStatus,
  type PracticeCaseResult,
  type PracticeResultStatus,
  type PracticeRunReason,
  type PracticeRunStatus,
  type PracticeSection,
} from "../lib/engine/practice/types";
import { DEVICE_LABEL_MAX } from "../lib/factors/device";
import {
  MISS_CASE_STATUSES,
  MISSED_OUTCOMES,
  OUTAGE_STATUSES,
  type MissedOutcome,
  ROUTED_CHANNELS,
  ROUTED_OUTCOMES,
  ROUTED_REASONS,
  type MissCaseStatus,
  type OutageStatus,
  type RoutedOutcome,
  type RoutedReason,
} from "../lib/channels/routed-words";
import {
  CHANNEL_NAMES,
  CONVERSATION_OUTCOMES,
  type ConversationChannel,
  type ConversationOutcome,
} from "../lib/portal/conversation-words";
import {
  DEVICE_RECOVERY_REVOKE_REASONS,
  DEVICE_RECOVERY_TTL_HOURS,
  type DeviceRecoveryRevokeReason,
} from "../lib/factors/recovery-terms";
import {
  SETTINGS_HISTORY_FIELDS,
  SETUP_SCREEN_OUTCOMES,
  SETUP_SCREENS,
  type SettingsHistoryField,
  type SetupScreenId,
  type SetupScreenOutcome,
} from "../lib/setup/screen-ids";
import {
  SITE_REREAD_FAILURES,
  SITE_REREAD_REASONS,
  SITE_REREAD_STATUSES,
  WEBSITE_CHANGE_KINDS,
  WEBSITE_CHANGE_SECTIONS,
  WEBSITE_CHANGE_STATES,
  type SiteRereadFailure,
  type SiteRereadReason,
  type SiteRereadStatus,
  type WebsiteChangeKind,
  type WebsiteChangeSection,
  type WebsiteChangeState,
} from "../lib/website/types";
import { CHECKLIST_STEPS, type ChecklistStep } from "../lib/incidents/assistant/vocab";
import {
  SUPPORT_CASE_CATEGORIES,
  SUPPORT_CASE_SOURCES,
  SUPPORT_CASE_STATES,
  SUPPORT_CASE_URGENCIES,
  SUPPORT_CLOSED_REASONS,
  SUPPORT_MESSAGE_DIRECTIONS,
  SUPPORT_MESSAGE_KINDS,
  type SupportCaseSource,
  type SupportCaseState,
  type SupportCaseUrgency,
  type SupportClosedReason,
  type SupportMessageDirection,
  type SupportMessageKind,
} from "../lib/support/case-vocab";
import {
  SUPPORT_SEND_MAX_ATTEMPTS,
  SUPPORT_SEND_STOPPED_REASONS,
  type SupportSendStoppedReason,
} from "../lib/support/send-vocab";

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
     *             window closes; 90 days by default. (healdesk keeps no audio.)
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
    /** The assistant's own number (on Retell) that the clinic forwards to, E.164. */
    assistantNumberE164: text("assistant_number_e164"),
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
    /**
     * Where E6, "Your data has been destroyed", goes: the clinic's one
     * address, read in the destruction's own transaction before anything is
     * deleted and written beside the destroyed stamp
     * (lib/offboarding/after-cancellation.ts), so the email never depends on
     * a sign-in that may not outlive the destruction. Only a destroyed clinic
     * holds one (a CHECK). Business contact data, never a patient's. It is
     * the clinic row's, which destruction keeps, and it goes itself once E6
     * is sent, or once DESTRUCTION_NOTICE_DAYS have passed without a send.
     */
    destructionNoticeAddress: text("destruction_notice_address"),
    /**
     * The account was closed (lib/offboarding/account-closure.ts): once the
     * data is destroyed and calls no longer pass through, its sign-in was
     * ended and its address taken off it, and its setup and business data
     * went, keeping only the signed agreement, the billing records and the
     * records the agreements and the law need (the keep-list there). The
     * database's to stamp, like destroyed_at: app_close_clinic_account()
     * writes it, the runtime role has no UPDATE on it, a new clinic cannot
     * carry it, and the tables the closure emptied refuse new rows after it
     * (drizzle/0096).
     */
    accountClosedAt: timestamp("account_closed_at", { withTimezone: true }),
    /**
     * The agreement's notice address once the account is closed: the BAA's
     * Notices clause sends notices to "the email address on Practice's
     * healdesk account", and the closure takes that address off the sign-in,
     * while the agreement's duties outlive it (a breach report while backups
     * or a subcontractor's retained copies still hold the practice's data;
     * clauses 12, 17 and 20). Business contact data, never a patient's,
     * written by app_close_clinic_account() beside the closure, read by
     * billingRecipients() for a closed account, and cleared at
     * `noticeAddressUntil`: six years after the service ended, since the
     * clauses give the retained copies no end ("for as long as the law
     * requires") and the signed agreement itself is kept six years.
     */
    noticeAddress: text("notice_address"),
    noticeAddressUntil: timestamp("notice_address_until", { withTimezone: true }),

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
    // Held only by a clinic already destroyed, and only an address.
    check(
      "clinics_destruction_notice_address_check",
      sql`${t.destructionNoticeAddress} is null or (${t.destroyedAt} is not null and char_length(${t.destructionNoticeAddress}) between 3 and 254 and ${t.destructionNoticeAddress} ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$')`,
    ),
    // Held only by a closed account, only an address, and only with its end.
    check(
      "clinics_notice_address_check",
      sql`${t.noticeAddress} is null or (${t.accountClosedAt} is not null and ${t.noticeAddressUntil} is not null and char_length(${t.noticeAddress}) between 3 and 254 and ${t.noticeAddress} ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$')`,
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
// Locations (drizzle/0109): one AYA for every location of the account
// -----------------------------------------------------------------------------

/**
 * What a writer leaves in a row's `location_id` when it names none: the
 * column's default, which a BEFORE INSERT trigger replaces with the main
 * location of the row's clinic (app_location_default, drizzle/0109), as
 * calendar_elections.sequence is replaced. A row can never keep it: the
 * foreign key to clinic_locations refuses an id no location has.
 */
export const LOCATION_UNSET = "00000000-0000-0000-0000-000000000000";

/** A location of the account: added pending, active once paid for, retired (later) when removed. */
export const LOCATION_STATUSES = ["pending", "active", "retired"] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/** The main location's place: the location set up at checkout, under the signed agreement. */
export const MAIN_LOCATION_POSITION = 1;

/**
 * The client's acceptance, for one added location, of one central AYA for
 * every location (the extra-locations plan, section 3): the server-rendered
 * acknowledgement as it was shown, its version and SHA-256, who accepted it
 * (the portal user, the name they typed, and the passkey step-up they passed,
 * named as the access log names one: the step-up's and the passkey's ids and
 * the device's label) and when, by the database's clock.
 *
 * Contract evidence, not PHI, so no BAA gate. Append-only for every role
 * (app_location_acknowledgement_guard), and kept for good with the
 * agreement: neither destruction nor the account's closure deletes one, and
 * the location row it was accepted for, which the closure does delete,
 * points here rather than the other way round. Written before the charge, in
 * the same transaction as the pending location row
 * (lib/location-acknowledgements.ts), so a location never exists without it.
 */
export const locationAcknowledgements = pgTable(
  "location_acknowledgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** RESTRICT: an acceptance outlives nothing that could delete it. */
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    /**
     * The location it was accepted for: the id the pending location row is
     * then written with. No foreign key, because the record outlives the
     * location row; the location's own (clinic_id, id, acknowledgement_id)
     * foreign key is what binds the two.
     */
    locationId: uuid("location_id").notNull(),
    /** The document's version, `<document>/<semver>`. */
    documentVersion: text("document_version").notNull(),
    /** SHA-256 hex of `renderedText` (the guard checks). */
    documentHash: text("document_hash").notNull(),
    /** The acknowledgement as shown, rendered by the server: the evidence. */
    renderedText: text("rendered_text").notNull(),
    /** The name (and title) the person typed as someone with authority to bind the practice. */
    acceptedByLabel: text("accepted_by_label").notNull(),
    /** The portal user. No foreign key: the record outlives the user. */
    acceptedByUserId: text("accepted_by_user_id").notNull(),
    /** The passkey step-up it was accepted under (step_ups.id), and its passkey (user_factors.id). No foreign keys, for the same reason. */
    stepUpId: uuid("step_up_id").notNull(),
    passkeyId: uuid("passkey_id").notNull(),
    /** The device's label as the step-up holds it: what the access log names. */
    deviceLabel: text("device_label").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    /** The database's clock; whatever a writer passes is replaced. */
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of clinic_locations' foreign key: a location names an
    // acceptance of its own clinic, recorded for it.
    unique("location_acknowledgements_clinic_location_id_key").on(t.clinicId, t.locationId, t.id),
    index("location_acknowledgements_location_idx").on(t.clinicId, t.locationId),
    check(
      "location_acknowledgements_version_check",
      sql`${t.documentVersion} ~ '^[a-z][a-z0-9-]{0,63}/[0-9]+\\.[0-9]+\\.[0-9]+$'`,
    ),
    check("location_acknowledgements_hash_check", sql`${t.documentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "location_acknowledgements_text_check",
      sql`char_length(btrim(${t.renderedText})) between 1 and 20000`,
    ),
    check(
      "location_acknowledgements_label_check",
      sql`char_length(btrim(${t.acceptedByLabel})) between 2 and 200 and ${t.acceptedByLabel} !~ '[[:cntrl:]]'`,
    ),
    check(
      "location_acknowledgements_device_check",
      sql`char_length(${t.deviceLabel}) between 1 and ${sql.raw(String(DEVICE_LABEL_MAX))} and ${t.deviceLabel} !~ '[[:cntrl:]]'`,
    ),
    check(
      "location_acknowledgements_user_agent_check",
      sql`${t.userAgent} is null or char_length(${t.userAgent}) <= 512`,
    ),
  ],
);

export type LocationAcknowledgementRow = typeof locationAcknowledgements.$inferSelect;

/**
 * A location of the account. The clinics row stays the one tenant: one
 * knowledge base, one sign-in, one email address, one subscription whose
 * quantity is the number of locations, and one AYA that answers for all of
 * them (the owner's decision of 20 October 2026: "a centralizer, like a call
 * center"). This row holds what differs from site to site.
 *
 * Location 1, the main location, exists for every open account: a trigger
 * on clinics creates it with the clinic (app_clinic_locations_follow_clinic),
 * 0109 backfilled it for every clinic before that, and the account's closure
 * deletes every location with the rest of its business data. A later
 * location is added pending, with its acknowledgement and the add's request
 * id, before the charge, and only app_activate_location() makes it active,
 * once, after the charge is recorded; the runtime role cannot insert an
 * active one, or move a status at all.
 *
 * ONE SOURCE OF TRUTH. Until the portal's Locations card moves their writers
 * (the plan's step 12), the main location's facts are written where they
 * always were, on clinics (address, published number, hours, time zone,
 * carrier, phone system, call routing) and clinic_settings (direct line,
 * transfer, urgent-help and vet referral numbers, coverage mode), and every
 * reader keeps reading them there. Location 1's columns below are the
 * database's copy of them, kept equal by triggers on both tables, which the
 * runtime role cannot write. A later location's columns are its only
 * record. The time zone is the account's for every location in this
 * release, so the trigger keeps every location's equal to the clinic's.
 * AYA's own number stays on clinics (`assistant_number_e164`) until phone
 * per location (the plan's step 15) moves it.
 *
 * Business data, no patient: no BAA gate. Tenant RLS, forced.
 */
export const clinicLocations = pgTable(
  "clinic_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** 1 is the main location; a later location takes the next free place. Never changes. */
    position: integer("position").notNull(),
    /** The location's own name ("Downtown"); null on the main location means the account's name. */
    label: text("label"),
    status: text("status").$type<LocationStatus>().notNull().default("pending"),
    /**
     * The add that bought it: entitlements.pending_location_request_id while
     * the add is pending. Null on the main location, set on every other.
     */
    addRequestId: uuid("add_request_id"),
    /** Its acceptance (location_acknowledgements). Null on the main location, set on every other. */
    acknowledgementId: uuid("acknowledgement_id"),
    /** The clinic's time zone, for every location in this release (enforced at insert and kept by the trigger). */
    timezone: text("timezone").notNull(),
    address: text("address"),
    publishedPhoneE164: text("published_phone_e164"),
    openingHours: jsonb("opening_hours").$type<OpeningHours>(),
    directLineE164: text("direct_line_e164"),
    transferE164: text("transfer_e164"),
    urgentHelpE164: text("urgent_help_e164"),
    vetReferralE164: text("vet_referral_e164"),
    coverageMode: text("coverage_mode")
      .$type<CoverageModeId>()
      .notNull()
      .default("overflow_after_hours"),
    carrier: text("carrier"),
    phoneSystemType: text("phone_system_type")
      .$type<(typeof phoneSystemTypeEnum.enumValues)[number]>()
      .notNull()
      .default("unknown"),
    callRouting: text("call_routing")
      .$type<(typeof callRoutingEnum.enumValues)[number]>()
      .notNull()
      .default("conditional"),
    /** The database's clock, set by the guard. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When it became active: the database's clock, at pending → active, once. */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    /**
     * When the practice confirmed this later location's address, hours and
     * phone numbers on its Settings page (drizzle/0110,
     * lib/portal/location-details.ts): the database's clock, stamped once by
     * the guard and never cleared or moved. Null on the main location, whose
     * facts the setup wizard confirms on clinics, and on a later one until
     * the practice confirms it. Business data; deleted with the row by the
     * account's closure.
     */
    detailsConfirmedAt: timestamp("details_confirmed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of every location_id foreign key: (clinic_id, location_id)
    // names a location of the row's own clinic, or nothing.
    unique("clinic_locations_clinic_id_id_key").on(t.clinicId, t.id),
    uniqueIndex("clinic_locations_position_idx").on(t.clinicId, t.position),
    uniqueIndex("clinic_locations_add_request_idx").on(t.clinicId, t.addRequestId),
    foreignKey({
      name: "clinic_locations_acknowledgement_fk",
      columns: [t.clinicId, t.id, t.acknowledgementId],
      foreignColumns: [
        locationAcknowledgements.clinicId,
        locationAcknowledgements.locationId,
        locationAcknowledgements.id,
      ],
    }).onDelete("restrict"),
    check("clinic_locations_position_check", sql`${t.position} >= 1`),
    check(
      "clinic_locations_status_check",
      sql`${t.status} in (${sqlList(LOCATION_STATUSES)})`,
    ),
    // The main location came with the signed agreement; every other was
    // added from Billing, under an acceptance of its own.
    check(
      "clinic_locations_added_check",
      sql`(${t.position} = 1) = (${t.addRequestId} is null) and (${t.position} = 1) = (${t.acknowledgementId} is null)`,
    ),
    check(
      "clinic_locations_lifecycle_check",
      sql`(${t.status} <> 'pending' or (${t.activatedAt} is null and ${t.retiredAt} is null))
        and (${t.status} <> 'active' or (${t.activatedAt} is not null and ${t.retiredAt} is null))
        and (${t.status} <> 'retired' or ${t.retiredAt} is not null)
        and (${t.position} > 1 or ${t.status} = 'active')`,
    ),
    check(
      "clinic_locations_label_check",
      sql`(${t.position} = 1 or ${t.label} is not null) and (${t.label} is null or (char_length(${t.label}) between 1 and 120 and ${t.label} = btrim(${t.label}) and ${t.label} !~ '[[:cntrl:]]'))`,
    ),
    check("clinic_locations_timezone_check", sql`btrim(${t.timezone}) <> ''`),
    // The main location's columns copy clinics' and clinic_settings', so
    // they take exactly what those take; a later location's numbers are E.164.
    check(
      "clinic_locations_address_check",
      sql`${t.address} is null or (char_length(${t.address}) between 1 and 300 and ${t.address} !~ '[[:cntrl:]]')`,
    ),
    check(
      "clinic_locations_published_phone_check",
      sql`${t.position} = 1 or ${t.publishedPhoneE164} is null or ${t.publishedPhoneE164} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      "clinic_locations_carrier_check",
      sql`${t.position} = 1 or ${t.carrier} is null or (char_length(${t.carrier}) between 1 and 80 and ${t.carrier} !~ '[[:cntrl:]]')`,
    ),
    check(
      "clinic_locations_numbers_check",
      sql`(${t.directLineE164} is null or ${t.directLineE164} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.transferE164} is null or ${t.transferE164} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.urgentHelpE164} is null or ${t.urgentHelpE164} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.vetReferralE164} is null or ${t.vetReferralE164} ~ '^\\+[1-9][0-9]{6,14}$')`,
    ),
    check(
      "clinic_locations_coverage_mode_check",
      sql`${t.coverageMode} in (${sqlList(COVERAGE_MODES)})`,
    ),
    check(
      "clinic_locations_phone_system_check",
      sql`${t.phoneSystemType} in ('landline', 'voip', 'unknown')`,
    ),
    check(
      "clinic_locations_call_routing_check",
      sql`${t.callRouting} in ('conditional', 'always')`,
    ),
    // A confirmed location has what confirming checked: an address, its
    // hours and its own number. The main location is never confirmed here.
    check(
      "clinic_locations_details_confirmed_check",
      sql`${t.detailsConfirmedAt} is null or (${t.position} > 1 and ${t.address} is not null and ${t.openingHours} is not null and ${t.publishedPhoneE164} is not null)`,
    ),
  ],
);

export type ClinicLocationRow = typeof clinicLocations.$inferSelect;

/**
 * The location column the conversations, booking requests, bookings,
 * handovers, slot holds, Meta booking drafts and closed days carry: which
 * location of the account the row is about. NOT NULL; a writer that names
 * none gets the main location (LOCATION_UNSET above), because until the
 * tool layer learns locations (the plan's step 9) every row is the main
 * location's. The foreign key (clinic_id, location_id) to clinic_locations
 * (clinic_id, id), written by hand in drizzle/0109 after the backfill, stops
 * a row naming another account's location, and a trigger on each table
 * freezes it once written, for every role.
 */
function locationColumn() {
  return uuid("location_id")
    .notNull()
    .default(sql.raw(`'${LOCATION_UNSET}'::uuid`));
}

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
    // The key a patient's request names its contact by, with the clinic
    // (patient_requests_contact_fk, drizzle/0094), so a request can only name
    // a contact of its own clinic, and the list of people a breach affected
    // names its contact by (incident_affected_contacts, drizzle/0098). id is
    // unique already.
    unique("contacts_clinic_id_unique").on(t.clinicId, t.id),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
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
    /**
     * The urgent screen matched in this conversation (lib/assistant/turn.ts's
     * screen, before the model): the fixed reply went and the clinic's urgent
     * alert was raised. Written by the voice ingest and web chat beside
     * `outcome`, which says `escalated_to_human` for an urgent hit and a
     * handover alike, so the Conversations screen can tell them apart
     * (drizzle/0078). A fact, never inferred afterwards; false for every row
     * written before it.
     */
    urgent: boolean("urgent").notNull().default(false),
    treatmentInterest: text("treatment_interest"),

    /**
     * ⚠️ PHI when set. No longer written: by the owner's decision of 13
     * October 2026 a transcript is emailed to the clinic when its
     * conversation ends (lib/conversations/transcript-email.ts) and healdesk
     * keeps neither the transcript nor a link to one, so every new row has
     * null here. BAA 1.4.0 and the DPA describe no stored transcript (13
     * October 2026); the column, and the retention purge that clears it,
     * stay until the spec that still describes one changes. healdesk keeps no
     * audio either (21 September 2026; `recording_uri` was dropped in 0038).
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

    /**
     * The call ended unexpectedly (lib/voice/ended-early.ts): Retell's
     * technical disconnection reason, or `unexplained` for a call only the
     * backstop recorded with no reason given. Null for every call that ended
     * normally, and for every web chat. Set once, never cleared: the
     * transcript email carries a banner, Conversations marks the row, Home
     * counts it, and the clinic's L35 alert points at it, so staff can call
     * the person back themselves. healdesk contacts nobody (drizzle/0108).
     */
    endedEarlyReason: text("ended_early_reason"),
    /** When the flag was set, by the database's clock. */
    endedEarlyAt: timestamp("ended_early_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "conversations_ended_early_check",
      sql`(${t.endedEarlyReason} is null) = (${t.endedEarlyAt} is null) and (${t.endedEarlyReason} is null or ${t.endedEarlyReason} ~ '^[a-z_]{1,64}$')`,
    ),
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
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
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
     * "pending_link" is owed through a Stripe Connect payment link: written
     * with the booking, so it holds from the moment the booking commits until
     * the link opens and is paid; one whose link was never made is handed to
     * the front desk by lib/billing/deposit-sweep.ts.
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
     * When the desk sweep may try an `unknown` write again (drizzle/0117):
     * set after each attempt that ended unknown, +2 min, +10 min, +30 min,
     * +2 h and +6 h after the first to the fifth (lib/booking/calendar.ts,
     * WRITE_BACKOFF_MINUTES); null when nothing is waiting (never tried, or
     * settled). The sweep takes a write only once this has passed, and only
     * while its slot has not started.
     */
    calendarWriteNextAt: timestamp("calendar_write_next_at", { withTimezone: true }),
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

    /**
     * The clinic's own listed price for the booked service when the booking
     * was made (drizzle/0087): what "booked value" multiplies by (spec, "What
     * v1 can prove": bookings times the clinic's own configured prices,
     * labelled booked value, never revenue; lib/reporting/claims.ts). The
     * low end of the price as Knowledge → Prices states it: an exact price,
     * the start of a "from" price or a range, or the price of one unit for a
     * per-unit price, which the claims count apart and never multiply into a
     * total. Both null when the booking named no service on the clinic's
     * list, or the service has no price there. Written once, at insert, by
     * insertAppointment (lib/meta/booking-requests.ts); a trigger refuses a
     * change, so a price edited in Knowledge later never rewrites what was
     * booked.
     */
    listedPriceCents: integer("listed_price_cents"),
    listedPriceKind: text("listed_price_kind").$type<ServicePriceKind>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "appointments_listed_price_check",
      sql`(${t.listedPriceCents} is null and ${t.listedPriceKind} is null) or (${t.listedPriceCents} >= 0 and ${t.listedPriceKind} in (${sqlList(SERVICE_PRICE_KINDS)}))`,
    ),
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
    // The desk sweep's due writes (drizzle/0117): unsettled ones only.
    index("appointments_calendar_write_due_idx")
      .on(t.clinicId, t.calendarWriteNextAt)
      .where(sql`${t.calendarWriteStatus} in ('unknown', 'writing')`),
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
/**
 * A question and the answer AYA gives. `flagId` tags a quick answer that came
 * from a "Flag this answer" correction (conversation_flags.id): the Flagged
 * view reads it to say whether the correction is still live, and Knowledge
 * shows it. It is a tag only: AYA's prompt reads the question and the answer.
 */
export type KnowledgeAnswer = { question: string; answer: string; flagId?: string };

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
    /**
     * The Slack copy (lib/ops/slack.ts, the ops-slack sweep; owner decision
     * D1, 23 October 2026): when Slack took it, how many posts were tried,
     * the last failure as a status or an error name (never the webhook's
     * address), and when the next try may start, which is also the lease a
     * try holds while it runs.
     */
    slackPostedAt: timestamp("slack_posted_at", { withTimezone: true }),
    slackAttempts: integer("slack_attempts").notNull().default(0),
    slackError: text("slack_error"),
    slackNextAt: timestamp("slack_next_at", { withTimezone: true }),
  },
  (t) => [
    index("ops_alerts_dedupe_idx").on(t.event, t.dedupeKey, t.raisedAt),
    check("ops_alerts_slack_attempts_check", sql`${t.slackAttempts} >= 0`),
    // The Slack sweep's scan, every minute, over a table that only grows:
    // the alerts not yet posted, by when they were raised.
    index("ops_alerts_slack_owed_idx").on(t.raisedAt).where(sql`${t.slackPostedAt} is null`),
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

/** Which app sent an email the ops digest counts: this one, or the marketing site. */
export const EMAIL_EVENT_APPS = ["app", "web"] as const;

/** What an email_events row says happened: a send's answer here, or what Resend reported later. */
export const EMAIL_EVENT_STATUSES = ["sent", "failed", "bounced", "complained", "suppressed"] as const;
export type EmailEventStatus = (typeof EMAIL_EVENT_STATUSES)[number];

/**
 * The email the ledgers do not hold, counted for the 07:00 ops digest (I2):
 * Annex X5 asks it for email health per kind, and X8's bounce and complaint
 * targets are the whole Resend account's, since Resend pauses the account,
 * not one app. report_deliveries holds every send about a clinic; these rows
 * hold the rest. One per send of a direct kind with no ledger row (sign-in
 * links, B3, O3, O6, the calendar's two, I3, P6's resend, I2), written by
 * sendEmail, and one per bounce, complaint or suppression Resend reports for
 * one of them, written by the webhook relay; and for apps/web's mail, whose
 * sends apps/app never sees, one per event Resend reports and apps/web's
 * webhook relays (sent, bounced, complained, suppressed).
 *
 * A kind, a status and a time, and no more: no address, no clinic, no
 * message id, nothing a person could be found by. `event_id` is the
 * webhook's own id, so a redelivered event counts once, or I3's daily claim,
 * a digest of the clinic, the code and the day (lib/sign-in/help.ts). Ours, not a
 * tenant's: no clinic_id and no row-level security. The digest deletes rows
 * past 30 days, which nothing reads.
 */
export const emailEvents = pgTable(
  "email_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    app: text("app").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    /** When it happened: the send's answer, or the event's own timestamp. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The webhook delivery's id (svix-id), for a relayed event; I3's daily claim digest. */
    eventId: text("event_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("email_events_app_check", sql`${t.app} in (${sqlList(EMAIL_EVENT_APPS)})`),
    check("email_events_kind_check", sql`${t.kind} ~ '^[a-z0-9_]{1,64}$'`),
    check("email_events_status_check", sql`${t.status} in (${sqlList(EMAIL_EVENT_STATUSES)})`),
    check(
      "email_events_event_id_check",
      sql`${t.eventId} is null or ${t.eventId} ~ '^[A-Za-z0-9_.-]{1,128}$'`,
    ),
    uniqueIndex("email_events_event_id_key").on(t.eventId),
    index("email_events_at_idx").on(t.at),
  ],
);

// -----------------------------------------------------------------------------
// Incidents — the BAA's two clocks, as rows with deadlines
// -----------------------------------------------------------------------------

/** What the forwarding test saw. Facts from the call; no caller in it. */
export type ForwardingTestObservation = {
  arrivedAt: string;
  /**
   * When the test's window ended. Every call inside it is Healdesk's own,
   * not only the first, so none of them is phone's first answer or billed
   * minutes (lib/onboarding/forwarding-test.ts). Absent on an observation
   * recorded before 0079.
   */
  windowUntil?: string;
  conversationId: string;
  callerIdPreserved: boolean;
  /** Which forward condition fired, where the carrier told us. */
  condition: "busy" | "no_answer" | "all" | "unknown";
  /**
   * How it was observed. Absent: the first call in a forwarding test's
   * window. `forwarded_call`: a call the carrier said it forwarded from the
   * clinic's own published line, with no window open (the spec's "flips to
   * live by itself"); it has no `windowUntil`, so it makes no call a test
   * call.
   */
  via?: "forwarded_call";
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
    /**
     * The deadline the clinic's agreement itself promises, set when the
     * incident is opened from the agreement in effect then
     * (lib/incidents/reporting-rules.ts): 10 calendar days after discovery
     * under BAA 1.7.0 and DPA 1.2.0, 60 under BAA 1.2.2 to 1.6.0 and DPA
     * 1.0.0 and 1.1.0; five calendar days for a breach and
     * five business days for the rest under 1.2.1 and before, and for a
     * clinic with no agreement or one the map does not know. Null for a
     * service complaint, which no agreement clocks. `notify_by` is healdesk's
     * own target, stricter, and never a promise (owner, 12 October 2026).
     */
    agreementNotifyBy: timestamp("agreement_notify_by", { withTimezone: true }),
    /** The version that deadline was read from, or null when there was none (the strictest rule applied). */
    agreementVersion: text("agreement_version"),
    /**
     * Ops' decision on an incident the agreement covers (plan Part J,
     * "incidents"): a report sent (L29, from fixed fields only, through the
     * outbox) or not reportable, with the reason. Nothing reaches a clinic
     * unless ops sends it. `reports_sent` counts the reports and their
     * updates, so each one has its own outbox dedupe key.
     */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    reportsSent: integer("reports_sent").notNull().default(0),
    /**
     * How many people the operator recorded as affected (wave 2 R11;
     * lib/incidents/affected.ts), written with each change to the list. A
     * count, never who, kept on the incident because the list's rows go with
     * their contacts (an erasure, the record clock), and the record of how
     * many a breach reached must not fall with them.
     */
    affectedRecorded: integer("affected_recorded").notNull().default(0),
    notReportableAt: timestamp("not_reportable_at", { withTimezone: true }),
    /** Operator prose, PHI-scanned on the way in like the summary. */
    notReportableReason: text("not_reportable_reason"),
    /** Who decided: the administrator's address (lib/ops/api.ts). */
    decidedBy: text("decided_by"),
    openedBy: text("opened_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incidents_clinic_idx").on(t.clinicId, t.discoveredAt),
    index("incidents_open_idx").on(t.notifyBy).where(sql`${t.resolvedAt} is null`),
    // One decision: a report sent, or not reportable with its reason, never both.
    check(
      "incidents_decision_check",
      sql`not (${t.reportedAt} is not null and ${t.notReportableAt} is not null)
          and (${t.notReportableAt} is null) = (${t.notReportableReason} is null)
          and (${t.reportedAt} is null) = (${t.reportsSent} = 0)
          and ${t.reportsSent} >= 0`,
    ),
    check("incidents_affected_recorded_check", sql`${t.affectedRecorded} >= 0`),
    // The key the list of people a breach affected names its incident by,
    // with the clinic (incident_affected_contacts). id is unique already.
    unique("incidents_clinic_id_unique").on(t.clinicId, t.id),
  ],
);

/**
 * Who an incident affected (plan Annex X5, L29: "The list of individuals is
 * never emailed. It sits on a page behind step-up"): one row per contact the
 * operator named, from the app's own shell, by ids only
 * (`npm run ops:incident-affected -w @healdesk/app`; lib/incidents/affected.ts).
 * The practice reads it on the incident's page, behind the passkey step-up,
 * which writes an access row naming every contact shown
 * (app/c/[slug]/incidents/[id]). That page is the secure transfer the
 * agreements' Safeguards clause promises the list travels by.
 *
 * ⚠️ PHI by what it says: that this person's information was involved in a
 * breach at this practice. So tenant RLS, FORCEd, and the BAA gate
 * (drizzle/0098). It holds no name, no number, no address and nothing typed:
 * the person is the contact it names, read from `contacts` when the page
 * opens, and the contact's own clock, erasure and destruction govern them.
 * Both keys are composite with the clinic, so a row can name only an
 * incident and a contact of its own clinic, and both cascade: when the
 * contact goes, the list keeps no trace of them.
 */
export const incidentAffectedContacts = pgTable(
  "incident_affected_contacts",
  {
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    incidentId: uuid("incident_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    /** The operator at the shell: their healdesk address. */
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.contactId] }),
    index("incident_affected_contacts_clinic_idx").on(t.clinicId, t.incidentId),
    foreignKey({
      name: "incident_affected_contacts_incident_fk",
      columns: [t.clinicId, t.incidentId],
      foreignColumns: [incidents.clinicId, incidents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "incident_affected_contacts_contact_fk",
      columns: [t.clinicId, t.contactId],
      foreignColumns: [contacts.clinicId, contacts.id],
    }).onDelete("cascade"),
    check(
      "incident_affected_contacts_recorded_by_check",
      sql`char_length(btrim(${t.recordedBy})) between 1 and 320`,
    ),
  ],
);

export type IncidentAffectedContact = typeof incidentAffectedContacts.$inferSelect;

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
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
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
    /**
     * How the request was taken: by AYA in a conversation, or on the
     * website's contact form while website chat was not answering (L20,
     * package F): a first name, a number and one of a fixed set of times,
     * nothing else. A contact-form request is always web chat's, with no
     * conversation (CHECK). Frozen after insert: the runtime role has no
     * UPDATE on it, and the no-rewrite trigger refuses it to the owner too.
     */
    source: text("source").$type<BookingRequestSource>().notNull().default("assistant"),
    /** The person's last inbound message on the thread — the start of Meta's 24-hour window. */
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("booking_requests_source_known", sql`${t.source} in ('assistant', 'contact_form')`),
    check(
      "booking_requests_source_shape",
      sql`${t.source} = 'assistant' or (${t.channel} = 'web_chat' and ${t.conversationId} is null and ${t.vendorCallId} is null)`,
    ),
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
/** See bookingRequests.source: AYA took it, or the website's contact form did while AYA was not answering. */
export type BookingRequestSource = "assistant" | "contact_form";

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
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
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
 * (clause 14(b) of BAA 1.5.1, as of 1.3.0; 45 CFR 164.526(c)(1); the DPA's
 * Clients' requests clause; release gate 8, PT-17). A booking request's
 * facts never change (the no-rewrite trigger, 0039 and 0041), a conversation
 * is the record of what was said, and an appointment is the booking as the
 * clinic's calendar holds it, so none is edited on Practice's word: the
 * amendment is appended beside it and linked to it, and every later export
 * of the record, and every screen of healdesk's that shows it, carries it
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
 * What a patient asked healdesk for about their information at a practice
 * (BAA 1.5.1 clause 14, its last paragraph): to see it, to have it
 * corrected, to be told who it was disclosed to, to have it deleted, or
 * anything else about it. Chosen by the operator, never typed.
 */
export const PATIENT_REQUEST_KINDS = [
  "access",
  "amendment",
  "accounting",
  "deletion",
  "other",
] as const;
export type PatientRequestKind = (typeof PATIENT_REQUEST_KINDS)[number];

/**
 * A request a patient made to healdesk itself, rather than to the practice
 * (L32 in Annex X5 of the funnel and portal plan; BAA 1.5.1 clause 14:
 * "healdesk will not act on it. It will pass the request to Practice within
 * five business days"). The operator records it from the app's own shell
 * (`npm run ops:patient-request -w @healdesk/app`, by ids and closed choices
 * only); the practice gets L32, a pointer, and the request opens on its own
 * patient page behind the passkey step-up, where staff mark it received
 * (lib/patient-rights/patient-requests.ts).
 *
 * PHI while it names a contact: whose request it is, at which practice. So
 * tenant RLS, FORCEd, and the BAA gate (drizzle/0094). It holds no name, no
 * number, no address and nothing typed: the person is the contact it names,
 * read from `contacts` when the page opens, and the contact's own clock and
 * erasure govern them. Its foreign key (clinic_id, contact_id) is written by
 * hand in the migration, because drizzle cannot say ON DELETE SET NULL of
 * one column: when the contact goes, by erasure or the purge, the request
 * stays as a record without the person.
 *
 * `reply_by` is the fifth business day after the clinic-local day the
 * request reached healdesk: the day by which the practice is asked to mark
 * it received, and the BAA's own deadline for passing it on. `recorded_at`
 * and `acknowledged_at` are the database's clock (patient_requests_guard),
 * nothing but the acknowledgement is ever added to a row, and that once.
 */
export const patientRequests = pgTable(
  "patient_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    kind: text("kind").$type<PatientRequestKind>().notNull(),
    /** The contact the request is about, when the operator could name one. Nulled when the contact goes. */
    contactId: uuid("contact_id"),
    /**
     * Whether a contact was named when it was recorded (patient_requests_guard
     * sets it), so a page can tell "healdesk holds no record of them" from
     * "their details have since been deleted".
     */
    contactNamed: boolean("contact_named").notNull().default(false),
    /** When the request reached healdesk: the five business days run from here. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** The fifth business day after the clinic-local day of received_at (YYYY-MM-DD). */
    replyBy: date("reply_by", { mode: "string" }).notNull(),
    /** The operator's healdesk address. */
    recordedBy: text("recorded_by").notNull(),
    /** When it was recorded, by the database's clock (patient_requests_guard). */
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** When the practice marked it received, by the database's clock; once. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** The device it was marked from, by the name staff gave its passkey. */
    acknowledgedBy: text("acknowledged_by"),
  },
  (t) => [
    index("patient_requests_open_idx")
      .on(t.clinicId, t.replyBy)
      .where(sql`${t.acknowledgedAt} is null`),
    index("patient_requests_contact_idx")
      .on(t.clinicId, t.contactId)
      .where(sql`${t.contactId} is not null`),
    check(
      "patient_requests_kind_check",
      sql`${t.kind} in ('access', 'amendment', 'accounting', 'deletion', 'other')`,
    ),
    check(
      "patient_requests_recorded_by_check",
      sql`char_length(btrim(${t.recordedBy})) between 1 and 320`,
    ),
    check("patient_requests_received_check", sql`${t.receivedAt} <= ${t.recordedAt}`),
    check("patient_requests_contact_check", sql`${t.contactId} is null or ${t.contactNamed}`),
    // Five business days after a clinic-local day are five to seven calendar
    // days after it (from a Sunday, a Saturday, any weekday), and that day is
    // at most one either side of received_at's day in UTC.
    check(
      "patient_requests_reply_by_check",
      sql`${t.replyBy} between (${t.receivedAt} at time zone 'UTC')::date + 4 and (${t.receivedAt} at time zone 'UTC')::date + 8`,
    ),
    check(
      "patient_requests_acknowledged_check",
      sql`(${t.acknowledgedAt} is null) = (${t.acknowledgedBy} is null)
        and (${t.acknowledgedBy} is null or char_length(btrim(${t.acknowledgedBy})) between 1 and 200)`,
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

    /** When the assistant's forwarded-to number may be released after a cancel. */
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

/**
 * Whether the website was read at checkout: read, tried and failed, or there
 * was none. The catalog's list since 14 October 2026, because apps/web holds a
 * purchase to it before payment (packages/catalog/src/checkout-intent.ts).
 */
export { CHECKOUT_PROFILE_STATUSES, type CheckoutProfileStatus };

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
     * When a paid first invoice's relay first reached /api/provision for this
     * purchase (WP5): the database's clock, written before provisioning runs
     * and kept whatever it does. Ten minutes later with no account, the ops
     * watch raises `paid_intent_without_clinic` (lib/ops/watch.ts). The relay
     * is the only caller, and it calls only for a paid first invoice (or, in
     * development, for the unpaid path that provisions at once).
     */
    paidSeenAt: timestamp("paid_seen_at", { withTimezone: true }),
    /**
     * How many provisioning attempts failed in a way a retry could fix (a 500
     * that Stripe redelivers). At PROVISION_DEAD_LETTER_AT the purchase is
     * dead-lettered: ops is told, B3 goes to the buyer, and /welcome stops
     * waiting; later redeliveries still provision (lib/checkout/dead-letter.ts).
     */
    provisionFailures: integer("provision_failures").notNull().default(0),
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

/** What the assistant asks the patient to pay (Settings → Payments). */
export const PAYMENT_ASKS = ["deposit_only", "full_payment"] as const;
export type PaymentAsk = (typeof PAYMENT_ASKS)[number];

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
    /**
     * What patients call the clinic, said after its full name has been said
     * once ("Lumen" for "Lumen Aesthetics & Wellness"; owner, 26 October 2026,
     * docs/design/clinic-nickname-2026-10-26.md). Null means the short form
     * worked out from the name (@healdesk/catalog shortClinicName).
     */
    shortName: text("short_name"),
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
    /**
     * Payments (owner, 28 October 2026; drizzle/0133). "Text the payment
     * link": the clinic's choice, off by default, usable once phone is
     * bought and Stripe is connected; whether a text can go out at all is
     * the tool layer's, and no sender exists yet. "What the assistant asks
     * the patient to pay": deposit only, or the full price, which needs
     * Stripe, the calendar and Auto-confirm (lib/portal/switch-rules.ts);
     * losing any of them sets it back to deposit only in the same
     * transaction (lib/portal/switch-resets.ts). Clinic configuration only.
     */
    textPaymentLink: boolean("text_payment_link").notNull().default(false),
    paymentAsk: text("payment_ask").$type<PaymentAsk>().notNull().default("deposit_only"),
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
     * L33, "What changed in healdesk": on by default, and turned off by its
     * one-click stop link (lib/email/stop.ts), which the sender reads.
     */
    productUpdates: boolean("product_updates").notNull().default(true),
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
    check("clinic_settings_short_name_check", sql`${t.shortName} is null or char_length(${t.shortName}) between 1 and 40`),
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
      "clinic_settings_payment_ask_check",
      sql`${t.paymentAsk} in ('deposit_only', 'full_payment')`,
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
    channel: text("channel").$type<"web" | "meta" | "voice">().notNull(),
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
    // 'voice': the link texted after a call (drizzle/0141, lib/sms/payment-text.ts).
    check("deposit_payments_channel_check", sql`${t.channel} in ('web', 'meta', 'voice')`),
    check("deposit_payments_amount_check", sql`${t.amountCents} > 0`),
    check(
      "deposit_payments_status_check",
      sql`${t.status} in ('creating', 'open', 'paid', 'expired', 'failed', 'cancelled', 'refunded')`,
    ),
  ],
);

export type DepositPayment = typeof depositPayments.$inferSelect;

/**
 * Where the one payment-link text of a booking stands (drizzle/0141). `queued`
 * is written before AWS is asked, so a crash mid-send leaves the row and no
 * second text ever follows; the other three are where a send ended.
 * `declined`: offered on the call and turned down (or never confirmed), so it
 * is never offered again for that booking.
 */
export const PAYMENT_LINK_TEXT_STATUSES = ["queued", "sent", "failed", "opted_out", "declined"] as const;
export type PaymentLinkTextStatus = (typeof PAYMENT_LINK_TEXT_STATUSES)[number];

/** Why a send failed, closed words only: never AWS's message. */
export const PAYMENT_LINK_TEXT_FAILURES = [
  "invalid_number",
  "throttled",
  "not_configured",
  "error",
  "link_unavailable",
  "refused",
  /** AWS did not answer inside our deadline: the text may or may not have gone. */
  "unknown",
] as const;
export type PaymentLinkTextFailure = (typeof PAYMENT_LINK_TEXT_FAILURES)[number];

/**
 * The ledger of the optional payment-link text after a call (owner, 28 and
 * 30 October 2026; lib/sms/payment-text.ts): ONE row per appointment, the
 * unique key that makes the send idempotent. A retried tool call, a
 * reconnected call or a duplicate event finds the row and returns its
 * outcome; nothing ever texts the booking twice.
 *
 * What it keeps is the evidence and the outcome, never the message: the
 * caller's yes and their read-back confirmation (both times), the call as an
 * opaque reference (SHA-256 of Retell's call id, never the id), the deposit
 * link's row (itself only an amount and an opaque id) and AWS's message id.
 * NEVER the phone number (the send is synchronous, inside the call, so the
 * number is held in the call's memory only) and never the body (fixed words
 * in code, lib/sms/send.ts). Tenant RLS, forced; the BAA gate, as on every
 * patient table; deleted with its appointment (the foreign key's cascade),
 * and by the clinic's destruction.
 */
export const paymentLinkTexts = pgTable(
  "payment_link_texts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    /** SHA-256, hex, of the call's Retell id: which call the yes was given on, never the id itself. */
    callRefHash: text("call_ref_hash").notNull(),
    status: text("status").$type<PaymentLinkTextStatus>().notNull(),
    failureCode: text("failure_code").$type<PaymentLinkTextFailure>(),
    /** When the caller said yes to the text: the opt-in. Null on a declined row. */
    optedInAt: timestamp("opted_in_at", { withTimezone: true }),
    /** When the caller confirmed the number read back to them. Null on a declined row. */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /**
     * The deposit link texted, once one was made: an opaque id, with no
     * foreign key. The deposit purge (app_purge_deposit_payments) may delete
     * the deposit before its appointment, and a key's SET NULL would be an
     * UPDATE here, which the closed-account freeze refuses: purging a closed
     * clinic's deposits would fail on the ledger (drizzle/0141).
     */
    depositPaymentId: uuid("deposit_payment_id"),
    /** AWS's id for the message, once it was accepted. */
    awsMessageId: text("aws_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the row reached its final status. */
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    unique("payment_link_texts_appointment_key").on(t.appointmentId),
    index("payment_link_texts_clinic_idx").on(t.clinicId, t.createdAt),
    check("payment_link_texts_status_check", sql`${t.status} in (${sqlList(PAYMENT_LINK_TEXT_STATUSES)})`),
    check(
      "payment_link_texts_failure_check",
      sql`(${t.status} = 'failed') = (${t.failureCode} is not null) and (${t.failureCode} is null or ${t.failureCode} in (${sqlList(PAYMENT_LINK_TEXT_FAILURES)}))`,
    ),
    check("payment_link_texts_ref_check", sql`${t.callRefHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "payment_link_texts_evidence_check",
      sql`(${t.status} = 'declined') = (${t.optedInAt} is null) and (${t.optedInAt} is null) = (${t.confirmedAt} is null) and (${t.confirmedAt} is null or ${t.confirmedAt} >= ${t.optedInAt})`,
    ),
    check(
      "payment_link_texts_message_check",
      sql`(${t.status} = 'sent') = (${t.awsMessageId} is not null) and (${t.awsMessageId} is null or ${t.awsMessageId} ~ '^[A-Za-z0-9-]{1,100}$')`,
    ),
    check("payment_link_texts_settled_check", sql`(${t.status} = 'queued') = (${t.settledAt} is null)`),
  ],
);

export type PaymentLinkText = typeof paymentLinkTexts.$inferSelect;

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
  // Phone's: the direct line, where every call AYA can't answer goes, is not
  // on file (drizzle/0079). Its own state so the portal and L4 can name it.
  "direct_line",
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
  // Two of `live`'s inputs (lib/channels/events.ts, drizzle/0076): the
  // channel's audit passed, which only an operator records until the
  // practice questions exist (lib/channels/audit-seam.ts), and the first
  // sign that the channel's runtime answers there: website chat's widget
  // loading on the clinic's own site.
  "audit_passed",
  "runtime_seen",
  // Website chat's first open from a page on the clinic's own site, by its
  // Origin (drizzle/0138, lib/channels/widget-sighting.ts): once per channel.
  // A second open at least five minutes later records runtime_seen by
  // 'origin_seen'; the definer alone writes either.
  "widget_seen",
] as const;
export type ChannelEventKind = (typeof CHANNEL_EVENT_KINDS)[number];

/**
 * What happened to a clinic's channels, append-only: ready on our side,
 * waiting on the clinic (and for what), live, the first answer, the header's
 * pause and resume, the Settings switch, and two of `live`'s inputs: the
 * channel's audit passed, and its runtime first seen answering there.
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
    // Each of `live`'s recorded inputs once per channel (drizzle/0079), and
    // website chat's first sighting (0138), so its definer records it with
    // ON CONFLICT and takes no row lock.
    uniqueIndex("channel_events_input_once_idx")
      .on(t.clinicId, t.channel, t.kind)
      .where(sql`${t.kind} in ('audit_passed', 'runtime_seen', 'widget_seen')`),
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
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
    closedOn: date("closed_on", { mode: "string" }).notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Still one row per day for the account: no writer names a location yet,
    // so every closed day is the main location's. The key gains location_id
    // with the first writer that does (the portal's Locations card, the
    // plan's step 12): drizzle-kit would add that key before the column it
    // names if both came in one migration.
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

/**
 * Where a change of the clinic's one address stands (plan Part D5, Annex X5
 * O5; drizzle/0084). `awaiting_confirmation`: asked for from Settings, with a
 * single-use link sent to the new address. `pending`: confirmed (or entered
 * by the operator through ops' changeClinicEmail), and taking effect at
 * `effective_at`, 72 hours on. Then exactly one of `applied`, `stopped` (by
 * the clinic or the operator), `expired` (the link was never used) or
 * `failed` (the new address became another sign-in's in the meantime).
 */
export const ADDRESS_CHANGE_STATUSES = [
  "awaiting_confirmation",
  "pending",
  "applied",
  "stopped",
  "expired",
  "failed",
] as const;
export type AddressChangeStatus = (typeof ADDRESS_CHANGE_STATUSES)[number];

/** The statuses a change is still open in: at most one per sign-in. */
export const OPEN_ADDRESS_CHANGE_STATUSES = [
  "awaiting_confirmation",
  "pending",
] as const satisfies readonly AddressChangeStatus[];

/** Who asked: the clinic from Settings, or the operator after a call back (D5). */
export const ADDRESS_CHANGE_SOURCES = ["settings", "operator"] as const;
export type AddressChangeSource = (typeof ADDRESS_CHANGE_SOURCES)[number];

/** Who stopped one: the clinic, signed in, or the operator on an objection. */
export const ADDRESS_CHANGE_STOPPERS = ["clinic", "operator"] as const;
export type AddressChangeStopper = (typeof ADDRESS_CHANGE_STOPPERS)[number];

/**
 * A change of the clinic's one address: its sign-in (the Better Auth user's
 * email), the Stripe customer's email and the agreement's notice address,
 * which move together when it takes effect (lib/sign-in/address-change.ts).
 * Business contact data, never a patient. Tenant RLS on the clinic it was
 * asked for; the confirmation link and the hourly job find a row across
 * tenants only through two SECURITY DEFINER functions (0084).
 *
 * The confirmation token is never stored, only its SHA-256, as sign-in links
 * keep theirs. The runtime role may move the state columns and never DELETE:
 * the row is the written record that the practice gave healdesk a new notice
 * address (the agreements' Notices clause), and destruction and the
 * account's closure keep it.
 */
export const signInAddressChanges = pgTable(
  "sign_in_address_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** The sign-in that moves. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Lower-cased, as user.email stood when the change was asked for. */
    oldEmail: text("old_email").notNull(),
    newEmail: text("new_email").notNull(),
    source: text("source").$type<AddressChangeSource>().notNull(),
    status: text("status").$type<AddressChangeStatus>().notNull(),
    /** The device whose passkey stepped up, or the operator's address. A snapshot. */
    requestedBy: text("requested_by").notNull(),
    /** SHA-256 of the single-use confirmation link's token; Settings changes only. */
    confirmTokenHash: bytea("confirm_token_hash"),
    confirmExpiresAt: timestamp("confirm_expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** When it takes effect: 72 hours after confirmation (or after the operator entered it). */
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    stoppedBy: text("stopped_by").$type<AddressChangeStopper>(),
    /** A closed code for `failed`, or the label of whoever stopped it. Never typed text. */
    resolution: text("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sign_in_address_changes_clinic_idx").on(t.clinicId, t.createdAt),
    uniqueIndex("sign_in_address_changes_token_idx")
      .on(t.confirmTokenHash)
      .where(sql`${t.confirmTokenHash} is not null`),
    // One open change per sign-in: a second request while one is open would
    // leave two notices naming two different addresses.
    uniqueIndex("sign_in_address_changes_open_idx")
      .on(t.userId)
      .where(sql`${t.status} in (${sqlList(OPEN_ADDRESS_CHANGE_STATUSES)})`),
    index("sign_in_address_changes_due_idx")
      .on(t.effectiveAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      "sign_in_address_changes_status_check",
      sql`${t.status} in (${sqlList(ADDRESS_CHANGE_STATUSES)})`,
    ),
    check(
      "sign_in_address_changes_source_check",
      sql`${t.source} in (${sqlList(ADDRESS_CHANGE_SOURCES)})`,
    ),
    check(
      "sign_in_address_changes_stopped_by_check",
      sql`${t.stoppedBy} is null or ${t.stoppedBy} in (${sqlList(ADDRESS_CHANGE_STOPPERS)})`,
    ),
    check(
      "sign_in_address_changes_emails_check",
      sql`${t.oldEmail} = lower(btrim(${t.oldEmail})) and ${t.newEmail} = lower(btrim(${t.newEmail})) and char_length(${t.oldEmail}) between 3 and 254 and char_length(${t.newEmail}) between 3 and 254 and ${t.oldEmail} <> ${t.newEmail}`,
    ),
    check(
      "sign_in_address_changes_token_hash_length",
      sql`${t.confirmTokenHash} is null or octet_length(${t.confirmTokenHash}) = 32`,
    ),
    check(
      "sign_in_address_changes_requested_by_check",
      sql`char_length(${t.requestedBy}) between 1 and 200`,
    ),
    check(
      "sign_in_address_changes_resolution_check",
      sql`${t.resolution} is null or char_length(${t.resolution}) between 1 and 200`,
    ),
    // A Settings change carries its link until it is confirmed; the operator's
    // has none, because the operator confirmed it on the call back.
    check(
      "sign_in_address_changes_link_check",
      sql`(${t.source} = 'settings') = (${t.confirmExpiresAt} is not null)`,
    ),
    check(
      "sign_in_address_changes_pending_check",
      sql`${t.status} <> 'pending' or (${t.effectiveAt} is not null and ${t.confirmedAt} is not null)`,
    ),
    check(
      "sign_in_address_changes_resolved_check",
      sql`(${t.status} in (${sqlList(OPEN_ADDRESS_CHANGE_STATUSES)})) = (${t.resolvedAt} is null)`,
    ),
    check(
      "sign_in_address_changes_stopped_check",
      sql`(${t.status} = 'stopped') = (${t.stoppedBy} is not null)`,
    ),
  ],
);

export type SignInAddressChange = typeof signInAddressChanges.$inferSelect;

// -----------------------------------------------------------------------------
// The DPA→BAA re-sign (package WP9, plan Part L, Annex X5 L22; drizzle/0088)
// -----------------------------------------------------------------------------

/**
 * Why a practice signs again: under the Data Protection Agreement, its answer
 * (`now_covered`, `not_sure`), which stops the DPA covering it; or, under a
 * Business Associate Agreement, a newer version of it (`baa_version`,
 * drizzle/0098): the version in force is older than the current one.
 */
export const AGREEMENT_RESIGN_REASONS = ["now_covered", "not_sure", "baa_version"] as const;
export type AgreementResignReason = (typeof AGREEMENT_RESIGN_REASONS)[number];

/**
 * Who opened it: ops (setCoveredEntity, or the broadcast that starts every
 * practice on an older BAA re-signing), the practice from Billing, or the
 * hourly job (`release`), when a release has left the BAA in force below the
 * floor go-live accepts (app_baa_version_acceptable).
 */
export const AGREEMENT_RESIGN_SOURCES = ["operator", "portal", "release"] as const;
export type AgreementResignSource = (typeof AGREEMENT_RESIGN_SOURCES)[number];

/**
 * `open` until the practice signs the BAA (`signed`), or until ops records
 * that it bills no insurance electronically after all (`withdrawn`), which
 * leaves the DPA in force and covering it again.
 */
export const AGREEMENT_RESIGN_STATUSES = ["open", "signed", "withdrawn"] as const;
export type AgreementResignStatus = (typeof AGREEMENT_RESIGN_STATUSES)[number];

/**
 * A practice's re-sign, from the Data Protection Agreement to the Business
 * Associate Agreement (lib/agreements/resign.ts): opened the moment its
 * covered-entity answer stops the DPA covering it, which is the moment the
 * PHI gate starts refusing its data, and closed when the BAA it signs through
 * L22's link is put in force by app_supersede_agreement().
 *
 * L22's link is signed and never stored: it names this row and its clinic,
 * and works only while the row is open, so signing spends every link it was
 * ever sent. The emails are on the ledger (report_deliveries), one period key
 * each for L22 and its reminders at 3 and 7 days.
 *
 * `paused_at` is the header pause this re-sign put on AYA
 * (clinic_settings.ai_paused_at), so that L22's "AYA is paused until it's
 * signed" is true whatever the answer gate reads, and so signing lifts only
 * that pause and never one the practice set itself.
 *
 * Since drizzle/0098 a practice under an older version of the BAA re-signs
 * the current one through the same row, link, screen and reminders
 * (`baa_version`). That re-sign never pauses AYA (owner, 19 October 2026):
 * the version signed governs until the newer one is, so its `paused_at` is
 * always NULL (agreement_resigns_baa_version_unpaused_check), and 0088's
 * guard still fixes `paused_at` once a row is written.
 *
 * Contract metadata, never a patient: no BAA gate. Tenant RLS on the clinic
 * that recorded the answer; the hourly job walks open rows through a SECURITY
 * DEFINER function that answers ids only (0088). Destruction keeps it: it is
 * part of the record of which agreement covered the practice, and when.
 */
export const agreementResigns = pgTable(
  "agreement_resigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /**
     * The agreement in force when the re-sign began, which the BAA is to
     * replace: the DPA, or for `baa_version` the older BAA.
     */
    fromAgreementId: uuid("from_agreement_id")
      .notNull()
      .references(() => baaAcceptances.id),
    reason: text("reason").$type<AgreementResignReason>().notNull(),
    source: text("source").$type<AgreementResignSource>().notNull(),
    /** The operator's address, or the device whose passkey stepped up. A snapshot. */
    requestedBy: text("requested_by").notNull(),
    status: text("status").$type<AgreementResignStatus>().notNull().default("open"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** The pause this re-sign put on AYA, or null when she was already paused or nothing answered. */
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    /**
     * Each pause the opening put in force, or extended, at a clinic of the
     * organisation, its own included (drizzle/0102): `[{ clinicId, pausedAt,
     * until }]`, `until` being the end a location's own timed pause had before
     * the re-sign made it indefinite. Signing or withdrawing gives back
     * exactly those and never a pause set there otherwise.
     */
    heldPauses: jsonb("held_pauses")
      .$type<{ clinicId: string; pausedAt: string; until: string | null }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    supersedingAgreementId: uuid("superseding_agreement_id").references(() => baaAcceptances.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Who closed it: the signatory's address, or the operator who withdrew it. */
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    // One open re-sign per clinic: "Not sure" after "Yes" is the same re-sign.
    uniqueIndex("agreement_resigns_open_idx")
      .on(t.clinicId)
      .where(sql`${t.status} = 'open'`),
    index("agreement_resigns_clinic_idx").on(t.clinicId, t.startedAt),
    check(
      "agreement_resigns_status_check",
      sql`${t.status} in (${sqlList(AGREEMENT_RESIGN_STATUSES)})`,
    ),
    check(
      "agreement_resigns_reason_check",
      sql`${t.reason} in (${sqlList(AGREEMENT_RESIGN_REASONS)})`,
    ),
    check(
      "agreement_resigns_source_check",
      sql`${t.source} in (${sqlList(AGREEMENT_RESIGN_SOURCES)})`,
    ),
    check(
      "agreement_resigns_requested_by_check",
      sql`char_length(${t.requestedBy}) between 1 and 200`,
    ),
    check(
      "agreement_resigns_resolved_by_check",
      sql`${t.resolvedBy} is null or char_length(${t.resolvedBy}) between 1 and 254`,
    ),
    check(
      "agreement_resigns_resolved_check",
      sql`(${t.status} = 'open') = (${t.resolvedAt} is null) and (${t.resolvedAt} is null) = (${t.resolvedBy} is null)`,
    ),
    check(
      "agreement_resigns_signed_check",
      sql`(${t.status} = 'signed') = (${t.signedAt} is not null and ${t.supersedingAgreementId} is not null)`,
    ),
    // A newer BAA over an older one never pauses AYA (owner, 19 October 2026).
    check(
      "agreement_resigns_baa_version_unpaused_check",
      sql`${t.reason} <> 'baa_version' or (${t.pausedAt} is null and ${t.heldPauses} = '[]'::jsonb)`,
    ),
    check("agreement_resigns_held_pauses_check", sql`jsonb_typeof(${t.heldPauses}) = 'array'`),
  ],
);

export type AgreementResign = typeof agreementResigns.$inferSelect;

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
 * clinics has gone live, a passkey step-up on this session, a code from the
 * authenticator app or a backup code, the human route's one-time link
 * (`recovery`, device_recoveries), or the browser that paid, within its seven
 * days, adding the sign-in's first passkey ever (`paying_browser`,
 * lib/sign-in/paying-browser.ts).
 */
export const PASSKEY_ENROL_BASES = [
  "first_passkey",
  "step_up",
  "code",
  "recovery",
  "paying_browser",
] as const;
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

/**
 * The human route for a clinic that has lost every device (plan Part D3,
 * "Lost every device"; drizzle/0095): after the operator has called the
 * practice back on its published number and entered a fresh code from the
 * operator's authenticator on apps/web, the ops operation
 * issueDeviceRecovery mints one of these and emails its link to the
 * clinic's address on file, and nowhere else (lib/factors/recovery.ts).
 *
 * One row is one basis for one passkey, and it can be spent once, by one
 * session, inside its window:
 *
 *   - **issued**: `token_hash` is SHA-256 of the link's token, never the
 *     token; `address_hash` is SHA-256 of the sign-in address it was mailed
 *     to (app_address_hash), checked again at claim and at use, so a link
 *     sent before the address moved adds nothing after. The database sets
 *     `created_at` and `expires_at`, DEVICE_RECOVERY_TTL_HOURS later, on
 *     INSERT (a trigger), and a row always arrives unclaimed;
 *   - **claimed**: the link was used. `claimed_at` is set first, by one
 *     conditional UPDATE, before any session exists, so a losing claim
 *     signs nobody in; then `session_token_hash`, once, names the session
 *     the winner started, so only that browser can use what it allows;
 *   - **used**: that session added one passkey (`used_at`, `factor_id`), in
 *     the same transaction as the passkey, and nothing more;
 *   - **revoked**: ended unused, by a newer link, the clinic's "Someone
 *     left", or the operator's removal.
 *
 * At most one is open (unused and unrevoked) per sign-in, by a partial
 * unique index; issuing a new one revokes the last. `landing` is the portal
 * path the link lands on, the Protect page of the clinic whose number was
 * called.
 *
 * Identity plane, like user_factors and sign_in_links: a passkey belongs to
 * the sign-in, not to a clinic, so no clinic_id and no RLS; the clinic is
 * named in the security events and in `landing`. The runtime role may move
 * only the claim, the use and the end, never DELETE, and a trigger freezes
 * what was issued and a row once it is used or revoked. Kept: each row is
 * the record that a device was added on our word, after a call.
 */
export const deviceRecoveries = pgTable(
  "device_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    /** SHA-256 of the sign-in's address when the link was mailed to it (app_address_hash). */
    addressHash: bytea("address_hash").notNull(),
    /** Where the link lands: `/c/<slug>/protect`. A path on this app, like sign_in_links.redirect_to. */
    landing: text("landing").notNull(),
    /** The operator's address, as a snapshot. */
    issuedBy: text("issued_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** SHA-256 of the Better Auth session token the link started, never the token. */
    sessionTokenHash: bytea("session_token_hash"),
    usedAt: timestamp("used_at", { withTimezone: true }),
    factorId: uuid("factor_id").references(() => userFactors.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason").$type<DeviceRecoveryRevokeReason>(),
  },
  (t) => [
    uniqueIndex("device_recoveries_token_hash_idx").on(t.tokenHash),
    uniqueIndex("device_recoveries_one_open_idx")
      .on(t.userId)
      .where(sql`${t.usedAt} is null and ${t.revokedAt} is null`),
    index("device_recoveries_user_idx").on(t.userId, t.createdAt),
    index("device_recoveries_session_idx")
      .on(t.sessionTokenHash)
      .where(sql`${t.sessionTokenHash} is not null`),
    check("device_recoveries_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check("device_recoveries_address_hash_length", sql`octet_length(${t.addressHash}) = 32`),
    check(
      "device_recoveries_session_hash_length",
      sql`${t.sessionTokenHash} is null or octet_length(${t.sessionTokenHash}) = 32`,
    ),
    check(
      "device_recoveries_landing_check",
      sql`${t.landing} like '/c/%/protect' and ${t.landing} not like '//%' and ${t.landing} !~ '[\\\\[:cntrl:][:space:]]' and char_length(${t.landing}) <= 200`,
    ),
    check(
      "device_recoveries_issued_by_check",
      sql`char_length(${t.issuedBy}) between 1 and 200`,
    ),
    check(
      "device_recoveries_window_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '${sql.raw(String(DEVICE_RECOVERY_TTL_HOURS))} hours'`,
    ),
    check(
      "device_recoveries_claim_check",
      sql`${t.sessionTokenHash} is null or ${t.claimedAt} is not null`,
    ),
    check(
      "device_recoveries_use_check",
      sql`${t.usedAt} is null or ${t.sessionTokenHash} is not null`,
    ),
    check(
      "device_recoveries_factor_check",
      sql`${t.factorId} is null or ${t.usedAt} is not null`,
    ),
    check(
      "device_recoveries_revoked_check",
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null) and (${t.revokedAt} is null or ${t.usedAt} is null) and (${t.revokedReason} is null or ${t.revokedReason} in (${sqlList(DEVICE_RECOVERY_REVOKE_REASONS)}))`,
    ),
  ],
);

export type DeviceRecovery = typeof deviceRecoveries.$inferSelect;

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
 * location set up at signing, and only as the first row under its agreement
 * (drizzle/0100); a released document and a booking sync as the
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
    // An agreement row is a released, signed document nobody had to
    // confirm. It is the first row under its agreement, which the guard
    // checks (drizzle/0100): a location's first terms at provisioning, and
    // its terms under the agreement that superseded the one before
    // (recordSupersedingTerms), so not always sequence 1.
    check(
      "calendar_elections_agreement_shape",
      sql`${t.source} <> 'agreement' or (${t.documentReleased} and not ${t.ownerConfirmed})`,
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
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
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

// -----------------------------------------------------------------------------
// The practice questions (plan Part G; spec, "The pre-launch audit")
// -----------------------------------------------------------------------------

/**
 * One run of a clinic's practice questions: the spec's nine cases, and the
 * disclosure line, templated from its own profile and asked of every channel
 * it bought, through the brain each channel answers with
 * (lib/engine/practice). A run is asked for by a change to what the cases
 * read and waits two minutes without another (`run_after`, moved on by each
 * change while it is queued); the job claims it under a lease, one at a time
 * per clinic, which the two partial unique indexes hold.
 *
 * `agent_version` is agent_configs.version as the run read it, and a pass
 * approves that version and no other; `input_version` the hash of
 * everything the cases read (the knowledge, the settings, the case set),
 * which tells a run whose inputs changed while it ran (`superseded`).
 * `failed_section` and `failed_count` are what O9 names when a case failed
 * on the clinic's own data. `override_label` is an operator's approval of
 * the script recorded as a passed run with no cases (ops approveAgentConfig),
 * retired on 19 October 2026: kept on the rows it named, and never read as a
 * run of the questions (drizzle/0097).
 *
 * Synthetic: no patient is in any run, and nothing here is PHI. Tenant RLS,
 * forced; the runtime role may read, add and move a run on, never delete
 * one. Kept at destruction, beside agent_configs: the record of what
 * approved the words AYA said for the clinic.
 */
export const practiceQuestionRuns = pgTable(
  "practice_question_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    status: text("status").$type<PracticeRunStatus>().notNull().default("queued"),
    reason: text("reason").$type<PracticeRunReason>().notNull(),
    /** The Knowledge section whose save asked for it, when one did: what Home's "double-checking" line names. */
    triggerSection: text("trigger_section").$type<PracticeSection>(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Not before: two minutes after the last change that asked for it. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    /** While running: the job's lease, after which another run of the job may take it over. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    agentVersion: integer("agent_version"),
    casesVersion: text("cases_version"),
    inputVersion: text("input_version"),
    failedSection: text("failed_section").$type<PracticeSection>(),
    failedCount: integer("failed_count"),
    /** The agent_configs version this pass approved; null when it approved nothing new. */
    approvedVersion: integer("approved_version"),
    overrideLabel: text("override_label"),
    /** Why the last attempt could not finish: a category, never the model's words. */
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("practice_question_runs_queued_idx").on(t.clinicId).where(sql`${t.status} = 'queued'`),
    uniqueIndex("practice_question_runs_running_idx").on(t.clinicId).where(sql`${t.status} = 'running'`),
    // The target of the results' and reviews' composite foreign keys, so a
    // result or a review can only belong to a run of its own clinic.
    unique("practice_question_runs_clinic_run_key").on(t.clinicId, t.id),
    index("practice_question_runs_clinic_idx").on(t.clinicId, t.requestedAt),
    check("practice_question_runs_status_check", sql`${t.status} in (${sqlList(PRACTICE_RUN_STATUSES)})`),
    check("practice_question_runs_reason_check", sql`${t.reason} in (${sqlList(PRACTICE_RUN_REASONS)})`),
    check(
      "practice_question_runs_trigger_section_check",
      sql`${t.triggerSection} is null or ${t.triggerSection} in (${sqlList(PRACTICE_SECTIONS)})`,
    ),
    check(
      "practice_question_runs_failed_section_check",
      sql`${t.failedSection} is null or ${t.failedSection} in (${sqlList(PRACTICE_SECTIONS)})`,
    ),
    check("practice_question_runs_attempts_check", sql`${t.attempts} >= 0`),
    check("practice_question_runs_failed_count_check", sql`${t.failedCount} is null or ${t.failedCount} >= 0`),
    check(
      "practice_question_runs_input_version_check",
      sql`${t.inputVersion} is null or ${t.inputVersion} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "practice_question_runs_cases_version_check",
      sql`${t.casesVersion} is null or ${t.casesVersion} ~ '^[a-z0-9.-]{1,32}$'`,
    ),
    check("practice_question_runs_last_error_check", sql`${t.lastError} is null or ${t.lastError} ~ '^[a-z0-9_]{1,64}$'`),
    check(
      "practice_question_runs_override_check",
      sql`${t.overrideLabel} is null or (${t.reason} = 'override' and ${t.status} = 'passed' and char_length(${t.overrideLabel}) between 1 and 200)`,
    ),
  ],
);

export type PracticeQuestionRun = typeof practiceQuestionRuns.$inferSelect;

/**
 * One channel's result within a run, at the input version that channel read:
 * the cases, what the synthetic person said, what AYA answered on that
 * channel, and what the checks and the judge made of it. Kept per channel
 * and per audit-input version (plan Part G), so a later run whose inputs for
 * a channel are unchanged reuses that channel's pass instead of asking the
 * model again (`reused`).
 *
 * Synthetic, so no PHI. Tenant RLS, forced; the runtime role adds a result
 * and moves its status on once a review decides it, and changes nothing else.
 */
export const practiceQuestionResults = pgTable(
  "practice_question_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    channel: text("channel").$type<Channel>().notNull(),
    inputVersion: text("input_version").notNull(),
    status: text("status").$type<PracticeResultStatus>().notNull(),
    cases: jsonb("cases").$type<PracticeCaseResult[]>().notNull(),
    /** Copied from an earlier pass at the same input version, so the model was not asked again. */
    reused: boolean("reused").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("practice_question_results_run_channel_idx").on(t.runId, t.channel),
    index("practice_question_results_version_idx").on(t.clinicId, t.channel, t.inputVersion),
    foreignKey({
      name: "practice_question_results_run_fk",
      columns: [t.clinicId, t.runId],
      foreignColumns: [practiceQuestionRuns.clinicId, practiceQuestionRuns.id],
    }).onDelete("cascade"),
    check("practice_question_results_channel_check", sql`${t.channel} in (${sqlList(CHANNELS)})`),
    check(
      "practice_question_results_status_check",
      sql`${t.status} in (${sqlList(PRACTICE_RESULT_STATUSES)})`,
    ),
    check(
      "practice_question_results_input_version_check",
      sql`${t.inputVersion} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type PracticeQuestionResult = typeof practiceQuestionResults.$inferSelect;

/**
 * The audit review queue (plan Part G, Part K): a run whose judge failed a
 * case, or whose check failed on our side, waits here for a person at
 * healdesk, who decides it by `due_on`, the next business day, which is the
 * date the clinic's tracker shows ("Being checked by our team; ready by …").
 * A decision passes the run (and approves its script) or fails it; a later
 * run supersedes an open one. A review still open after `due_at` raises
 * `practice_question_review_past_due` once (`past_due_alerted_at`).
 *
 * Ops-only: read and decided through the ops envelope (/admin/reviews), never
 * by the portal. No PHI: the cases are synthetic. Tenant RLS, forced; never
 * deleted, kept at destruction with its run.
 */
export const auditReviewQueue = pgTable(
  "audit_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /**
     * What the review is about (AUDIT_REVIEW_KINDS): a practice-questions
     * run, or the agreement-kind signal (WP9, drizzle/0088), which has no run.
     */
    kind: text("kind").$type<AuditReviewKind>().notNull().default("practice_questions"),
    /** The run reviewed; null exactly when the review is not about one. */
    runId: uuid("run_id"),
    status: text("status").$type<AuditReviewStatus>().notNull().default("open"),
    /** The day promised to the clinic, in New York: the next business day after the review opened. */
    dueOn: date("due_on", { mode: "string" }).notNull(),
    /** The end of `due_on` in New York: past it, an open review alerts ops. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    pastDueAlertedAt: timestamp("past_due_alerted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The operator's address, as the ops envelope's environment names them. */
    decidedByLabel: text("decided_by_label"),
    /** A failed review that is the clinic's to fix: the section O9 named. */
    section: text("section").$type<PracticeSection>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("audit_review_queue_run_idx").on(t.runId),
    index("audit_review_queue_open_idx").on(t.clinicId, t.dueAt).where(sql`${t.status} = 'open'`),
    foreignKey({
      name: "audit_review_queue_run_fk",
      columns: [t.clinicId, t.runId],
      foreignColumns: [practiceQuestionRuns.clinicId, practiceQuestionRuns.id],
    }).onDelete("cascade"),
    check("audit_review_queue_status_check", sql`${t.status} in (${sqlList(AUDIT_REVIEW_STATUSES)})`),
    check("audit_review_queue_kind_check", sql`${t.kind} in (${sqlList(AUDIT_REVIEW_KINDS)})`),
    // A practice-questions review names its run; the agreement-kind signal has none.
    check(
      "audit_review_queue_run_check",
      sql`(${t.kind} = 'practice_questions') = (${t.runId} is not null)`,
    ),
    // One open agreement-kind review per clinic: the signal is about the
    // practice, not about a run, so a second read of the same site adds nothing.
    uniqueIndex("audit_review_queue_agreement_open_idx")
      .on(t.clinicId)
      .where(sql`${t.kind} = 'agreement_kind' and ${t.status} = 'open'`),
    check(
      "audit_review_queue_section_check",
      sql`${t.section} is null or (${t.status} = 'failed' and ${t.section} in (${sqlList(PRACTICE_SECTIONS)}))`,
    ),
    check(
      "audit_review_queue_decided_check",
      sql`(${t.status} in ('open', 'superseded')) = (${t.decidedAt} is null) and (${t.decidedAt} is null) = (${t.decidedByLabel} is null)`,
    ),
    check(
      "audit_review_queue_decided_by_check",
      sql`${t.decidedByLabel} is null or char_length(${t.decidedByLabel}) between 1 and 200`,
    ),
  ],
);

export type AuditReviewRow = typeof auditReviewQueue.$inferSelect;

/**
 * Tables carrying a clinic_id, and therefore requiring RLS. Held to the catalog
 * by tests/rls-drift.test.ts, which fails on a table on one side only.
 */
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
  "sign_in_address_changes",
  "practice_question_runs",
  "practice_question_results",
  "audit_review_queue",
  "agreement_resigns",
  "site_rereads",
  "website_changes",
  "transcript_emails",
  "handovers",
  "conversation_flags",
  "patient_requests",
  "incident_affected_contacts",
  "retell_recording_alerts",
  "voice_agents",
  "voice_redial_contexts",
  "clinic_locations",
  "location_acknowledgements",
  // Ops automation lane B (drizzle/0114).
  "clinic_change_events",
  "clinic_audits",
  "clinic_audit_claims",
  "clinic_lifecycle",
  "lifecycle_waves",
  // Ops automation lane P5d (drizzle/0118).
  "lifecycle_ignored_clinics",
  // Ops automation lane P6c (drizzle/0120).
  "rights_intakes",
  // Ops automation lane P6i (drizzle/0124).
  "incident_checklist_ticks",
  // Gate B, the routed/answered counter and its workflows (drizzle/0139).
  "routed_interactions",
  "answer_outages",
  "miss_cases",
  "missed_contacts",
  // The payment-link text's ledger (drizzle/0141).
  "payment_link_texts",
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

// -----------------------------------------------------------------------------
// Flag this answer (spec, "When the agent gets something wrong"; plan Part F4)
// -----------------------------------------------------------------------------

/** Where a flagged conversation is held: a call's or web chat's row, or a Meta thread. */
export const CONVERSATION_FLAG_SOURCES = ["call_or_chat", "meta_thread"] as const;
export type ConversationFlagSource = (typeof CONVERSATION_FLAG_SOURCES)[number];

/**
 * A staff member's "Flag this answer" on one conversation: the clinic says
 * AYA got something wrong there. One per conversation. It opens an ops ticket
 * (I4, lib/ops/flag-alert.ts: ids and counts only), and two flags from one
 * clinic in seven days make that ticket an alert. It may carry a correction,
 * typed by staff and screened as Knowledge screens a quick answer, which is
 * written into the clinic's quick answers at once, tagged with this flag's id
 * (KnowledgeAnswer.flagId), so the Flagged view can say whether it is still
 * live. The correction's words live there, in the clinic's knowledge, and
 * never here; nothing of the conversation's words is anywhere, since none is
 * kept.
 *
 * It points at the conversation the portal shows: a call's or web chat's row
 * (`conversation_id`, against conversations' (clinic_id, id) key), or a Meta
 * thread's current conversation (`thread_conversation_id`, with the thread's
 * channel and keyed party reference against chat_threads' key), and records
 * that conversation's channel, outcome and start, so the Flagged view can
 * list a Meta conversation its thread has since moved on from. Either way it
 * goes with what it points at, through the foreign key's cascade: an erasure,
 * the record clock or a quiet thread's purge, and destruction, which also
 * deletes it first and checks (drizzle/0093).
 *
 * PHI-adjacent, since it marks a patient's conversation: tenant RLS, forced,
 * and the BAA gate. `flagged_at` and `corrected_at` are the database's clock
 * (a trigger), so the seven-day count cannot be moved; the runtime role may
 * change only `corrected_at`, once, from none.
 */
export const conversationFlags = pgTable(
  "conversation_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    source: text("source").$type<ConversationFlagSource>().notNull(),
    /** A call's or web chat's conversations row. */
    conversationId: uuid("conversation_id"),
    /** A Meta thread's conversation id, as Conversations shows it (chat_threads.conversation_id). */
    threadConversationId: uuid("thread_conversation_id"),
    /** The Meta thread's keyed party reference (chat_threads.party_ref), the thread's key with `channel`. */
    threadPartyRef: text("thread_party_ref"),
    /** The channel as Conversations names it (lib/portal/conversation-words.ts). */
    channel: text("channel").$type<ConversationChannel>().notNull(),
    /** The conversation's outcome when it was flagged; null for a Meta thread with none stored. */
    outcome: text("outcome").$type<ConversationOutcome>(),
    /** When the flagged conversation started. */
    conversationStartedAt: timestamp("conversation_started_at", { withTimezone: true }).notNull(),
    flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** When staff's correction went into the quick answers; null while none has. */
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("conversation_flags_conversation_idx")
      .on(t.clinicId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    uniqueIndex("conversation_flags_thread_conversation_idx")
      .on(t.clinicId, t.threadConversationId)
      .where(sql`${t.threadConversationId} is not null`),
    index("conversation_flags_flagged_idx").on(t.clinicId, t.flaggedAt),
    // Composite, so a flag can only point at its own clinic's records; it
    // goes when they go.
    foreignKey({
      name: "conversation_flags_conversation_fk",
      columns: [t.clinicId, t.conversationId],
      foreignColumns: [conversations.clinicId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "conversation_flags_thread_fk",
      columns: [t.clinicId, t.channel, t.threadPartyRef],
      foreignColumns: [chatThreads.clinicId, chatThreads.channel, chatThreads.partyRef],
    }).onDelete("cascade"),
    check("conversation_flags_source_check", sql`${t.source} in (${sqlList(CONVERSATION_FLAG_SOURCES)})`),
    check(
      "conversation_flags_target_check",
      sql`(${t.source} = 'call_or_chat' and ${t.conversationId} is not null and ${t.threadConversationId} is null and ${t.threadPartyRef} is null)
        or (${t.source} = 'meta_thread' and ${t.conversationId} is null and ${t.threadConversationId} is not null and ${t.threadPartyRef} is not null
            and ${t.channel} in ('instagram', 'messenger', 'whatsapp'))`,
    ),
    check(
      "conversation_flags_channel_check",
      sql`${t.channel} in (${sqlList(Object.keys(CHANNEL_NAMES))})`,
    ),
    check(
      "conversation_flags_outcome_check",
      sql`${t.outcome} is null or ${t.outcome} in (${sqlList(CONVERSATION_OUTCOMES)})`,
    ),
    check(
      "conversation_flags_party_ref_check",
      sql`${t.threadPartyRef} is null or char_length(${t.threadPartyRef}) between 1 and 200`,
    ),
  ],
);

export type ConversationFlagRow = typeof conversationFlags.$inferSelect;

// -----------------------------------------------------------------------------
// The signed website re-reads and the drift list (plan Part B, "Re-reads";
// Part F3, "Changes on your website")
// -----------------------------------------------------------------------------

/**
 * One read of a clinic's website after purchase, asked of apps/web's signed
 * route (/api/clinic-site), which fetches and extracts off the PHI host and
 * stores nothing (lib/website). Asked for when a clinic has a website and no
 * profile (`missing`), when it corrects its website (`corrected`), by the
 * monthly drift check (`drift`), or by an operator (`ops`); claimed by the
 * site-reads job under a lease, one at a time per clinic, which the two
 * partial unique indexes hold. A queued read asked for again is moved on
 * rather than doubled.
 *
 * `website` is the address read, the clinic's own public website; `changes`
 * how many changes the read raised on the drift list. What came back is not
 * kept here: a missing or corrected read becomes clinics.site_profile, the
 * baseline, and a drift read leaves only its changes.
 *
 * Business data, never a patient's: no BAA gate. Tenant RLS, forced; the
 * runtime role may read, add and move a read on, never delete one. Kept at
 * destruction, beside agent_configs.
 */
export const siteRereads = pgTable(
  "site_rereads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    reason: text("reason").$type<SiteRereadReason>().notNull(),
    status: text("status").$type<SiteRereadStatus>().notNull().default("queued"),
    /** The website read: host and path, without the scheme (catalog `cleanWebsite`). */
    website: text("website").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Not before: now when asked for, later after a failure worth retrying. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    /** While running: the job's lease, after which another run of the job may take it over. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Why the last attempt brought no profile back: a category, never apps/web's words. */
    failure: text("failure").$type<SiteRereadFailure>(),
    /** How many changes the read raised on the drift list; null until it was read. */
    changes: integer("changes"),
  },
  (t) => [
    uniqueIndex("site_rereads_queued_idx").on(t.clinicId).where(sql`${t.status} = 'queued'`),
    uniqueIndex("site_rereads_running_idx").on(t.clinicId).where(sql`${t.status} = 'running'`),
    // The target of the changes' composite foreign key, so a change can only
    // name a read of its own clinic.
    unique("site_rereads_clinic_read_key").on(t.clinicId, t.id),
    index("site_rereads_clinic_idx").on(t.clinicId, t.requestedAt),
    check("site_rereads_reason_check", sql`${t.reason} in (${sqlList(SITE_REREAD_REASONS)})`),
    check("site_rereads_status_check", sql`${t.status} in (${sqlList(SITE_REREAD_STATUSES)})`),
    check(
      "site_rereads_failure_check",
      sql`${t.failure} is null or ${t.failure} in (${sqlList(SITE_REREAD_FAILURES)})`,
    ),
    check(
      "site_rereads_website_check",
      sql`char_length(${t.website}) between 4 and 200 and ${t.website} !~ '[[:space:][:cntrl:]]'`,
    ),
    check("site_rereads_attempts_check", sql`${t.attempts} >= 0`),
    check("site_rereads_changes_check", sql`${t.changes} is null or ${t.changes} >= 0`),
    // A finished read has its time, and only a finished read.
    check(
      "site_rereads_finished_check",
      sql`(${t.status} in ('read', 'failed', 'superseded')) = (${t.finishedAt} is not null)`,
    ),
  ],
);

export type SiteReread = typeof siteRereads.$inferSelect;

/**
 * One change a re-read found on a clinic's website against its baseline,
 * clinics.site_profile, the profile read at purchase (plan Part B): a
 * service, an hour, a policy, a question and its answer, a provider, or the
 * location's address or phone, per Knowledge section, that the website now
 * lists, no longer lists, or states differently. Screened like the purchase
 * read (screenClinicProfile), and raised only when Knowledge does not
 * already say the same.
 *
 * The clinic confirms each one, which applies it into Knowledge through the
 * knowledge writers, or ignores it. `fingerprint` is the hash of the section,
 * the kind, the item and what the website now says, one row per clinic, so
 * an ignored change is remembered and never raised again, and a later read
 * that no longer finds a waiting one marks it `superseded` until it comes
 * back. `before` and `after` are the item as the baseline and the new read
 * have it: the clinic's own published business data, never a patient's.
 *
 * Tenant RLS, forced; the runtime role may read, add and move a change's
 * state on, never delete one. Kept at destruction with its read.
 */
export const websiteChanges = pgTable(
  "website_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** The read that last found it. */
    rereadId: uuid("reread_id").notNull(),
    section: text("section").$type<WebsiteChangeSection>().notNull(),
    kind: text("kind").$type<WebsiteChangeKind>().notNull(),
    /** Which item within the section: a service's or a provider's name, a question, a policy, "weekly", "address" or "phone", lower-cased. */
    itemKey: text("item_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    state: text("state").$type<WebsiteChangeState>().notNull().default("new"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The device whose session decided it, as the portal labels the actor. */
    decidedByLabel: text("decided_by_label"),
  },
  (t) => [
    uniqueIndex("website_changes_fingerprint_idx").on(t.clinicId, t.fingerprint),
    index("website_changes_new_idx").on(t.clinicId, t.detectedAt).where(sql`${t.state} = 'new'`),
    foreignKey({
      name: "website_changes_reread_fk",
      columns: [t.clinicId, t.rereadId],
      foreignColumns: [siteRereads.clinicId, siteRereads.id],
    }).onDelete("cascade"),
    check("website_changes_section_check", sql`${t.section} in (${sqlList(WEBSITE_CHANGE_SECTIONS)})`),
    check("website_changes_kind_check", sql`${t.kind} in (${sqlList(WEBSITE_CHANGE_KINDS)})`),
    check("website_changes_state_check", sql`${t.state} in (${sqlList(WEBSITE_CHANGE_STATES)})`),
    check("website_changes_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check(
      "website_changes_item_key_check",
      sql`char_length(${t.itemKey}) between 1 and 300 and ${t.itemKey} !~ '[[:cntrl:]]'`,
    ),
    // What each kind carries: an addition has no before, a removal no after.
    check(
      "website_changes_values_check",
      sql`(${t.kind} = 'added' and ${t.before} is null and ${t.after} is not null) or (${t.kind} = 'removed' and ${t.before} is not null and ${t.after} is null) or (${t.kind} = 'changed' and ${t.before} is not null and ${t.after} is not null)`,
    ),
    check(
      "website_changes_decided_check",
      sql`(${t.state} in ('confirmed', 'ignored')) = (${t.decidedAt} is not null) and (${t.decidedAt} is null) = (${t.decidedByLabel} is null)`,
    ),
    check(
      "website_changes_decided_by_check",
      sql`${t.decidedByLabel} is null or char_length(${t.decidedByLabel}) between 1 and 200`,
    ),
  ],
);

export type WebsiteChangeRow = typeof websiteChanges.$inferSelect;

// -----------------------------------------------------------------------------
// Platform compliance (WP2: automatic go-live; plan Part J, Part K and Gate B)
// -----------------------------------------------------------------------------

/**
 * What an operator has attested about the platform: each vendor's business
 * associate agreement in the chain (the model provider, the database host,
 * AWS, and Retell for phone) and Gate B's readiness flags
 * (lib/compliance/subjects.ts). Go-live, which is automatic, and each
 * channel's `live` read the latest row per subject (drizzle/0090,
 * app_platform_attested): a subject counts while its latest row attests it
 * and has not lapsed (`expires_on`, a UTC date).
 *
 * Ops-only and platform-wide: no clinic_id, because nothing here is about a
 * clinic, and no patient data, because nothing here is about a person but
 * the operator who attested. Append-only for the runtime role, which reads
 * and inserts and never rewrites: a withdrawal is a row of its own, so the
 * record of what was attested, by whom, on what document and when, stays.
 * Written only from the ops envelope, outside any tenant (a trigger refuses
 * an insert made inside one), entered on /admin with the operator's fresh
 * authenticator code (apps/web lib/admin/fresh-code.ts).
 */
export const platformCompliance = pgTable(
  "platform_compliance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: text("subject").$type<PlatformSubject>().notNull(),
    action: text("action").$type<PlatformAction>().notNull(),
    /**
     * Where the document is kept, or what the check was: "AWS BAA, AWS
     * Artifact, account agreements"; never a copy of it. On a withdrawal,
     * why.
     */
    documentRef: text("document_ref").notNull(),
    /** The day the document took effect or the check was made (UTC). */
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    /** The day the attestation lapses, if it does (UTC). Only on an attestation. */
    expiresOn: date("expires_on", { mode: "string" }),
    /** The operator, from the ops envelope's environment, never the request. */
    actorLabel: text("actor_label").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index("platform_compliance_subject_idx").on(t.subject, t.recordedAt),
    check("platform_compliance_subject_check", sql`${t.subject} in (${sqlList(PLATFORM_SUBJECTS)})`),
    check("platform_compliance_action_check", sql`${t.action} in (${sqlList(PLATFORM_ACTIONS)})`),
    check(
      "platform_compliance_document_ref_check",
      sql`char_length(${t.documentRef}) between 1 and ${sql.raw(String(DOCUMENT_REF_MAX))} and ${t.documentRef} !~ '[[:cntrl:]]'`,
    ),
    check(
      "platform_compliance_expires_check",
      sql`${t.expiresOn} is null or (${t.action} = 'attested' and ${t.expiresOn} >= ${t.effectiveOn})`,
    ),
    check(
      "platform_compliance_actor_check",
      sql`char_length(${t.actorLabel}) between 1 and 200`,
    ),
  ],
);

export type PlatformComplianceRow = typeof platformCompliance.$inferSelect;

// -----------------------------------------------------------------------------
// Handovers  ⚠️ PHI by what they point at
// -----------------------------------------------------------------------------

/** The channels a person can ask AYA for a person on. */
export type HandoverChannel = "voice" | "web_chat" | "meta";
export type HandoverPlatform = "instagram" | "messenger" | "whatsapp";

/**
 * Someone asked AYA for a person (alert L11; spec, "Every switch in the
 * portal": Handover requests, "Where 'I want to speak to a person' goes"),
 * kept so Bookings can list it under Needs you until the desk marks it
 * handled (plan Part F5: "open handovers"). lib/handovers/record.ts is its
 * one writer, in the transaction that queues the alert.
 *
 * It holds no words and no identity of its own: only which conversation it
 * was asked in, so the person is reached, kept and erased through that
 * conversation, and for a web chat the number the visitor gave for the call
 * back. A call or web chat points at its conversation and goes with
 * it by the foreign key's cascade (a call's row is written when the call
 * ends, so a call's handover carries the vendor's call id until then and
 * the database links it, drizzle/0092). A Meta thread points at its
 * chat_threads row, the keyed hash of who wrote, and goes with that.
 * Nothing the Meta screen refused is ever behind one: the front door records
 * a handover only from the model's answer, which a screened message never
 * reaches. The record clock deletes what outlives both (lib/retention/purge.ts).
 */
export const handovers = pgTable(
  "handovers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** Which location of the account (locationColumn): the main one unless a writer names another. */
    locationId: locationColumn(),
    channel: text("channel").$type<HandoverChannel>().notNull(),
    /** Meta only: which of the three. */
    platform: text("platform").$type<HandoverPlatform>(),
    /** Voice only: the vendor's call id, which the call's conversation will carry. */
    externalCallId: text("external_call_id"),
    /** The call's or web chat's conversation. A call's is set when its row is written. */
    conversationId: uuid("conversation_id"),
    /** Meta only: the keyed reference to who wrote (chat_threads.party_ref). */
    partyRef: text("party_ref"),
    /** Meta only: the thread's conversation (chat_threads.conversation_id), once per which. */
    metaConversationId: uuid("meta_conversation_id"),
    /**
     * Web chat only: the number the visitor gave so the desk can call back
     * (E.164), and the first name with it, set once. ⚠️ PHI. On the handover,
     * never as a contact: the number is whatever was typed, so a contact
     * would be found by every later lookup by that number and could take a
     * patient's call or booking; and never on the conversation, which a later
     * request in the chat may tie to someone else. Erasure by the number
     * deletes it (lib/patient-rights/erasure.ts).
     */
    callbackPhone: text("callback_phone"),
    callbackFirstName: text("callback_first_name"),
    /** When they asked: the database's clock at the insert. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** The desk marked it handled: the database's clock, once. */
    handledAt: timestamp("handled_at", { withTimezone: true }),
    /** Who: the device whose passkey stepped up, as staff named it. */
    handledByLabel: text("handled_by_label"),
    handledByUserId: text("handled_by_user_id"),
  },
  (t) => [
    index("handovers_clinic_idx").on(t.clinicId, t.createdAt),
    uniqueIndex("handovers_call_idx")
      .on(t.clinicId, t.externalCallId)
      .where(sql`${t.externalCallId} is not null`),
    uniqueIndex("handovers_conversation_idx")
      .on(t.clinicId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    uniqueIndex("handovers_meta_conversation_idx")
      .on(t.clinicId, t.metaConversationId)
      .where(sql`${t.metaConversationId} is not null`),
    index("handovers_thread_idx").on(t.clinicId, t.platform, t.partyRef),
    index("handovers_callback_idx").on(t.clinicId, t.callbackPhone).where(sql`${t.callbackPhone} is not null`),
    foreignKey({
      name: "handovers_conversation_fk",
      columns: [t.clinicId, t.conversationId],
      foreignColumns: [conversations.clinicId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "handovers_thread_fk",
      columns: [t.clinicId, t.platform, t.partyRef],
      foreignColumns: [chatThreads.clinicId, chatThreads.channel, chatThreads.partyRef],
    }).onDelete("cascade"),
    check(
      "handovers_shape_check",
      sql`(${t.channel} = 'voice' and ${t.externalCallId} is not null and ${t.platform} is null and ${t.partyRef} is null and ${t.metaConversationId} is null and ${t.callbackPhone} is null)
        or (${t.channel} = 'web_chat' and ${t.conversationId} is not null and ${t.externalCallId} is null and ${t.platform} is null and ${t.partyRef} is null and ${t.metaConversationId} is null)
        or (${t.channel} = 'meta' and ${t.platform} in ('instagram', 'messenger', 'whatsapp') and ${t.partyRef} is not null and ${t.metaConversationId} is not null and ${t.conversationId} is null and ${t.externalCallId} is null and ${t.callbackPhone} is null)`,
    ),
    check(
      "handovers_callback_check",
      sql`(${t.callbackPhone} is null or ${t.callbackPhone} ~ '^\\+[1-9][0-9]{6,14}$') and (${t.callbackFirstName} is null or (${t.callbackPhone} is not null and char_length(${t.callbackFirstName}) between 1 and 40))`,
    ),
    check(
      "handovers_call_id_check",
      sql`${t.externalCallId} is null or char_length(${t.externalCallId}) between 1 and 200`,
    ),
    check(
      "handovers_handled_check",
      sql`(${t.handledAt} is null) = (${t.handledByLabel} is null) and (${t.handledAt} is null) = (${t.handledByUserId} is null) and (${t.handledByLabel} is null or char_length(${t.handledByLabel}) between 1 and 200)`,
    ),
  ],
);

// -----------------------------------------------------------------------------
// Retell call data still held (NOAUDIO-01; reversed by the owner on 21 October 2026)
// -----------------------------------------------------------------------------

/**
 * One row per call whose data Retell still holds past the deletion window
 * (lib/voice/recording-alerts.ts, RETELL_DELETION_WINDOW_MS). Retell keeps
 * a call's transcript and recording until the call has ended; once our copy
 * is committed (the conversation and its sealed transcript, in one
 * transaction) the backstop job deletes the call at Retell. A row is
 * written only when that delete has not gone through in time, so the table
 * name is older than its meaning: a recording URL on a call is expected, not
 * an alert.
 *
 * An opaque alert: the clinic, Retell's call id and when, and the delete
 * bookkeeping: when Retell deleted the call (resolved_at), or the short
 * reason it did not (last_error, written by our code, never Retell's body).
 * No transcript, no number, no words, no URL.
 */
export const retellRecordingAlerts = pgTable(
  "retell_recording_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    retellCallId: text("retell_call_id").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** How many times Retell was asked to delete it since the alert, by the job or the operator. */
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** Why the last delete did not go, in our words; cleared when it does. */
    lastError: text("last_error"),
    /** Retell answered that the call is deleted, or that it has no such call. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("retell_recording_alerts_call_idx").on(t.clinicId, t.retellCallId),
    index("retell_recording_alerts_open_idx").on(t.clinicId, t.detectedAt).where(sql`${t.resolvedAt} is null`),
    check("retell_recording_alerts_call_id_check", sql`${t.retellCallId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    check("retell_recording_alerts_attempts_check", sql`${t.attempts} >= 0`),
    check(
      "retell_recording_alerts_error_check",
      sql`${t.lastError} is null or char_length(${t.lastError}) between 1 and 200`,
    ),
  ],
);

export type RetellRecordingAlertRow = typeof retellRecordingAlerts.$inferSelect;

// -----------------------------------------------------------------------------
// Each clinic's Retell agent and AYA number, written by code (21 October 2026)
// -----------------------------------------------------------------------------

/**
 * Which response engine a clinic's Retell agent runs (owner, 21 October
 * 2026): `custom`, our custom-LLM WebSocket endpoint (src/voice/server.ts),
 * the default and the only one built; `native`, Retell's own LLM, a later
 * package, which provisioning refuses with an honest reason until it exists
 * (docs/design/voice-native-llm-migration-2026-10-21.md).
 */
export const VOICE_ENGINES = ["custom", "native"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

/**
 * Where a clinic's Retell set-up stands (lib/voice/provision.ts):
 *   pending         owed and not started (or waiting on the daily cap)
 *   provisioning    a run is under way, or crashed part-way and will resume
 *   ready           agent and number exist, wired together, config recorded
 *   failed          stopped with a reason in our own words; retried by hand or by a later run
 *   deprovisioning  the clinic has left and its number and agent are being released
 *   released        number released and agent deleted at Retell
 */
export const VOICE_AGENT_STATUSES = [
  "pending",
  "provisioning",
  "ready",
  "failed",
  "deprovisioning",
  "released",
] as const;
export type VoiceAgentStatus = (typeof VOICE_AGENT_STATUSES)[number];

/**
 * One row per clinic that bought voice: Retell's ids for its agent (and,
 * under the native engine, its Retell LLM), the AYA number bought for it,
 * where the set-up stands, and a hash of the configuration last written to
 * Retell, so a settings change is written once and an unchanged one never.
 *
 * Business data about healdesk's own vendor set-up: no caller, no call, no
 * words. `last_error` is our own short reason, never Retell's body.
 * `number_ordered_at` is set before a number is bought, so a run that
 * crashed between buying and recording looks the number up by its nickname
 * instead of buying a second (lib/voice/provision.ts).
 */
export const voiceAgents = pgTable(
  "voice_agents",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),
    engine: text("engine").$type<VoiceEngine>().notNull().default("custom"),
    status: text("status").$type<VoiceAgentStatus>().notNull().default("pending"),
    retellAgentId: text("retell_agent_id"),
    retellLlmId: text("retell_llm_id"),
    phoneNumberE164: text("phone_number_e164"),
    /** sha256 hex of the configuration last written to Retell and read back as kept. */
    configHash: text("config_hash"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /** Why the last run stopped, in our words; cleared when one succeeds. */
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    /** Set just before a number is bought: the crash-safe marker and the daily cap's count. */
    numberOrderedAt: timestamp("number_ordered_at", { withTimezone: true }),
    /** Drift repairs since the last clean read-back; past the limit, flagged and left for a person. */
    driftRepairs: integer("drift_repairs").notNull().default(0),
    driftFlaggedAt: timestamp("drift_flagged_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    check("voice_agents_engine_check", sql`${t.engine} in (${sqlList(VOICE_ENGINES)})`),
    check("voice_agents_status_check", sql`${t.status} in (${sqlList(VOICE_AGENT_STATUSES)})`),
    check("voice_agents_agent_id_check", sql`${t.retellAgentId} is null or ${t.retellAgentId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    check("voice_agents_llm_id_check", sql`${t.retellLlmId} is null or ${t.retellLlmId} ~ '^[A-Za-z0-9_-]{1,128}$'`),
    check("voice_agents_number_check", sql`${t.phoneNumberE164} is null or ${t.phoneNumberE164} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check("voice_agents_hash_check", sql`${t.configHash} is null or ${t.configHash} ~ '^[0-9a-f]{64}$'`),
    check("voice_agents_error_check", sql`${t.lastError} is null or char_length(${t.lastError}) between 1 and 200`),
    check("voice_agents_attempts_check", sql`${t.attempts} >= 0 and ${t.driftRepairs} >= 0`),
    // Ready means wired: an agent and a number, and the configuration recorded.
    check(
      "voice_agents_ready_check",
      sql`${t.status} <> 'ready' or (${t.retellAgentId} is not null and ${t.phoneNumberE164} is not null and ${t.configHash} is not null)`,
    ),
    check("voice_agents_released_check", sql`(${t.status} = 'released') = (${t.releasedAt} is not null)`),
  ],
);

export type VoiceAgentRow = typeof voiceAgents.$inferSelect;

/**
 * How many AYA numbers were ordered from Retell on each UTC day, across every
 * clinic: the daily spend cap's counter (HEALDESK_VOICE_PROVISION_DAILY_CAP,
 * lib/voice/provision.ts). A day and a count, nothing else; no clinic_id,
 * because the cap is across tenants and a SECURITY DEFINER function does not
 * bypass a FORCEd policy (drizzle/0024's note). One conditional upsert takes
 * a slot or finds the day full, so two runs cannot both pass the cap.
 */
export const voiceNumberOrderDays = pgTable(
  "voice_number_order_days",
  {
    day: date("day").primaryKey(),
    ordered: integer("ordered").notNull().default(0),
  },
  (t) => [check("voice_number_order_days_ordered_check", sql`${t.ordered} >= 0`)],
);

// -----------------------------------------------------------------------------
// Redial recognition (drizzle/0108, 21 October 2026)  ⚠️ PHI
// -----------------------------------------------------------------------------

/**
 * The last few turns of a call that ended unexpectedly, kept sealed for a
 * short while so that, if the same number calls again, AYA knows it was cut
 * off and can carry on (lib/voice/redial.ts). Inbound only: nothing here
 * contacts anyone; the record waits for the caller to ring back.
 *
 * At most REDIAL_MAX_TURNS turns, sealed under the KMS key with the lock
 * label's login `redial`; one row per clinic and caller, the newest call's;
 * the caller only as a keyed reference (identifierRef("redial_caller", ...),
 * never the number). The database sets both clocks: expires_at is
 * created_at plus two hours, and nothing moves it. Deleted when it is used,
 * by the minute sweep once expired (app_sweep_redial_contexts), with its
 * conversation by cascade, by a person's erasure, and at a clinic's
 * destruction. Never in the ops projection, a log or Retell.
 */
export const voiceRedialContexts = pgTable(
  "voice_redial_contexts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** identifierRef("redial_caller", clinic, the caller's E.164): never the number. */
    callerRef: text("caller_ref").notNull(),
    /** The call that ended early. */
    conversationId: uuid("conversation_id").notNull(),
    sealed: jsonb("sealed").$type<SealedPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** created_at plus two hours, set by the database (drizzle/0108). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("voice_redial_contexts_caller_idx").on(t.clinicId, t.callerRef),
    index("voice_redial_contexts_expiry_idx").on(t.expiresAt),
    foreignKey({
      name: "voice_redial_contexts_conversation_fk",
      columns: [t.clinicId, t.conversationId],
      foreignColumns: [conversations.clinicId, conversations.id],
    }).onDelete("cascade"),
    check("voice_redial_contexts_caller_ref_check", sql`${t.callerRef} ~ '^v1:[0-9a-f]{64}$'`),
    check("voice_redial_contexts_expiry_check", sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '2 hours'`),
  ],
);

// -----------------------------------------------------------------------------
// Availability changes and the ops audits (drizzle/0114; ops automation E3 and
// E4, 23 October 2026)
// -----------------------------------------------------------------------------

/** What a clinic changed: its weekly hours, its closed days, a location's hours, its providers or their services. */
export const CLINIC_CHANGE_KINDS = [
  "hours",
  "closures",
  "location_hours",
  "providers",
  "provider_services",
  // A Settings switch or choice (lib/clinic/setting-changes.ts; owner, 28
  // October 2026: ops hears of every change to a clinic's settings, from
  // the clinic, an operator or a support action).
  "setting",
] as const;
export type ClinicChangeKind = (typeof CLINIC_CHANGE_KINDS)[number];

/**
 * Who made it: the portal, the setup wizard, a website change the clinic took
 * in Knowledge, a reconnect through the calendar link ops mailed, the ops
 * console, or `direct`, the database's own safety net
 * (a change file through db-apply, or psql), written by a trigger.
 */
export const CLINIC_CHANGE_SOURCES = [
  "portal",
  "wizard",
  "website",
  "calendar_link",
  "ops_console",
  "direct",
  // A support request carried out as an action (lane D's support drafter):
  // a setting changed on a clinic's emailed request.
  "support_action",
  // healdesk itself: a payment switch set back because something it needs
  // was lost (lib/portal/switch-resets.ts; owner, 28 October 2026).
  "system",
] as const;
export type ClinicChangeSource = (typeof CLINIC_CHANGE_SOURCES)[number];

/**
 * Who made a change, coarsely: a clinic device or the clinic's sign-in in
 * the portal or wizard, ops, a change file (db-apply) or another direct
 * edit. Never the device's own label, which the clinic's staff typed.
 */
export const CLINIC_CHANGE_ACTORS = ["clinic_device", "clinic_signin", "ops", "change_file", "direct", "support", "system"] as const;
export type ClinicChangeActor = (typeof CLINIC_CHANGE_ACTORS)[number];

/**
 * Where the ops audit of a change stands. Null when no audit was asked for
 * (the audits are off). `error` once its audit could not finish in three
 * attempts.
 */
export const CLINIC_CHANGE_AUDIT_STATUSES = ["queued", "running", "passed", "attention", "error"] as const;
export type ClinicChangeAuditStatus = (typeof CLINIC_CHANGE_AUDIT_STATUSES)[number];

/**
 * The summary a change row carries: counts and dates (YYYY-MM-DD, the clinic's
 * own zone), never a name, a calendar id, a label or a patient. Each key is
 * optional; a direct change carries only `rows` and `operation`.
 */
export type ClinicChangeSummary = {
  weeklyChanged?: boolean;
  closuresAdded?: string[];
  closuresRemoved?: string[];
  closuresUpcoming?: number;
  providersActive?: number;
  servicesMapped?: number;
  holdsReleased?: number;
  rows?: number;
  operation?: "insert" | "update" | "delete";
  table?: "clinic_closures" | "clinic_providers" | "clinic_provider_services";
  /**
   * A `setting` change: which switch (a key of lib/clinic/setting-changes.ts
   * SETTING_CHANGE_LABELS) and, for a switch or a choice, its value before
   * and after as a closed token ("on", "off", a choice's id). A text setting
   * (a greeting, a number) carries the key alone: never the words.
   */
  setting?: string;
  before?: string;
  after?: string;
};

/**
 * One change a clinic made to when and with whom AYA books, for ops to see
 * (design E4): written in the save's own transaction by
 * lib/clinic/change-events.ts, so a save that rolls back leaves none, and by
 * a statement trigger on clinic_closures, clinic_providers and
 * clinic_provider_services for any other session's edit (`direct`). The
 * minute sweep raises clinic_availability_changed for it once
 * (`alerted_at`), and the ops audit records how it went (`audit_status`).
 * Business data about the practice, no patient: counts, dates and a coarse
 * kind of actor. Tenant plane; the runtime role never deletes one, and they go when
 * the account closes.
 */
export const clinicChangeEvents = pgTable(
  "clinic_change_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** The location whose hours changed; null for the account's main location. */
    locationId: uuid("location_id"),
    kind: text("kind").$type<ClinicChangeKind>().notNull(),
    source: text("source").$type<ClinicChangeSource>().notNull(),
    actorKind: text("actor_kind").$type<ClinicChangeActor>().notNull(),
    summary: jsonb("summary").$type<ClinicChangeSummary>().notNull().default(sql`'{}'::jsonb`),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    /** When the sweep raised its ops alert; null until then. */
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    auditStatus: text("audit_status").$type<ClinicChangeAuditStatus>(),
    /** How many times an audit claimed it, and when the last claim started (a stale one is claimed again). */
    auditAttempts: integer("audit_attempts").notNull().default(0),
    auditStartedAt: timestamp("audit_started_at", { withTimezone: true }),
    /** The clinic_audits row that checked it. */
    auditId: uuid("audit_id"),
    opsAcknowledgedAt: timestamp("ops_acknowledged_at", { withTimezone: true }),
    opsAcknowledgedBy: text("ops_acknowledged_by"),
  },
  (t) => [
    index("clinic_change_events_clinic_idx").on(t.clinicId, t.changedAt),
    index("clinic_change_events_unalerted_idx")
      .on(t.changedAt)
      .where(sql`${t.alertedAt} is null`),
    check("clinic_change_events_kind_check", sql`${t.kind} in (${sqlList(CLINIC_CHANGE_KINDS)})`),
    check("clinic_change_events_source_check", sql`${t.source} in (${sqlList(CLINIC_CHANGE_SOURCES)})`),
    check(
      "clinic_change_events_audit_status_check",
      sql`${t.auditStatus} is null or ${t.auditStatus} in (${sqlList(CLINIC_CHANGE_AUDIT_STATUSES)})`,
    ),
    check("clinic_change_events_actor_kind_check", sql`${t.actorKind} in (${sqlList(CLINIC_CHANGE_ACTORS)})`),
    check("clinic_change_events_audit_attempts_check", sql`${t.auditAttempts} between 0 and 10`),
    check(
      "clinic_change_events_acknowledged_check",
      sql`(${t.opsAcknowledgedAt} is null) = (${t.opsAcknowledgedBy} is null)`,
    ),
    check(
      "clinic_change_events_acknowledged_by_check",
      sql`${t.opsAcknowledgedBy} is null or char_length(${t.opsAcknowledgedBy}) between 1 and 320`,
    ),
    check("clinic_change_events_summary_check", sql`jsonb_typeof(${t.summary}) = 'object'`),
  ],
);

export type ClinicChangeEventRow = typeof clinicChangeEvents.$inferSelect;

/** The audit packs (design E3 §2.1). */
export const AUDIT_PACKS = ["availability", "roster", "golive", "transcripts"] as const;
export type AuditPack = (typeof AUDIT_PACKS)[number];

/** What started an audit: a clinic's change, a fingerprint that moved, the 04 UTC run, or an operator. */
export const AUDIT_TRIGGERS = ["change", "change_detected", "scheduled", "manual"] as const;
export type AuditTrigger = (typeof AUDIT_TRIGGERS)[number];

export const AUDIT_RESULTS = ["pass", "warn", "fail", "error"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/** One check's outcome as stored: its id, result, fixed hint and counts. Never a name, a time or free text. */
export type AuditCheckOutcome = {
  id: string;
  result: AuditResult;
  hint: string | null;
  counts: Record<string, number>;
  /** A closed code the check names (a go-live code, a booking-mode reason, a status). */
  code?: string | null;
  side?: "clinic" | "ours" | null;
};

/**
 * One run of one audit pack for one clinic (design E3, lib/audits): ids,
 * codes, counts and a fingerprint, never a name, a time of day, an address
 * or free text. The last 20 per clinic and pack are kept; the runtime role
 * deletes older ones (lib/audits/run.ts). Tenant plane, no patient; they go
 * when the account closes.
 */
export const clinicAudits = pgTable(
  "clinic_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    pack: text("pack").$type<AuditPack>().notNull(),
    trigger: text("trigger").$type<AuditTrigger>().notNull(),
    changeKind: text("change_kind").$type<ClinicChangeKind>(),
    /** sha256 of the hours, upcoming closures, active providers with their services, and location hours. */
    fingerprint: text("fingerprint"),
    result: text("result").$type<AuditResult>().notNull(),
    checks: jsonb("checks").$type<AuditCheckOutcome[]>().notNull().default(sql`'[]'::jsonb`),
    /** The operator's address for a manual run, or the service's name. */
    requestedBy: text("requested_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index("clinic_audits_clinic_pack_idx").on(t.clinicId, t.pack, t.startedAt),
    check("clinic_audits_pack_check", sql`${t.pack} in (${sqlList(AUDIT_PACKS)})`),
    check("clinic_audits_trigger_check", sql`${t.trigger} in (${sqlList(AUDIT_TRIGGERS)})`),
    check("clinic_audits_result_check", sql`${t.result} in (${sqlList(AUDIT_RESULTS)})`),
    check(
      "clinic_audits_change_kind_check",
      sql`${t.changeKind} is null or ${t.changeKind} in (${sqlList(CLINIC_CHANGE_KINDS)})`,
    ),
    check(
      "clinic_audits_fingerprint_check",
      sql`${t.fingerprint} is null or ${t.fingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "clinic_audits_requested_by_check",
      sql`char_length(${t.requestedBy}) between 1 and 320`,
    ),
    check("clinic_audits_checks_check", sql`jsonb_typeof(${t.checks}) = 'array'`),
  ],
);

export type ClinicAuditRow = typeof clinicAudits.$inferSelect;

/**
 * An operator's manual audit of one clinic in progress (lib/ops/audit-ops.ts):
 * one row per clinic, claimed before the run and deleted after it, so a
 * second press is refused as busy without holding a database connection for
 * the run. A claim older than two minutes is stale and may be taken over.
 * The operator's address and a time; no patient. Tenant plane; goes when the
 * account closes.
 */
export const clinicAuditClaims = pgTable(
  "clinic_audit_claims",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    requestedBy: text("requested_by").notNull(),
  },
  (t) => [
    check(
      "clinic_audit_claims_requested_by_check",
      sql`char_length(${t.requestedBy}) between 1 and 320`,
    ),
  ],
);


// -----------------------------------------------------------------------------
// The lifecycle watch (drizzle/0115; design E2 of the ops automation plan,
// 23 October 2026): where each billing clinic stands, and every reminder and
// ops wave about it in one ledger
// -----------------------------------------------------------------------------

/** Where a billing clinic stands (lib/lifecycle/stage.ts). Before an account exists there is no row. */
export const LIFECYCLE_STAGES = [
  "not_started",
  "in_setup",
  "waiting_on_us",
  "partly_live",
  "live",
  "closed",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** The operator's decision about a stalled setup. `extended` is set when the deadline moves later. */
export const LIFECYCLE_DECISIONS = ["none", "extension_offered", "let_close", "extended"] as const;
export type LifecycleDecision = (typeof LIFECYCLE_DECISIONS)[number];

/** Who a wave went to: the clinic (a spec reminder, recorded), the ops address, or Slack. */
export const LIFECYCLE_TARGETS = ["clinic_email", "ops_email", "slack"] as const;
export type LifecycleTarget = (typeof LIFECYCLE_TARGETS)[number];

/** What is stored of a wave's outcome; a sent one's is read from its notice or alert. */
export const LIFECYCLE_DELIVERIES = ["delivered", "bounced", "failed", "skipped"] as const;
export type LifecycleDelivery = (typeof LIFECYCLE_DELIVERIES)[number];

/**
 * One row per billing clinic, written by the hourly lifecycle-watch job
 * (lib/lifecycle/watch.ts): its stage and since when, how many wizard steps
 * and channel actions it still owes, when it last made progress, the setup
 * deadline the watch last saw (a later one means it was extended), the
 * operator's snooze of the ops waves and the decision about a stalled setup.
 * Ids, counts, dates and closed words; never a patient. Tenant plane, RLS.
 */
export const clinicLifecycle = pgTable(
  "clinic_lifecycle",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),
    stage: text("stage").$type<LifecycleStage>().notNull(),
    stageSince: timestamp("stage_since", { withTimezone: true }).notNull(),
    stepsLeft: integer("steps_left").notNull().default(0),
    channelsWaiting: integer("channels_waiting").notNull().default(0),
    lastProgressAt: timestamp("last_progress_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** The window's last day on the clinic's calendar when last seen: a later one is an extension. */
    lastDay: date("last_day", { mode: "string" }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozedBy: text("snoozed_by"),
    decision: text("decision").$type<LifecycleDecision>().notNull().default("none"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("clinic_lifecycle_stage_check", sql`${t.stage} in (${sqlList(LIFECYCLE_STAGES)})`),
    check("clinic_lifecycle_decision_check", sql`${t.decision} in (${sqlList(LIFECYCLE_DECISIONS)})`),
    check("clinic_lifecycle_counts_check", sql`${t.stepsLeft} >= 0 and ${t.channelsWaiting} >= 0`),
    check(
      "clinic_lifecycle_labels_check",
      sql`(${t.snoozedBy} is null or char_length(${t.snoozedBy}) between 1 and 200) and (${t.decidedBy} is null or char_length(${t.decidedBy}) between 1 and 200)`,
    ),
  ],
);

/**
 * The reminder ledger the admin shows: one row per wave per target, unique on
 * (clinic, stage, wave, target), so a replayed run records nothing twice. A
 * clinic row records a spec reminder the setup-reminders job queued
 * (`notice_id`; the watch never sends one); an ops row points at the ops
 * alert that carried it (`ops_alert_id`), which Slack posts and, for an
 * escalation, email sends. `delivery` is stored only when nothing was sent
 * (`skipped`: snoozed, or let close); a sent wave's outcome is read from its
 * notice's ledger or its alert. Ids, closed words and dates; never a patient.
 */
export const lifecycleWaves = pgTable(
  "lifecycle_waves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    stage: text("stage").$type<LifecycleStage>().notNull(),
    wave: text("wave").notNull(),
    target: text("target").$type<LifecycleTarget>().notNull(),
    noticeId: uuid("notice_id").references(() => billingNotices.id, { onDelete: "set null" }),
    /** The ops alert that carried it (ops_alerts.id). No foreign key: the ops log is the identity plane's, never deleted. */
    opsAlertId: uuid("ops_alert_id"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerId: text("provider_id"),
    delivery: text("delivery").$type<LifecycleDelivery>(),
    error: text("error"),
    manualBy: text("manual_by"),
    escalated: boolean("escalated").notNull().default(false),
  },
  (t) => [
    uniqueIndex("lifecycle_waves_once_idx").on(t.clinicId, t.stage, t.wave, t.target),
    uniqueIndex("lifecycle_waves_notice_idx")
      .on(t.clinicId, t.noticeId)
      .where(sql`${t.noticeId} is not null`),
    index("lifecycle_waves_queued_idx").on(t.queuedAt),
    check("lifecycle_waves_stage_check", sql`${t.stage} in (${sqlList(LIFECYCLE_STAGES)})`),
    check("lifecycle_waves_target_check", sql`${t.target} in (${sqlList(LIFECYCLE_TARGETS)})`),
    check(
      "lifecycle_waves_delivery_check",
      sql`${t.delivery} is null or ${t.delivery} in (${sqlList(LIFECYCLE_DELIVERIES)})`,
    ),
    check("lifecycle_waves_wave_check", sql`${t.wave} ~ '^[a-z0-9_]+(:[A-Za-z0-9_.:+-]{1,60})?$'`),
    check(
      "lifecycle_waves_text_check",
      sql`(${t.error} is null or char_length(${t.error}) <= 200) and (${t.manualBy} is null or char_length(${t.manualBy}) between 1 and 200) and (${t.providerId} is null or char_length(${t.providerId}) <= 200)`,
    ),
    check(
      "lifecycle_waves_link_check",
      sql`(${t.target} = 'clinic_email' and ${t.opsAlertId} is null) or (${t.target} <> 'clinic_email' and ${t.noticeId} is null)`,
    ),
  ],
);
/**
 * Why an operator took a clinic off the lifecycle watch: a closed list, never
 * free text (lane P5d, owner's decision of 24 October 2026).
 */
export const LIFECYCLE_IGNORE_NOTES = [
  "internal_test_account",
  "healdesk_staff_account",
  "sales_demo_account",
] as const;
export type LifecycleIgnoreNote = (typeof LIFECYCLE_IGNORE_NOTES)[number];

/**
 * The lifecycle watch's ignore list: healdesk's own test accounts, which the
 * watch, its ops waves, Home's "decision owed" row and the digest's
 * Lifecycle block leave out. One row per billing clinic an operator has ever
 * set, flipped by `ignored` and never deleted, so turning it back on is one
 * update, and who set it last and when stay on the row (the audit row and
 * the security event keep the history). Its own table, not a column on
 * clinic_lifecycle: that row exists only once the watch has observed the
 * clinic, and an internal account must be ignorable before the watch first
 * runs. Ids, a closed word, a label and a date; never a patient.
 */
export const lifecycleIgnoredClinics = pgTable(
  "lifecycle_ignored_clinics",
  {
    clinicId: uuid("clinic_id")
      .primaryKey()
      .references(() => clinics.id, { onDelete: "cascade" }),
    ignored: boolean("ignored").notNull(),
    note: text("note").$type<LifecycleIgnoreNote>(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "lifecycle_ignored_clinics_note_check",
      sql`${t.note} is null or ${t.note} in (${sqlList(LIFECYCLE_IGNORE_NOTES)})`,
    ),
    check("lifecycle_ignored_clinics_set_by_check", sql`char_length(${t.setBy}) between 1 and 200`),
  ],
);

// -----------------------------------------------------------------------------
// The approval inbox (ops automation Phase 6, lane P6a; drizzle/0119)
// -----------------------------------------------------------------------------

/**
 * What an approval asks the owner to allow: a closed list, one per existing
 * ops operation the inbox may run (lib/approvals/kinds.ts says which). The
 * three billing kinds gate from the dead letter onward (owner decision D17):
 * the worker's own retries and Stripe's dunning stay ungated.
 */
export const APPROVAL_KINDS = [
  "billing_request_retry",
  "overage_invoice_retry",
  "billing_event_replay",
  // The clinic-contact kinds (ops automation lane P6f, drizzle/0122): the
  // BAA version re-sign chase, the agreement question and the setup
  // notices, each an email from a fixed template, and the next setup
  // reminder sooner.
  "baa_resign_chase",
  "agreement_question",
  "setup_extended",
  "setup_waiting_on_us",
  "setup_help_offer",
  "setup_reminder_now",
  // The incident assistant (ops automation lane P6i, drizzle/0124).
  "incident_open_batch",
  "incident_report_send",
  // A composed support reply, sent only once the owner approves it (ops
  // automation lane P7c, drizzle/0126; owner decision D12).
  "support_reply_send",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** How a waiting item is chased: a legal clock re-alerts every 4 hours, money and routine once past due. */
export const APPROVAL_URGENCIES = ["legal_clock", "money", "routine"] as const;
export type ApprovalUrgency = (typeof APPROVAL_URGENCIES)[number];

/**
 * Where an item stands. `waiting` until a decision or its window; `approved`
 * only for the instant between the decision and the operation's answer, in
 * the same request; then `executed` or `failed`. `rejected` and `expired`
 * run nothing, ever. The trigger in drizzle/0119 refuses any other move.
 */
export const APPROVAL_STATUSES = ["waiting", "approved", "rejected", "expired", "executed", "failed"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** What happened to an item, one row each, never rewritten. */
export const APPROVAL_EVENTS = [
  "proposed",
  "edited",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
  "reminded",
] as const;
export type ApprovalEventName = (typeof APPROVAL_EVENTS)[number];

/**
 * One thing waiting for the owner's yes (design E6 §2; owner decisions D17,
 * D18, D21). Ops-only and platform-wide like ops_alerts and
 * platform_compliance: listed across clinics by the console, written outside
 * any tenant from the ops envelope and the proposer job, so it has no
 * `clinic_id` and no RLS (every table with a clinic_id is a tenant table,
 * tests/rls-drift.test.ts). `subject_clinic_id` names the clinic the item is
 * about, as billing_events.resolved_clinic_id does: a stored fact, not a
 * tenant key, and no foreign key, so the record outlives the clinic.
 *
 * `payload` is ids and closed codes only, checked per kind in code and by a
 * CHECK that refuses an `@` and a run of seven or more digits once uuids and
 * dates are taken out. `draft` and `draft_hash` are for email kinds (none
 * yet). Never a patient, a card, an invoice PDF or free text.
 */
export const opsApprovals = pgTable(
  "ops_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    subjectClinicId: uuid("subject_clinic_id"),
    /** The thing approved, by id, with its episode where it has one ("<request id>:<epoch>"). */
    subjectRef: text("subject_ref").notNull(),
    payload: jsonb("payload").$type<Record<string, string | number | boolean | null>>().notNull(),
    draft: text("draft"),
    draftHash: text("draft_hash"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** Past it, the item leaves the waiting list as `expired` and is never run. Null: no window. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    urgency: text("urgency").$type<ApprovalUrgency>().notNull(),
    proposedBy: text("proposed_by").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<ApprovalStatus>().notNull().default("waiting"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The operation's outcome, or why the item left the list: a snake_case code. */
    outcomeCode: text("outcome_code"),
  },
  (t) => [
    // A proposer can never double-propose: one waiting item per subject.
    uniqueIndex("ops_approvals_waiting_idx")
      .on(t.kind, t.subjectRef)
      .where(sql`${t.status} = 'waiting'`),
    index("ops_approvals_status_idx").on(t.status, t.dueAt),
    index("ops_approvals_subject_idx").on(t.kind, t.subjectRef),
    check("ops_approvals_kind_check", sql`${t.kind} in (${sqlList(APPROVAL_KINDS)})`),
    check("ops_approvals_urgency_check", sql`${t.urgency} in (${sqlList(APPROVAL_URGENCIES)})`),
    check("ops_approvals_status_check", sql`${t.status} in (${sqlList(APPROVAL_STATUSES)})`),
    check("ops_approvals_subject_check", sql`${t.subjectRef} ~ '^[A-Za-z0-9_:.-]+$' and char_length(${t.subjectRef}) <= 300`),
    check("ops_approvals_proposed_by_check", sql`${t.proposedBy} ~ '^[a-z][a-z0-9-]{0,63}$'`),
    check(
      "ops_approvals_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and position('@' in ${t.payload}::text) = 0 and regexp_replace(regexp_replace(${t.payload}::text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){6,}'`,
    ),
    check(
      "ops_approvals_draft_check",
      sql`((${t.draft} is null) = (${t.draftHash} is null) or (${t.kind} = 'support_reply_send' and ${t.draft} is null)) and (${t.draftHash} is null or ${t.draftHash} ~ '^[0-9a-f]{64}$') and (${t.draft} is null or char_length(${t.draft}) <= 20000)`,
    ),
    check("ops_approvals_decided_check", sql`(${t.status} = 'waiting') = (${t.decidedAt} is null)`),
    check("ops_approvals_outcome_check", sql`${t.outcomeCode} is null or ${t.outcomeCode} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check("ops_approvals_expiry_check", sql`${t.expiresAt} is null or ${t.expiresAt} > ${t.proposedAt}`),
  ],
);
export type OpsApproval = typeof opsApprovals.$inferSelect;

/**
 * The approval inbox's record: what happened to each item, add-only (a
 * trigger refuses UPDATE, DELETE and TRUNCATE, the migrator included). Who
 * decided is the operator account (D21: one shared sign-in), with the IP
 * address and user agent the request carried; a service event (proposed,
 * expired, reminded) has none. The hashes of a draft as approved and as sent;
 * never the draft itself.
 */
export const opsApprovalEvents = pgTable(
  "ops_approval_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => opsApprovals.id, { onDelete: "restrict" }),
    event: text("event").$type<ApprovalEventName>().notNull(),
    actorLabel: text("actor_label").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    draftHashApproved: text("draft_hash_approved"),
    draftHashSent: text("draft_hash_sent"),
    outcomeCode: text("outcome_code"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ops_approval_events_approval_idx").on(t.approvalId, t.at),
    index("ops_approval_events_at_idx").on(t.at),
    check("ops_approval_events_event_check", sql`${t.event} in (${sqlList(APPROVAL_EVENTS)})`),
    check("ops_approval_events_actor_check", sql`char_length(${t.actorLabel}) between 1 and 200`),
    check(
      "ops_approval_events_text_check",
      sql`(${t.ip} is null or char_length(${t.ip}) <= 64) and (${t.userAgent} is null or char_length(${t.userAgent}) <= 256)`,
    ),
    check(
      "ops_approval_events_hash_check",
      sql`(${t.draftHashApproved} is null or ${t.draftHashApproved} ~ '^[0-9a-f]{64}$') and (${t.draftHashSent} is null or ${t.draftHashSent} ~ '^[0-9a-f]{64}$')`,
    ),
    check("ops_approval_events_outcome_check", sql`${t.outcomeCode} is null or ${t.outcomeCode} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  ],
);
export type OpsApprovalEvent = typeof opsApprovalEvents.$inferSelect;
// The patient-rights tracker (ops automation Phase 6, lane P6c; drizzle/0120)
// -----------------------------------------------------------------------------

/**
 * What a rights request asks for, as the tracker counts its clock
 * (lib/rights/clocks.ts): a deletion, an amendment to a record, a correction
 * of a contact's details, a person's export, or a request a patient made to
 * healdesk itself, which is passed on to the practice.
 */
export const RIGHTS_KINDS = ["erasure", "amendment", "correction", "export", "patient_request"] as const;
export type RightsKind = (typeof RIGHTS_KINDS)[number];

/** How the request was verified before it was recorded (docs/handover.md, "Deletion requests", step 2). */
export const RIGHTS_VERIFICATIONS = ["notice_address", "phone_confirmed", "unverified"] as const;
export type RightsVerification = (typeof RIGHTS_VERIFICATIONS)[number];

export const RIGHTS_STATUSES = ["open", "done", "not_applicable"] as const;
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

/**
 * A rights request as it reached us, recorded the day it came so its clock
 * is tracked before anything runs on the host. Ids, closed words and dates
 * only: no person, no contact id, no free text (the text check refuses `@`
 * and any run of three digits in every text column). `asked_for` is what a
 * patient asked healdesk for (PATIENT_REQUEST_KINDS), set exactly for a
 * `patient_request`, because the host's task needs it. `linked_record_id`
 * is the erasure request, amendment or patient request the intake became,
 * when it was recorded after it; it is not a foreign key, so a record the
 * erasure expiry or the purge takes leaves the intake standing. `due_on` is
 * written at insert from the kind's clock (lib/rights/clocks.ts) and never
 * changed. Recorded once per clinic and request_key, the form's own key,
 * so a retried form records nothing twice while two people's requests of
 * one kind on one day stay two; and at most once per record it became.
 * Flipped once from open to done or not applicable. Deleted with the clinic's
 * other patient-rights records at its destruction, open or closed
 * (app_destroy_rights_intakes, drizzle/0121), never by the runtime role.
 */
export const rightsIntakes = pgTable(
  "rights_intakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /**
     * The caller's own key for this request, generated once when the form
     * opens: the same key again is the same request (a retried submit), and
     * two people's requests of one kind on one day are two keys, two rows.
     */
    requestKey: uuid("request_key").notNull(),
    kind: text("kind").$type<RightsKind>().notNull(),
    askedFor: text("asked_for").$type<PatientRequestKind>(),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    verifiedVia: text("verified_via").$type<RightsVerification>().notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    status: text("status").$type<RightsStatus>().notNull().default("open"),
    linkedRecordId: uuid("linked_record_id"),
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    unique("rights_intakes_request_key").on(t.clinicId, t.requestKey),
    // One intake per record it became.
    uniqueIndex("rights_intakes_linked_key")
      .on(t.clinicId, t.kind, t.linkedRecordId)
      .where(sql`${t.linkedRecordId} is not null`),
    index("rights_intakes_open_idx")
      .on(t.clinicId, t.dueOn)
      .where(sql`${t.status} = 'open'`),
    check("rights_intakes_kind_check", sql`${t.kind} in (${sqlList(RIGHTS_KINDS)})`),
    check(
      "rights_intakes_verified_via_check",
      sql`${t.verifiedVia} in (${sqlList(RIGHTS_VERIFICATIONS)})`,
    ),
    check("rights_intakes_status_check", sql`${t.status} in (${sqlList(RIGHTS_STATUSES)})`),
    check(
      "rights_intakes_asked_for_check",
      sql`(${t.kind} = 'patient_request') = (${t.askedFor} is not null)
        and (${t.askedFor} is null or ${t.askedFor} in (${sqlList(PATIENT_REQUEST_KINDS)}))`,
    ),
    check("rights_intakes_closed_check", sql`(${t.status} = 'open') = (${t.closedAt} is null)`),
    // Five business days from any day are five to seven calendar days; ten are twelve to fourteen.
    check(
      "rights_intakes_due_check",
      sql`${t.dueOn} between ${t.receivedOn} + 5 and ${t.receivedOn} + 14`,
    ),
    check(
      "rights_intakes_text_check",
      sql`char_length(${t.recordedBy}) between 1 and 64
        and (${t.kind} || ' ' || coalesce(${t.askedFor}, '') || ' ' || ${t.verifiedVia} || ' ' || ${t.status} || ' ' || ${t.recordedBy}) !~ '[@]|[0-9]{3,}'`,
    ),
  ],
);

// -----------------------------------------------------------------------------
// The weekly compliance pack (ops automation Phase 6, lane P6h; drizzle/0123)
// -----------------------------------------------------------------------------

/**
 * One week's compliance pack (design E6 item 18; owner decision D20: for the
 * owner only): counts, ids, dates and closed words read from the database
 * for the week that starts on `weekStart`, a Monday in New York, stored once
 * and never changed. A trigger refuses UPDATE, DELETE and TRUNCATE for every
 * role, the migrator included. `payloadHash` is the SHA-256 of the payload's
 * canonical JSON (lib/compliance-pack/hash.ts), so a printed page can be
 * checked against the row. Platform-wide: no clinic column, no RLS, like
 * ops_approval_events (drizzle/0119 says why).
 */
export const compliancePacks = pgTable(
  "compliance_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekStart: date("week_start", { mode: "string" }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    generatedBy: text("generated_by").notNull(),
  },
  (t) => [
    uniqueIndex("compliance_packs_week_key").on(t.weekStart),
    check("compliance_packs_week_check", sql`extract(isodow from ${t.weekStart}) = 1`),
    check("compliance_packs_hash_check", sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check("compliance_packs_generated_by_check", sql`${t.generatedBy} ~ '^[a-z][a-z0-9-]{0,63}$'`),
    check(
      "compliance_packs_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' and position('@' in ${t.payload}::text) = 0 and regexp_replace(regexp_replace(${t.payload}::text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){6,}'`,
    ),
  ],
);
export type CompliancePackRow = typeof compliancePacks.$inferSelect;

// -----------------------------------------------------------------------------
// The incident assistant's checklist (ops automation Phase 6, lane P6i; drizzle/0124)
// -----------------------------------------------------------------------------

/**
 * One tick on an incident's checklist: a step of docs/incident-response.md's
 * procedure (lib/incidents/assistant/vocab.ts CHECKLIST_STEPS), when, and
 * the operator account that ticked it. Add-only, like ops_approval_events:
 * the runtime role holds SELECT and INSERT, and a trigger refuses UPDATE and
 * DELETE for every role. Each step is ticked once per incident. Never free
 * text: the step is a code, `ticked_by` is the operator account's address
 * and nothing else, `affected_count` is the number of people the incident's
 * list named when its step was ticked (read from incidents.affected_recorded,
 * never typed, never who), and `batch_key` names the vendor or channel scope
 * an `open` tick came from when the incident assistant opened the incident
 * from an approved batch, which is what makes that batch open each clinic's
 * incident once (the partial unique index). A tenant table, FORCE RLS like
 * incidents, and kept for good with them.
 */
export const incidentChecklistTicks = pgTable(
  "incident_checklist_ticks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "restrict" }),
    incidentId: uuid("incident_id").notNull(),
    step: text("step").$type<ChecklistStep>().notNull(),
    affectedCount: integer("affected_count"),
    batchKey: text("batch_key"),
    tickedBy: text("ticked_by").notNull(),
    tickedAt: timestamp("ticked_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    unique("incident_checklist_ticks_step_key").on(t.incidentId, t.step),
    uniqueIndex("incident_checklist_ticks_batch_key")
      .on(t.clinicId, t.batchKey)
      .where(sql`${t.batchKey} is not null`),
    index("incident_checklist_ticks_clinic_idx").on(t.clinicId, t.incidentId),
    foreignKey({
      name: "incident_checklist_ticks_incident_fk",
      columns: [t.clinicId, t.incidentId],
      foreignColumns: [incidents.clinicId, incidents.id],
    }).onDelete("restrict"),
    check("incident_checklist_ticks_step_check", sql`${t.step} in (${sqlList(CHECKLIST_STEPS)})`),
    check(
      "incident_checklist_ticks_count_check",
      sql`(${t.step} = 'affected_list_recorded') = (${t.affectedCount} is not null) and (${t.affectedCount} is null or ${t.affectedCount} >= 0)`,
    ),
    check(
      "incident_checklist_ticks_batch_check",
      sql`${t.batchKey} is null or (${t.step} = 'open' and ${t.batchKey} ~ '^(vendor|channel):[a-z_]{1,40}:(all_holding|window_only):[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z:[a-z_]{1,40}$')`,
    ),
    check(
      "incident_checklist_ticks_by_check",
      sql`char_length(${t.tickedBy}) between 3 and 200 and ${t.tickedBy} ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$'`,
    ),
  ],
);

export type IncidentChecklistTick = typeof incidentChecklistTicks.$inferSelect;

/**
 * The support team's cases (ops automation Phase 7, lane P7a; design E5
 * §2.2; drizzle/0125). One row per request a clinic, or later anyone by
 * email, brought to healdesk: its ref, the clinic it is about, where it came
 * from, its state, topic, what is wrong and how urgent, who has it, the day
 * we promised a reply by, and when it was closed and why.
 *
 * Platform-wide, like ops_alerts and ops_approvals: the console lists cases
 * across clinics, and a case from an email nobody matched has no clinic, so
 * the clinic is `subject_clinic_id` and the table has no RLS (every table
 * with a clinic_id is a FORCE-RLS tenant table, tests/rls-drift.test.ts).
 * Unlike ops_approvals it has a foreign key: a clinic's cases go with it at
 * destruction (app_destroy_support_cases, owner's rule of 25 October 2026),
 * and the clinics row itself is never deleted. A write that names a clinic
 * runs in that clinic's tenant, so the guard can read the clinic's row and
 * refuse one that has left.
 *
 * No text: ids, closed words, counts, dates and the operator's label. A chat
 * case can carry no words at all (the CHECKs below and on support_messages).
 */
export const supportCases = pgTable(
  "support_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Five characters of Crockford base32, printed "HD-" + ref (lib/support/case-vocab.ts). */
    ref: text("ref").notNull(),
    subjectClinicId: uuid("subject_clinic_id").references(() => clinics.id, { onDelete: "cascade" }),
    source: text("source").$type<SupportCaseSource>().notNull(),
    state: text("state").$type<SupportCaseState>().notNull().default("new"),
    category: text("category").notNull(),
    symptom: text("symptom").notNull(),
    urgency: text("urgency").$type<SupportCaseUrgency>().notNull(),
    /** A name from HEALDESK_OPS_PEOPLE: a label, not an identity (one shared operator sign-in, D21). */
    assigneeLabel: text("assignee_label"),
    /** The day we promised a reply by (L25's day: replyByDay, New York's next business day). */
    replyByOn: date("reply_by_on").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    /** The inbound screen hid something, or found clinical words (email only; never on a chat case). */
    phiSuspected: boolean("phi_suspected").notNull().default(false),
    hiddenNumbers: integer("hidden_numbers").notNull().default(0),
    hiddenEmails: integer("hidden_emails").notNull().default(0),
    hiddenTreatments: integer("hidden_treatments").notNull().default(0),
    clinicalMatches: integer("clinical_matches").notNull().default(0),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }).notNull().defaultNow(),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason: text("closed_reason").$type<SupportClosedReason>(),
    /** When the retention sweep (follow-up S7) nulls the case's inbound text: 30 days after close, 7 if phi_suspected. */
    inboundTextDeleteAfter: timestamp("inbound_text_delete_after", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_cases_ref_key").on(t.ref),
    // One open chat case per clinic and topic: a second escalation about the
    // same topic joins it (lib/support/cases.ts), and two racing ones cannot
    // open two.
    uniqueIndex("support_cases_open_chat_key")
      .on(t.subjectClinicId, t.category)
      .where(sql`${t.source} = 'chat' and ${t.state} <> 'closed'`),
    index("support_cases_state_idx").on(t.state, t.replyByOn),
    index("support_cases_clinic_idx").on(t.subjectClinicId, t.openedAt),
    check("support_cases_ref_check", sql`${t.ref} ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'`),
    check("support_cases_source_check", sql`${t.source} in (${sqlList(SUPPORT_CASE_SOURCES)})`),
    check("support_cases_state_check", sql`${t.state} in (${sqlList(SUPPORT_CASE_STATES)})`),
    check("support_cases_category_check", sql`${t.category} in (${sqlList(SUPPORT_CASE_CATEGORIES)})`),
    check("support_cases_symptom_check", sql`${t.symptom} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check("support_cases_urgency_check", sql`${t.urgency} in (${sqlList(SUPPORT_CASE_URGENCIES)})`),
    check(
      "support_cases_closed_check",
      sql`(${t.state} = 'closed') = (${t.closedAt} is not null) and (${t.state} = 'closed') = (${t.closedReason} is not null) and (${t.closedReason} is null or ${t.closedReason} in (${sqlList(SUPPORT_CLOSED_REASONS)}))`,
    ),
    check("support_cases_snoozed_check", sql`(${t.state} = 'snoozed') = (${t.snoozedUntil} is not null)`),
    check(
      "support_cases_assignee_check",
      sql`${t.assigneeLabel} is null or (char_length(${t.assigneeLabel}) between 1 and 60 and ${t.assigneeLabel} ~ '^[A-Za-z][A-Za-z .''-]*$')`,
    ),
    check(
      "support_cases_counts_check",
      sql`${t.hiddenNumbers} >= 0 and ${t.hiddenEmails} >= 0 and ${t.hiddenTreatments} >= 0 and ${t.clinicalMatches} >= 0 and (${t.phiSuspected} or ${t.hiddenNumbers} + ${t.hiddenEmails} + ${t.hiddenTreatments} + ${t.clinicalMatches} = 0)`,
    ),
    // A chat case is always a clinic's, and the chat screens before the
    // model, stores nothing and carries fields only: nothing to suspect.
    check(
      "support_cases_chat_check",
      sql`${t.source} <> 'chat' or (${t.subjectClinicId} is not null and not ${t.phiSuspected} and ${t.hiddenNumbers} + ${t.hiddenEmails} + ${t.hiddenTreatments} + ${t.clinicalMatches} = 0)`,
    ),
  ],
);
export type SupportCase = typeof supportCases.$inferSelect;

/**
 * What passed on a case, one row each (design E5 §2.2): a chat escalation's
 * fields (no words), and later an inbound email's screened text, our fixed
 * acknowledgement, and a reply's drafts and the text the owner approved.
 * Withheld from the read-only role (scripts/readonly-tables.ts): `text`,
 * `subject_screened` and `draft_text` are typed correspondence. Never on
 * apps/web: the console reads the case's facts and the draft through the ops
 * envelope, never the clinic's own words (owner, D15).
 *
 * A chat escalation holds NULL text by CHECK, and the guard refuses one on a
 * case that did not come from the chat. Inbound text may only ever be set to
 * NULL (the retention sweep); a message's identity never changes.
 */
export const supportMessages = pgTable(
  "support_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => supportCases.id, { onDelete: "cascade" }),
    direction: text("direction").$type<SupportMessageDirection>().notNull(),
    kind: text("kind").$type<SupportMessageKind>().notNull(),
    /** A chat escalation's request id (the I3 email's and L25's): a retried escalation is the same row. */
    requestId: uuid("request_id"),
    /** A chat escalation's fields, ids from fixed lists only (lib/support/escalation-fields.ts). */
    fieldsJson: jsonb("fields_json").$type<Record<string, string | null>>(),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    subjectScreened: text("subject_screened"),
    text: text("text"),
    draftText: text("draft_text"),
    draftVersion: integer("draft_version"),
    factsJson: jsonb("facts_json"),
    checksJson: jsonb("checks_json"),
    approvedByLabel: text("approved_by_label"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    deliveryId: uuid("delivery_id"),
    /**
     * A reply's send (lane P7c, drizzle/0126): the subject it goes under
     * (fixed per topic, with the case's ref) and the SHA-256 of the subject
     * and the approved text, both frozen with the approval; how many sends
     * were tried, when the next is due, and why the sending stopped without
     * the email going.
     */
    replySubject: text("reply_subject"),
    approvedHash: text("approved_hash"),
    sendAttempts: integer("send_attempts").notNull().default(0),
    nextSendAt: timestamp("next_send_at", { withTimezone: true }),
    sendStoppedAt: timestamp("send_stopped_at", { withTimezone: true }),
    sendStoppedReason: text("send_stopped_reason").$type<SupportSendStoppedReason>(),
    /** When the approved text is deleted: 12 months after it was sent, or after the sending stopped without it going (0129; the row stays). */
    textDeleteAfter: timestamp("text_delete_after", { withTimezone: true }),
    /** Names, types and sizes only: an attachment is never opened or kept. */
    attachmentsJson: jsonb("attachments_json"),
    /**
     * An inbound email (lane P7g, drizzle/0130): SES's own message id, so a
     * notice SNS delivers twice is the same row; and an HMAC of the sender's
     * address (lib/support/inbound/facts.ts senderRef), so mail from one address can
     * be counted without the address being kept.
     */
    inboundMailId: text("inbound_mail_id"),
    senderRef: text("sender_ref"),
    /**
     * Lane P7h (drizzle/0131): the inbound bucket's key of this email's raw
     * message while it waits for the support drafter to read it.
     * Cleared when the object is deleted:
     * by the draft job in its finally, or by the hourly sweep after six hours.
     * Only ever 'mail/' || inbound_mail_id, and only ever set to null.
     */
    inboundObjectKey: text("inbound_object_key"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_messages_request_key").on(t.requestId),
    index("support_messages_case_idx").on(t.caseId, t.createdAt),
    // Lane P7g (drizzle/0130): one row per message SES received, and the
    // hour's count per sender.
    uniqueIndex("support_messages_inbound_mail_key").on(t.inboundMailId),
    index("support_messages_sender_idx").on(t.senderRef, t.receivedAt),
    // Lane P7h (drizzle/0131): the emails whose raw message still waits in the bucket.
    index("support_messages_object_pending_idx").on(t.caseId).where(sql`${t.inboundObjectKey} is not null`),
    // An inbound email is facts only (owner, lane P7g): no text, no subject,
    // no attachment name, ever; its fields and attachment summary are fixed
    // words and small numbers; and only an email carries SES's id and the
    // sender's reference.
    check(
      "support_messages_email_check",
      sql`(${t.kind} = 'email') = (${t.inboundMailId} is not null) and (${t.kind} = 'email') = (${t.senderRef} is not null) and (${t.kind} <> 'email' or (${t.direction} = 'in' and ${t.text} is null and ${t.subjectScreened} is null and ${t.draftText} is null and ${t.receivedAt} is not null and ${t.fieldsJson} is not null and ${t.inboundMailId} ~ '^[A-Za-z0-9._-]{1,128}$' and ${t.senderRef} ~ '^[0-9a-f]{64}$' and (${t.attachmentsJson} is null or (jsonb_typeof(${t.attachmentsJson}) = 'object' and char_length(${t.attachmentsJson}::text) <= 300 and ${t.attachmentsJson}::text ~ '^[a-z0-9_{}":, ]*$'))))`,
    ),
    // An inbound email's Message-ID and In-Reply-To are of one strict shape
    // (lib/support/inbound/parse.ts MESSAGE_ID): never a link, a quote or a
    // space, at most 250 characters, so a reply can always carry them.
    check(
      "support_messages_email_ids_check",
      sql`${t.kind} <> 'email' or ((${t.messageId} is null or (char_length(${t.messageId}) <= 250 and ${t.messageId} ~ '^<[A-Za-z0-9!#$%&*+.=?^_{|}~-]{1,200}@[A-Za-z0-9._-]{1,200}>$')) and (${t.inReplyTo} is null or (char_length(${t.inReplyTo}) <= 250 and ${t.inReplyTo} ~ '^<[A-Za-z0-9!#$%&*+.=?^_{|}~-]{1,200}@[A-Za-z0-9._-]{1,200}>$')))`,
    ),
    // Lane P7h (drizzle/0131): only an inbound email waits in the bucket, under its own SES id.
    check(
      "support_messages_object_key_check",
      sql`${t.inboundObjectKey} is null or (${t.kind} = 'email' and ${t.inboundObjectKey} = 'mail/' || ${t.inboundMailId})`,
    ),
    check("support_messages_direction_check", sql`${t.direction} in (${sqlList(SUPPORT_MESSAGE_DIRECTIONS)})`),
    check("support_messages_kind_check", sql`${t.kind} in (${sqlList(SUPPORT_MESSAGE_KINDS)})`),
    // A chat escalation carries no words: no text, subject, draft, ids of
    // mail or attachments, only its request id and its fields.
    check(
      "support_messages_chat_check",
      sql`(${t.kind} = 'chat_escalation') = (${t.requestId} is not null) and (${t.kind} <> 'chat_escalation' or (${t.direction} = 'in' and ${t.text} is null and ${t.subjectScreened} is null and ${t.draftText} is null and ${t.attachmentsJson} is null and ${t.messageId} is null and ${t.inReplyTo} is null and ${t.fieldsJson} is not null))`,
    ),
    check(
      "support_messages_fields_check",
      sql`${t.fieldsJson} is null or (jsonb_typeof(${t.fieldsJson}) = 'object' and char_length(${t.fieldsJson}::text) <= 1000 and position('@' in ${t.fieldsJson}::text) = 0 and ${t.fieldsJson}::text !~ '[0-9]{3,}')`,
    ),
    check(
      "support_messages_inbound_check",
      sql`${t.direction} <> 'in' or (${t.draftText} is null and ${t.draftVersion} is null and ${t.approvedByLabel} is null and ${t.approvedAt} is null and ${t.deliveryId} is null and ${t.sentAt} is null)`,
    ),
    check(
      "support_messages_text_check",
      sql`(${t.text} is null or char_length(${t.text}) <= 20000) and (${t.draftText} is null or char_length(${t.draftText}) <= 20000) and (${t.subjectScreened} is null or char_length(${t.subjectScreened}) <= 300) and (${t.messageId} is null or char_length(${t.messageId}) <= 998) and (${t.inReplyTo} is null or char_length(${t.inReplyTo}) <= 998)`,
    ),
    check(
      "support_messages_draft_check",
      sql`(${t.draftText} is null) = (${t.draftVersion} is null) and (${t.draftVersion} is null or ${t.draftVersion} >= 1)`,
    ),
    // A reply is ours, outbound. Its text is only ever the approved text: set
    // with the approval and its frozen subject and hash, never before. A send
    // stops once, sent or not; at most six tries (lib/support/send.ts).
    check(
      "support_messages_reply_check",
      sql`${t.kind} <> 'reply' or (${t.direction} = 'out' and (${t.approvedAt} is null) = (${t.approvedHash} is null) and (${t.approvedAt} is null) = (${t.replySubject} is null) and (${t.text} is null or ${t.approvedAt} is not null) and (${t.sentAt} is null or ${t.approvedAt} is not null) and (${t.nextSendAt} is null or ${t.approvedAt} is not null))`,
    ),
    check(
      "support_messages_send_check",
      sql`(${t.kind} = 'reply' or (${t.replySubject} is null and ${t.approvedHash} is null and ${t.sendAttempts} = 0 and ${t.nextSendAt} is null and ${t.sendStoppedAt} is null and ${t.textDeleteAfter} is null)) and ${t.sendAttempts} between 0 and ${sql.raw(String(SUPPORT_SEND_MAX_ATTEMPTS))} and (${t.approvedHash} is null or ${t.approvedHash} ~ '^[0-9a-f]{64}$') and (${t.replySubject} is null or char_length(${t.replySubject}) between 1 and 200) and (${t.sendStoppedAt} is null) = (${t.sendStoppedReason} is null) and (${t.sendStoppedReason} is null or ${t.sendStoppedReason} in (${sqlList(SUPPORT_SEND_STOPPED_REASONS)})) and not (${t.sendStoppedAt} is not null and ${t.sentAt} is not null) and (${t.textDeleteAfter} is null or ${t.sentAt} is not null or ${t.sendStoppedAt} is not null)`,
    ),
    check(
      "support_messages_approved_check",
      sql`(${t.approvedByLabel} is null) = (${t.approvedAt} is null) and (${t.approvedByLabel} is null or (char_length(${t.approvedByLabel}) between 1 and 60 and ${t.approvedByLabel} ~ '^[A-Za-z][A-Za-z .''-]*$'))`,
    ),
  ],
);
export type SupportMessage = typeof supportMessages.$inferSelect;

/**
 * The Slack message each support case's reply is shown in (ops automation
 * Phase 7, lane P7i; lib/support/slack-reply.ts). One row per case: the
 * channel and the message's ts, so a new draft version UPDATES the one
 * message (chat.update) and a decided, expired or closed item turns it into
 * its final state with the buttons gone. Ids, Slack's own ids, a version, a
 * state key of ids and codes, and the outcome of the last Slack call; never
 * the reply's words (those live on support_messages and in Slack). Not a
 * tenant table: written by the worker's sweep and the Slack route, outside
 * any clinic, like support_cases.
 */
export const supportSlackMessages = pgTable(
  "support_slack_messages",
  {
    caseId: uuid("case_id")
      .primaryKey()
      .references(() => supportCases.id, { onDelete: "cascade" }),
    /** Slack's channel id (C…), set once the first post is taken. */
    channel: text("channel"),
    /** Slack's id of the message ("1700000000.000100"), set once the first post is taken. */
    ts: text("ts"),
    /** The approval item the message shows now, and its draft version. */
    approvalId: uuid("approval_id"),
    draftVersion: integer("draft_version"),
    /** What the message shows: ids, statuses and codes joined; a new key means an update is owed. */
    shownKey: text("shown_key"),
    /** The message is in its final state: no buttons left. */
    final: boolean("final").notNull().default(false),
    /** Who holds the row while a Slack call is in flight (a lease), and when the next try may run. */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAt: timestamp("next_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** The last Slack call's failure: Slack's error code or an HTTP status, never a token. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("support_slack_messages_open_idx").on(t.final, t.nextAt),
    check(
      "support_slack_messages_ids_check",
      sql`(${t.channel} is null) = (${t.ts} is null) and (${t.channel} is null or ${t.channel} ~ '^[CDG][A-Z0-9]{2,30}$') and (${t.ts} is null or ${t.ts} ~ '^[0-9]{1,12}[.][0-9]{1,8}$')`,
    ),
    check(
      "support_slack_messages_key_check",
      sql`(${t.shownKey} is null or (char_length(${t.shownKey}) <= 300 and ${t.shownKey} ~ '^[A-Za-z0-9_:|.-]+$')) and (${t.draftVersion} is null or ${t.draftVersion} >= 1) and ${t.attempts} between 0 and 1000`,
    ),
    check(
      "support_slack_messages_error_check",
      sql`${t.lastError} is null or (char_length(${t.lastError}) <= 120 and ${t.lastError} ~ '^[a-z0-9_ ]+$')`,
    ),
  ],
);
export type SupportSlackMessage = typeof supportSlackMessages.$inferSelect;

// -----------------------------------------------------------------------------
// Gate B: the routed/answered counter (drizzle/0139)
// -----------------------------------------------------------------------------

/**
 * One row per call or conversation routed to AYA for a clinic, and what
 * became of it (lib/channels/routed-answered.ts; the words in
 * lib/channels/routed-words.ts): the runtime's count of what was routed
 * against what she answered, which the outage notices (L17, L18) and the
 * first-month guarantee's miss notice (L21) read.
 *
 * Counts, not records: the channel, an opaque reference (the SHA-256 of the
 * runtime's own id for the call or conversation, never the id itself, so the
 * row joins to nothing that names a person), closed words and times. Written
 * `pending` when the call or message reaches us, then resolved by the runtime
 * that took it, only ever towards the worse outcome (pending, excluded,
 * answered, missed; the trigger refuses any other move), so a retry, a
 * redelivery or a later message never turns a miss back into an answer.
 * Unique per clinic, channel and reference, so a retried write is the same
 * row. Kept for good beside usage_events (KEPT_FOR_GOOD): it is the record a
 * guarantee claim is checked against, and a claim may come after the account
 * has closed.
 */
export const routedInteractions = pgTable(
  "routed_interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<(typeof ROUTED_CHANNELS)[number]>().notNull(),
    /** SHA-256, hex, of the runtime's own reference for the call or conversation (routedRefHash). */
    refHash: text("ref_hash").notNull(),
    /** When the call, or the conversation's first message, reached us. */
    routedAt: timestamp("routed_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<RoutedOutcome>().notNull().default("pending"),
    reason: text("reason").$type<RoutedReason>(),
    /** When AYA first answered it, if she did. */
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** When the outcome last moved. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * When it was missed: the time the failing call or message reached us,
     * written once as the row becomes `missed`. A conversation's row keeps
     * its first message's `routed_at`, which on a Meta thread can be hours
     * before a later message failed; the outage sweep, the miss notice's day
     * and the missed-contact record date the miss by this instead.
     */
    failedAt: timestamp("failed_at", { withTimezone: true }),
  },
  (t) => [
    unique("routed_interactions_ref_key").on(t.clinicId, t.channel, t.refHash),
    index("routed_interactions_clinic_routed_idx").on(t.clinicId, t.routedAt),
    index("routed_interactions_clinic_failed_idx")
      .on(t.clinicId, t.failedAt)
      .where(sql`${t.failedAt} is not null`),
    index("routed_interactions_pending_idx")
      .on(t.routedAt)
      .where(sql`${t.outcome} = 'pending'`),
    check("routed_interactions_channel_check", sql`${t.channel} in (${sqlList(ROUTED_CHANNELS)})`),
    check("routed_interactions_outcome_check", sql`${t.outcome} in (${sqlList(ROUTED_OUTCOMES)})`),
    check(
      "routed_interactions_reason_check",
      sql`${t.reason} is null or ${t.reason} in (${sqlList(ROUTED_REASONS)})`,
    ),
    check("routed_interactions_ref_check", sql`${t.refHash} ~ '^[0-9a-f]{64}$'`),
    // Pending and answered carry no reason; an exclusion or a miss always does.
    check(
      "routed_interactions_reason_shape_check",
      sql`(${t.outcome} in ('pending', 'answered')) = (${t.reason} is null)`,
    ),
    // A miss, and only a miss, is dated.
    check("routed_interactions_failed_check", sql`(${t.outcome} = 'missed') = (${t.failedAt} is not null)`),
  ],
);
export type RoutedInteraction = typeof routedInteractions.$inferSelect;

/**
 * An outage incident (lib/channels/answer-notices.ts): opened in the
 * transaction that queues L17, so it is the one record L18 pairs with and
 * nothing else; closed in the one that queues L18, with when AYA answered
 * again and the calls and chats the counter shows went unanswered meanwhile.
 * One open at a time per clinic. `reply_by_at` is when the owner is told the
 * incident is still open (escalated_at), so "we'll keep you updated" cannot
 * go quiet. Counts, channel ids and times; no patient.
 */
export const answerOutages = pgTable(
  "answer_outages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** The first unanswered call or conversation after the last one answered. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }).notNull(),
    channels: text("channels").array().$type<(typeof ROUTED_CHANNELS)[number][]>().notNull(),
    status: text("status").$type<OutageStatus>().notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    replyByAt: timestamp("reply_by_at", { withTimezone: true }).notNull(),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalations: integer("escalations").notNull().default(0),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    callCount: integer("call_count"),
    chatCount: integer("chat_count"),
    /** When the sweep closed it (and queued L18, unless `quiet`). */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * Opened within OUTAGE_FLAP_WINDOW_MS of the last one closing: the clinic
     * is sent neither L17 nor L18 for it, and ops is told once instead
     * (lib/channels/answer-notices.ts, `aya_outage_flapping`).
     */
    quiet: boolean("quiet").notNull().default(false),
  },
  (t) => [
    unique("answer_outages_start_key").on(t.clinicId, t.startedAt),
    uniqueIndex("answer_outages_one_open_key")
      .on(t.clinicId)
      .where(sql`${t.status} = 'open'`),
    check("answer_outages_status_check", sql`${t.status} in (${sqlList(OUTAGE_STATUSES)})`),
    check(
      "answer_outages_channels_check",
      sql`cardinality(${t.channels}) between 1 and 3 and ${t.channels} <@ array[${sqlList(ROUTED_CHANNELS)}]::text[]`,
    ),
    check(
      "answer_outages_closed_check",
      sql`(${t.status} = 'closed') = (${t.endedAt} is not null) and (${t.status} = 'closed') = (${t.closedAt} is not null) and (${t.endedAt} is null) = (${t.callCount} is null) and (${t.endedAt} is null) = (${t.chatCount} is null) and coalesce(${t.callCount}, 0) >= 0 and coalesce(${t.chatCount}, 0) >= 0 and ${t.escalations} >= 0`,
    ),
  ],
);
export type AnswerOutage = typeof answerOutages.$inferSelect;

/**
 * A miss investigation (lib/channels/answer-notices.ts): opened in the
 * transaction that queues L21, on the practice's billing clinic, one per
 * channel and practice-local day (the collapse rule: a burst of misses is one
 * case with a count, and one email). Its `ref` is printed in L21's subject,
 * so the clinic's reply joins the support case it opens or the one already
 * linked (lib/support/inbound/match.ts, app_miss_case_support_case). The
 * owner moves it from open to looking, explained or closed in /admin's
 * queues. Ids, a channel, counts, days and times; no patient.
 */
export const missCases = pgTable(
  "miss_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    /** Five characters of Crockford base32, printed "HD-" + ref, as a support case's. */
    ref: text("ref").notNull(),
    channel: text("channel").$type<(typeof ROUTED_CHANNELS)[number]>().notNull(),
    /** The practice-local day of the misses. */
    missedOn: date("missed_on", { mode: "string" }).notNull(),
    firstMissedAt: timestamp("first_missed_at", { withTimezone: true }).notNull(),
    missCount: integer("miss_count").notNull(),
    status: text("status").$type<MissCaseStatus>().notNull().default("open"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    /** The day we look into it by: New York's next business day (replyByDay). */
    replyByOn: date("reply_by_on", { mode: "string" }).notNull(),
    statusAt: timestamp("status_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The support case the clinic's reply opened or joined, once it replied. */
    supportCaseId: uuid("support_case_id").references(() => supportCases.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("miss_cases_day_key").on(t.clinicId, t.channel, t.missedOn),
    uniqueIndex("miss_cases_ref_key").on(t.ref),
    index("miss_cases_status_idx").on(t.status, t.replyByOn),
    check("miss_cases_ref_check", sql`${t.ref} ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'`),
    check("miss_cases_channel_check", sql`${t.channel} in (${sqlList(ROUTED_CHANNELS)})`),
    check("miss_cases_status_check", sql`${t.status} in (${sqlList(MISS_CASE_STATUSES)})`),
    check("miss_cases_count_check", sql`${t.missCount} >= 1`),
    check("miss_cases_closed_check", sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  ],
);
export type MissCase = typeof missCases.$inferSelect;

/**
 * The 30-day missed-contact record (owner, 29 October 2026): one row per
 * call or conversation routed to AYA that she did not answer, so the clinic
 * can follow up. ⚠️ PHI: the caller's number next to the clinic. Held as
 * contacts hold a number (E.164, in this BAA-covered database under RLS,
 * never logged), and nothing else about the person: no words, no audio, no
 * transcript, nothing they said. `outcome` is where the call or message went
 * (lib/channels/routed-words.ts MISSED_OUTCOMES); `called_back_at` is the
 * clinic's tick in the portal; `closing_note` is the owner's one or two
 * plain lines when the miss case is explained, shown to the clinic in the
 * portal and never emailed. One per routed call or conversation (its
 * counter row's hashed reference). Deleted 30 days after `missed_at` by the
 * retention purge (MISSED_CONTACT_RETENTION_DAYS), with the clinic's data at
 * destruction, and by a person's erasure (by their number).
 */
export const missedContacts = pgTable(
  "missed_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    channel: text("channel").$type<(typeof ROUTED_CHANNELS)[number]>().notNull(),
    /** The counter row's reference (routed_interactions.ref_hash): one record per call or conversation. */
    refHash: text("ref_hash").notNull(),
    missedAt: timestamp("missed_at", { withTimezone: true }).notNull(),
    /** ⚠️ PHI. Never logged. E.164, when the caller's number was known. */
    callerPhone: text("caller_phone"),
    outcome: text("outcome").$type<MissedOutcome>().notNull(),
    reachedDirectLine: boolean("reached_direct_line").notNull(),
    calledBackAt: timestamp("called_back_at", { withTimezone: true }),
    closingNote: text("closing_note"),
    missCaseId: uuid("miss_case_id").references(() => missCases.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("missed_contacts_ref_key").on(t.clinicId, t.channel, t.refHash),
    index("missed_contacts_clinic_missed_idx").on(t.clinicId, t.missedAt),
    index("missed_contacts_purge_idx").on(t.missedAt),
    check("missed_contacts_channel_check", sql`${t.channel} in (${sqlList(ROUTED_CHANNELS)})`),
    check("missed_contacts_outcome_check", sql`${t.outcome} in (${sqlList(MISSED_OUTCOMES)})`),
    check("missed_contacts_ref_check", sql`${t.refHash} ~ '^[0-9a-f]{64}$'`),
    check("missed_contacts_phone_check", sql`${t.callerPhone} is null or ${t.callerPhone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check("missed_contacts_direct_check", sql`${t.reachedDirectLine} = (${t.outcome} = 'direct_line')`),
    // One or two plain lines: no address, no link, no markup.
    check(
      "missed_contacts_note_check",
      sql`${t.closingNote} is null or (char_length(${t.closingNote}) between 1 and 280 and ${t.closingNote} !~ '[@<>]|https?:|www\\.')`,
    ),
  ],
);
export type MissedContact = typeof missedContacts.$inferSelect;

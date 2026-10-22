/**
 * What the db-query task's database role may read (docs/design/db-access-2026-10-22.md).
 *
 * `healdesk_readonly` has no BYPASSRLS and owns nothing; it can SELECT exactly
 * the tables in READONLY_TABLES, which hold business and configuration data and
 * no patient's identity attached to health information (CLAUDE.md, "The PHI
 * boundary"). Everything else is named in READONLY_WITHHELD with the reason, so
 * a table cannot be added to the schema without someone deciding which list it
 * belongs on: tests/readonly-tables.test.ts fails on a table in neither list.
 *
 * The grants are applied by scripts/readonly-grants.ts as the migrator, after
 * the migrations of every migrate run. They are rebuilt from this file each
 * time (all table privileges revoked, then these granted), so removing a name
 * here removes the access on the next run, and a new table is invisible until
 * it is listed.
 *
 * Moving a table from "unreviewed" to READONLY_TABLES is a code review of its
 * columns, not of its name. The first list below is the owner's to approve
 * before the role is created.
 */

export const READONLY_ROLE = "healdesk_readonly";

/** Business and configuration tables an operator may read. */
export const READONLY_TABLES = [
  "agent_configs",
  "baa_acceptances",
  "calendar_elections",
  "clinic_channels",
  "clinic_closures",
  "clinic_provider_services",
  "clinic_providers",
  "clinic_settings",
  "clinic_settings_history",
  "clinic_setup_screens",
  "clinics",
  "entitlements",
  "platform_compliance",
  "provisioning_attempts",
  "usage_events",
] as const;

/** Tables the role can never read, and why. */
export const READONLY_WITHHELD: Record<string, "patient" | "credential" | "unreviewed"> = {
  // A person's identity, contact details or what they said or booked.
  appointments: "patient",
  booking_request_keys: "patient",
  booking_requests: "patient",
  chat_threads: "patient",
  channel_events: "patient",
  consent_records: "patient",
  contact_attempts: "patient",
  contacts: "patient",
  conversation_flags: "patient",
  conversations: "patient",
  deposit_payments: "patient",
  email_events: "patient",
  erasure_requests: "patient",
  handovers: "patient",
  incident_affected_contacts: "patient",
  meta_booking_drafts: "patient",
  meta_inbound_messages: "patient",
  patient_requests: "patient",
  reconciliation_exceptions: "patient",
  record_amendments: "patient",
  slot_holds: "patient",
  suppressions: "patient",
  transactions: "patient",
  transcript_emails: "patient",
  voice_redial_contexts: "patient",

  // Sign-in, sessions, factors, tokens and connections.
  account: "credential",
  clinic_memberships: "credential",
  connection_links: "credential",
  device_recoveries: "credential",
  factor_lockouts: "credential",
  google_oauth_states: "credential",
  invitation: "credential",
  member: "credential",
  organization: "credential",
  provider_connections: "credential",
  session: "credential",
  sign_in_address_changes: "credential",
  sign_in_links: "credential",
  step_ups: "credential",
  stripe_connect_events: "credential",
  stripe_connect_states: "credential",
  user: "credential",
  user_backup_codes: "credential",
  user_factors: "credential",
  verification: "credential",
  webauthn_challenges: "credential",

  // Not yet read column by column. Fail closed until someone does.
  agreement_resigns: "unreviewed",
  clinic_locations: "unreviewed",
  location_acknowledgements: "unreviewed",
  retell_recording_alerts: "unreviewed",
  voice_agents: "unreviewed",
  voice_number_order_days: "unreviewed",
  audit_log: "unreviewed",
  audit_review_queue: "unreviewed",
  billing_events: "unreviewed",
  billing_notices: "unreviewed",
  billing_requests: "unreviewed",
  billing_transitions: "unreviewed",
  checkout_intents: "unreviewed",
  clinic_touches: "unreviewed",
  email_daily_quota: "unreviewed",
  incidents: "unreviewed",
  ops_alerts: "unreviewed",
  overage_invoices: "unreviewed",
  practice_question_results: "unreviewed",
  practice_question_runs: "unreviewed",
  report_deliveries: "unreviewed",
  report_recipients: "unreviewed",
  scheduled_jobs: "unreviewed",
  security_events: "unreviewed",
  site_rereads: "unreviewed",
  sync_runs: "unreviewed",
  webhook_events: "unreviewed",
  website_changes: "unreviewed",
};

/** The migration journal, in drizzle's own schema: the host's schema version. */
export const READONLY_JOURNAL = { schema: "drizzle", table: "__drizzle_migrations" } as const;

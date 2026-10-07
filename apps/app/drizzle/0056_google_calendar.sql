CREATE SEQUENCE "public"."clinics_client_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "calendar_elections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"agreement_id" uuid NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"terms_kind" text NOT NULL,
	"clause_id" text NOT NULL,
	"calendar_account" text NOT NULL,
	"booking_sync" text NOT NULL,
	"booking_system" text NOT NULL,
	"document_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"document_released" boolean NOT NULL,
	"owner_confirmed" boolean DEFAULT false NOT NULL,
	"rendered_text" text,
	"elected_by_label" text NOT NULL,
	"elected_by_user_id" text,
	"link_id" uuid,
	"link_sent_to" text[],
	"ip_address" "inet",
	"user_agent" text,
	"elected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_elections_sequence_check" CHECK ("calendar_elections"."sequence" >= 1),
	CONSTRAINT "calendar_elections_source_check" CHECK ("calendar_elections"."source" in ('agreement', 'calendar_link', 'portal')),
	CONSTRAINT "calendar_elections_terms_kind_check" CHECK ("calendar_elections"."terms_kind" in ('covered', 'uncovered', 'not_used')),
	CONSTRAINT "calendar_elections_clause_check" CHECK ("calendar_elections"."clause_id" = 'google-calendar-' || replace("calendar_elections"."terms_kind", '_', '-')),
	CONSTRAINT "calendar_elections_account_check" CHECK ("calendar_elections"."calendar_account" in ('workspace_baa', 'workspace_no_baa', 'personal')),
	CONSTRAINT "calendar_elections_sync_check" CHECK ("calendar_elections"."booking_sync" in ('live', 'manual')),
	CONSTRAINT "calendar_elections_booking_system_check" CHECK ("calendar_elections"."booking_system" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "calendar_elections_version_check" CHECK (btrim("calendar_elections"."document_version") <> ''),
	CONSTRAINT "calendar_elections_hash_check" CHECK ("calendar_elections"."document_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "calendar_elections_label_check" CHECK (char_length(btrim("calendar_elections"."elected_by_label")) between 2 and 200),
	CONSTRAINT "calendar_elections_kind_consistent" CHECK (("calendar_elections"."booking_sync" = 'manual' and "calendar_elections"."terms_kind" = 'not_used')
        or ("calendar_elections"."booking_sync" = 'live' and "calendar_elections"."calendar_account" = 'workspace_baa' and "calendar_elections"."terms_kind" = 'covered')
        or ("calendar_elections"."booking_sync" = 'live' and "calendar_elections"."calendar_account" <> 'workspace_baa' and "calendar_elections"."terms_kind" = 'uncovered')),
	CONSTRAINT "calendar_elections_link_shape" CHECK (("calendar_elections"."source" = 'calendar_link') = ("calendar_elections"."link_id" is not null)),
	CONSTRAINT "calendar_elections_portal_shape" CHECK (("calendar_elections"."source" = 'portal') = ("calendar_elections"."elected_by_user_id" is not null)),
	CONSTRAINT "calendar_elections_rendered_shape" CHECK (("calendar_elections"."source" = 'agreement') = ("calendar_elections"."rendered_text" is null)),
	CONSTRAINT "calendar_elections_agreement_shape" CHECK ("calendar_elections"."source" <> 'agreement' or ("calendar_elections"."sequence" = 1 and "calendar_elections"."document_released" and not "calendar_elections"."owner_confirmed")),
	CONSTRAINT "calendar_elections_sent_to_shape" CHECK ("calendar_elections"."link_sent_to" is null or "calendar_elections"."link_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "clinic_provider_services" (
	"clinic_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"service_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_provider_services_provider_id_service_key_pk" PRIMARY KEY("provider_id","service_key"),
	CONSTRAINT "clinic_provider_services_key_check" CHECK ("clinic_provider_services"."service_key" = lower(btrim("clinic_provider_services"."service_key")) and char_length("clinic_provider_services"."service_key") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "clinic_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"calendar_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_providers_clinic_id_unique" UNIQUE("clinic_id","id"),
	CONSTRAINT "clinic_providers_display_name_check" CHECK (char_length(btrim("clinic_providers"."display_name")) between 1 and 80 and "clinic_providers"."display_name" !~ '[[:cntrl:]]'),
	CONSTRAINT "clinic_providers_calendar_id_check" CHECK (char_length("clinic_providers"."calendar_id") between 1 and 255 and "clinic_providers"."calendar_id" !~ '[[:space:][:cntrl:]]')
);
--> statement-breakpoint
CREATE TABLE "google_oauth_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"target_clinic_id" uuid NOT NULL,
	"initiated_via" text NOT NULL,
	"link_id" uuid,
	"user_id" text,
	"return_to" text NOT NULL,
	"browser_binding_hash" "bytea" NOT NULL,
	"disclosure_version" text NOT NULL,
	"disclosure_sha256" "bytea" NOT NULL,
	"disclosure_accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"consumed_ip" "inet",
	CONSTRAINT "google_oauth_states_hash_length" CHECK (octet_length("google_oauth_states"."state_hash") = 32),
	CONSTRAINT "google_oauth_states_binding_length" CHECK (octet_length("google_oauth_states"."browser_binding_hash") = 32),
	CONSTRAINT "google_oauth_states_disclosure_length" CHECK (octet_length("google_oauth_states"."disclosure_sha256") = 32),
	CONSTRAINT "google_oauth_states_expiry_check" CHECK ("google_oauth_states"."expires_at" > "google_oauth_states"."created_at" and "google_oauth_states"."expires_at" <= "google_oauth_states"."created_at" + interval '15 minutes'),
	CONSTRAINT "google_oauth_states_initiated_check" CHECK ("google_oauth_states"."initiated_via" in ('calendar_link', 'portal')),
	CONSTRAINT "google_oauth_states_return_check" CHECK ("google_oauth_states"."return_to" in ('calendar_link', 'portal', 'wizard')),
	CONSTRAINT "google_oauth_states_link_shape" CHECK (("google_oauth_states"."initiated_via" = 'calendar_link') = ("google_oauth_states"."link_id" is not null)
        and ("google_oauth_states"."initiated_via" = 'calendar_link') = ("google_oauth_states"."return_to" = 'calendar_link')),
	CONSTRAINT "google_oauth_states_portal_shape" CHECK (("google_oauth_states"."initiated_via" = 'portal') = ("google_oauth_states"."user_id" is not null)),
	CONSTRAINT "google_oauth_states_consumed_ip_check" CHECK ("google_oauth_states"."consumed_ip" is null or "google_oauth_states"."used_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "slot_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"holder_ref" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"duration_minutes" smallint NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT clock_timestamp() + interval '60 seconds' NOT NULL,
	"contact_id" uuid,
	"booking_request_id" uuid,
	"appointment_id" uuid,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"insert_attempted_at" timestamp with time zone,
	"blocks_until" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"check_attempts" smallint DEFAULT 0 NOT NULL,
	"outcome_reason" text,
	"released_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_holds_channel_check" CHECK ("slot_holds"."channel" in ('voice', 'web_chat', 'meta')),
	CONSTRAINT "slot_holds_holder_ref_check" CHECK ("slot_holds"."holder_ref" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "slot_holds_duration_check" CHECK ("slot_holds"."duration_minutes" between 5 and 480),
	CONSTRAINT "slot_holds_ends_check" CHECK ("slot_holds"."ends_at" = "slot_holds"."starts_at" + make_interval(mins => "slot_holds"."duration_minutes")),
	CONSTRAINT "slot_holds_status_check" CHECK ("slot_holds"."status" in ('held', 'reserved', 'writing', 'unknown', 'converted', 'released', 'expired')),
	CONSTRAINT "slot_holds_expiry_check" CHECK ("slot_holds"."expires_at" > "slot_holds"."created_at" and "slot_holds"."expires_at" <= "slot_holds"."created_at" + interval '2 minutes'),
	CONSTRAINT "slot_holds_blocks_until_check" CHECK ("slot_holds"."blocks_until" is null or "slot_holds"."blocks_until" <= "slot_holds"."created_at" + interval '1450 minutes'),
	CONSTRAINT "slot_holds_check_attempts_check" CHECK ("slot_holds"."check_attempts" >= 0),
	CONSTRAINT "slot_holds_outcome_reason_check" CHECK ("slot_holds"."outcome_reason" is null or "slot_holds"."outcome_reason" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "slot_holds_held_shape" CHECK ("slot_holds"."status" <> 'held' or ("slot_holds"."insert_attempted_at" is null and "slot_holds"."blocks_until" is null
        and "slot_holds"."lease_token" is null and "slot_holds"."lease_until" is null and "slot_holds"."next_check_at" is null)),
	CONSTRAINT "slot_holds_reserved_shape" CHECK ("slot_holds"."status" <> 'reserved' or ("slot_holds"."blocks_until" is not null and "slot_holds"."insert_attempted_at" is null)),
	CONSTRAINT "slot_holds_writing_shape" CHECK ("slot_holds"."status" <> 'writing' or ("slot_holds"."lease_token" is not null and "slot_holds"."lease_until" is not null
        and "slot_holds"."insert_attempted_at" is not null and "slot_holds"."blocks_until" is not null)),
	CONSTRAINT "slot_holds_unknown_shape" CHECK ("slot_holds"."status" <> 'unknown' or ("slot_holds"."insert_attempted_at" is not null and "slot_holds"."blocks_until" is not null
        and "slot_holds"."next_check_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "duration_minutes" smallint;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "booking_origin" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_write_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_write_attempts" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_write_lease" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_event_key" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "auto_confirm_bookings" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "auto_confirm_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "auto_confirm_changed_by_label" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "client_number" integer DEFAULT nextval('clinics_client_number_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_links" ADD COLUMN "sent_to" text[];--> statement-breakpoint
ALTER TABLE "connection_links" ADD COLUMN "audience" text DEFAULT 'recipients' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_links" ADD COLUMN "allows_account_change" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_links" ADD COLUMN "pending_election" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "account_ref" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "broken_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "broken_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "transient_failures" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_elections" ADD CONSTRAINT "calendar_elections_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_elections" ADD CONSTRAINT "calendar_elections_agreement_id_baa_acceptances_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."baa_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_provider_services" ADD CONSTRAINT "clinic_provider_services_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_provider_services" ADD CONSTRAINT "clinic_provider_services_provider_fk" FOREIGN KEY ("clinic_id","provider_id") REFERENCES "public"."clinic_providers"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_providers" ADD CONSTRAINT "clinic_providers_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_oauth_states" ADD CONSTRAINT "google_oauth_states_target_clinic_id_clinics_id_fk" FOREIGN KEY ("target_clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_booking_request_id_booking_requests_id_fk" FOREIGN KEY ("booking_request_id") REFERENCES "public"."booking_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_elections_clinic_sequence_idx" ON "calendar_elections" USING btree ("clinic_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "clinic_provider_services_service_idx" ON "clinic_provider_services" USING btree ("clinic_id","service_key");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_providers_active_calendar_idx" ON "clinic_providers" USING btree ("clinic_id","calendar_id") WHERE "clinic_providers"."active";--> statement-breakpoint
CREATE INDEX "google_oauth_states_created_idx" ON "google_oauth_states" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slot_holds_holder_held_idx" ON "slot_holds" USING btree ("clinic_id","holder_ref") WHERE "slot_holds"."status" = 'held';--> statement-breakpoint
CREATE UNIQUE INDEX "slot_holds_holder_writing_idx" ON "slot_holds" USING btree ("clinic_id","holder_ref") WHERE "slot_holds"."status" in ('writing', 'unknown');--> statement-breakpoint
CREATE INDEX "slot_holds_live_idx" ON "slot_holds" USING btree ("clinic_id","starts_at") WHERE "slot_holds"."status" in ('held', 'reserved', 'writing', 'unknown');--> statement-breakpoint
CREATE INDEX "slot_holds_unknown_due_idx" ON "slot_holds" USING btree ("next_check_at") WHERE "slot_holds"."status" = 'unknown';--> statement-breakpoint
CREATE INDEX "slot_holds_lease_idx" ON "slot_holds" USING btree ("lease_until") WHERE "slot_holds"."status" = 'writing';--> statement-breakpoint
CREATE INDEX "slot_holds_reserved_idx" ON "slot_holds" USING btree ("blocks_until") WHERE "slot_holds"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "slot_holds_request_idx" ON "slot_holds" USING btree ("booking_request_id") WHERE "slot_holds"."booking_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinics_client_number_idx" ON "clinics" USING btree ("client_number");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_google_account_live_idx" ON "provider_connections" USING btree ("provider","account_ref") WHERE "provider_connections"."account_ref" is not null and "provider_connections"."status" <> 'revoked';--> statement-breakpoint
ALTER TABLE "connection_links" ADD CONSTRAINT "connection_links_clinic_link_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_duration_check" CHECK ("appointments"."duration_minutes" is null or "appointments"."duration_minutes" between 5 and 480);--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booking_origin_check" CHECK ("appointments"."booking_origin" is null or "appointments"."booking_origin" in ('assistant', 'desk'));--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_write_attempts_check" CHECK ("appointments"."calendar_write_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_event_key_check" CHECK ("appointments"."calendar_event_key" is null or "appointments"."calendar_event_key" ~ '^(hold:)?[0-9a-f-]{36}$');--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_auto_confirm_stamp_check" CHECK (("clinic_settings"."auto_confirm_changed_at" is null) = ("clinic_settings"."auto_confirm_changed_by_label" is null));--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_client_number_positive" CHECK ("clinics"."client_number" > 0);--> statement-breakpoint
ALTER TABLE "connection_links" ADD CONSTRAINT "connection_links_audience_check" CHECK ("connection_links"."audience" in ('recipients', 'owner'));--> statement-breakpoint
ALTER TABLE "connection_links" ADD CONSTRAINT "connection_links_calendar_only_flags" CHECK ("connection_links"."purpose" = 'calendar' or ("connection_links"."audience" = 'recipients' and not "connection_links"."allows_account_change" and "connection_links"."pending_election" is null));--> statement-breakpoint
ALTER TABLE "connection_links" ADD CONSTRAINT "connection_links_account_change_owner" CHECK (not "connection_links"."allows_account_change" or "connection_links"."audience" = 'owner');--> statement-breakpoint
ALTER TABLE "connection_links" ADD CONSTRAINT "connection_links_pending_election_owner" CHECK ("connection_links"."pending_election" is null or ("connection_links"."audience" = 'owner' and jsonb_typeof("connection_links"."pending_election") = 'object'));--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_account_ref_check" CHECK ("provider_connections"."account_ref" is null or "provider_connections"."account_ref" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_transient_failures_check" CHECK ("provider_connections"."transient_failures" >= 0);--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_alert_needs_break" CHECK ("provider_connections"."broken_alerted_at" is null or "provider_connections"."broken_at" is not null);--> statement-breakpoint

-- =============================================================================
-- The Google Calendar connection, migration A (plan of 5 October 2026, §11,
-- with its binding addendum: client numbers, and named providers in v1).
-- Everything above this line was generated from schema.ts; everything below
-- is the part drizzle cannot express, or cannot put in a working order: the
-- client-number backfill, row-level security, grants, two (clinic, link)
-- foreign keys, the overlap guard and its lock, the triggers and functions
-- that hold the calendar terms, the job seed, the comments and the audit at
-- the end.
--
-- What this migration adds, in one paragraph. A location's calendar terms
-- are an append-only list of elections (calendar_elections): the first taken
-- from the signed agreement, every later one accepted by the practice, and
-- the newest under the agreement in effect deciding. A Google sign-in is a
-- single-use, browser-bound OAuth state (google_oauth_states). Time the
-- assistant is holding is a slot hold (slot_holds), and the database refuses
-- a hold or a healdesk booking that overlaps another, under one advisory
-- lock per clinic and with no extension. app_calendar_write_permitted() is
-- the database's own answer to "may healdesk write to this clinic's Google
-- Calendar now?", and a hold cannot start writing unless it says yes. Named
-- providers (clinic_providers, clinic_provider_services) are the spec's
-- provider-specific booking. Every clinic gets a client number, which will
-- label its sealed credentials (C6b), and neither it nor what a credential
-- is sealed to (a connection's id, clinic and provider) can be named or moved
-- by a writer. Calendar connections gain the account reference that keeps
-- one Google account live on one clinic and the breakage stamps the calendar
-- watch reads; appointments gain their duration, their origin and the desk
-- write's claim; clinic_settings gains Auto-confirm; connection_links gains
-- the calendar link's audience and flags; and a booking request whose desk
-- token was never delivered can have it re-issued.
--
-- Not here: app_appointment_write_guard, which refuses a desk write to
-- Google outside the terms. It is migration B, in the commit that makes the
-- desk path's writer terms-aware and Google-only, so main is never red
-- (plan §11.1).
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, and USAGE
-- and SELECT on every sequence, so those have ALREADY landed on each new
-- object by the time these statements run. Every REVOKE below is therefore
-- required, not defensive, and each GRANT restates the intended set so it
-- can be read in one place.
--
-- Safe to run: every new table is empty; every new column is nullable or has
-- a default, client_number included, which the generated ADD COLUMN filled
-- from the sequence and section 1 puts in order; the new trigger on
-- appointments ignores a row with no booking_origin, which is every row that
-- exists; the new triggers on clinics and provider_connections refuse only
-- what no code does (naming or changing a client number, moving a
-- connection to another id, clinic or provider); nothing reads the new
-- columns yet; and apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Client numbers, and what a credential is sealed to (addendum, "KMS
-- lock labels")
-- -----------------------------------------------------------------------------
-- Every clinic has a number, in the order clinics were created, so a
-- customer's second location gets the next one. It will label each
-- credential sealed for the clinic (healdesk:clinic in the KMS encryption
-- context, C6b), so it can never change. The ADD COLUMN above gave each
-- existing clinic a distinct number from the sequence, but in the order
-- Postgres rewrote the table, not the order of creation. Renumber by
-- (created_at, id), passing through a disjoint range first, because the
-- unique index is checked row by row and a direct permutation would collide
-- with itself. clinics is ENABLEd but not FORCEd (0002), so the owner sees
-- every row here.
UPDATE clinics SET client_number = client_number + 1000000000;--> statement-breakpoint
UPDATE clinics c
   SET client_number = ordered.n
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM clinics) ordered
 WHERE ordered.id = c.id;--> statement-breakpoint

-- The next clinic created gets the next number: max + 1, recorded as the
-- sequence's start as well as where it restarts, so the sequence itself says
-- where numbering began. Owned by the column, so the two live and die
-- together.
DO $$
DECLARE
  next_number bigint;
BEGIN
  SELECT coalesce(max(client_number), 0) + 1 INTO next_number FROM clinics;
  EXECUTE format('ALTER SEQUENCE clinics_client_number_seq START WITH %s RESTART WITH %s',
                 next_number, next_number);
END;
$$;--> statement-breakpoint
ALTER SEQUENCE clinics_client_number_seq OWNED BY clinics.client_number;--> statement-breakpoint

-- The runtime role inserts clinics (provisioning), so it draws numbers;
-- setval needs UPDATE on the sequence, which it does not get, so it can never
-- move the sequence. clinics carries column-level UPDATE grants since 0031,
-- which do not reach a column added later; the REVOKE says so in executable
-- form.
REVOKE ALL ON SEQUENCE clinics_client_number_seq FROM healdesk_app;--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE clinics_client_number_seq TO healdesk_app;--> statement-breakpoint
REVOKE UPDATE (client_number) ON clinics FROM healdesk_app;--> statement-breakpoint

-- And no role names a number or changes one, the migrator included: a
-- credential sealed under one number does not open under another, and a
-- label that could be moved would bind nothing (the AWS key policy is to be
-- conditioned on it). At insert the number must be the one the column
-- default has just drawn in this session (currval): a writer naming a free
-- number ahead of the sequence would choose its own label and make a later
-- provisioning fail on the unique index. Column INSERT grants cannot say
-- this, because drizzle names every column in its INSERT, the defaulted
-- ones included, and Postgres checks the privilege on every column named.
CREATE OR REPLACE FUNCTION app_clinic_client_number_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  drawn bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    BEGIN
      drawn := currval('clinics_client_number_seq');
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      drawn := NULL;
    END;
    IF drawn IS NULL OR NEW.client_number IS DISTINCT FROM drawn THEN
      RAISE EXCEPTION 'clinics.client_number is drawn by its column default; a writer never names one'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.client_number IS DISTINCT FROM OLD.client_number THEN
    RAISE EXCEPTION 'clinics.client_number never changes: it labels every credential sealed for the clinic'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER clinics_client_number_fixed
  BEFORE INSERT OR UPDATE OF client_number ON clinics
  FOR EACH ROW EXECUTE FUNCTION app_clinic_client_number_fixed();--> statement-breakpoint

-- The other half of the label is the connection's provider (healdesk:login),
-- and the envelope's AAD already binds the clinic and the row's id
-- (lib/crypto/envelope.ts). The addendum derives labels from immutable data
-- only, so none of the three moves either, for any role: a connection whose
-- provider or clinic could be edited would carry a label that binds nothing.
-- No code moves one (saveConnection rewrites them with the values it found
-- the row by); a reconnect writes the same row, and another provider is
-- another row.
CREATE OR REPLACE FUNCTION app_provider_connection_identity_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
  THEN
    RAISE EXCEPTION 'provider_connections: a connection''s id, clinic and provider never change; its credential is sealed to them'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER provider_connections_identity_fixed
  BEFORE UPDATE OF id, clinic_id, provider ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION app_provider_connection_identity_fixed();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Tenant tables: ENABLE + FORCE row-level security, one isolation policy
-- each, exactly as 0043. FORCE because the migrator owns the tables and an
-- owner bypasses policies otherwise; tests/rls-drift.test.ts asks the
-- catalogue for every table with a clinic_id and fails on any that is not
-- both. google_oauth_states has target_clinic_id instead (the callback reads
-- it before any tenant is known), like stripe_connect_states.
-- -----------------------------------------------------------------------------
ALTER TABLE calendar_elections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE calendar_elections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY calendar_elections_tenant_isolation ON calendar_elections
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE slot_holds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE slot_holds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY slot_holds_tenant_isolation ON slot_holds
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE clinic_providers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_providers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_providers_tenant_isolation ON clinic_providers
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE clinic_provider_services ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_provider_services FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_provider_services_tenant_isolation ON clinic_provider_services
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. The BAA gate. A hold is a time tied to a call, a contact and a request;
-- a provider and their services, beside a booking, say whose patient someone
-- is. None may be written for a production clinic without an agreement that
-- covers its data. tests/database-audit.test.ts pins the exact list.
-- calendar_elections is contract evidence and google_oauth_states identity
-- plane, neither PHI, so neither is gated.
-- -----------------------------------------------------------------------------
CREATE TRIGGER slot_holds_baa_gate
  BEFORE INSERT OR UPDATE ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint
CREATE TRIGGER clinic_providers_baa_gate
  BEFORE INSERT OR UPDATE ON clinic_providers
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint
CREATE TRIGGER clinic_provider_services_baa_gate
  BEFORE INSERT OR UPDATE ON clinic_provider_services
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Grants, table by table.
-- -----------------------------------------------------------------------------

-- calendar_elections: append-only. A location's terms change by recording
-- another election, never by editing one; the guard trigger (section 7)
-- holds the migrator to the same rule.
REVOKE ALL ON calendar_elections FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON calendar_elections TO healdesk_app;--> statement-breakpoint

-- google_oauth_states: append-then-consume, the sign_in_links rules (0043),
-- except that housekeeping deletes states older than a day: a state is
-- worthless fifteen minutes after it was minted, and keeps no record anyone
-- needs.
REVOKE ALL ON google_oauth_states FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON google_oauth_states TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (used_at, consumed_ip) ON google_oauth_states TO healdesk_app;--> statement-breakpoint

-- slot_holds: working state. Spent holds are deleted after a day, so DELETE
-- stays, for spent holds only: section 8's delete guard refuses, for every
-- role, a hold that still blocks. UPDATE of everything but who holds what and
-- when: the holder, the time and the hold's own window never move (the
-- transition trigger says the same to every role).
REVOKE ALL ON slot_holds FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON slot_holds TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, contact_id, booking_request_id, appointment_id, lease_token, lease_until,
              insert_attempted_at, blocks_until, next_check_at, check_attempts, outcome_reason,
              released_at, updated_at)
  ON slot_holds TO healdesk_app;--> statement-breakpoint

-- clinic_providers: configuration the wizard and Settings edit. Deactivated,
-- never deleted, so a hold or booking that names a provider keeps its row; a
-- provider never moves to another clinic.
REVOKE ALL ON clinic_providers FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_providers TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (display_name, calendar_id, active, updated_at) ON clinic_providers TO healdesk_app;--> statement-breakpoint

-- clinic_provider_services: a mapping is a fact, replaced by deleting and
-- inserting, never edited.
REVOKE ALL ON clinic_provider_services FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON clinic_provider_services TO healdesk_app;--> statement-breakpoint

-- The new columns on appointments, provider_connections and clinic_settings
-- need no GRANT: those tables give healdesk_app table-level UPDATE (0003,
-- 0043), which covers a column added later; each is written after insert by
-- a runtime path, and the audit at the end pins that they stay writable. The
-- new connection_links columns get none on purpose: that table's UPDATE is
-- (used_at, consumed_ip) only (0024), and the trigger in section 5 freezes
-- them for every role.

-- -----------------------------------------------------------------------------
-- 5. connection_links: the calendar link
-- -----------------------------------------------------------------------------
-- A fifth purpose, `calendar` (plan §4.1): the recipients link that connects
-- a location's Google Calendar, the owner's change and confirm links, and the
-- rotated continuation link. Resolution and consumption already compare the
-- purpose (lib/connections/links.ts), so a calendar token opens nothing else,
-- and no other token opens a calendar page.
ALTER TABLE connection_links DROP CONSTRAINT connection_links_purpose_known;--> statement-breakpoint
ALTER TABLE connection_links
  ADD CONSTRAINT connection_links_purpose_known CHECK (purpose IN ('connect', 'setup', 'meta', 'whatsapp', 'calendar'));--> statement-breakpoint

-- An election and a Google sign-in each name the calendar link they came
-- through, and the link must be one of their own clinic's: a sign-in started
-- from one clinic's link must not land on another clinic. Keyed on (clinic,
-- link), so the database says it whatever the writer's tenant could see;
-- foreign keys are checked past row-level security, which the identity-plane
-- google_oauth_states needs, and a NULL link_id is not checked. Written here
-- rather than in schema.ts because drizzle-kit emits a new table's foreign
-- keys before the unique constraint they need on an existing table
-- (connection_links_clinic_link_unique, generated above).
ALTER TABLE calendar_elections
  ADD CONSTRAINT calendar_elections_link_fk FOREIGN KEY (clinic_id, link_id)
  REFERENCES connection_links (clinic_id, id);--> statement-breakpoint
ALTER TABLE google_oauth_states
  ADD CONSTRAINT google_oauth_states_link_fk FOREIGN KEY (target_clinic_id, link_id)
  REFERENCES connection_links (clinic_id, id);--> statement-breakpoint

-- 0024's function, with the calendar link's purpose, audience, recipients and
-- flags frozen beside the issuance facts: who a link was mailed to, and
-- whether it lets the holder change the Google account or confirm a widening
-- election, are decided when it is minted and never after. purpose was frozen
-- only by grant until now. The search_path is pinned as every function since
-- 0031 pins it.
CREATE OR REPLACE FUNCTION app_connection_link_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION
      'connection_links row is already consumed and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.sent_to IS DISTINCT FROM OLD.sent_to
     OR NEW.allows_account_change IS DISTINCT FROM OLD.allows_account_change
     OR NEW.pending_election IS DISTINCT FROM OLD.pending_election
  THEN
    RAISE EXCEPTION
      'connection_links is append-then-consume: only used_at and consumed_ip may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 6. appointments: the claim backfill (the origin and time guard is in 8)
-- -----------------------------------------------------------------------------
-- A desk write stuck in `writing` from before this migration has no claim
-- time. The desk path's reclaim (C12) reads coalesce(calendar_write_claimed_at,
-- updated_at), and this records the claim as updated_at too, so such a row is
-- reclaimed after two minutes like any other instead of staying stuck.
-- appointments FORCEs row-level security, which binds the migrator as well
-- (0031 §1), so the update walks the tenants as withTenant() does and gives
-- the caller's setting back.
DO $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    UPDATE appointments
       SET calendar_write_claimed_at = updated_at
     WHERE clinic_id = c.id
       AND calendar_write_status = 'writing'
       AND calendar_write_claimed_at IS NULL;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 7. The calendar terms, in the database
-- -----------------------------------------------------------------------------

-- A demo clinic (plan A10): healdesk's own fictional practice, made by the
-- operator script, on which a draft election document may count so the
-- Google verification video can run before 1.3.0 is released. No paying
-- clinic can carry the marker: provisioning seeds `provisioning` or
-- `active`, a location gets no entitlements row, the billing state machine
-- has no edge into `demo`, and a clinic with any Stripe id or that went live
-- is not one. Invoker rights: it reads under the caller's tenant, so another
-- clinic is never demo from inside this one.
CREATE OR REPLACE FUNCTION app_clinic_is_demo(target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1
             FROM entitlements e
            WHERE e.clinic_id = target
              AND e.status = 'demo'
              AND e.stripe_subscription_id IS NULL
              AND e.stripe_customer_id IS NULL)
     AND EXISTS (
           SELECT 1
             FROM clinics c
            WHERE c.id = target
              AND c.data_classification = 'synthetic')
$$;--> statement-breakpoint

-- May healdesk write to this location's Google Calendar now? The same rule as
-- calendarTermsFor (lib/booking/terms.ts, C7), so the two cannot disagree:
--
--   1. the organisation has an agreement in effect, read through
--      app_agreement_in_effect() (0048), the one definition of it;
--   2. the location's newest election under that agreement is `covered` or
--      `uncovered`, and counts: an `agreement` row, a released document, or
--      a demo clinic. Never a fallback to an older row;
--   3. the location is not offboarding and its data not destroyed;
--   4. its Google Calendar connection is active or degraded, not broken, and
--      of the account kind the terms name (a Workspace account for the two
--      Workspace kinds, a personal one for `personal`);
--   5. for the assistant's own booking, Auto-confirm is on (on when the
--      location has no settings row). A staff confirmation does not ask.
--
-- Read by the hold transition below and by migration B's guard on the desk
-- write. Invoker rights: every table it reads is the caller's tenant's, so
-- outside a tenant it answers false. Total: false, never NULL.
CREATE OR REPLACE FUNCTION app_calendar_write_permitted(target uuid, for_assistant boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((
    SELECT e.terms_kind IN ('covered', 'uncovered')
           AND (e.source = 'agreement' OR e.document_released OR app_clinic_is_demo(target))
           AND EXISTS (
                 SELECT 1
                   FROM provider_connections p
                  WHERE p.clinic_id = target
                    AND p.provider = 'google_calendar'
                    AND p.status IN ('active', 'degraded')
                    AND p.broken_at IS NULL
                    AND p.metadata -> 'managed' = to_jsonb(e.calendar_account <> 'personal'))
           AND (NOT for_assistant
                OR coalesce((SELECT s.auto_confirm_bookings
                               FROM clinic_settings s
                              WHERE s.clinic_id = target), true))
      FROM clinics c
     CROSS JOIN LATERAL app_agreement_in_effect(c.organization_id) a
      JOIN LATERAL (
             SELECT el.terms_kind, el.source, el.document_released, el.calendar_account
               FROM calendar_elections el
              WHERE el.clinic_id = c.id
                AND el.agreement_id = a.agreement_id
              ORDER BY el.sequence DESC
              LIMIT 1) e ON true
     WHERE c.id = target
       AND c.offboarding_started_at IS NULL
       AND c.destroyed_at IS NULL
  ), false)
$$;--> statement-breakpoint

-- Two facts of the catalogue the guard below needs, written out because SQL
-- cannot read @healdesk/catalog: the app_baa_version_acceptable pattern
-- (0048), and tests/database-audit.test.ts fails while either disagrees with
-- the catalogue. Without them the guard would take the writer's word for
-- whether an election document is released and whether a booking system
-- reads Google, and app_calendar_write_permitted() would believe it.
--
-- The released election documents: CALENDAR_ELECTIONS with approvedByCounsel
-- true. None yet. calendar-election/1.0.0 stays a draft until the release
-- (plan C19), which needs a migration adding it here; until that lands an
-- election under it counts only for a demo clinic, which is the safe way
-- round. An allow-list, so a draft, an unknown string or NULL is unreleased.
CREATE OR REPLACE FUNCTION app_calendar_election_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY[]::text[]), false)
$$;--> statement-breakpoint

-- The booking systems that read a Google Calendar for conflicts, so that an
-- election naming one is live: bookingSyncFor() over BOOKING_SYSTEMS
-- (readsGoogleCalendar "yes"). Anything else, an unknown id included, is
-- manual, as there: the cost of a wrong "live" is a double booking. A system
-- confirmed later needs a migration adding it here.
CREATE OR REPLACE FUNCTION app_booking_system_live(system_id text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(system_id = ANY (ARRAY['google_calendar', 'calendly', 'calcom', 'gohighlevel', 'none']), false)
$$;--> statement-breakpoint

-- The election guard (plan §2.6, §11.6). On every INSERT: the row is
-- anchored to the organisation's agreement in effect; it takes the
-- location's next sequence number; an `agreement` row is recorded only for
-- the location set up at signing and must be exactly what the practice
-- signed (its clause among the signed clauses, and the same account kind,
-- booking system, version and hash); any other row must say of its document
-- and its booking system what the database's own copies of the catalogue
-- say, needs a released document unless the clinic is a demo clinic, must
-- carry the hash of its own text, and must come through one of this
-- location's live calendar links, as mailed, or one of its members' own
-- sign-in. owner_confirmed needs an owner link or the owner, and an election
-- that widens what reaches Google needs owner_confirmed: starting to write
-- where nothing was written, or moving a calendar out from under Google's
-- BAA (electionWidens() in @healdesk/catalog, written out). UPDATE and DELETE
-- are refused for every role: the list is the evidence.
--
-- After a supersede (app_supersede_agreement, 0051) no row is anchored to the
-- new agreement, so the location reads as needing an election, and its first
-- election under the new agreement widens and needs the owner. That fails
-- closed until the funnel and this build settle whether a superseding
-- signature's calendar clause should count for one location (the design
-- record's open item 2).
--
-- Invoker rights: it reads the agreement, the links and the memberships
-- under the caller's tenant, so another clinic's link or member is not
-- merely mismatched but invisible.
CREATE OR REPLACE FUNCTION app_calendar_election_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  billing_clinic uuid;
  in_effect uuid;
  signed record;
  via_link record;
  member_role clinic_role;
  owner_basis boolean;
  previous_kind text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'calendar_elections is append-only: a location''s calendar terms change by recording another election'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.organization_id, c.billing_clinic_id INTO org, billing_clinic
    FROM clinics c
   WHERE c.id = NEW.clinic_id;
  SELECT a.agreement_id INTO in_effect FROM app_agreement_in_effect(org) a;
  IF in_effect IS NULL OR NEW.agreement_id IS DISTINCT FROM in_effect THEN
    RAISE EXCEPTION 'calendar_elections: an election is recorded against the agreement in effect for the location''s organisation'
      USING ERRCODE = '23514';
  END IF;

  -- Two elections racing for one number meet the unique index; the loser's
  -- caller retries once, and is judged again here against the winner.
  SELECT coalesce(max(el.sequence), 0) + 1 INTO NEW.sequence
    FROM calendar_elections el
   WHERE el.clinic_id = NEW.clinic_id;

  IF NEW.source = 'agreement' THEN
    -- The signed clause "governs the calendar of the location Practice sets
    -- up when it signs this agreement"; for any other location "the calendar
    -- election Practice records for that location takes the place of this
    -- clause" (CALENDAR_LOCATION_PARAGRAPH). Provisioning makes a new
    -- organisation for each signature, and a location added later always
    -- names its billing clinic, so that location records an election, and
    -- its first one widens and needs the owner (plan §2.9).
    IF billing_clinic IS NOT NULL THEN
      RAISE EXCEPTION 'calendar_elections: an agreement row records the signed clause only for the location set up at signing; another location records an election'
        USING ERRCODE = '23514';
    END IF;
    SELECT b.document_version, b.document_hash, b.variables INTO signed
      FROM baa_acceptances b
     WHERE b.id = NEW.agreement_id;
    IF NEW.document_version IS DISTINCT FROM signed.document_version
       OR NEW.document_hash IS DISTINCT FROM signed.document_hash
       OR NOT coalesce((signed.variables -> 'appliedClauses') ? NEW.clause_id, false)
       OR NEW.calendar_account IS DISTINCT FROM signed.variables ->> 'calendarAccount'
       OR NEW.booking_system IS DISTINCT FROM signed.variables ->> 'bookingSystem'
       OR (signed.variables ? 'bookingSync'
           AND NEW.booking_sync IS DISTINCT FROM signed.variables ->> 'bookingSync')
    THEN
      RAISE EXCEPTION 'calendar_elections: an agreement row records exactly the calendar terms the practice signed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- What the document is and what the booking system does are the
  -- catalogue's to say, not the writer's (the two functions above). The
  -- sync then fixes the kind with the account (calendar_elections_kind_consistent).
  IF NEW.document_released IS DISTINCT FROM app_calendar_election_released(NEW.document_version) THEN
    RAISE EXCEPTION 'calendar_elections: document_released is what app_calendar_election_released() says of the version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.booking_sync IS DISTINCT FROM
       (CASE WHEN app_booking_system_live(NEW.booking_system) THEN 'live' ELSE 'manual' END) THEN
    RAISE EXCEPTION 'calendar_elections: booking_sync is what app_booking_system_live() says of the booking system'
      USING ERRCODE = '23514';
  END IF;

  IF NOT NEW.document_released AND NOT app_clinic_is_demo(NEW.clinic_id) THEN
    RAISE EXCEPTION 'calendar_elections: that election document is not released, and only a demo clinic may record a draft'
      USING ERRCODE = '42501';
  END IF;

  -- The text is the evidence, and the server rendered and hashed it
  -- (hashCalendarElection: SHA-256 of the UTF-8 text); a hash from anywhere
  -- else would point at nothing.
  IF NEW.document_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.rendered_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'calendar_elections: document_hash must be the SHA-256 of rendered_text'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source = 'calendar_link' THEN
    SELECT l.audience, l.used_at, l.expires_at, l.sent_to, l.pending_election INTO via_link
      FROM connection_links l
     WHERE l.id = NEW.link_id
       AND l.clinic_id = NEW.clinic_id
       AND l.purpose = 'calendar';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calendar_elections: the link is not one of this location''s calendar links'
        USING ERRCODE = '23514';
    END IF;
    -- A link speaks for its holder while it is live, by the clock link
    -- resolution uses (now()): the election is recorded before the same
    -- transaction consumes the link (plan §2.6), never after it was spent or
    -- once it has expired.
    IF via_link.used_at IS NOT NULL OR via_link.expires_at <= now() THEN
      RAISE EXCEPTION 'calendar_elections: that calendar link is spent or expired'
        USING ERRCODE = '42501';
    END IF;
    -- Who could have held it is the link's own record, copied.
    IF NEW.link_sent_to IS DISTINCT FROM via_link.sent_to THEN
      RAISE EXCEPTION 'calendar_elections: link_sent_to is the sent_to of the link the election came through'
        USING ERRCODE = '23514';
    END IF;
    -- A confirm link records the election it asks the owner to confirm and
    -- no other. Not its hash: the stored text carries the name the owner
    -- types on confirming, so the confirm page compares the re-rendered
    -- document instead (plan §4.1).
    IF via_link.pending_election IS NOT NULL
       AND (NEW.booking_system IS DISTINCT FROM via_link.pending_election ->> 'bookingSystem'
            OR NEW.calendar_account IS DISTINCT FROM via_link.pending_election ->> 'calendarAccount'
            OR NEW.document_version IS DISTINCT FROM via_link.pending_election ->> 'documentVersion')
    THEN
      RAISE EXCEPTION 'calendar_elections: a confirm link records only the election it asked the owner to confirm'
        USING ERRCODE = '23514';
    END IF;
    owner_basis := via_link.audience = 'owner';
  ELSE
    SELECT m.role INTO member_role
      FROM clinic_memberships m
     WHERE m.clinic_id = NEW.clinic_id
       AND m.user_id = NEW.elected_by_user_id
       AND m.revoked_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calendar_elections: that user holds no active membership of this location'
        USING ERRCODE = '42501';
    END IF;
    owner_basis := member_role = 'owner';
  END IF;

  IF NEW.owner_confirmed AND NOT owner_basis THEN
    RAISE EXCEPTION 'calendar_elections: only the practice owner confirms an election, through an owner link or their own sign-in'
      USING ERRCODE = '42501';
  END IF;

  SELECT el.terms_kind INTO previous_kind
    FROM calendar_elections el
   WHERE el.clinic_id = NEW.clinic_id
     AND el.agreement_id = in_effect
   ORDER BY el.sequence DESC
   LIMIT 1;
  IF NEW.terms_kind IN ('covered', 'uncovered')
     AND (coalesce(previous_kind, 'none') NOT IN ('covered', 'uncovered')
          OR (previous_kind = 'covered' AND NEW.terms_kind = 'uncovered'))
     AND NOT NEW.owner_confirmed
  THEN
    RAISE EXCEPTION 'calendar_elections: an election that lets more reach Google needs the practice owner''s confirmation'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER calendar_elections_guard
  BEFORE INSERT OR UPDATE OR DELETE ON calendar_elections
  FOR EACH ROW EXECUTE FUNCTION app_calendar_election_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 8. Overlap: slot holds and healdesk's own bookings (plan §7.1-7.3)
-- -----------------------------------------------------------------------------
-- Within one clinic (one Google calendar, one live connection per account),
-- no live hold overlaps another holder's live hold or a live healdesk
-- booking, and no live healdesk booking overlaps either. No extension: an
-- exclusion constraint cannot say "unexpired", so an expired hold would block
-- until a sweeper ran. Instead every writer that occupies time takes one
-- advisory lock per clinic and then asks this function, which reads the
-- committed state because it is VOLATILE and runs after the lock is granted
-- (READ COMMITTED: tenant.ts). Times are compared with clock_timestamp(),
-- never now(), so a transaction that waited on the lock sees real time.
-- Durations are at most 480 minutes, so a row starting more than 480
-- minutes before the span cannot reach it, and the search stays on a
-- bounded stretch of (clinic_id, starts_at) and appointments_clinic_idx.
-- Invoker rights: the caller's tenant.
CREATE OR REPLACE FUNCTION app_calendar_time_conflict(target_clinic uuid, span_start timestamptz,
                                                      span_end timestamptz, except_holder text,
                                                      except_appointment uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM slot_holds h
                  WHERE h.clinic_id = target_clinic AND h.holder_ref IS DISTINCT FROM except_holder
                    AND h.starts_at > span_start - interval '480 minutes' AND h.starts_at < span_end
                    AND span_start < h.ends_at
                    AND ((h.status = 'held' AND h.expires_at > clock_timestamp())
                         OR (h.status IN ('writing', 'unknown', 'reserved') AND h.blocks_until > clock_timestamp())))
      OR EXISTS (SELECT 1 FROM appointments a
                  WHERE a.clinic_id = target_clinic AND a.id IS DISTINCT FROM except_appointment
                    AND a.booking_origin IS NOT NULL AND a.status IN ('scheduled', 'confirmed')
                    AND a.scheduled_for > span_start - interval '480 minutes' AND a.scheduled_for < span_end
                    AND span_start < a.scheduled_for + make_interval(mins => coalesce(a.duration_minutes, 30)))
$$;--> statement-breakpoint

-- A hold is born `held`, with nothing written, leased or decided yet, and is
-- refused (23P01) when its time overlaps another holder's live hold or a
-- live healdesk booking. The holder's own holds never block it: the engine
-- supersedes them in the same transaction.
CREATE OR REPLACE FUNCTION app_slot_hold_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'held' THEN
    RAISE EXCEPTION 'slot_holds: a hold starts held; % is reached only by a transition', NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.insert_attempted_at IS NOT NULL
     OR NEW.blocks_until IS NOT NULL OR NEW.next_check_at IS NOT NULL OR NEW.appointment_id IS NOT NULL
     OR NEW.outcome_reason IS NOT NULL OR NEW.released_at IS NOT NULL OR NEW.check_attempts <> 0
  THEN
    RAISE EXCEPTION 'slot_holds: a new hold carries no lease, write or outcome'
      USING ERRCODE = '23514';
  END IF;
  -- The window runs from the moment the hold is placed, never from a time
  -- the writer chose: a created_at in the future would let a hold block for
  -- as long as it liked.
  IF NEW.created_at > clock_timestamp() THEN
    RAISE EXCEPTION 'slot_holds: a hold cannot be placed in the future'
      USING ERRCODE = '23514';
  END IF;
  -- Web chat collects a name and a number before any slot is held (spec,
  -- "How a session runs").
  IF NEW.channel = 'web_chat' AND NEW.contact_id IS NULL THEN
    RAISE EXCEPTION 'slot_holds: a web chat hold names the contact who asked for it'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || NEW.clinic_id::text, 0));
  IF app_calendar_time_conflict(NEW.clinic_id, NEW.starts_at,
                                NEW.starts_at + make_interval(mins => NEW.duration_minutes),
                                NEW.holder_ref, NULL) THEN
    RAISE EXCEPTION 'slot_holds: that time is already held or booked through healdesk'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER slot_holds_guard
  BEFORE INSERT ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_slot_hold_guard();--> statement-breakpoint

-- The states (plan §7.3):
--
--   held     → writing, reserved, released, expired
--   reserved → converted, released, expired
--   writing  → converted, released, unknown
--   unknown  → converted, released
--   converted, released, expired → nothing
--
-- Who holds what and when never changes. The insert attempt and the lease
-- token are written once, on held → writing, and the blocking window once,
-- on held → writing or held → reserved, so each hold makes at most one Google
-- insert and blocks for one bounded window. The two transitions that extend
-- the block take the clinic's calendar lock and need the hold still live by
-- the database clock; writing also needs app_calendar_write_permitted(), so a
-- hold cannot start a write the terms, the connection or Auto-confirm no
-- longer allow, whatever the application believes (23514). A reservation
-- names its request and lasts a day at most. The foreign keys may go to NULL
-- in any state (erasure); a converted hold's appointment is written once.
-- Final states are frozen.
CREATE OR REPLACE FUNCTION app_slot_hold_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.holder_ref IS DISTINCT FROM OLD.holder_ref
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'slot_holds: the holder, the time and the hold''s own window never change; hold the new time instead'
      USING ERRCODE = '42501';
  END IF;

  IF (OLD.contact_id IS NOT NULL AND NEW.contact_id IS NOT NULL AND NEW.contact_id <> OLD.contact_id)
     OR (OLD.booking_request_id IS NOT NULL AND NEW.booking_request_id IS NOT NULL
         AND NEW.booking_request_id <> OLD.booking_request_id)
     OR (OLD.appointment_id IS NOT NULL AND NEW.appointment_id IS NOT NULL
         AND NEW.appointment_id <> OLD.appointment_id)
  THEN
    RAISE EXCEPTION 'slot_holds: a hold''s contact, request and appointment are each set once'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status IN ('converted', 'released', 'expired')
     AND ((OLD.contact_id IS NULL AND NEW.contact_id IS NOT NULL)
          OR (OLD.booking_request_id IS NULL AND NEW.booking_request_id IS NOT NULL))
  THEN
    RAISE EXCEPTION 'slot_holds: a % hold takes no new contact or request', OLD.status
      USING ERRCODE = '42501';
  END IF;
  IF OLD.appointment_id IS NULL AND NEW.appointment_id IS NOT NULL AND NEW.status <> 'converted' THEN
    RAISE EXCEPTION 'slot_holds: only a converted hold names the appointment it became'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.insert_attempted_at IS DISTINCT FROM OLD.insert_attempted_at
        AND NOT (OLD.status = 'held' AND NEW.status = 'writing' AND OLD.insert_attempted_at IS NULL))
     OR (NEW.lease_token IS DISTINCT FROM OLD.lease_token
        AND NOT (OLD.status = 'held' AND NEW.status = 'writing' AND OLD.lease_token IS NULL))
     OR (NEW.blocks_until IS DISTINCT FROM OLD.blocks_until
        AND NOT (OLD.status = 'held' AND NEW.status IN ('writing', 'reserved') AND OLD.blocks_until IS NULL))
  THEN
    RAISE EXCEPTION 'slot_holds: the insert attempt, the lease token and the blocking window are written once, by the claim'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'held'     AND NEW.status IN ('writing', 'reserved', 'released', 'expired'))
      OR (OLD.status = 'reserved' AND NEW.status IN ('converted', 'released', 'expired'))
      OR (OLD.status = 'writing'  AND NEW.status IN ('converted', 'released', 'unknown'))
      OR (OLD.status = 'unknown'  AND NEW.status IN ('converted', 'released'))
    ) THEN
      RAISE EXCEPTION 'slot_holds: % -> % is not a permitted transition', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;

    IF OLD.status = 'held' AND NEW.status IN ('writing', 'reserved') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || NEW.clinic_id::text, 0));
      IF OLD.expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'slot_holds: the hold lapsed before it was claimed; hold the time again'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'writing' AND NOT app_calendar_write_permitted(NEW.clinic_id, true) THEN
        RAISE EXCEPTION 'slot_holds: the calendar terms, the Google connection or Auto-confirm no longer let the assistant write to this calendar'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'reserved' AND NEW.booking_request_id IS NULL THEN
        RAISE EXCEPTION 'slot_holds: a deposit reservation names the request staff will confirm'
          USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'reserved' AND NEW.blocks_until > clock_timestamp() + interval '1440 minutes' THEN
        RAISE EXCEPTION 'slot_holds: a deposit reservation blocks the time for a day at most'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF OLD.status IN ('converted', 'released', 'expired') THEN
    IF NEW.lease_until IS DISTINCT FROM OLD.lease_until
       OR NEW.next_check_at IS DISTINCT FROM OLD.next_check_at
       OR NEW.check_attempts IS DISTINCT FROM OLD.check_attempts
       OR NEW.outcome_reason IS DISTINCT FROM OLD.outcome_reason
       OR NEW.released_at IS DISTINCT FROM OLD.released_at
    THEN
      RAISE EXCEPTION 'slot_holds: a % hold is final', OLD.status
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER slot_holds_transition
  BEFORE UPDATE ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_slot_hold_transition();--> statement-breakpoint

-- A hold that still blocks is never deleted, by any role. A delete would
-- free its time at once, ahead of its own clock, and let an overlapping hold
-- or booking in while the Google write it stands for may yet land: the
-- write-once window above would mean nothing. Every delete the plan makes
-- reaches only holds that stopped blocking: placeHold's purge of final holds
-- older than a day, the retention purge at seven days, and destruction, which
-- comes weeks after offboarding released them (plan §7.5, §11.8). Time is
-- freed early by a transition (to released), which leaves its reason on the
-- row.
CREATE OR REPLACE FUNCTION app_slot_hold_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.status = 'held' AND OLD.expires_at > clock_timestamp())
     OR (OLD.status IN ('writing', 'unknown', 'reserved') AND OLD.blocks_until > clock_timestamp())
  THEN
    RAISE EXCEPTION 'slot_holds: a hold that still blocks is released, never deleted'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER slot_holds_delete_guard
  BEFORE DELETE ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_slot_hold_delete_guard();--> statement-breakpoint

-- A healdesk booking occupies time like a hold: one whose booking_origin is
-- set (the assistant's, or staff's on a location whose terms let healdesk
-- write) and whose status is live is refused (23P01) when it overlaps a live
-- hold or another such booking. booking_origin is written once, at insert
-- (42501 on any change). Every other row returns at once, which is every
-- row that exists today and every phase-two vendor upsert
-- (lib/sync/upsert.ts), so nothing that writes appointments now is touched.
CREATE OR REPLACE FUNCTION app_appointment_time_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.booking_origin IS DISTINCT FROM OLD.booking_origin THEN
    RAISE EXCEPTION 'appointments: booking_origin is written once, when the booking is recorded'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.booking_origin IS NULL OR NEW.status NOT IN ('scheduled', 'confirmed') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || NEW.clinic_id::text, 0));
  IF app_calendar_time_conflict(NEW.clinic_id, NEW.scheduled_for,
                                NEW.scheduled_for + make_interval(mins => coalesce(NEW.duration_minutes, 30)),
                                NULL, NEW.id) THEN
    RAISE EXCEPTION 'appointments: that time is already held or booked through healdesk'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER appointments_time_guard
  BEFORE INSERT OR UPDATE OF scheduled_for, duration_minutes, status, booking_origin ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_appointment_time_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 9. google_oauth_states: minted now, consumed once, frozen otherwise
-- -----------------------------------------------------------------------------
-- A state's fifteen minutes run from its created_at, so that is the
-- database's time, never a later one the writer chose: a state minted to
-- start next year would stay live until then. The slot_holds guard's rule;
-- the writer leaves created_at to its default.
CREATE OR REPLACE FUNCTION app_google_oauth_state_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.created_at > clock_timestamp() THEN
    RAISE EXCEPTION 'google_oauth_states: a state cannot be minted in the future'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER google_oauth_states_guard
  BEFORE INSERT ON google_oauth_states
  FOR EACH ROW EXECUTE FUNCTION app_google_oauth_state_guard();--> statement-breakpoint

-- The app_sign_in_link_no_rewrite pattern (0043). The column grant keeps the
-- runtime role off everything but used_at and consumed_ip; this stops a
-- consumed state being re-armed by clearing used_at, and binds the owner too.
CREATE OR REPLACE FUNCTION app_google_oauth_state_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'google_oauth_states row is already consumed and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.state_hash IS DISTINCT FROM OLD.state_hash
     OR NEW.target_clinic_id IS DISTINCT FROM OLD.target_clinic_id
     OR NEW.initiated_via IS DISTINCT FROM OLD.initiated_via
     OR NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.return_to IS DISTINCT FROM OLD.return_to
     OR NEW.browser_binding_hash IS DISTINCT FROM OLD.browser_binding_hash
     OR NEW.disclosure_version IS DISTINCT FROM OLD.disclosure_version
     OR NEW.disclosure_sha256 IS DISTINCT FROM OLD.disclosure_sha256
     OR NEW.disclosure_accepted_at IS DISTINCT FROM OLD.disclosure_accepted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'google_oauth_states is append-then-consume: only used_at and consumed_ip may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER google_oauth_states_no_rewrite
  BEFORE UPDATE ON google_oauth_states
  FOR EACH ROW EXECUTE FUNCTION app_google_oauth_state_no_rewrite();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 10. Across tenants: the watch's list, and whether an account is live
-- -----------------------------------------------------------------------------
-- Both walk the tenants one at a time, the 0034 and 0052 way:
-- provider_connections FORCEs row-level security, which binds the function's
-- owner too, so each sets the tenant per clinic, as withTenant() does, and
-- gives the caller's setting back, also on the way out of an error.

-- The calendar watch's work list (plan §9.2): every Google Calendar
-- connection not revoked, plus a revoked one whose breakage the clinic has
-- not yet been told about, on clinics whose data is not destroyed. Ids,
-- status, dates and whether the clinic is offboarding: no credential, no
-- account, no error text.
CREATE OR REPLACE FUNCTION app_calendar_connections()
RETURNS TABLE (clinic_id uuid, connection_id uuid, status connection_status, last_verified_at timestamptz,
               broken_at timestamptz, broken_alerted_at timestamptz, offboarding boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  BEGIN
    FOR c IN
      SELECT cl.id, (cl.offboarding_started_at IS NOT NULL) AS leaving
        FROM clinics cl
       WHERE cl.destroyed_at IS NULL
       ORDER BY cl.created_at
    LOOP
      PERFORM set_config('app.clinic_id', c.id::text, true);
      RETURN QUERY
        SELECT p.clinic_id, p.id, p.status, p.last_verified_at, p.broken_at, p.broken_alerted_at, c.leaving
          FROM provider_connections p
         WHERE p.clinic_id = c.id
           AND p.provider = 'google_calendar'
           AND (p.status <> 'revoked' OR (p.broken_at IS NOT NULL AND p.broken_alerted_at IS NULL))
         ORDER BY p.id;
    END LOOP;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_calendar_connections() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_calendar_connections() TO healdesk_app;--> statement-breakpoint

-- How many clinics hold this Google account live: 0 or 1, the unique index
-- provider_connections_google_account_live_idx being what makes it so
-- (plan §4.13). revokeGoogleGrantIfUnused revokes a grant at Google only
-- when this says 0, because Google's revoke ends every grant of that user to
-- the project. A count, nothing else; a malformed reference raises rather
-- than answering 0, so a caller's bug never reads as "unused".
CREATE OR REPLACE FUNCTION app_google_account_live_count(target_ref text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  live integer := 0;
  c record;
BEGIN
  IF target_ref IS NULL OR target_ref !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'An account reference is the sha256 hex of a Google subject.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    FOR c IN SELECT cl.id FROM clinics cl LOOP
      PERFORM set_config('app.clinic_id', c.id::text, true);
      live := live + (
        SELECT count(*)::integer
          FROM provider_connections p
         WHERE p.clinic_id = c.id
           AND p.provider = 'google_calendar'
           AND p.account_ref = target_ref
           AND p.status <> 'revoked');
    END LOOP;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;
  RETURN live;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_google_account_live_count(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_google_account_live_count(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 11. A desk token nobody received (plan §7.11)
-- -----------------------------------------------------------------------------
-- A request's desk token exists in memory until the notice carrying it is
-- sent. If the process dies first, the token is lost and the desk could
-- never open the request. The app_bind_agreement precedent (0031): this
-- function, and nothing else, may put a fresh token's hash on a request, and
-- only while the request is still `requested`, unexpired and no notice has
-- gone out, in the caller's own tenant. The runtime role keeps no UPDATE on
-- token_hash; the switch below is what the transition trigger reads, on for
-- this one statement and off again (and is_local, so a failure anywhere
-- reverts it with the transaction).
CREATE OR REPLACE FUNCTION app_reissue_undelivered_booking_token(target_request uuid, new_hash bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reissued boolean;
BEGIN
  IF new_hash IS NULL OR octet_length(new_hash) <> 32 THEN
    RAISE EXCEPTION 'A booking token is stored as its 32-byte SHA-256, never as itself.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM set_config('app.booking_token_reissue', 'on', true);
  UPDATE booking_requests
     SET token_hash = new_hash
   WHERE id = target_request
     AND clinic_id = app_current_clinic_id()
     AND desk_notified_at IS NULL
     AND status = 'requested'
     AND expires_at > now();
  reissued := FOUND;
  PERFORM set_config('app.booking_token_reissue', 'off', true);

  RETURN reissued;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_reissue_undelivered_booking_token(uuid, bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_reissue_undelivered_booking_token(uuid, bytea) TO healdesk_app;--> statement-breakpoint

-- 0041's function, unchanged except for one door: token_hash may change while
-- app_reissue_undelivered_booking_token() has its switch on, and then only on
-- a request that is and stays `requested` with no desk notice sent. The
-- permitted transitions are unchanged:
--
--   requested    → accepted, rescheduling, confirmed, declined, expired
--   accepted     → rescheduling, confirmed, expired
--   rescheduling → confirmed, declined, expired
--   confirmed, declined, expired → nothing
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  token_reissued boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'requested'    AND NEW.status IN ('accepted', 'rescheduling', 'confirmed', 'declined', 'expired'))
      OR (OLD.status = 'accepted'     AND NEW.status IN ('rescheduling', 'confirmed', 'expired'))
      OR (OLD.status = 'rescheduling' AND NEW.status IN ('confirmed', 'declined', 'expired'))
    ) THEN
      RAISE EXCEPTION 'booking_requests: % -> % is not a permitted transition; a decided request is already decided', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('confirmed', 'declined', 'expired')
        AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
             OR NEW.decided_by_label IS DISTINCT FROM OLD.decided_by_label
             OR NEW.desk_note IS DISTINCT FROM OLD.desk_note
             OR NEW.confirmed_for IS DISTINCT FROM OLD.confirmed_for
             OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id) THEN
    RAISE EXCEPTION 'booking_requests row is already decided and cannot be re-decided'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('confirmed', 'declined', 'expired')
     AND (NEW.proposed_slots IS DISTINCT FROM OLD.proposed_slots
          OR NEW.reschedule_expires_at IS DISTINCT FROM OLD.reschedule_expires_at
          OR NEW.collected_fields IS DISTINCT FROM OLD.collected_fields
          OR NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at) THEN
    RAISE EXCEPTION 'booking_requests: the request is % and its slots, fields and thread state are frozen', NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- Never NULL: current_setting(..., true) is NULL in a session that never
  -- defined the switch, and a NULL here would make the freeze below NULL,
  -- which an IF reads as false, letting any token through.
  token_reissued := coalesce(current_setting('app.booking_token_reissue', true), '') = 'on'
                    AND OLD.status = 'requested' AND NEW.status = 'requested'
                    AND OLD.desk_notified_at IS NULL AND NEW.desk_notified_at IS NULL;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR (OLD.conversation_id IS NOT NULL
         AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
         AND NEW.conversation_id IS NOT NULL)
     OR (NEW.token_hash IS DISTINCT FROM OLD.token_hash AND NOT token_reissued)
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.alternative_windows IS DISTINCT FROM OLD.alternative_windows
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.vendor_call_id IS DISTINCT FROM OLD.vendor_call_id
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 12. The calendar watch, seeded OFF like every job but the heartbeat. Its
-- owner is this build (plan §9, C10), and it is switched on from the console
-- at go-live, after queue:install and a worker restart (docs/on-call.md).
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('calendar-watch', 'Every 5 minutes on its own queue: forces a refresh and one free/busy probe per Google Calendar connection, disconnects what the terms no longer cover, flips a broken one to manual booking and alerts the clinic and ops once, resolves unconfirmed writes and owed desk notices, purges spent holds and OAuth states', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 13. Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE calendar_elections IS
  'One location''s calendar terms from elected_at on: which Google Calendar clause (covered, uncovered or not used) governs it, anchored to the organisation''s agreement in effect; the newest row under that agreement decides. Contract evidence, not PHI. Append-only for every role (app_calendar_election_guard), kept through offboarding and destruction.';--> statement-breakpoint
COMMENT ON COLUMN calendar_elections.document_released IS
  'Whether the document was released for use when the row was recorded. Never upgraded: a draft row stays a draft, and counts only for a demo clinic (app_clinic_is_demo).';--> statement-breakpoint
COMMENT ON COLUMN calendar_elections.owner_confirmed IS
  'The practice owner accepted it, through an owner-audience calendar link or the owner''s own sign-in. Required for an election that widens what reaches Google.';--> statement-breakpoint
COMMENT ON TABLE google_oauth_states IS
  'Single-use Google OAuth state, stored as SHA-256, bound to the browser that started the sign-in and recording the Google data-use notice accepted (version, hash, time). Minted at the database''s time, never in the future; its link, if any, is one of the target clinic''s own. target_clinic_id is not called clinic_id because the callback reads the row before any tenant is known. Not PHI. Purged after a day.';--> statement-breakpoint
COMMENT ON TABLE slot_holds IS
  'Time the assistant is holding on a clinic''s calendar: a 60-second hold, a Google write in flight or unconfirmed, or a deposit reservation, each blocking only while its own clock runs. The guard and transition triggers refuse overlaps (23P01) under one advisory lock per clinic and keep the states; a hold that still blocks is released, never deleted. PHI-adjacent: tenant RLS and the BAA gate.';--> statement-breakpoint
COMMENT ON COLUMN slot_holds.holder_ref IS
  'sha256 hex of the holder key (e.g. voice: plus the call id). Never the raw key.';--> statement-breakpoint
COMMENT ON TABLE clinic_providers IS
  'Named providers for provider-specific booking: a display name and the Google calendar their availability lives in, one active provider per calendar, on the location''s connected account (which the saving library checks). Deactivated, never deleted. Tenant RLS and the BAA gate.';--> statement-breakpoint
COMMENT ON TABLE clinic_provider_services IS
  'The service-to-provider mapping: which named provider offers which service, the service as the clinic''s own list names it, trimmed and lower-cased. Replaced by delete and insert, never edited. Tenant RLS and the BAA gate.';--> statement-breakpoint
COMMENT ON COLUMN clinics.client_number IS
  'The clinic''s number, in the order clinics were created (a customer''s second location gets the next). Labels every credential sealed for the clinic (healdesk:clinic in the KMS encryption context), so it is drawn by the column default and never named or changed: a trigger refuses both for every role, and healdesk_app holds no UPDATE on it or on the sequence.';--> statement-breakpoint
COMMENT ON COLUMN appointments.duration_minutes IS
  'Minutes the booking occupies, 5 to 480. NULL is read as 30 by the overlap guard.';--> statement-breakpoint
COMMENT ON COLUMN appointments.booking_origin IS
  'Who booked it through healdesk: assistant, or desk (staff confirming a request on a location whose calendar terms let healdesk write). Written once, at insert. Non-null makes a live appointment occupy time for the overlap guard; NULL leaves it out (phase-two vendor rows, and desk confirmations where nothing is written).';--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_write_claimed_at IS
  'When the current writing claim was taken. A claim older than two minutes is stuck and may be reclaimed (read back first).';--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_write_attempts IS
  'Calendar write attempts so far. The desk path claims at most five times.';--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_write_lease IS
  'Fencing token of the current claim: only the holder of the current lease records the outcome.';--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_event_key IS
  'What the Google event id is derived from: hold: plus the slot hold id when the assistant held the time, otherwise the booking request id. Written once (migration B).';--> statement-breakpoint
COMMENT ON COLUMN provider_connections.account_ref IS
  'sha256 hex of google: plus the Google subject. The raw subject is never stored. provider_connections_google_account_live_idx keeps one account live on one clinic.';--> statement-breakpoint
COMMENT ON COLUMN provider_connections.broken_at IS
  'When a definitive failure was first seen (access removed, the calendar gone). Cleared by a reconnect; kept on a revoked row until the clinic has been told.';--> statement-breakpoint
COMMENT ON COLUMN provider_connections.broken_alerted_at IS
  'When the clinic and ops were told about broken_at. Claimed once by the calendar watch; never set without broken_at.';--> statement-breakpoint
COMMENT ON COLUMN provider_connections.transient_failures IS
  'Consecutive transient probe failures. Three in a row degrade the connection to manual booking; never a flip on one miss.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.auto_confirm_bookings IS
  'Auto-confirm: on, the assistant''s booking goes into the calendar; off, every booking it takes is a request staff approve. On by default, as for a clinic with no row. Gates only the assistant''s own bookings (app_calendar_write_permitted).';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.auto_confirm_changed_at IS
  'When Auto-confirm was last changed. Set together with auto_confirm_changed_by_label.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.auto_confirm_changed_by_label IS
  'Who last changed Auto-confirm: the device or operator label the audit row names. Never a patient detail.';--> statement-breakpoint
COMMENT ON COLUMN connection_links.sent_to IS
  'The lower-cased addresses a calendar link was mailed to. Set at issue and frozen.';--> statement-breakpoint
COMMENT ON COLUMN connection_links.audience IS
  'recipients: the practice''s calendar contacts. owner: the practice owner only (a change of Google account, or confirming a widening election). Only a calendar link may be owner. Frozen.';--> statement-breakpoint
COMMENT ON COLUMN connection_links.allows_account_change IS
  'An owner''s change link: any Google account may connect through it. Frozen.';--> statement-breakpoint
COMMENT ON COLUMN connection_links.pending_election IS
  'An owner''s confirm link: the widening election the owner is asked to accept, as booking system, account kind, document version and hash. Frozen.';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.vendor_call_id IS
  'The conversation''s booking key (plan §7.13): the call id for the Synthflow harness, retell: plus the call id and a number for the Retell process, and so on per channel. Unique per clinic, which is what makes a retried booking a replay. Frozen after insert.';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.booked_via IS
  'Who attempted the booking: agent_direct, the assistant on the conversation (written before the outcome is known, so read status and decided_by_label for whether it was booked), or desk. Frozen after insert.';--> statement-breakpoint
COMMENT ON FUNCTION app_calendar_write_permitted(uuid, boolean) IS
  'True iff healdesk may write to the clinic''s Google Calendar now: an agreement in effect; the newest election under it covered or uncovered and acceptable (agreement row, released document, or demo clinic); not offboarding or destroyed; an active or degraded, unbroken google_calendar connection of the account kind the terms name; and, for the assistant, Auto-confirm on. The rule calendarTermsFor applies. Invoker; false outside a tenant.';--> statement-breakpoint
COMMENT ON FUNCTION app_calendar_election_released(text) IS
  'True for the calendar election document versions released for use: CALENDAR_ELECTIONS with approvedByCounsel true in @healdesk/catalog, written out (none yet). Must equal the catalogue (parity test in tests/database-audit.test.ts); a release needs a migration redefining it.';--> statement-breakpoint
COMMENT ON FUNCTION app_booking_system_live(text) IS
  'True for the booking systems that read a Google Calendar for conflicts, so an election naming one is live: bookingSyncFor() in @healdesk/catalog, written out. Unknown ids are manual. Must equal the catalogue (parity test in tests/database-audit.test.ts).';--> statement-breakpoint
COMMENT ON FUNCTION app_clinic_is_demo(uuid) IS
  'A demo clinic: entitlements status demo with no Stripe ids, and still synthetic. The only clinic on which a draft election document counts. Invoker.';--> statement-breakpoint
COMMENT ON FUNCTION app_calendar_time_conflict(uuid, timestamptz, timestamptz, text, uuid) IS
  'Whether [span_start, span_end) overlaps a live slot hold of another holder or a live healdesk appointment (booking_origin set) other than except_appointment. Call it after taking the clinic''s calendar lock. Invoker; VOLATILE, so it reads committed state.';--> statement-breakpoint
COMMENT ON FUNCTION app_calendar_connections() IS
  'The calendar watch''s work list across tenants: google_calendar connections not revoked, or revoked with an untold breakage, on clinics not destroyed, with an offboarding flag. A tenant walk because provider_connections FORCEs RLS; restores app.clinic_id, also on error. No credential, account or error text.';--> statement-breakpoint
COMMENT ON FUNCTION app_google_account_live_count(text) IS
  'How many clinics hold this Google account (account_ref) live: 0 or 1. Read before revoking a grant at Google. A count only; raises on a malformed reference.';--> statement-breakpoint
COMMENT ON FUNCTION app_reissue_undelivered_booking_token(uuid, bytea) IS
  'Puts a fresh token hash on a booking request of the caller''s tenant that is still requested, unexpired and never notified, so a desk notice can carry a working link after the original token died with its process. The only path to booking_requests.token_hash after insert.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 14. The posture, re-asserted: a later widening fails here, not in
-- production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  IF has_any_column_privilege('healdesk_app'::name, 'calendar_elections'::regclass, 'UPDATE')
     OR has_table_privilege('healdesk_app'::name, 'calendar_elections'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE or DELETE calendar_elections, which must stay append-only.';
  END IF;

  SELECT string_agg(col, ', ') INTO offending
    FROM unnest(ARRAY['id', 'clinic_id', 'channel', 'holder_ref', 'starts_at', 'duration_minutes',
                      'ends_at', 'created_at', 'expires_at']) AS col
   WHERE has_column_privilege('healdesk_app'::name, 'slot_holds'::regclass, col, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE who holds what and when on slot_holds: %', offending;
  END IF;

  SELECT string_agg(col, ', ') INTO offending
    FROM unnest(ARRAY['preferred_window', 'token_hash', 'expires_at', 'booked_via', 'vendor_call_id']) AS col
   WHERE has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, col, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a frozen booking_requests column: %', offending;
  END IF;

  SELECT string_agg(format('%s.%s', t, col), ', ') INTO offending
    FROM (VALUES ('appointments', 'duration_minutes'), ('appointments', 'booking_origin'),
                 ('appointments', 'calendar_write_claimed_at'), ('appointments', 'calendar_write_attempts'),
                 ('appointments', 'calendar_write_lease'), ('appointments', 'calendar_event_key'),
                 ('provider_connections', 'account_ref'), ('provider_connections', 'broken_at'),
                 ('provider_connections', 'broken_alerted_at'), ('provider_connections', 'transient_failures'),
                 ('clinic_settings', 'auto_confirm_bookings'), ('clinic_settings', 'auto_confirm_changed_at'),
                 ('clinic_settings', 'auto_confirm_changed_by_label')) AS v(t, col)
   WHERE NOT has_column_privilege('healdesk_app'::name, v.t::regclass, v.col, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app cannot UPDATE a calendar column added for a runtime writer: %', offending;
  END IF;

  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'client_number', 'UPDATE')
     OR has_sequence_privilege('healdesk_app'::name, 'clinics_client_number_seq', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can move a clinic''s client number, which labels its sealed credentials.';
  END IF;
  IF NOT has_sequence_privilege('healdesk_app'::name, 'clinics_client_number_seq', 'USAGE') THEN
    RAISE EXCEPTION 'healdesk_app cannot draw client numbers, so provisioning could not insert a clinic.';
  END IF;

  SELECT string_agg(col, ', ') INTO offending
    FROM unnest(ARRAY['purpose', 'audience', 'sent_to', 'allows_account_change', 'pending_election']) AS col
   WHERE has_column_privilege('healdesk_app'::name, 'connection_links'::regclass, col, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a connection_links column fixed at issue: %', offending;
  END IF;

  SELECT string_agg(a.attname, ', ') INTO offending
    FROM pg_attribute a
   WHERE a.attrelid = 'google_oauth_states'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('used_at', 'consumed_ip')
     AND has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a google_oauth_states column other than used_at and consumed_ip: %', offending;
  END IF;

  IF has_table_privilege('healdesk_app'::name, 'clinic_providers'::regclass, 'DELETE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_providers'::regclass, 'clinic_id', 'UPDATE')
     OR has_any_column_privilege('healdesk_app'::name, 'clinic_provider_services'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can delete a provider, move one to another clinic, or edit a service mapping.';
  END IF;

  SELECT string_agg(c.relname, ', ') INTO offending
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('calendar_elections', 'slot_holds', 'clinic_providers', 'clinic_provider_services')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Row-level security is not ENABLEd and FORCEd on: %', offending;
  END IF;

  -- Every rule above that binds the owner too is a trigger: each must exist
  -- on its table, enabled.
  SELECT string_agg(format('%s on %s', v.tg, v.rel), ', ') INTO offending
    FROM (VALUES ('clinics', 'clinics_client_number_fixed'),
                 ('provider_connections', 'provider_connections_identity_fixed'),
                 ('connection_links', 'connection_links_no_rewrite'),
                 ('calendar_elections', 'calendar_elections_guard'),
                 ('slot_holds', 'slot_holds_guard'),
                 ('slot_holds', 'slot_holds_transition'),
                 ('slot_holds', 'slot_holds_delete_guard'),
                 ('slot_holds', 'slot_holds_baa_gate'),
                 ('clinic_providers', 'clinic_providers_baa_gate'),
                 ('clinic_provider_services', 'clinic_provider_services_baa_gate'),
                 ('appointments', 'appointments_time_guard'),
                 ('google_oauth_states', 'google_oauth_states_guard'),
                 ('google_oauth_states', 'google_oauth_states_no_rewrite')) AS v(rel, tg)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger g
      WHERE g.tgrelid = v.rel::regclass
        AND g.tgname = v.tg
        AND g.tgenabled <> 'D');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or disabled trigger(s): %', offending;
  END IF;

  -- Every function this migration defines pins its search_path, and every
  -- one exists under the name the code will call.
  SELECT string_agg(f, ', ') INTO offending
    FROM unnest(ARRAY['app_clinic_client_number_fixed', 'app_provider_connection_identity_fixed',
                      'app_connection_link_no_rewrite', 'app_clinic_is_demo',
                      'app_calendar_write_permitted', 'app_calendar_election_released',
                      'app_booking_system_live', 'app_calendar_election_guard',
                      'app_calendar_time_conflict', 'app_slot_hold_guard', 'app_slot_hold_transition',
                      'app_slot_hold_delete_guard', 'app_appointment_time_guard',
                      'app_google_oauth_state_guard', 'app_google_oauth_state_no_rewrite',
                      'app_calendar_connections', 'app_google_account_live_count',
                      'app_reissue_undelivered_booking_token', 'app_booking_request_no_rewrite']) AS f
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = f
        AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing, or without a pinned search_path: %', offending;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND (has_function_privilege('public', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('healdesk_app', p.oid, 'EXECUTE'));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER function(s) executable by PUBLIC, or not by healdesk_app: %', offending;
  END IF;
END;
$$;
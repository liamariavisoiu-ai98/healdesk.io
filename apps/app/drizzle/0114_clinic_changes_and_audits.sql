CREATE TABLE "clinic_audit_claims" (
	"clinic_id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	CONSTRAINT "clinic_audit_claims_requested_by_check" CHECK (char_length("clinic_audit_claims"."requested_by") between 1 and 320)
);
--> statement-breakpoint
CREATE TABLE "clinic_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"pack" text NOT NULL,
	"trigger" text NOT NULL,
	"change_kind" text,
	"fingerprint" text,
	"result" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "clinic_audits_pack_check" CHECK ("clinic_audits"."pack" in ('availability', 'roster', 'golive', 'transcripts')),
	CONSTRAINT "clinic_audits_trigger_check" CHECK ("clinic_audits"."trigger" in ('change', 'change_detected', 'scheduled', 'manual')),
	CONSTRAINT "clinic_audits_result_check" CHECK ("clinic_audits"."result" in ('pass', 'warn', 'fail', 'error')),
	CONSTRAINT "clinic_audits_change_kind_check" CHECK ("clinic_audits"."change_kind" is null or "clinic_audits"."change_kind" in ('hours', 'closures', 'location_hours', 'providers', 'provider_services')),
	CONSTRAINT "clinic_audits_fingerprint_check" CHECK ("clinic_audits"."fingerprint" is null or "clinic_audits"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "clinic_audits_requested_by_check" CHECK (char_length("clinic_audits"."requested_by") between 1 and 320),
	CONSTRAINT "clinic_audits_checks_check" CHECK (jsonb_typeof("clinic_audits"."checks") = 'array')
);
--> statement-breakpoint
CREATE TABLE "clinic_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"location_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"actor_kind" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"alerted_at" timestamp with time zone,
	"audit_status" text,
	"audit_attempts" integer DEFAULT 0 NOT NULL,
	"audit_started_at" timestamp with time zone,
	"audit_id" uuid,
	"ops_acknowledged_at" timestamp with time zone,
	"ops_acknowledged_by" text,
	CONSTRAINT "clinic_change_events_kind_check" CHECK ("clinic_change_events"."kind" in ('hours', 'closures', 'location_hours', 'providers', 'provider_services')),
	CONSTRAINT "clinic_change_events_source_check" CHECK ("clinic_change_events"."source" in ('portal', 'wizard', 'website', 'calendar_link', 'ops_console', 'direct')),
	CONSTRAINT "clinic_change_events_audit_status_check" CHECK ("clinic_change_events"."audit_status" is null or "clinic_change_events"."audit_status" in ('queued', 'running', 'passed', 'attention', 'error')),
	CONSTRAINT "clinic_change_events_actor_kind_check" CHECK ("clinic_change_events"."actor_kind" in ('clinic_device', 'clinic_signin', 'ops', 'change_file', 'direct')),
	CONSTRAINT "clinic_change_events_audit_attempts_check" CHECK ("clinic_change_events"."audit_attempts" between 0 and 10),
	CONSTRAINT "clinic_change_events_acknowledged_check" CHECK (("clinic_change_events"."ops_acknowledged_at" is null) = ("clinic_change_events"."ops_acknowledged_by" is null)),
	CONSTRAINT "clinic_change_events_acknowledged_by_check" CHECK ("clinic_change_events"."ops_acknowledged_by" is null or char_length("clinic_change_events"."ops_acknowledged_by") between 1 and 320),
	CONSTRAINT "clinic_change_events_summary_check" CHECK (jsonb_typeof("clinic_change_events"."summary") = 'object')
);
--> statement-breakpoint
ALTER TABLE "clinic_audit_claims" ADD CONSTRAINT "clinic_audit_claims_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_audits" ADD CONSTRAINT "clinic_audits_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_change_events" ADD CONSTRAINT "clinic_change_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_audits_clinic_pack_idx" ON "clinic_audits" USING btree ("clinic_id","pack","started_at");--> statement-breakpoint
CREATE INDEX "clinic_change_events_clinic_idx" ON "clinic_change_events" USING btree ("clinic_id","changed_at");--> statement-breakpoint
CREATE INDEX "clinic_change_events_unalerted_idx" ON "clinic_change_events" USING btree ("changed_at") WHERE "clinic_change_events"."alerted_at" is null;--> statement-breakpoint
-- =============================================================================
-- Availability changes and the ops audits (23 October 2026; ops automation
-- designs E3 and E4, lane B). The statements above were generated from
-- schema.ts; everything below is the part drizzle cannot express.
--
-- clinic_change_events: one row for each change a clinic makes to its weekly
-- hours, closed days, a location's hours, its named providers or their
-- services, written in the save's own transaction (lib/clinic/change-events.ts),
-- so a save that rolls back leaves none. Ops hears of each once, from the
-- minute sweep (clinic_availability_changed, `alerted_at`), and the audit of
-- the change records how it went (`audit_status`, `audit_id`).
--
-- The safety net: ops may still write clinic_closures, clinic_providers and
-- clinic_provider_services through a change file (db-apply, owner decision
-- D8), and the migrator can through psql. Neither calls the app's writers, so
-- a statement trigger on each of the three records a count-only `direct` row
-- per clinic the statement touched: the table, the operation and how many
-- rows, nothing from the rows themselves, and whether it came through
-- db-apply (`change_file`) or elsewhere (`direct`). It stands aside only for
-- the app's own sessions (session_user healdesk_app), whose writers record
-- their changes themselves with the detail the trigger cannot see; for a
-- clinic that already has a change row written by an app writer (not this
-- trigger) in the same transaction, something the change file's role cannot
-- forge, since it may not insert one; and for a clinic whose account has
-- closed, which has nobody to tell. Each other statement gets its own row,
-- so a transaction's insert, insert and update are three. No setting turns
-- it off. A statement that touched no row records nothing. While the
-- clinic-audits job is on, the row waits for its audit like any other
-- change.
--
-- app_clinics_changed_in_transaction(): which clinics have a change row
-- written in the current transaction, for db-apply to check after its
-- statement that the run touched only the clinic it named (granted to the
-- change file's role only). Ids only.
--
-- clinic_audits: one run of one audit pack (lib/audits): ids, codes, counts
-- and a fingerprint. The runtime role keeps the last 20 per clinic and pack
-- and deletes older ones, so it alone of the two may DELETE.
--
-- Both tables are tenant plane, forced row-level security like their
-- neighbours, business data with no patient: readable by the db-query role
-- (scripts/readonly-tables.ts), writable by no change file, and deleted when
-- the account closes (app_close_clinic_account, copied whole below from 0109
-- with the two deletes added).
--
-- app_clinic_change_work(): the minute sweep's walk across clinics, as
-- app_open_agreement_resigns (0088) walks them: per clinic with work, how
-- many changes wait for their alert and how many for their audit, and when
-- the newest of those was made. A change still `running` 15 minutes after
-- its audit started belongs to a run that stopped, and counts as waiting
-- again (lib/audits/jobs.ts gives up after three attempts). Counts and ids
-- only.
--
-- Two jobs, both seeded OFF, each with its own lock: `clinic-audits`, the
-- minute's audits after a change, and `clinic-audits-hourly`, the hourly
-- fingerprint check and the 04 UTC run. While they are off no audit runs on
-- its own (a change is still recorded and still told to ops); the owner
-- switches them on from /admin's job list.
--
-- Safe to apply in place: two new, empty tables with their policies, grants
-- and triggers on three small tables, one function replaced with two more
-- deletes, one job row.
-- =============================================================================

ALTER TABLE clinic_change_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_change_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_change_events_tenant_isolation ON clinic_change_events
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
ALTER TABLE clinic_audit_claims ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_audit_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_audit_claims_tenant_isolation ON clinic_audit_claims
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
ALTER TABLE clinic_audits ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_audits FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_audits_tenant_isolation ON clinic_audits
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants. 0003's default privileges have already given healdesk_app full DML
-- on the new tables, so each REVOKE is required. A change row is never
-- rewritten: only its alert, audit and acknowledgement columns move.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON clinic_change_events FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_change_events TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (alerted_at, audit_status, audit_attempts, audit_started_at, audit_id,
              ops_acknowledged_at, ops_acknowledged_by)
  ON clinic_change_events TO healdesk_app;--> statement-breakpoint
REVOKE UPDATE, TRUNCATE ON clinic_audits FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON clinic_audits TO healdesk_app;--> statement-breakpoint
REVOKE TRUNCATE ON clinic_audit_claims FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON clinic_audit_claims TO healdesk_app;--> statement-breakpoint

-- After the closure, nothing writes either again (0096's freeze; the closure
-- deletes them).
CREATE TRIGGER clinic_change_events_closed_account
  BEFORE INSERT OR UPDATE ON clinic_change_events
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint
CREATE TRIGGER clinic_audits_closed_account
  BEFORE INSERT OR UPDATE ON clinic_audits
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint
CREATE TRIGGER clinic_audit_claims_closed_account
  BEFORE INSERT OR UPDATE ON clinic_audit_claims
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The safety net. One function, nine statement triggers (a trigger with a
-- transition table takes one event), each naming the changed rows
-- `changed_rows`. A definer, because the change file's role may write the
-- three tables and nothing else; it sets the tenant per clinic, since the
-- table forces row-level security on its owner too, and puts the caller's
-- setting back.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_record_direct_clinic_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  change_kind text := CASE TG_TABLE_NAME
                        WHEN 'clinic_closures' THEN 'closures'
                        WHEN 'clinic_providers' THEN 'providers'
                        ELSE 'provider_services'
                      END;
  c record;
BEGIN
  IF session_user = 'healdesk_app' THEN
    RETURN NULL;
  END IF;
  FOR c IN SELECT r.clinic_id, count(*)::int AS n FROM changed_rows r GROUP BY r.clinic_id LOOP
    -- A clinic deleted in this statement (its rows going by cascade), or
    -- whose account has closed, has nobody left to tell.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM clinics cl WHERE cl.id = c.clinic_id AND cl.account_closed_at IS NULL
    );
    PERFORM set_config('app.clinic_id', c.clinic_id::text, true);
    -- Already recorded in this transaction by an app writer, which may
    -- insert one; never by this trigger's own earlier row.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM clinic_change_events e
       WHERE e.clinic_id = c.clinic_id
         AND e.source <> 'direct'
         AND e.xmin = pg_current_xact_id()::xid
    );
    INSERT INTO clinic_change_events (clinic_id, kind, source, actor_kind, summary, audit_status)
    VALUES (
      c.clinic_id,
      change_kind,
      'direct',
      CASE WHEN current_setting('application_name', true) LIKE 'db-apply:%' THEN 'change_file' ELSE 'direct' END,
      jsonb_build_object('rows', c.n, 'operation', lower(TG_OP), 'table', TG_TABLE_NAME),
      CASE WHEN EXISTS (SELECT 1 FROM scheduled_jobs j WHERE j.name = 'clinic-audits' AND j.enabled)
           THEN 'queued' END
    );
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_record_direct_clinic_change() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_clinics_changed_in_transaction()
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.id LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    IF EXISTS (SELECT 1 FROM clinic_change_events e
                WHERE e.clinic_id = c.id AND e.xmin = pg_current_xact_id()::xid) THEN
      RETURN NEXT c.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_changed_in_transaction() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_changed_in_transaction() TO healdesk_writer;--> statement-breakpoint

CREATE TRIGGER clinic_closures_direct_insert AFTER INSERT ON clinic_closures
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_closures_direct_update AFTER UPDATE ON clinic_closures
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_closures_direct_delete AFTER DELETE ON clinic_closures
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_providers_direct_insert AFTER INSERT ON clinic_providers
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_providers_direct_update AFTER UPDATE ON clinic_providers
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_providers_direct_delete AFTER DELETE ON clinic_providers
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_provider_services_direct_insert AFTER INSERT ON clinic_provider_services
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_provider_services_direct_update AFTER UPDATE ON clinic_provider_services
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint
CREATE TRIGGER clinic_provider_services_direct_delete AFTER DELETE ON clinic_provider_services
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app_record_direct_clinic_change();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The minute sweep's walk. Ids, counts and one instant per clinic with work.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_clinic_change_work()
RETURNS TABLE (clinic_id uuid, unalerted integer, queued integer, last_queued_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  stale timestamptz := clock_timestamp() - interval '15 minutes';
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.destroyed_at IS NULL ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT e.clinic_id,
             (count(*) FILTER (WHERE e.alerted_at IS NULL))::int,
             (count(*) FILTER (WHERE e.audit_status = 'queued' OR (e.audit_status = 'running' AND e.audit_started_at < stale)))::int,
             max(e.changed_at) FILTER (WHERE e.audit_status = 'queued' OR (e.audit_status = 'running' AND e.audit_started_at < stale))
        FROM clinic_change_events e
       WHERE e.clinic_id = c.id
         AND (e.alerted_at IS NULL OR e.audit_status = 'queued' OR (e.audit_status = 'running' AND e.audit_started_at < stale))
       GROUP BY e.clinic_id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_change_work() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_change_work() TO healdesk_app;--> statement-breakpoint

-- 0109's app_close_clinic_account, copied whole, with the change rows and
-- the audits added to what it deletes, beside our other notes on the
-- account. tests/booking-request-destruction reads its deletes as the
-- closure's list.
CREATE OR REPLACE FUNCTION app_close_clinic_account(target_clinic uuid, notice_to text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  clinic_row record;
  waiting text;
  holders text[];
  uid text;
  other record;
  kept boolean;
  n integer;
  ended integer := 0;
  done jsonb := '{}'::jsonb;
  kept_address text := nullif(lower(btrim(coalesce(notice_to, ''))), '');
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_close_clinic_account: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.account_closed_at, c.offboarding_started_at
    INTO clinic_row
    FROM clinics c
   WHERE c.id = target_clinic
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_close_clinic_account: no clinic %', target_clinic USING ERRCODE = 'no_data_found';
  END IF;
  IF clinic_row.account_closed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  waiting := app_account_closure_waiting_on(target_clinic);
  IF waiting IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic %''s account cannot close yet: %.', target_clinic, waiting
      USING ERRCODE = 'check_violation',
            HINT = 'not_destroyed and pass_through wait for the clock; voice_agent for the agent''s release recorded on the care page; incident_open, critical_notice and stripe_connect for what they name (app_account_closure_waiting_on).';
  END IF;
  IF kept_address IS NOT NULL
     AND (char_length(kept_address) NOT BETWEEN 3 AND 254
          OR kept_address !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$') THEN
    kept_address := NULL;
  END IF;

  -- The sign-in. Who held a live grant is read first; an address change still
  -- open is ended, so nothing moves an address back onto a closed sign-in;
  -- the grants are revoked and kept; and each person whose last live grant
  -- this was loses every way in and every detail of theirs.
  holders := ARRAY(SELECT DISTINCT m.user_id FROM clinic_memberships m
                    WHERE m.clinic_id = target_clinic AND m.revoked_at IS NULL);
  UPDATE sign_in_address_changes a
     SET status = CASE a.status WHEN 'awaiting_confirmation' THEN 'expired' ELSE 'failed' END,
         resolved_at = now(),
         resolution = 'The account closed.'
   WHERE a.clinic_id = target_clinic
     AND a.status IN ('awaiting_confirmation', 'pending');
  UPDATE clinic_memberships m SET revoked_at = now()
   WHERE m.clinic_id = target_clinic AND m.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('memberships_revoked', n);
  FOREACH uid IN ARRAY holders LOOP
    kept := false;
    -- clinic_memberships is FORCEd, so even its owner sees one tenant at a
    -- time: walk the other clinics of the person's organisations, as
    -- app_user_clinic_grants does (0043), and put the tenant back.
    FOR other IN
      SELECT cl.id FROM clinics cl
       WHERE cl.id <> target_clinic
         AND cl.organization_id IN (SELECT mb.organization_id FROM member mb WHERE mb.user_id = uid)
    LOOP
      PERFORM set_config('app.clinic_id', other.id::text, true);
      IF EXISTS (SELECT 1 FROM clinic_memberships m
                  WHERE m.clinic_id = other.id AND m.user_id = uid AND m.revoked_at IS NULL) THEN
        kept := true;
        EXIT;
      END IF;
    END LOOP;
    PERFORM set_config('app.clinic_id', target_clinic::text, true);
    IF NOT kept THEN
      DELETE FROM step_ups s WHERE s.user_id = uid;
      DELETE FROM factor_lockouts f WHERE f.user_id = uid;
      DELETE FROM webauthn_challenges w WHERE w.user_id = uid;
      DELETE FROM user_backup_codes b WHERE b.user_id = uid;
      DELETE FROM user_factors f WHERE f.user_id = uid;
      DELETE FROM sign_in_links l WHERE l.user_id = uid;
      DELETE FROM device_recoveries d WHERE d.user_id = uid;
      DELETE FROM session s WHERE s.user_id = uid;
      DELETE FROM account a WHERE a.user_id = uid;
      DELETE FROM invitation i WHERE i.inviter_id = uid;
      DELETE FROM member mb WHERE mb.user_id = uid;
      -- Better Auth's own rows for the person. As lib/auth.ts configures it
      -- (passwords off, no social sign-in, no OTP or magic-link plugin), the
      -- only ones that name a user are core's reset-password:<token> and
      -- delete-account-<token>, each holding that user's id, whole, as its
      -- value (better-auth 1.6.26, api/routes/password.mjs and
      -- update-user.mjs; identifiers stored plain). So they are matched on
      -- the id, exactly, never on the address, which can sit inside another
      -- person's (a@b.com inside xa@b.com). A plugin that keys its rows by
      -- the address (email-otp's <type>-otp-<email>) would need its exact
      -- form added here before it is turned on.
      DELETE FROM verification v WHERE v.value = uid;
      -- Kept as the tombstone the audit log's actor id points at: a
      -- non-routable address (RFC 2606's .invalid), no name, no picture.
      UPDATE "user" u
         SET email = 'closed+' || replace(gen_random_uuid()::text, '-', '') || '@invalid',
             name = 'Closed account',
             image = NULL,
             email_verified = false,
             updated_at = now()
       WHERE u.id = uid;
      ended := ended + 1;
    END IF;
  END LOOP;
  done := done || jsonb_build_object('sign_ins_ended', ended);

  -- The setup.
  DELETE FROM agent_configs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('agent_configs', n);
  DELETE FROM clinic_settings_history x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_settings_history', n);
  DELETE FROM clinic_settings x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_settings', n);
  DELETE FROM report_recipients x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('report_recipients', n);
  DELETE FROM audit_review_queue x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('audit_review_queue', n);
  DELETE FROM practice_question_results x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('practice_question_results', n);
  DELETE FROM practice_question_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('practice_question_runs', n);
  DELETE FROM website_changes x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('website_changes', n);
  DELETE FROM site_rereads x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('site_rereads', n);
  -- The account's locations (0109): their addresses, lines and hours,
  -- business data, no patient. The acceptance each later one was added
  -- under is kept with the agreement (location_acknowledgements).
  DELETE FROM clinic_locations x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_locations', n);

  -- Our own business data about the account.
  DELETE FROM clinic_touches x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_touches', n);
  -- The availability changes ops was told of and its audits (0114):
  -- counts, dates and codes about the practice, no patient.
  DELETE FROM clinic_change_events x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_change_events', n);
  DELETE FROM clinic_audits x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_audits', n);
  DELETE FROM clinic_audit_claims x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_audit_claims', n);
  DELETE FROM sync_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('sync_runs', n);
  -- A link a calendar election was signed through is part of that
  -- election's record (0057), and an OAuth state in flight still names its
  -- link; every other link goes.
  DELETE FROM connection_links x WHERE x.clinic_id = target_clinic
     AND NOT EXISTS (SELECT 1 FROM calendar_elections e WHERE e.clinic_id = x.clinic_id AND e.link_id = x.id)
     AND NOT EXISTS (SELECT 1 FROM google_oauth_states s WHERE s.target_clinic_id = x.clinic_id AND s.link_id = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('connection_links', n);
  -- The checkout the clinic was provisioned from: the buyer's details and
  -- the website read at checkout (no clinic_id, so not on the catalog's
  -- lists; billing-housekeeping deletes the same rows 90 days after use).
  DELETE FROM checkout_intents ci WHERE ci.provisioned_clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('checkout_intents', n);

  -- The setup columns of the clinic row, and the closure beside them: every
  -- column the practice or the wizard set up, how calls were routed and
  -- when it went live included, back to its default. What stays, and why:
  --   name, slug, specialty, time zone and address: the kept records name
  --     the practice by them;
  --   the published number: the widget a clinic has not yet taken off its
  --     website shows it as the number to call;
  --   is_covered_entity, the agreement kind and regime, the BAA stamps, the
  --     data classification and the direct-booking clause: terms of the
  --     signed agreement;
  --   the record clock (retention_*_days and its shortening): the clock the
  --     agreement's retention clause ran on, which the kept audit of each
  --     purge and the destruction refers to;
  --   billing_clinic_id, the Stripe Connect disconnect and client_number:
  --     billing records, and the label the destroyed credentials were sealed
  --     under;
  --   the offboarding dates, the destruction notice address and the
  --     organisation: what destruction and its notice ran on.
  UPDATE clinics c
     SET site_profile = NULL,
         onboarding = '{}'::jsonb,
         opening_hours = NULL,
         booking_requirements = NULL,
         booking_requirements_source = NULL,
         booking_requirements_confirmed_at = NULL,
         forwarding_test_observed = NULL,
         forwarding_test_until = NULL,
         website = NULL,
         booking_provider = NULL,
         pos_provider = NULL,
         carrier = NULL,
         phone_system_type = 'unknown',
         average_treatment_value_usd = NULL,
         booking_mode = 'desk_confirms',
         meta_front_door_enabled = false,
         stripe_connect_connected_at = NULL,
         call_routing = 'conditional',
         call_routing_confirmed_at = NULL,
         timezone_confirmed_at = NULL,
         agent_approved_at = NULL,
         went_live_at = NULL,
         attribution_mode = 'estimated',
         plan = NULL,
         notice_address = kept_address,
         notice_address_until = CASE WHEN kept_address IS NULL THEN NULL
                                     ELSE clinic_row.offboarding_started_at + interval '6 years' END,
         account_closed_at = now(),
         updated_at = now()
   WHERE c.id = target_clinic;

  RETURN done;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_close_clinic_account(uuid, text) IS
  'Closes a clinic''s account once app_account_closure_waiting_on() says nothing is left: revokes its memberships and, for each person whose last live grant it held, deletes every way in (sessions, accounts, verifications, factors, codes, challenges, step-ups, lockouts, sign-in links, device recovery links, invitations, organisation memberships) and tombstones the user row, which the audit log keeps naming; deletes its setup, its locations (0109), touches, availability changes and audits (0114), sync runs, unnamed connection links and checkout intents; clears the clinic row''s setup columns; keeps the notice address for six years after the service ended; stamps clinics.account_closed_at. Returns what it did by table, or NULL when already closed. No patient data.';--> statement-breakpoint

COMMENT ON TABLE clinic_change_events IS
  'One change a clinic made to its hours, closed days, a location''s hours, its providers or their services: kind, source, a coarse kind of actor, counts and dates (YYYY-MM-DD) only. Written in the save''s transaction, or by the direct-change trigger for any other session. Alerted to ops once (alerted_at); audited (audit_status, audit_id); acknowledged on the console. No patient. Deleted when the account closes.';--> statement-breakpoint
COMMENT ON TABLE clinic_audit_claims IS
  'An operator''s manual audit of one clinic in progress: claimed before the run, deleted after, stale after two minutes. The operator''s address and a time; no patient. Deleted when the account closes.';--> statement-breakpoint
COMMENT ON TABLE clinic_audits IS
  'One run of one ops audit pack for one clinic (lib/audits): codes, counts, fixed hints and a fingerprint, never a name, a time of day or free text. The last 20 per clinic and pack are kept. No patient. Deleted when the account closes.';--> statement-breakpoint

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('clinic-audits', 'Every minute from the billing-minute queue, and hourly from the tick as a backstop: audits each clinic two minutes after its last change to hours, closed days or providers, three at most a run. Reads only, and records its results for ops. Off until the owner switches it on', false),
  ('clinic-audits-hourly', 'Hourly; audits a clinic whose availability changed with nothing recorded, and daily at 04 UTC every audit pack for every clinic in service. Reads only, and records its results for ops. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;

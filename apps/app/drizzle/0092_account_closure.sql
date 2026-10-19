ALTER TABLE "sign_in_address_changes" DROP CONSTRAINT "sign_in_address_changes_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "sign_in_address_changes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "account_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sign_in_address_changes" ADD CONSTRAINT "sign_in_address_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- =============================================================================
-- Closing the account (wave 2, R8, 19 October 2026). The four statements above
-- were generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The spec closes a clinic "keeping only the signed agreement and the billing
-- records the law requires" (Stage 1; Terms §3 and §7; contracts §2: "the
-- account and its setup data are removed"). Destruction (destroyClinicData,
-- app_mark_clinic_destroyed) takes every patient row on the day the
-- agreement's Term clause gives, and nothing else: until today the sign-in,
-- the setup and the clinic's business data stayed for good, and nothing ever
-- deleted the account.
--
-- app_close_clinic_account() is the second step. It runs once the data is
-- destroyed and the Terms' pass-through has ended (the end of the service
-- plus FORWARDING_PASS_THROUGH_DAYS, 30, the moment AYA's number is released),
-- because until then a forwarded call still passes through to the direct line
-- that clinic_settings holds, and E3's last notice still goes to the clinic's
-- address. It deletes, in the clinic's own tenant:
--
--   * the sign-in: every clinic_memberships row, and each user whose last
--     membership that was (Better Auth's sessions, accounts, org members and
--     invitations, and our factors, backup codes, passkey challenges,
--     step-ups, lockouts and sign-in links go with the user, by cascade);
--   * the setup: agent_configs, clinic_settings with its history,
--     report_recipients, the practice questions and their review queue, the
--     website re-reads and what they found, the setup columns of the clinic
--     row (the scraped site profile, the onboarding answers, the opening
--     hours, the booking requirements, the forwarding test, the website);
--   * our own business data about the account: clinic_touches, sync_runs
--     (phase two), and every connection link no calendar election names.
--
-- and keeps, for the reasons tests/booking-request-destruction.test.ts lists
-- (KEPT_FOR_GOOD, held to the catalog): the clinic row (name, slug,
-- published number and address: what the kept records point at, and what the
-- widget still on the clinic's website shows visitors to call), the audit
-- log, the agreements (calendar elections, re-signs, the links elections were
-- signed through), the billing records, the notices given and their ledger,
-- the incidents, and the record of each notice address the practice gave
-- (sign_in_address_changes, whose user_id the user's deletion nulls, above).
--
-- Like destruction it is the database's: the function refuses a clinic that
-- is not the transaction's tenant, not destroyed, or still in its
-- pass-through, by the database's clock in hours and in UTC; it stamps
-- clinics.account_closed_at, which the runtime role cannot write and a new
-- clinic cannot carry; and a second call changes nothing.
--
-- Safe to apply in place: one nullable column, one relaxed NOT NULL with its
-- foreign key now SET NULL, two guards redefined to allow strictly more
-- (the address change's, only the null its user's deletion writes) or strictly
-- less (the insert guard), and two new functions. apps/app holds synthetic
-- and seed data only (CLAUDE.md).
-- =============================================================================

COMMENT ON COLUMN clinics.account_closed_at IS
  'The account was closed by app_close_clinic_account(): after destruction and the pass-through, its sign-in, setup and business data deleted, keeping the agreements, billing records, notices, incidents, audit log and notice-address record. The database''s to stamp; the runtime role cannot write it.';--> statement-breakpoint

-- The runtime role's UPDATE on clinics is column by column (0003 onwards), so
-- the new column is not in it; this says so, as 0058 does for the dates.
REVOKE UPDATE (account_closed_at) ON clinics FROM healdesk_app;--> statement-breakpoint

-- 0066's insert guard, with account_closed_at added to what a new clinic
-- cannot carry: a clinic born closed would be one whose sign-in the closure
-- never removed.
CREATE OR REPLACE FUNCTION app_clinic_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.offboarding_started_at IS NOT NULL
     OR NEW.destroy_after IS NOT NULL
     OR NEW.destroyed_at IS NOT NULL
     OR NEW.export_delivered_at IS NOT NULL
     OR NEW.account_closed_at IS NOT NULL
     OR NEW.retention_record_days_previous IS NOT NULL
     OR NEW.retention_record_days_shortened_at IS NOT NULL THEN
    RAISE EXCEPTION 'clinics: a new clinic carries no offboarding date, no export delivery, no closure and no record-clock history; app_start_offboarding, app_mark_export_delivered, app_mark_clinic_destroyed, app_close_clinic_account and the clinics_record_clock trigger write them'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.data_classification IS DISTINCT FROM 'synthetic' OR NEW.baa_signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'clinics: a new clinic is synthetic and unsigned; only app_mark_clinic_production() takes a clinic live'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- 0084's guard on an address change, which kept who, which addresses and the
-- link fixed and a final change final, now lets one thing through: user_id
-- becoming null, with nothing else moving, once that user no longer exists.
-- That is the foreign key's ON DELETE SET NULL when the closure deletes the
-- sign-in; it cannot be anyone repointing a change, which needs a user that
-- exists, and the runtime role holds no UPDATE on user_id anyway.
CREATE OR REPLACE FUNCTION app_address_change_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  unchanged sign_in_address_changes%ROWTYPE;
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = OLD.user_id) THEN
    unchanged := NEW;
    unchanged.user_id := OLD.user_id;
    IF ROW(unchanged.*) IS NOT DISTINCT FROM ROW(OLD.*) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.old_email IS DISTINCT FROM OLD.old_email
     OR NEW.new_email IS DISTINCT FROM OLD.new_email
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.confirm_token_hash IS DISTINCT FROM OLD.confirm_token_hash THEN
    RAISE EXCEPTION 'sign_in_address_changes: who, which addresses and the link are fixed once asked for.';
  END IF;
  IF NEW.status = OLD.status THEN
    IF OLD.status NOT IN ('awaiting_confirmation', 'pending') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'sign_in_address_changes: a % change is final.', OLD.status;
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status = 'awaiting_confirmation' AND NEW.status IN ('pending', 'stopped', 'expired'))
     OR (OLD.status = 'pending' AND NEW.status IN ('applied', 'stopped', 'failed')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sign_in_address_changes: % cannot become %.', OLD.status, NEW.status;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_address_change_transition_guard() FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_close_clinic_account: the closure itself, in the tenant's transaction.
-- Returns what it deleted, by table, or NULL when the account was closed
-- already. The deletes below are one list with KEPT_FOR_GOOD and destruction's:
-- tests/booking-request-destruction.test.ts reads them from this source and
-- fails if a table with a clinic_id is on none of the three.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_close_clinic_account(target_clinic uuid)
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
  leaving text[];
  uid text;
  other record;
  kept boolean;
  n integer;
  deleted jsonb := '{}'::jsonb;
  users_deleted integer := 0;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_close_clinic_account: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.destroyed_at, c.offboarding_started_at, c.account_closed_at
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
  IF clinic_row.destroyed_at IS NULL THEN
    RAISE EXCEPTION 'Clinic %''s data is not destroyed; refusing to close its account.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'The account closes after destruction (app_mark_clinic_destroyed), never before.';
  END IF;
  -- The pass-through: FORWARDING_PASS_THROUGH_DAYS (30) after the end, in
  -- hours, by the database's clock, as releaseNumberAfterPassThrough counts it.
  IF clinic_row.offboarding_started_at > clock_timestamp() - make_interval(hours => 720) THEN
    RAISE EXCEPTION 'Clinic %''s forwarded calls still pass through to its direct line; refusing to close its account.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'The direct line and the clinic''s address are needed until the pass-through ends, 30 days after the service.';
  END IF;

  -- The sign-in. Who held it is read first; an address change still open is
  -- ended, so nothing applies it to a sign-in that is gone; then the
  -- memberships go, and each user goes with its last one.
  leaving := ARRAY(SELECT DISTINCT m.user_id FROM clinic_memberships m WHERE m.clinic_id = target_clinic);
  UPDATE sign_in_address_changes a
     SET status = CASE a.status WHEN 'awaiting_confirmation' THEN 'expired' ELSE 'failed' END,
         resolved_at = now(),
         resolution = 'The account closed.'
   WHERE a.clinic_id = target_clinic
     AND a.status IN ('awaiting_confirmation', 'pending');
  DELETE FROM clinic_memberships m WHERE m.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('clinic_memberships', n);
  FOREACH uid IN ARRAY leaving LOOP
    kept := false;
    -- clinic_memberships is FORCEd, so even its owner sees one tenant at a
    -- time: walk the other clinics of the user's organisations, as
    -- app_user_clinic_grants does (0043), and put the tenant back. Any row,
    -- revoked or not, keeps the user: it is that clinic's access history.
    FOR other IN
      SELECT cl.id FROM clinics cl
       WHERE cl.id <> target_clinic
         AND cl.organization_id IN (SELECT mb.organization_id FROM member mb WHERE mb.user_id = uid)
    LOOP
      PERFORM set_config('app.clinic_id', other.id::text, true);
      IF EXISTS (SELECT 1 FROM clinic_memberships m WHERE m.clinic_id = other.id AND m.user_id = uid) THEN
        kept := true;
        EXIT;
      END IF;
    END LOOP;
    PERFORM set_config('app.clinic_id', target_clinic::text, true);
    IF NOT kept THEN
      DELETE FROM "user" u WHERE u.id = uid;
      GET DIAGNOSTICS n = ROW_COUNT; users_deleted := users_deleted + n;
    END IF;
  END LOOP;
  deleted := deleted || jsonb_build_object('users', users_deleted);

  -- The setup.
  DELETE FROM agent_configs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('agent_configs', n);
  DELETE FROM clinic_settings_history x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('clinic_settings_history', n);
  DELETE FROM clinic_settings x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('clinic_settings', n);
  DELETE FROM report_recipients x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('report_recipients', n);
  DELETE FROM audit_review_queue x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('audit_review_queue', n);
  DELETE FROM practice_question_results x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('practice_question_results', n);
  DELETE FROM practice_question_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('practice_question_runs', n);
  DELETE FROM website_changes x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('website_changes', n);
  DELETE FROM site_rereads x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('site_rereads', n);

  -- Our own business data about the account.
  DELETE FROM clinic_touches x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('clinic_touches', n);
  DELETE FROM sync_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('sync_runs', n);
  -- A link a calendar election was signed through is part of that
  -- election's record (0057), and an OAuth state in flight still names its
  -- link; every other link goes.
  DELETE FROM connection_links x WHERE x.clinic_id = target_clinic
     AND NOT EXISTS (SELECT 1 FROM calendar_elections e WHERE e.clinic_id = x.clinic_id AND e.link_id = x.id)
     AND NOT EXISTS (SELECT 1 FROM google_oauth_states s WHERE s.target_clinic_id = x.clinic_id AND s.link_id = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted || jsonb_build_object('connection_links', n);

  -- The setup columns of the clinic row. Its name, slug, published number,
  -- address, specialty and time zone stay: the kept records name the
  -- practice by them, and the widget a clinic has not yet taken off its
  -- website shows the number to call.
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
         account_closed_at = now(),
         updated_at = now()
   WHERE c.id = target_clinic;

  RETURN deleted;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_close_clinic_account(uuid) IS
  'Closes a destroyed clinic''s account once its pass-through has ended (30 days after the service, in hours, by the database''s clock): deletes its memberships and each user whose last membership that was, its setup (agent configs, settings and their history, report recipients, practice questions and their review queue, website re-reads and changes, the clinic row''s setup columns), its touches, sync runs and the connection links no election names; stamps clinics.account_closed_at. Refuses another tenant, a clinic not destroyed, or one still in its pass-through. Returns the counts by table, or NULL when already closed. No patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_close_clinic_account(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_close_clinic_account(uuid) TO healdesk_app;--> statement-breakpoint

-- The hourly job's list: the destroyed clinics past their pass-through whose
-- account is still open. Ids only.
CREATE OR REPLACE FUNCTION app_accounts_to_close()
RETURNS TABLE (clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
  SELECT c.id
    FROM clinics c
   WHERE c.destroyed_at IS NOT NULL
     AND c.account_closed_at IS NULL
     AND c.offboarding_started_at <= clock_timestamp() - make_interval(hours => 720)
   ORDER BY c.destroyed_at, c.id
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_accounts_to_close() IS
  'The destroyed clinics whose pass-through has ended and whose account app_close_clinic_account() has not closed: ids only, for the hourly job.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_accounts_to_close() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_accounts_to_close() TO healdesk_app;

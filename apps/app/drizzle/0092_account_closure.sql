ALTER TABLE "clinics" ADD COLUMN "account_closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "notice_address" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "notice_address_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_notice_address_check" CHECK ("clinics"."notice_address" is null or ("clinics"."account_closed_at" is not null and "clinics"."notice_address_until" is not null and char_length("clinics"."notice_address") between 3 and 254 and "clinics"."notice_address" ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$'));--> statement-breakpoint
-- =============================================================================
-- Closing the account (wave 2, R8, 19 October 2026; its review's fix round the
-- same day). The four statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- The spec closes a clinic "keeping only the signed agreement and the billing
-- records the law requires" (Stage 1; Terms §3 and §7; contracts §2: "the
-- account and its setup data are removed"). Destruction (destroyClinicData,
-- app_mark_clinic_destroyed) takes every patient row on the day the
-- agreement's Term clause gives, and nothing else: until now the sign-in,
-- the setup and the clinic's business data stayed for good.
--
-- app_close_clinic_account() is the second step. It closes the account by
-- ending every way into it and taking the person's details off it, never by
-- deleting the user row: the audit log names the user it records as the
-- actor of every portal action (audit_log_actor_shape requires the id for
-- actor_type 'user'), and that log is kept six years. So, for each person
-- whose last live grant this clinic held, it deletes their sessions,
-- accounts, verifications, factors, backup codes, passkey challenges,
-- step-ups, lockouts, sign-in links, invitations and organisation
-- memberships, and turns the user row into a tombstone (a non-routable
-- address, no name). The clinic's memberships are revoked, never deleted:
-- they are its access history (schema.ts, clinic_memberships). It then
-- deletes the setup (agent_configs, clinic_settings with its history,
-- report_recipients, the practice questions and their review queue, the
-- website re-reads and what they found), our own notes (clinic_touches),
-- phase-two sync runs, every connection link no election or OAuth state
-- names, and the checkout intents the clinic was provisioned from (the
-- buyer's details and the website read at checkout; billing-housekeeping
-- deletes the same rows after 90 days, so they are no billing record);
-- clears the clinic row's setup columns; and keeps the agreement's notice
-- address beside the closure (clinics.notice_address) for six years after the
-- service ended, which billingRecipients() reads for a closed account, so a
-- breach report the BAA still owes (clauses 12, 17, 20) has somewhere to go.
--
-- It runs only once nothing is left to finish (app_account_closure_waiting_on):
-- the data destroyed, the Terms' pass-through over (30 days, in hours, by the
-- database's clock), the voice agent released at Retell for a clinic that
-- bought voice (the agent carries forwarded calls to the direct line that
-- clinic_settings holds), no incident open, no notice the agreements need
-- still waiting to go, and the Stripe Connect link already ended (its id is
-- what the disconnect needs). The function refuses otherwise; the hourly job
-- reads the reason and tells ops.
--
-- After it, the tables the closure emptied, the patient tables destruction
-- emptied, and the access records it kept (memberships, connection links,
-- address changes) refuse new and changed rows (app_refuse_after_account_
-- closure), so an old stop link, an invitation or an operator's re-read
-- cannot rebuild part of a closed account.
--
-- Safe to apply in place: three nullable columns and a CHECK every row
-- passes, the insert guard redefined to refuse strictly more, new functions,
-- and new triggers that refuse only after a closure no clinic has had.
-- apps/app holds synthetic and seed data only (CLAUDE.md).
-- =============================================================================

COMMENT ON COLUMN clinics.account_closed_at IS
  'The account was closed by app_close_clinic_account(): after destruction, the pass-through and everything the closure waits for, its sign-in ended and taken off the person, its setup and business data deleted. The database''s to stamp; the runtime role cannot write it.';--> statement-breakpoint
COMMENT ON COLUMN clinics.notice_address IS
  'The agreement''s notice address once the account is closed (BAA Notices clause): business contact data, kept for the notices the agreement still owes after termination, until notice_address_until, six years after the service ended. Written only by app_close_clinic_account().';--> statement-breakpoint

-- The runtime role's UPDATE on clinics is column by column (0003 onwards), so
-- the new columns are not in it; this says so, as 0058 does for the dates.
REVOKE UPDATE (account_closed_at, notice_address, notice_address_until) ON clinics FROM healdesk_app;--> statement-breakpoint

-- 0066's insert guard, with the closure's columns added to what a new clinic
-- cannot carry.
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
     OR NEW.notice_address IS NOT NULL
     OR NEW.notice_address_until IS NOT NULL
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

-- -----------------------------------------------------------------------------
-- What the closure still waits for, as one code, or NULL when nothing is left:
--   not_destroyed    the data is not destroyed yet;
--   pass_through     forwarded calls still pass through (30 days, in hours);
--   voice_agent      the clinic bought voice and no operator has recorded its
--                    agent released at Retell (voice_vendor_agent_released);
--   incident_open    an incident about the clinic is not resolved;
--   critical_notice  a critical notice (NOTICE_KIND_REGISTRY's, which
--                    tests/account-closure.test.ts pins to this list) is
--                    neither sent nor dead;
--   stripe_connect   the clinic's Stripe Connect link has not been ended.
-- Reads the clinic's own tenant rows by setting app.clinic_id for the call,
-- and puts the caller's back.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_account_closure_waiting_on(target_clinic uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
  answer text := NULL;
BEGIN
  SELECT cl.destroyed_at, cl.offboarding_started_at, cl.stripe_connect_account_id
    INTO c
    FROM clinics cl
   WHERE cl.id = target_clinic;
  IF NOT FOUND THEN
    RETURN 'not_destroyed';
  END IF;
  IF c.destroyed_at IS NULL THEN
    RETURN 'not_destroyed';
  END IF;
  IF c.offboarding_started_at > clock_timestamp() - make_interval(hours => 720) THEN
    RETURN 'pass_through';
  END IF;

  PERFORM set_config('app.clinic_id', target_clinic::text, true);
  IF EXISTS (SELECT 1 FROM clinic_channels ch WHERE ch.clinic_id = target_clinic AND ch.channel = 'voice')
     AND NOT EXISTS (
       SELECT 1 FROM security_events se
        WHERE se.event = 'voice_vendor_agent_released'
          AND se.metadata->>'clinicId' = target_clinic::text) THEN
    answer := 'voice_agent';
  ELSIF EXISTS (SELECT 1 FROM incidents i WHERE i.clinic_id = target_clinic AND i.resolved_at IS NULL) THEN
    answer := 'incident_open';
  ELSIF EXISTS (
    SELECT 1 FROM billing_notices b
     WHERE b.clinic_id = target_clinic
       AND b.sent_at IS NULL
       AND b.attempts < 6
       AND b.kind IN ('payment_failed', 'payment_action_required', 'suspended', 'plan_started',
                      'allowance_fallback', 'urgent', 'outage_started', 'outage_ended',
                      'subprocessor_notice', 'incident_report', 'suspended_for_cause')) THEN
    answer := 'critical_notice';
  ELSIF c.stripe_connect_account_id IS NOT NULL THEN
    answer := 'stripe_connect';
  END IF;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN answer;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_account_closure_waiting_on(uuid) IS
  'What a clinic''s account closure still waits for: not_destroyed, pass_through, voice_agent, incident_open, critical_notice or stripe_connect; NULL when it may close. For app_close_clinic_account() and app_accounts_to_close().';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_account_closure_waiting_on(uuid) FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_close_clinic_account: the closure itself, in the tenant's transaction.
-- `notice_to` is the clinic's one address as the caller read it before the
-- closure (billingRecipients, owner first), kept as the notice address; one
-- the CHECK would refuse is dropped rather than failing the closure. Returns
-- what it did, by table, or NULL when the account was closed already. The
-- deletes are one list with KEPT_FOR_GOOD and destruction's:
-- tests/booking-request-destruction.test.ts reads them from this source.
-- -----------------------------------------------------------------------------
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
      DELETE FROM session s WHERE s.user_id = uid;
      DELETE FROM account a WHERE a.user_id = uid;
      DELETE FROM invitation i WHERE i.inviter_id = uid;
      DELETE FROM member mb WHERE mb.user_id = uid;
      DELETE FROM verification v
       USING "user" u
       WHERE u.id = uid
         AND position(lower(u.email) IN lower(v.identifier || ' ' || v.value)) > 0;
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

  -- Our own business data about the account.
  DELETE FROM clinic_touches x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_touches', n);
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

  -- The setup columns of the clinic row, and the closure beside them. Its
  -- name, slug, specialty, time zone, address and published number stay: the
  -- kept records name the practice by them, and the widget a clinic has not
  -- yet taken off its website shows the number to call. The direct-booking
  -- clause it signed stays with the agreement.
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
  'Closes a clinic''s account once app_account_closure_waiting_on() says nothing is left: revokes its memberships and, for each person whose last live grant it held, deletes every way in (sessions, accounts, verifications, factors, codes, challenges, step-ups, lockouts, sign-in links, invitations, organisation memberships) and tombstones the user row, which the audit log keeps naming; deletes its setup, touches, sync runs, unnamed connection links and checkout intents; clears the clinic row''s setup columns; keeps the notice address for six years after the service ended; stamps clinics.account_closed_at. Returns what it did by table, or NULL when already closed. No patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_close_clinic_account(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_close_clinic_account(uuid, text) TO healdesk_app;--> statement-breakpoint

-- The hourly job's list: the destroyed clinics past their pass-through whose
-- account is still open, each with what it still waits for (NULL: ready).
CREATE OR REPLACE FUNCTION app_accounts_to_close()
RETURNS TABLE (clinic_id uuid, waiting_on text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
#variable_conflict use_column
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT cl.id FROM clinics cl
     WHERE cl.destroyed_at IS NOT NULL
       AND cl.account_closed_at IS NULL
       AND cl.offboarding_started_at <= clock_timestamp() - make_interval(hours => 720)
     ORDER BY cl.destroyed_at, cl.id
  LOOP
    clinic_id := c.id;
    waiting_on := app_account_closure_waiting_on(c.id);
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_accounts_to_close() IS
  'The destroyed clinics past their pass-through whose account is still open, with what each still waits for (app_account_closure_waiting_on), NULL when it may close: ids and codes only, for the hourly job.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_accounts_to_close() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_accounts_to_close() TO healdesk_app;--> statement-breakpoint

-- The kept notice address ends with its six years.
CREATE OR REPLACE FUNCTION app_expire_notice_addresses()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE clinics c
     SET notice_address = NULL, notice_address_until = NULL, updated_at = now()
   WHERE c.notice_address_until IS NOT NULL
     AND c.notice_address_until <= clock_timestamp();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_expire_notice_addresses() IS
  'Clears each closed account''s kept notice address once its six years are up. Returns how many.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_expire_notice_addresses() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_expire_notice_addresses() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_meta_asset_in_service: whether a Facebook Page or a WhatsApp Business
-- account still serves another clinic that has not left. Meta's
-- subscribed_apps edge is the Page's or the account's, not the clinic's, so
-- unsubscribing it for one leaving location would end every other location's
-- messages on it (lib/meta/revoke.ts). A Page serves a clinic through its
-- Messenger row (externalId) or its Instagram row (pageId); an account
-- through a WhatsApp row (wabaId). Any row not revoked counts. Walks the
-- clinics, since provider_connections is FORCEd, and puts the tenant back.
-- A boolean only.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_meta_asset_in_service(asset_kind text, asset_id text, except_clinic uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
  found_one boolean := false;
BEGIN
  IF asset_kind NOT IN ('page', 'waba') OR asset_id IS NULL OR asset_id !~ '^[0-9]{1,32}$' THEN
    RETURN false;
  END IF;
  FOR c IN
    SELECT cl.id FROM clinics cl
     WHERE cl.id IS DISTINCT FROM except_clinic
       AND cl.offboarding_started_at IS NULL
       AND cl.destroyed_at IS NULL
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    IF EXISTS (
      SELECT 1 FROM provider_connections p
       WHERE p.clinic_id = c.id
         AND p.status <> 'revoked'
         AND ((asset_kind = 'page'
               AND ((p.provider = 'meta-messenger' AND p.metadata->>'externalId' = asset_id)
                    OR (p.provider = 'meta-instagram' AND p.metadata->>'pageId' = asset_id)))
              OR (asset_kind = 'waba' AND p.provider = 'meta-whatsapp' AND p.metadata->>'wabaId' = asset_id))) THEN
      found_one := true;
      EXIT;
    END IF;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN found_one;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_meta_asset_in_service(text, text, uuid) IS
  'Whether a Facebook Page (asset_kind page) or a WhatsApp Business account (waba) still serves a clinic other than except_clinic that has not left, through a Meta connection not revoked. For lib/meta/revoke.ts, which leaves such an asset subscribed. A boolean only.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_meta_asset_in_service(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_meta_asset_in_service(text, text, uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- After the closure, nothing rebuilds part of the account. Every table with a
-- clinic_id that destruction or the closure empties, and the access records
-- the closure keeps (memberships, connection links, address changes), refuse
-- a new or changed row for a closed clinic. The kept records that must stay
-- writable (the audit log, the notices and their ledger, incidents, billing)
-- have no such trigger; tests/account-closure.test.ts holds the split to the
-- catalog and KEPT_FOR_GOOD.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_refuse_after_account_closure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM clinics c WHERE c.id = NEW.clinic_id AND c.account_closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Clinic %''s account is closed; % takes no new or changed rows for it.', NEW.clinic_id, TG_TABLE_NAME
      USING ERRCODE = 'check_violation',
            HINT = 'A closed account is not reopened piecemeal (app_close_clinic_account, drizzle/0092).';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_refuse_after_account_closure() FROM PUBLIC;--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- What destruction empties (app_mark_clinic_destroyed's list).
    'booking_requests', 'appointments', 'conversations', 'contacts', 'transactions',
    'reconciliation_exceptions', 'meta_booking_drafts', 'webhook_events', 'provider_connections',
    'clinic_closures', 'chat_threads', 'meta_inbound_messages', 'clinic_setup_screens', 'slot_holds',
    'clinic_provider_services', 'clinic_providers', 'suppressions', 'consent_records',
    'contact_attempts', 'erasure_requests', 'record_amendments', 'deposit_payments',
    'transcript_emails',
    -- What the closure empties.
    'agent_configs', 'clinic_settings', 'clinic_settings_history', 'report_recipients',
    'audit_review_queue', 'practice_question_results', 'practice_question_runs', 'website_changes',
    'site_rereads', 'clinic_touches', 'sync_runs', 'connection_links',
    -- The access records it keeps, frozen.
    'clinic_memberships', 'sign_in_address_changes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure()',
      t || '_closed_account', t);
  END LOOP;
END
$$;

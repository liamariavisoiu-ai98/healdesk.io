CREATE TABLE "sign_in_address_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"old_email" text NOT NULL,
	"new_email" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"confirm_token_hash" "bytea",
	"confirm_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"effective_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"stopped_by" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_address_changes_status_check" CHECK ("sign_in_address_changes"."status" in ('awaiting_confirmation', 'pending', 'applied', 'stopped', 'expired', 'failed')),
	CONSTRAINT "sign_in_address_changes_source_check" CHECK ("sign_in_address_changes"."source" in ('settings', 'operator')),
	CONSTRAINT "sign_in_address_changes_stopped_by_check" CHECK ("sign_in_address_changes"."stopped_by" is null or "sign_in_address_changes"."stopped_by" in ('clinic', 'operator')),
	CONSTRAINT "sign_in_address_changes_emails_check" CHECK ("sign_in_address_changes"."old_email" = lower(btrim("sign_in_address_changes"."old_email")) and "sign_in_address_changes"."new_email" = lower(btrim("sign_in_address_changes"."new_email")) and char_length("sign_in_address_changes"."old_email") between 3 and 254 and char_length("sign_in_address_changes"."new_email") between 3 and 254 and "sign_in_address_changes"."old_email" <> "sign_in_address_changes"."new_email"),
	CONSTRAINT "sign_in_address_changes_token_hash_length" CHECK ("sign_in_address_changes"."confirm_token_hash" is null or octet_length("sign_in_address_changes"."confirm_token_hash") = 32),
	CONSTRAINT "sign_in_address_changes_requested_by_check" CHECK (char_length("sign_in_address_changes"."requested_by") between 1 and 200),
	CONSTRAINT "sign_in_address_changes_resolution_check" CHECK ("sign_in_address_changes"."resolution" is null or char_length("sign_in_address_changes"."resolution") between 1 and 200),
	CONSTRAINT "sign_in_address_changes_link_check" CHECK (("sign_in_address_changes"."source" = 'settings') = ("sign_in_address_changes"."confirm_expires_at" is not null)),
	CONSTRAINT "sign_in_address_changes_pending_check" CHECK ("sign_in_address_changes"."status" <> 'pending' or ("sign_in_address_changes"."effective_at" is not null and "sign_in_address_changes"."confirmed_at" is not null)),
	CONSTRAINT "sign_in_address_changes_resolved_check" CHECK (("sign_in_address_changes"."status" in ('awaiting_confirmation', 'pending')) = ("sign_in_address_changes"."resolved_at" is null)),
	CONSTRAINT "sign_in_address_changes_stopped_check" CHECK (("sign_in_address_changes"."status" = 'stopped') = ("sign_in_address_changes"."stopped_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "clinic_settings_history" DROP CONSTRAINT "clinic_settings_history_field_check";--> statement-breakpoint
ALTER TABLE "sign_in_address_changes" ADD CONSTRAINT "sign_in_address_changes_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_address_changes" ADD CONSTRAINT "sign_in_address_changes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sign_in_address_changes_clinic_idx" ON "sign_in_address_changes" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_address_changes_token_idx" ON "sign_in_address_changes" USING btree ("confirm_token_hash") WHERE "sign_in_address_changes"."confirm_token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_address_changes_open_idx" ON "sign_in_address_changes" USING btree ("user_id") WHERE "sign_in_address_changes"."status" in ('awaiting_confirmation', 'pending');--> statement-breakpoint
CREATE INDEX "sign_in_address_changes_due_idx" ON "sign_in_address_changes" USING btree ("effective_at") WHERE "sign_in_address_changes"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "clinic_settings_history" ADD CONSTRAINT "clinic_settings_history_field_check" CHECK ("clinic_settings_history"."field" in ('direct_line_e164', 'transfer_e164', 'urgent_help_e164', 'vet_referral_e164', 'transcript_retention_days', 'auto_confirm_bookings', 'sign_in_email'));--> statement-breakpoint

-- =============================================================================
-- The clinic's one address, changed (package WP8, 14 October 2026; plan Part
-- D5, Annex X5 O5). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- One address per clinic is its sign-in (the Better Auth user's email), the
-- Stripe customer's email and the agreement's notice address (spec, "Account
-- access and credentials"), so a change of it moves all three together, and
-- takes effect 72 hours after it is confirmed: from Settings, once the new
-- address has used the single-use link sent to it; from ops'
-- changeClinicEmail, once the operator has called the practice back. Until
-- then the old address keeps every sign-in link and can stop it.
-- sign_in_address_changes holds each change and where it stands, and its row
-- is the written record that the practice gave healdesk a new notice address,
-- which every agreement's Notices clause provides for.
--
-- Business contact data, never a patient: no BAA gate. Tenant RLS on the
-- clinic it was asked for, like every table with a clinic_id
-- (tests/rls-drift.test.ts). Two readers cannot know the tenant first: the
-- confirmation page, opened from an inbox with no session, and the hourly
-- job that applies what is due. Each gets a SECURITY DEFINER function that
-- answers ids and nothing else, and then works inside the tenant it names.
--
-- clinic_settings_history widens its field list by `sign_in_email` (the
-- statements above): the change is recorded there, masked, when it takes
-- effect.
--
-- Safe to apply in place: a new, empty table, two functions, a trigger, and
-- a widened CHECK that only adds a value.
-- =============================================================================

ALTER TABLE sign_in_address_changes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sign_in_address_changes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sign_in_address_changes_tenant_isolation ON sign_in_address_changes
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants. 0003's default privileges have already given healdesk_app full DML
-- on the new table, so each REVOKE is required, not defensive. The runtime
-- role inserts a change and moves its state; it never rewrites who, which
-- addresses or the link, and never deletes one: destruction keeps the row
-- (tests/booking-request-destruction.test.ts, KEPT_AT_DESTRUCTION).
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON sign_in_address_changes FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON sign_in_address_changes TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, confirmed_at, effective_at, resolved_at, stopped_by, resolution)
  ON sign_in_address_changes TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- One way only. A change moves awaiting_confirmation -> pending, stopped or
-- expired, and pending -> applied, stopped or failed; a resolved change never
-- moves again, for every role. The column grants already keep the runtime
-- role off the addresses and every clock but its own transitions; this keeps
-- who, which addresses and the link fixed for the migrator's own scripts too.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_address_change_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
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

CREATE TRIGGER sign_in_address_changes_transition
  BEFORE UPDATE ON sign_in_address_changes
  FOR EACH ROW EXECUTE FUNCTION app_address_change_transition_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The two cross-tenant readers. Each answers ids only, so the caller then
-- opens the tenant it names and reads the row under RLS like any other.
--
-- app_address_change_by_token: the confirmation page's lookup, by the
-- SHA-256 of the token in the link (never the token), whatever the change's
-- state, so the page can say "already confirmed" or "stopped".
--
-- app_address_changes_due: the hourly job's list, by the database's clock:
-- pending changes whose 72 hours are up, and Settings changes whose link ran
-- out unused.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_address_change_by_token(token_hash bytea)
RETURNS TABLE (id uuid, clinic_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  IF token_hash IS NULL OR octet_length(token_hash) <> 32 THEN
    RETURN;
  END IF;
  -- The table is FORCEd, so even its owner sees one tenant at a time: walk
  -- the clinics, as app_transcript_email_work does (0072), and put the
  -- caller's tenant back.
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT a.id, a.clinic_id
        FROM sign_in_address_changes a
       WHERE a.clinic_id = c.id
         AND a.confirm_token_hash = token_hash;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_address_changes_due()
RETURNS TABLE (id uuid, clinic_id uuid, status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  now_ timestamptz := clock_timestamp();
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT a.id, a.clinic_id, a.status
        FROM sign_in_address_changes a
       WHERE a.clinic_id = c.id
         AND ((a.status = 'pending' AND a.effective_at <= now_)
           OR (a.status = 'awaiting_confirmation' AND a.confirm_expires_at <= now_))
       ORDER BY a.created_at;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_address_change_by_token(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_address_change_by_token(bytea) TO healdesk_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_address_changes_due() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_address_changes_due() TO healdesk_app;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_address_change_transition_guard() FROM PUBLIC;--> statement-breakpoint

COMMENT ON TABLE sign_in_address_changes IS
  'Changes of a clinic''s one address: its sign-in, the Stripe customer''s email and the agreement''s notice address, moved together 72 hours after confirmation (plan Part D5, O5; 0080). Business contact data. The runtime role moves the state only and never deletes; destruction keeps the row as the record of the notice address the practice gave.';--> statement-breakpoint
COMMENT ON FUNCTION app_address_change_by_token(bytea) IS
  'The confirmation page''s cross-tenant lookup: the change and its clinic for the SHA-256 of a link''s token, ids only (0080).';--> statement-breakpoint
COMMENT ON FUNCTION app_address_changes_due() IS
  'The hourly job''s cross-tenant list: pending address changes whose 72 hours are up, and unconfirmed ones whose link ran out, ids and state only, by the database''s clock (0080).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The audit: fails this migration, and any later one that widens it.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'sign_in_address_changes'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can delete sign_in_address_changes, which 0080 keeps.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'sign_in_address_changes'::regclass, 'new_email', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'sign_in_address_changes'::regclass, 'confirm_token_hash', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite an address change''s address or link, which 0080 fixes.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'sign_in_address_changes'::regclass, 'status', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot move an address change''s state.';
  END IF;
END
$$;

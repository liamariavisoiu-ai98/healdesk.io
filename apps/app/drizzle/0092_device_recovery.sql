CREATE TABLE "device_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"landing" text NOT NULL,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"session_token_hash" "bytea",
	"used_at" timestamp with time zone,
	"factor_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "device_recoveries_token_hash_length" CHECK (octet_length("device_recoveries"."token_hash") = 32),
	CONSTRAINT "device_recoveries_session_hash_length" CHECK ("device_recoveries"."session_token_hash" is null or octet_length("device_recoveries"."session_token_hash") = 32),
	CONSTRAINT "device_recoveries_landing_check" CHECK ("device_recoveries"."landing" like '/c/%/protect' and "device_recoveries"."landing" not like '//%' and "device_recoveries"."landing" !~ '[\\[:cntrl:][:space:]]' and char_length("device_recoveries"."landing") <= 200),
	CONSTRAINT "device_recoveries_issued_by_check" CHECK (char_length("device_recoveries"."issued_by") between 1 and 200),
	CONSTRAINT "device_recoveries_window_check" CHECK ("device_recoveries"."expires_at" > "device_recoveries"."created_at" and "device_recoveries"."expires_at" <= "device_recoveries"."created_at" + interval '24 hours'),
	CONSTRAINT "device_recoveries_claim_check" CHECK (("device_recoveries"."claimed_at" is null) = ("device_recoveries"."session_token_hash" is null)),
	CONSTRAINT "device_recoveries_use_check" CHECK ("device_recoveries"."used_at" is null or "device_recoveries"."claimed_at" is not null),
	CONSTRAINT "device_recoveries_factor_check" CHECK ("device_recoveries"."factor_id" is null or "device_recoveries"."used_at" is not null),
	CONSTRAINT "device_recoveries_revoked_check" CHECK (("device_recoveries"."revoked_at" is null) = ("device_recoveries"."revoked_reason" is null) and ("device_recoveries"."revoked_at" is null or "device_recoveries"."used_at" is null) and ("device_recoveries"."revoked_reason" is null or "device_recoveries"."revoked_reason" in ('replaced', 'someone_left', 'operator_signed_out', 'operator_ended')))
);
--> statement-breakpoint
ALTER TABLE "webauthn_challenges" DROP CONSTRAINT "webauthn_challenges_basis_check";--> statement-breakpoint
ALTER TABLE "device_recoveries" ADD CONSTRAINT "device_recoveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_recoveries" ADD CONSTRAINT "device_recoveries_factor_id_user_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."user_factors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_recoveries_token_hash_idx" ON "device_recoveries" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "device_recoveries_one_open_idx" ON "device_recoveries" USING btree ("user_id") WHERE "device_recoveries"."used_at" is null and "device_recoveries"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "device_recoveries_user_idx" ON "device_recoveries" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "device_recoveries_session_idx" ON "device_recoveries" USING btree ("session_token_hash") WHERE "device_recoveries"."session_token_hash" is not null;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_basis_check" CHECK (("webauthn_challenges"."purpose" = 'register') = ("webauthn_challenges"."enrol_basis" is not null) and ("webauthn_challenges"."enrol_basis" is null or "webauthn_challenges"."enrol_basis" in ('first_passkey', 'step_up', 'code', 'recovery', 'paying_browser')));--> statement-breakpoint

-- =============================================================================
-- The human route for a clinic that has lost every device (wave 2, R4, 19
-- October 2026; plan Part D3, "Lost every device", and Annex X5's O3). The
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express.
--
-- After go-live a sign-in link alone never adds a device (lib/factors/
-- authority.ts), so a clinic that has lost every passkey and its
-- authenticator backup could never open Conversations or Bookings again.
-- The plan's answer is a person: the operator calls the practice back on
-- its published number, enters a fresh code from the operator's own
-- authenticator on apps/web, and the ops operation issueDeviceRecovery mints
-- one device_recoveries row and emails its link to the clinic's address on
-- file, and nowhere else. The link starts a session and lets that session
-- add one passkey within the row's window; then it is spent. O3 tells the
-- clinic a device was added this way.
--
-- webauthn_challenges' basis CHECK widens by two values (above): `recovery`,
-- that link, and `paying_browser`, the plan's seven-day same-browser window
-- for first enrolment (lib/sign-in/paying-browser.ts).
--
-- Identity plane, like user_factors and sign_in_links (0043, 0047): a passkey
-- belongs to the sign-in, not to a clinic, and the link is read before any
-- tenant is known, so no clinic_id and no RLS. No PHI: ids, a token's hash, a
-- session token's hash, a portal path, the operator's address and times.
-- Nothing deletes a row; destruction has nothing of a clinic's here to take,
-- and the purge reaches only patient records.
--
-- Safe to apply in place: a new, empty table, a trigger, and a CHECK widened
-- by two values.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants. 0003's default privileges have already given healdesk_app full DML
-- on the new table, so each REVOKE is required, not defensive. The runtime
-- role issues a row and moves its claim, its use and its end; it never
-- rewrites whose it is, its token, where it lands or its window, and never
-- deletes one.
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON device_recoveries FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON device_recoveries TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (claimed_at, session_token_hash, used_at, factor_id, revoked_at, revoked_reason)
  ON device_recoveries TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Once only, for every role. What was issued is fixed; the claim is made
-- once, to one session; a row used or revoked never moves again, so a spent
-- link cannot be re-armed and an ended one cannot be revived. The one change
-- a final row takes is its factor_id going to null, which only the deletion
-- of the passkey itself does (ON DELETE SET NULL), and the runtime role
-- cannot delete a passkey.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_device_recovery_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.landing IS DISTINCT FROM OLD.landing
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'device_recoveries: whose it is, its link, where it lands and its window are fixed once issued.'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    IF NEW.factor_id IS NULL AND OLD.factor_id IS NOT NULL
       AND ROW(NEW.claimed_at, NEW.session_token_hash, NEW.used_at, NEW.revoked_at, NEW.revoked_reason)
           IS NOT DISTINCT FROM ROW(OLD.claimed_at, OLD.session_token_hash, OLD.used_at, OLD.revoked_at, OLD.revoked_reason) THEN
      RETURN NEW;
    END IF;
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'device_recoveries: a used or revoked link is final.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.claimed_at IS NOT NULL
     AND (NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
          OR NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash) THEN
    RAISE EXCEPTION 'device_recoveries: a link is claimed once, by one session.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER device_recoveries_no_rewrite
  BEFORE UPDATE ON device_recoveries
  FOR EACH ROW EXECUTE FUNCTION app_device_recovery_no_rewrite();--> statement-breakpoint

REVOKE ALL ON FUNCTION app_device_recovery_no_rewrite() FROM PUBLIC;--> statement-breakpoint

COMMENT ON TABLE device_recoveries IS
  'The human route for a clinic that lost every device (plan Part D3; 0092): one link, issued by the operator after a call back to the practice''s published number and mailed only to the clinic''s address, that lets the session it starts add one passkey within its window. Identity plane, no PHI. The runtime role moves the claim, the use and the end only, and never deletes.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The audit: fails this migration, and any later one that widens it.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'device_recoveries'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can delete device_recoveries, which 0092 keeps.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'device_recoveries'::regclass, 'token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'device_recoveries'::regclass, 'expires_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'device_recoveries'::regclass, 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can re-point a device recovery or stretch its window, which 0092 fixes.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'device_recoveries'::regclass, 'used_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot spend a device recovery.';
  END IF;
END
$$;

CREATE TABLE "factor_lockouts" (
	"user_id" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factor_lockouts_failures_check" CHECK ("factor_lockouts"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "step_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token_hash" "bytea" NOT NULL,
	"user_id" text NOT NULL,
	"factor_id" uuid NOT NULL,
	"device_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "step_ups_session_hash_length" CHECK (octet_length("step_ups"."session_token_hash") = 32),
	CONSTRAINT "step_ups_activity_window" CHECK ("step_ups"."last_activity_at" >= "step_ups"."created_at" and "step_ups"."last_activity_at" <= "step_ups"."created_at" + interval '8 hours')
);
--> statement-breakpoint
CREATE TABLE "user_backup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_backup_codes_hash_length" CHECK (octet_length("user_backup_codes"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "user_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"device_label" text,
	"credential_id" text,
	"public_key" "bytea",
	"counter" bigint,
	"transports" text[],
	"backed_up" boolean,
	"secret_sealed" jsonb,
	"last_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_factors_kind_check" CHECK ("user_factors"."kind" in ('passkey', 'totp')),
	CONSTRAINT "user_factors_passkey_columns" CHECK ("user_factors"."kind" <> 'passkey' or ("user_factors"."credential_id" is not null and "user_factors"."public_key" is not null and "user_factors"."counter" is not null and "user_factors"."device_label" is not null and "user_factors"."backed_up" is not null and "user_factors"."secret_sealed" is null and "user_factors"."last_step" is null)),
	CONSTRAINT "user_factors_totp_columns" CHECK ("user_factors"."kind" <> 'totp' or ("user_factors"."secret_sealed" is not null and "user_factors"."last_step" is not null and "user_factors"."credential_id" is null and "user_factors"."public_key" is null and "user_factors"."counter" is null and "user_factors"."transports" is null and "user_factors"."backed_up" is null)),
	CONSTRAINT "user_factors_device_label_check" CHECK ("user_factors"."device_label" is null or (char_length("user_factors"."device_label") between 1 and 60 and "user_factors"."device_label" = btrim("user_factors"."device_label") and "user_factors"."device_label" !~ '[[:cntrl:]]')),
	CONSTRAINT "user_factors_credential_id_format" CHECK ("user_factors"."credential_id" is null or ("user_factors"."credential_id" ~ '^[A-Za-z0-9_-]+$' and char_length("user_factors"."credential_id") <= 1364)),
	CONSTRAINT "user_factors_counter_check" CHECK ("user_factors"."counter" is null or "user_factors"."counter" >= 0),
	CONSTRAINT "user_factors_last_step_check" CHECK ("user_factors"."last_step" is null or "user_factors"."last_step" >= 0)
);
--> statement-breakpoint
CREATE TABLE "webauthn_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_token_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"challenge" text NOT NULL,
	"enrol_basis" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "webauthn_challenges_purpose_check" CHECK ("webauthn_challenges"."purpose" in ('register', 'authenticate')),
	CONSTRAINT "webauthn_challenges_basis_check" CHECK (("webauthn_challenges"."purpose" = 'register') = ("webauthn_challenges"."enrol_basis" is not null) and ("webauthn_challenges"."enrol_basis" is null or "webauthn_challenges"."enrol_basis" in ('first_passkey', 'step_up', 'code'))),
	CONSTRAINT "webauthn_challenges_challenge_format" CHECK ("webauthn_challenges"."challenge" ~ '^[A-Za-z0-9_-]{16,128}$'),
	CONSTRAINT "webauthn_challenges_session_hash_length" CHECK (octet_length("webauthn_challenges"."session_token_hash") = 32),
	CONSTRAINT "webauthn_challenges_expiry_check" CHECK ("webauthn_challenges"."expires_at" > "webauthn_challenges"."created_at" and "webauthn_challenges"."expires_at" <= "webauthn_challenges"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
ALTER TABLE "factor_lockouts" ADD CONSTRAINT "factor_lockouts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_ups" ADD CONSTRAINT "step_ups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_ups" ADD CONSTRAINT "step_ups_factor_id_user_factors_id_fk" FOREIGN KEY ("factor_id") REFERENCES "public"."user_factors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_backup_codes" ADD CONSTRAINT "user_backup_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_factors" ADD CONSTRAINT "user_factors_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_ups_session_idx" ON "step_ups" USING btree ("session_token_hash") WHERE "step_ups"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "step_ups_factor_idx" ON "step_ups" USING btree ("factor_id");--> statement-breakpoint
CREATE INDEX "step_ups_user_idx" ON "step_ups" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_backup_codes_live_idx" ON "user_backup_codes" USING btree ("user_id","code_hash") WHERE "user_backup_codes"."used_at" is null and "user_backup_codes"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_factors_credential_id_idx" ON "user_factors" USING btree ("credential_id") WHERE "user_factors"."credential_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_factors_one_totp_idx" ON "user_factors" USING btree ("user_id") WHERE "user_factors"."kind" = 'totp' and "user_factors"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "user_factors_user_idx" ON "user_factors" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_challenges_challenge_idx" ON "webauthn_challenges" USING btree ("challenge");--> statement-breakpoint
CREATE INDEX "webauthn_challenges_user_idx" ON "webauthn_challenges" USING btree ("user_id","created_at");--> statement-breakpoint

-- =============================================================================
-- The clinic portal's second factors and step-up (plan of 6 October 2026,
-- Part D2-D3). Everything above this line was generated from schema.ts;
-- everything below is the part drizzle cannot express: grants, the triggers
-- that freeze history, the comments and the audit at the end.
--
-- What this migration adds, in one paragraph. A clinic has one sign-in, shared
-- by its staff, and each phone or computer adds its own passkey, named by the
-- person adding it (user_factors, kind passkey), with an authenticator-app
-- secret and ten backup codes as the backup (user_factors kind totp, sealed;
-- user_backup_codes, hashed). Patient pages open only after a passkey step-up
-- on the session (step_ups): 15 minutes idle, 8 hours at most, bound to the
-- Better Auth session by SHA-256 of its token and naming the device, so a
-- shared sign-in still says which device opened what. WebAuthn challenges are
-- single-use and bound to the session that asked (webauthn_challenges), and
-- wrong codes are counted in the database so a lockout survives a restart
-- (factor_lockouts).
--
-- Identity plane, like sign_in_links (0043): no clinic_id, so no RLS. A factor
-- belongs to the sign-in, not to a clinic, and is read before any tenant is
-- known. None of these tables holds PHI.
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on each new table by the time these statements run.
-- Every REVOKE below is therefore required, not defensive, and each GRANT
-- restates the intended set so it can be read in one place.
--
-- Safe to run: every table is new and empty.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants, table by table. No DELETE anywhere: each table is the record of who
-- could open patient data with what, and when.
-- -----------------------------------------------------------------------------

-- user_factors: a factor is written once; only its use moves (the signature
-- counter, the spent TOTP step, last use) and its end (revoked_at). The key,
-- the secret, the credential and the device's name cannot be re-pointed.
REVOKE DELETE ON user_factors FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON user_factors FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (counter, last_step, last_used_at, revoked_at) ON user_factors TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON user_factors TO healdesk_app;--> statement-breakpoint

-- user_backup_codes: spent once, or revoked by the next set. Never deleted,
-- so "which code was used, and when" keeps an answer.
REVOKE DELETE ON user_backup_codes FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON user_backup_codes FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (used_at, revoked_at) ON user_backup_codes TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON user_backup_codes TO healdesk_app;--> statement-breakpoint

-- webauthn_challenges: append-then-consume, the sign_in_links rules. Old
-- challenges are not purged; they expire after five minutes.
REVOKE DELETE ON webauthn_challenges FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON webauthn_challenges FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (used_at) ON webauthn_challenges TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON webauthn_challenges TO healdesk_app;--> statement-breakpoint

-- step_ups: activity and the end move; the session, the passkey and the
-- device's name it was made with do not.
REVOKE DELETE ON step_ups FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON step_ups FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (last_activity_at, revoked_at) ON step_ups TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON step_ups TO healdesk_app;--> statement-breakpoint

-- factor_lockouts: the counter moves; whose counter it is does not.
REVOKE DELETE ON factor_lockouts FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON factor_lockouts FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (failures, window_started_at, locked_until, updated_at) ON factor_lockouts TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON factor_lockouts TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Frozen history, the app_sign_in_link_no_rewrite pattern (0043). The column
-- grants above already keep the runtime role off everything but the moving
-- columns; these triggers stop the moving columns being moved back (an
-- un-revoked passkey, a re-armed challenge, a counter or a TOTP step wound
-- back for a replay), and bind the owner too.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_user_factor_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'user_factors row is revoked and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.device_label IS DISTINCT FROM OLD.device_label
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.public_key IS DISTINCT FROM OLD.public_key
     OR NEW.transports IS DISTINCT FROM OLD.transports
     OR NEW.backed_up IS DISTINCT FROM OLD.backed_up
     OR NEW.secret_sealed IS DISTINCT FROM OLD.secret_sealed
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'user_factors: only counter, last_step, last_used_at and revoked_at may change'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.counter < OLD.counter OR NEW.last_step < OLD.last_step THEN
    RAISE EXCEPTION
      'user_factors: a signature counter or a spent TOTP step never goes backwards'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER user_factors_no_rewrite
  BEFORE UPDATE ON user_factors
  FOR EACH ROW
  EXECUTE FUNCTION app_user_factor_no_rewrite();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_user_backup_code_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'user_backup_codes row is spent or revoked and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'user_backup_codes: only used_at and revoked_at may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER user_backup_codes_no_rewrite
  BEFORE UPDATE ON user_backup_codes
  FOR EACH ROW
  EXECUTE FUNCTION app_user_backup_code_no_rewrite();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_webauthn_challenge_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION
      'webauthn_challenges row is already consumed and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.challenge IS DISTINCT FROM OLD.challenge
     OR NEW.enrol_basis IS DISTINCT FROM OLD.enrol_basis
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION
      'webauthn_challenges is append-then-consume: only used_at may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER webauthn_challenges_no_rewrite
  BEFORE UPDATE ON webauthn_challenges
  FOR EACH ROW
  EXECUTE FUNCTION app_webauthn_challenge_no_rewrite();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_step_up_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'step_ups row is revoked and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.session_token_hash IS DISTINCT FROM OLD.session_token_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.factor_id IS DISTINCT FROM OLD.factor_id
     OR NEW.device_label IS DISTINCT FROM OLD.device_label
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'step_ups: only last_activity_at and revoked_at may change'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.last_activity_at < OLD.last_activity_at THEN
    RAISE EXCEPTION
      'step_ups: activity never moves backwards'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER step_ups_no_rewrite
  BEFORE UPDATE ON step_ups
  FOR EACH ROW
  EXECUTE FUNCTION app_step_up_no_rewrite();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE user_factors IS
  'Second factors of a clinic''s one sign-in: a passkey per device, named by the person adding it, and at most one authenticator-app secret as the backup. Each kind has its own columns (CHECKs). Only counter, last_step, last_used_at and revoked_at move; a revoked row is frozen (app_user_factor_no_rewrite). No patient data.';--> statement-breakpoint
COMMENT ON COLUMN user_factors.device_label IS
  'The device''s name, chosen by the person adding it ("Front desk Mac"). Snapshotted into step_ups, so the access log names the device. Staff-chosen text: kept out of logs and security event metadata.';--> statement-breakpoint
COMMENT ON COLUMN user_factors.counter IS
  'The authenticator''s signature counter. Only moves forward; a response whose counter does not, when either side has ever counted, is refused as a cloned authenticator.';--> statement-breakpoint
COMMENT ON COLUMN user_factors.secret_sealed IS
  'The TOTP secret, sealed (lib/crypto/envelope.ts), its AAD bound to the sign-in and this row. Never stored or logged in the clear.';--> statement-breakpoint
COMMENT ON COLUMN user_factors.last_step IS
  'The highest RFC 6238 time step accepted: a code at or below it is refused, so each code works once.';--> statement-breakpoint
COMMENT ON TABLE user_backup_codes IS
  'Backup codes for the authenticator app, ten per set, stored as SHA-256 of the normalised code. Spent once (used_at); a new set revokes the old set''s unspent codes. No DELETE. No patient data.';--> statement-breakpoint
COMMENT ON TABLE webauthn_challenges IS
  'Single-use WebAuthn challenges, five minutes at most, bound to the session that asked (SHA-256 of its Better Auth token). A registration records the basis it was allowed on. Consumed by a conditional UPDATE of used_at, then frozen. No patient data.';--> statement-breakpoint
COMMENT ON TABLE step_ups IS
  'Passkey step-ups: this session proved a device''s passkey. Live while active in the last 15 minutes and at most 8 hours old (lib/portal/step-up.ts). Ended on sign-out and when its passkey is removed. device_label is a snapshot for the access log. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN step_ups.session_token_hash IS
  'SHA-256 of the Better Auth session token (the session cookie''s bearer value, which Better Auth never rotates), never the token itself.';--> statement-breakpoint
COMMENT ON TABLE factor_lockouts IS
  'Wrong second-factor codes per sign-in, persisted so a lockout survives restarts and holds across instances: five within fifteen minutes lock code entry for fifteen minutes. No patient data.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'user_factors'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'user_backup_codes'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'webauthn_challenges'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'step_ups'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'factor_lockouts'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from a table 0047 keeps as history.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'user_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'kind', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'device_label', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'credential_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'public_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_factors'::regclass, 'secret_sealed', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_backup_codes'::regclass, 'user_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'user_backup_codes'::regclass, 'code_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'webauthn_challenges'::regclass, 'challenge', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'webauthn_challenges'::regclass, 'session_token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'webauthn_challenges'::regclass, 'expires_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'webauthn_challenges'::regclass, 'enrol_basis', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'step_ups'::regclass, 'session_token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'step_ups'::regclass, 'user_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'step_ups'::regclass, 'factor_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'step_ups'::regclass, 'device_label', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'step_ups'::regclass, 'created_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'factor_lockouts'::regclass, 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a column 0047 froze.';
  END IF;
END;
$$;

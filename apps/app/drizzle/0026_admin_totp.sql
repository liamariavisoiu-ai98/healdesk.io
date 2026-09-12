-- =============================================================================
-- The administrator's second factor.
--
-- healdesk.io/admin has exactly one login. HEALDESK_ADMIN_EMAIL is the
-- username, HEALDESK_ADMIN_PASSWORD_HASH is a scrypt hash of the password, and
-- there is no user store behind either: no invitations, no team, no roles, and
-- so nothing to compromise sideways. That is a smaller attack surface in every
-- direction but one — a single password is the whole of authentication for a
-- console that issues booking credentials, resends executed contracts and
-- starts a six-year retention clock. This table is the second factor that
-- closes it.
--
-- ## Why a table at all, and why exactly one row
--
-- A TOTP secret in an environment variable is not a second factor. It would sit
-- in the same deployment configuration as the password hash, readable by
-- everything that can read the first factor, and "two secrets from one place"
-- is one secret. It has to be durable, it has to be sealed, and its used-step
-- counter has to be somewhere two concurrent requests can contend for — which
-- is a row.
--
-- There is one administrator, so there is one row, and the primary key is the
-- constant 1 with a CHECK pinning it there. Two rows is not a state this design
-- has an opinion about: which secret would verify, and which counter would
-- count? Rather than leave a later reader to choose, the database refuses to
-- represent the question.
--
-- ## The four properties, and what enforces each
--
--   1. THE SECRET IS NEVER STORED IN THE CLEAR. secret_ciphertext holds the
--      sealed envelope from src/lib/crypto/envelope.ts — AES-256-GCM under a
--      wrapped data key, opened in the application and never in SQL, for the
--      reason that file gives: pgcrypto would put the key into a statement, and
--      statements land in pg_stat_activity and query logs that HIPAA mode on
--      some hosts requires stay on.
--
--      The admin_totp_secret_is_sealed CHECK is the load-bearing part. The most
--      likely way this property dies is a refactor that stores the base32
--      secret directly, and nothing downstream would notice — codes would still
--      verify perfectly. Demanding the envelope's own fields turns that silent
--      catastrophe into a failed INSERT, exactly as connection_links'
--      octet_length(token_hash) = 32 does for a token stored verbatim.
--
--   2. A SPENT CODE STAYS SPENT. last_used_step only ever moves forward: the
--      application writes it with UPDATE ... WHERE last_used_step < $step, and
--      the trigger below refuses a smaller value regardless of what the
--      application asks for. Both, deliberately. The WHERE clause is what makes
--      two simultaneous submissions of the same six digits resolve to one
--      winner under READ COMMITTED; the trigger is what survives somebody
--      rewriting that statement. Without either, an intercepted code is
--      replayable for the rest of its thirty-second window, which is precisely
--      the window an attacker relaying a phished code operates in.
--
--   3. THE APPLICATION CANNOT DISENROL, AND CANNOT RE-POINT THE FACTOR. No
--      DELETE, and UPDATE is column-scoped to last_used_step and
--      recovery_code_hashes. Nothing reachable from a request can replace the
--      secret, clear enrolled_at, or drop the row — so an attacker holding the
--      signing key and full command of apps/web still cannot swap in an
--      authenticator of their own. Disenrolling is a deliberate act with the
--      migrator role, by a human, with a reason. That asymmetry is the entire
--      value of a second factor: it must be harder to move than the first one.
--
--   4. RECOVERY CODES CAN ONLY BE SPENT. The column holds SHA-256 digests, never
--      codes, and the trigger requires every UPDATE's array to be a subset of
--      the one it replaces. Adding a recovery code is how a compromised
--      application would mint itself a permanent bypass of everything above; it
--      is refused at the same place the secret is.
--
-- ## No RLS, and no clinic
--
-- Identity plane, like security_events and provisioning_attempts. It carries no
-- clinic_id, there is no tenant to scope it by, and the drift test in
-- tests/rls-drift.test.ts asks the catalog for clinic_id columns precisely so
-- that this distinction is made by the schema rather than by memory.
--
-- ⚠️ No PHI can reach this table. There is no column here that could hold any.
-- =============================================================================

CREATE TABLE "admin_totp" (
  -- Always 1. See admin_totp_is_a_singleton.
  "id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,

  -- The whole SealedPayload as one value: {ciphertext, iv, authTag, wrappedDek,
  -- keyVersion, aadVersion}. One column rather than the six that
  -- provider_connections spreads it over, because those six exist so a rotation
  -- job can scan key_version across thousands of rows and there is one row
  -- here. What matters instead is that the parts cannot be written apart from
  -- one another: a half-updated envelope is an unopenable secret and a locked
  -- out administrator.
  "secret_ciphertext" jsonb NOT NULL,

  -- When the authenticator was proved to hold the secret. Not "when the row was
  -- written" — see created_at, which is that, and which is why both exist: a
  -- gap between them would mean an enrolment that was stored before it was
  -- confirmed, and this application has no path that does so.
  "enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- The highest 30-second TOTP step already spent. 0 means none. bigint because
  -- the column outlives the arithmetic: floor(unix_seconds / 30) is about 5.8e7
  -- today, and an int would be a problem for somebody in 2038 rather than an
  -- honest column type now.
  "last_used_step" bigint DEFAULT 0 NOT NULL,

  -- SHA-256 hex of each UNSPENT recovery code. Spending one removes its digest,
  -- which is what makes a recovery code single-use. Never the codes.
  "recovery_code_hashes" text[] DEFAULT '{}'::text[] NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- One administrator, one row. The default means no writer has to know this;
  -- the constraint means no writer can get around it.
  CONSTRAINT "admin_totp_is_a_singleton" CHECK ("id" = 1),

  -- Property 1. Every field envelope.open() needs, present and not null. Written
  -- with ->> rather than the jsonb ? operator so that no tool in the path
  -- between here and Postgres can mistake it for a bind placeholder.
  CONSTRAINT "admin_totp_secret_is_sealed" CHECK (
    jsonb_typeof("secret_ciphertext") = 'object'
    AND ("secret_ciphertext" ->> 'ciphertext') IS NOT NULL
    AND ("secret_ciphertext" ->> 'iv') IS NOT NULL
    AND ("secret_ciphertext" ->> 'authTag') IS NOT NULL
    AND ("secret_ciphertext" ->> 'wrappedDek') IS NOT NULL
    AND ("secret_ciphertext" ->> 'keyVersion') IS NOT NULL
  ),

  CONSTRAINT "admin_totp_step_is_not_negative" CHECK ("last_used_step" >= 0),

  -- Digests, and nothing else — no empty strings, no codes stored by mistake.
  -- Expressed over the joined array because a CHECK constraint may not contain
  -- a subquery, so the usual `NOT EXISTS (SELECT ... unnest)` is unavailable.
  CONSTRAINT "admin_totp_recovery_hashes_are_sha256" CHECK (
    array_to_string("recovery_code_hashes", ',')
      ~ '^([0-9a-f]{64}(,[0-9a-f]{64})*)?$'
  )
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Properties 2, 3 and 4, in the one place the application cannot edit.
--
-- Grants stop the app writing the columns it must never write. They cannot stop
-- it writing a LOWER step into a column it is allowed to write, or adding a
-- recovery code to an array it is allowed to shrink — both are the same evasion
-- with an extra step, and both would be invisible in review because the
-- statement doing them looks ordinary.
--
-- The column list is restated here rather than trusted to the grants for the
-- same reason connection_links restates its own: a grant can be re-granted by
-- anyone who can run a migration, and a reader looking only at one of the two
-- should still see the rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_admin_totp_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext
     OR NEW.enrolled_at IS DISTINCT FROM OLD.enrolled_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'admin_totp: the enrolled secret cannot be changed by the application. Disenrolling is a deliberate act with the migrator role.'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.last_used_step < OLD.last_used_step THEN
    RAISE EXCEPTION
      'admin_totp.last_used_step only ever moves forward; a spent code stays spent'
      USING ERRCODE = '42501';
  END IF;

  -- Subset, not equality: burning a code removes a digest, and that is the only
  -- change this column may ever undergo after enrolment.
  IF NOT (NEW.recovery_code_hashes <@ OLD.recovery_code_hashes) THEN
    RAISE EXCEPTION
      'admin_totp: recovery codes can only be spent, never added'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER admin_totp_no_rewrite
  BEFORE UPDATE ON admin_totp
  FOR EACH ROW
  EXECUTE FUNCTION app_admin_totp_no_rewrite();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- 0003_grants.sql sets ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/
-- DELETE on every future migrator-created table to healdesk_app, so all four
-- have ALREADY landed on this table by the time these statements run. Every
-- line below is therefore a removal, and each is required rather than defensive.
--
-- DELETE goes first and matters most. A second factor the application can
-- delete is a second factor an attacker who reaches the application can delete,
-- and then sign in with the password alone — which is the whole of the control,
-- undone by one statement.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON admin_totp FROM healdesk_app;
--> statement-breakpoint

-- Column-level UPDATE. The app advances the step counter and spends recovery
-- codes. It has no business touching the secret, the enrolment date or the key.
REVOKE UPDATE ON admin_totp FROM healdesk_app;
--> statement-breakpoint
GRANT UPDATE ("last_used_step", "recovery_code_hashes") ON admin_totp TO healdesk_app;
--> statement-breakpoint

-- SELECT and INSERT survive the default grant; restated so the intended
-- privilege set is visible in one place rather than inferred from two files.
-- INSERT is what enrolment needs, and the singleton primary key is what stops it
-- being usable twice: a second enrolment conflicts rather than replacing the
-- first.
GRANT SELECT, INSERT ON admin_totp TO healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE admin_totp IS
  'The single administrator''s TOTP second factor. One row, pinned by a CHECK on a constant primary key. Stores the secret sealed with envelope encryption, never in the clear. Append-then-advance: the app role has no DELETE and may update only last_used_step and recovery_code_hashes, so nothing reachable from a request can disenrol the factor or re-point it at another authenticator. Identity plane: no clinic_id, no RLS, no PHI.';
--> statement-breakpoint

COMMENT ON COLUMN admin_totp.secret_ciphertext IS
  'The whole SealedPayload from src/lib/crypto/envelope.ts. The CHECK demands its fields so that storing the base32 secret directly fails the INSERT instead of silently making the column a working authenticator.';
--> statement-breakpoint

COMMENT ON COLUMN admin_totp.last_used_step IS
  'Highest 30-second TOTP step already spent. Advanced by UPDATE ... WHERE last_used_step < $step RETURNING, which is what makes two simultaneous submissions of one code produce a single success; the no-rewrite trigger refuses any decrease.';
--> statement-breakpoint

COMMENT ON COLUMN admin_totp.recovery_code_hashes IS
  'SHA-256 hex of each unspent recovery code. The codes are ours and carry 50 bits of entropy, so a digest is the right primitive and a password KDF is not; spending one is array_remove in a single conditional UPDATE, which is what makes it single-use. The trigger refuses any array that is not a subset of the one it replaces, so the application can never add a code.';

-- =============================================================================
-- Single-use connection links.
--
-- A clinic grants us read-only booking credentials exactly once and never signs
-- in. They click a link we mailed them, follow the wizard for their platform,
-- paste one credential, and are finished forever. There is no account, no
-- password and no session anywhere in that story — the link IS the credential,
-- the way a webhook signature is (see src/proxy.ts).
--
-- That makes this table the entire authentication surface for a route that can
-- write a clinic's booking credential. Four things follow from it.
--
-- ## 1. The token is never here
--
-- `token_hash` holds SHA-256(token). The 32 random bytes we mailed exist in the
-- clinic's inbox and nowhere else. A dump of this table yields no working link,
-- which is the whole reason the column is a digest rather than the secret.
--
-- The `octet_length = 32` check is not decoration. The single most likely way
-- this property dies is a refactor that stores the base64url token itself — 43
-- bytes — and nothing downstream would notice, because a link built from a
-- stored token still works perfectly. The constraint turns that silent
-- catastrophe into a failed INSERT.
--
-- ## 2. Consumption is a state change the application cannot undo
--
-- Single-use is enforced in three places, deliberately overlapping:
--
--   - `used_at IS NULL` in the WHERE clause of the consuming UPDATE, which
--     under READ COMMITTED makes two simultaneous submissions resolve to
--     exactly one winner (the loser blocks on the row lock, re-evaluates the
--     predicate against the committed row, and matches nothing).
--   - the trigger below, which refuses ANY update to a row that already has a
--     used_at — so the app cannot reset it to NULL and replay the link.
--   - the grants, which withhold DELETE — so the app cannot erase the evidence
--     that a link was used instead.
--
-- Any one of these alone leaves a hole: the WHERE clause is a line of code
-- somebody can edit, and a link that can be un-consumed or deleted is not
-- single-use, it is single-use-until-inconvenient.
--
-- ## 3. No cascade from clinics
--
-- `clinic_id` references clinics(id) with NO action, matching audit_log rather
-- than the PHI tables. These rows are a record of a credential grant; deleting
-- a clinic must not be a path to silently erasing them. Postgres refuses the
-- clinic delete instead, loudly, which is the correct outcome for a table whose
-- entire purpose is to be able to say what happened.
--
-- ## 4. It is tenant data, and the reader has no tenant
--
-- clinic_id means RLS, ENABLED and FORCEd like every other tenant table — the
-- drift test in tests/rls-drift.test.ts asks the catalog for tables with a
-- clinic_id and demands exactly that.
--
-- But the visitor holding the link has no session and therefore no tenant, and
-- a query against a FORCEd table with no tenant declared returns zero rows and
-- looks exactly like "no such link". So the tenant has to come from the token
-- itself, and something has to read clinic_id before the tenant exists.
--
-- The bootstrap policy below is that something, and the long comment above it
-- is the most important thing in this file: SECURITY DEFINER does not solve
-- this, because the definer would be the table owner and FORCE applies to the
-- owner too. Instead the visitor's own token digest, in a transaction-local
-- setting, is what the policy authorises against.
--
-- The lazy alternative — `clinic_id = app_current_clinic_id() OR
-- app_current_clinic_id() IS NULL` — was rejected outright: it would make the
-- whole table readable by any code path that merely forgot to open a tenant,
-- while still passing every assertion the drift test makes.
-- =============================================================================

CREATE TABLE "connection_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  -- No ON DELETE action. See section 3 above.
  "clinic_id" uuid NOT NULL,

  -- SHA-256 of the token we mailed. Never the token. See section 1.
  "token_hash" bytea NOT NULL,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,

  -- NULL means unused. This column is the single-use flag; everything in
  -- section 2 exists to keep it honest.
  "used_at" timestamp with time zone,

  -- The ops user who issued it, as an immutable snapshot.
  --
  -- Deliberately NOT a foreign key to "user", for the same reason audit_log
  -- carries a denormalised actor_label: a record of who granted access is
  -- worthless once it can read "nobody". A real FK would also have to pick a
  -- delete action, and both are wrong here — SET NULL fires an UPDATE that the
  -- no-rewrite trigger below correctly refuses, and NO ACTION makes offboarding
  -- an ops colleague fail on a table that has nothing to do with them.
  --
  -- Nullable because a link issued by a script has no human behind it, and a
  -- fabricated attribution would be worse than an absent one.
  "issued_by" text,

  -- Where it was redeemed from. Recorded once, at consumption.
  "consumed_ip" inet,

  CONSTRAINT "connection_links_token_hash_is_sha256"
    CHECK (octet_length("token_hash") = 32),
  CONSTRAINT "connection_links_expiry_after_creation"
    CHECK ("expires_at" > "created_at"),
  -- An ip on an unused link would mean we recorded a redemption that did not
  -- happen. Cheap to state, and it makes the column's meaning unambiguous.
  CONSTRAINT "connection_links_ip_only_when_consumed"
    CHECK ("consumed_ip" IS NULL OR "used_at" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "connection_links"
  ADD CONSTRAINT "connection_links_clinic_id_clinics_id_fk"
  FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- UNIQUE rather than a plain index, and it does double duty: it is the lookup
-- path for every resolve and consume, and it is what makes "one row per token"
-- a fact rather than an expectation.
CREATE UNIQUE INDEX "connection_links_token_hash_idx"
  ON "connection_links" USING btree ("token_hash");--> statement-breakpoint

-- Ops listing: "what links are outstanding for this clinic".
CREATE INDEX "connection_links_clinic_idx"
  ON "connection_links" USING btree ("clinic_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security, in two parts.
--
-- The first policy is the ordinary one every tenant table has. The second is
-- the interesting one, and it exists because of a trap worth stating plainly:
--
--   SECURITY DEFINER DOES NOT BYPASS RLS.
--
-- The obvious way to let an anonymous link holder find their tenant is a
-- definer function that reads clinic_id "as the owner". It does not work here
-- and it does not fail loudly — the definer IS healdesk_migrator, which owns
-- this table, and FORCE ROW LEVEL SECURITY applies policies to the owner too.
-- Such a function returns NULL for a perfectly valid token, and NULL is
-- indistinguishable from "no such link". A whole feature looks broken and every
-- test that stubs the database passes. Only `BYPASSRLS` on the role, or a
-- superuser, actually bypasses; `SET row_security = off` raises instead of
-- relaxing. So there is no definer trick available, and inventing one would
-- mean a role with BYPASSRLS in the request path — the one thing
-- docs/hipaa-compliance.md and tenant.ts are most emphatic about not having.
--
-- So the bootstrap read is authorised by the DATABASE, on the only credential
-- the visitor actually has: the token itself. `app_current_link_hash()` reads a
-- transaction-local GUC holding the SHA-256 the caller presented, and the
-- policy lets through exactly the row matching it — one row, selected by a
-- value nobody can produce without already holding the link.
--
-- Two things keep that narrow:
--
--   * `app_current_clinic_id() IS NULL` — it applies ONLY outside a tenant
--     transaction, which is the only situation that needs it. Inside one, the
--     ordinary policy governs and a stale hash setting is inert.
--   * FOR SELECT — reads only. Writes stay bound to the tenant policy's WITH
--     CHECK, so this can never become a way to insert a link into a clinic the
--     caller does not hold.
--
-- The result is that no code in this system reads this table with elevated
-- rights. Presenting the digest IS the authentication, and Postgres is what
-- enforces it rather than an `if` somebody can edit.
-- ---------------------------------------------------------------------------

-- The digest the current caller has presented, from a transaction-local
-- setting. STABLE so the planner hoists it to an InitPlan, and shaped-checked
-- so a junk setting yields NULL (no rows) rather than raising inside a policy.
CREATE OR REPLACE FUNCTION app_current_link_hash()
RETURNS bytea
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN current_setting('app.connection_link_hash', true) ~ '^[0-9a-f]{64}$'
           THEN decode(current_setting('app.connection_link_hash', true), 'hex')
           ELSE NULL
         END
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_current_link_hash() IS
  'SHA-256 a connection-link holder has presented, from app.connection_link_hash. Set with set_config(..., is_local => true) so it dies with the transaction and cannot follow a pooled connection to the next request.';
--> statement-breakpoint

ALTER TABLE connection_links ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE connection_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY connection_links_tenant_isolation ON connection_links
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

CREATE POLICY connection_links_token_bootstrap ON connection_links
  FOR SELECT
  USING (
    app_current_clinic_id() IS NULL
    AND token_hash = app_current_link_hash()
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Finding the tenant from the token.
--
-- Ordinary invoker rights: it runs as healdesk_app, under the policies above,
-- and gets exactly one row because it set the hash first. Nothing here is
-- privileged — the privilege is the digest.
--
-- It deliberately does NOT filter on expiry or used_at. Two reasons:
--
--   1. The authoritative liveness check belongs on the real row, read inside
--      the tenant transaction that acts on it, not in a helper that answered a
--      moment earlier.
--   2. Somebody clicking a link that was already redeemed is a signal worth
--      auditing, and audit_log.clinic_id is NOT NULL — without a clinic we
--      could not record the attempt at all.
--
-- Neither weakens it. The caller must present the digest to get anything back,
-- and the answer is one uuid: no token, no expiry, no clinic name, nothing the
-- app could not already read from the clinics table.
--
-- VOLATILE because set_config is. is_local => true scopes the setting to the
-- statement's own implicit transaction, so it cannot ride a pooled connection
-- into the next request — the same discipline, and the same reason, as
-- withTenant() in src/lib/tenant.ts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_connection_link_clinic(link_token_hash bytea)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  found uuid;
BEGIN
  IF link_token_hash IS NULL OR octet_length(link_token_hash) <> 32 THEN
    RETURN NULL;
  END IF;

  PERFORM set_config('app.connection_link_hash',
                     encode(link_token_hash, 'hex'),
                     true);

  SELECT l.clinic_id INTO found
    FROM connection_links l
   WHERE l.token_hash = link_token_hash;

  RETURN found;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_connection_link_clinic(bytea) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_connection_link_clinic(bytea) TO healdesk_app;
--> statement-breakpoint

COMMENT ON FUNCTION app_connection_link_clinic(bytea) IS
  'Tenant lookup for an anonymous link holder, before any tenant exists. Invoker rights: the bootstrap RLS policy, not a privilege, is what lets it see the row, and only the row whose digest was passed in. Never call it with anything a caller supplied unhashed.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A consumed link stays consumed.
--
-- Grants can stop the application deleting a row; they cannot stop it writing
-- `used_at = NULL` back over one, which is the same evasion with an extra step.
-- This is the only place that can prevent it, so it lives here rather than in
-- the query that happens to be written correctly today.
--
-- It also freezes the issuance facts. Widening expires_at on a link that has
-- been sitting in a forwarded inbox for a month is not an operation anyone
-- should have; reissuing is, and that writes a new row with a new token.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_connection_link_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
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
  THEN
    RAISE EXCEPTION
      'connection_links is append-then-consume: only used_at and consumed_ip may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER connection_links_no_rewrite
  BEFORE UPDATE ON connection_links
  FOR EACH ROW
  EXECUTE FUNCTION app_connection_link_no_rewrite();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges.
--
-- 0003 sets ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/DELETE on
-- every future migrator-created table to healdesk_app, so those four have
-- ALREADY landed on this table by the time these statements run. Everything
-- below is therefore a removal, and each one is required rather than defensive.
--
-- DELETE goes first and matters most: a link that can be deleted after it is
-- redeemed leaves no trace that a credential was ever granted through it.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON connection_links FROM healdesk_app;
--> statement-breakpoint

-- Column-level UPDATE. The app needs to write exactly two columns — the ones
-- consumption sets — and has no business touching the rest. This is the same
-- rule the trigger enforces, stated where the planner can refuse it earlier and
-- where a reader looking only at grants can still see it.
REVOKE UPDATE ON connection_links FROM healdesk_app;
--> statement-breakpoint
GRANT UPDATE ("used_at", "consumed_ip") ON connection_links TO healdesk_app;
--> statement-breakpoint

-- SELECT and INSERT survive from the default grant; restated so the intended
-- privilege set is visible in one place rather than inferred from two files.
GRANT SELECT, INSERT ON connection_links TO healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE connection_links IS
  'Single-use, no-account links that let a clinic hand us read-only booking credentials once. Stores SHA-256(token), never the token. Append-then-consume: no DELETE for the app role, and a trigger refuses any update to a consumed row. No PHI — a clinic name and a platform id are the most this surface ever renders.';
--> statement-breakpoint

COMMENT ON COLUMN connection_links.token_hash IS
  'SHA-256 of the 32 random bytes mailed to the clinic. Constrained to 32 bytes so storing the raw token fails the INSERT instead of silently making every row a working link.';
--> statement-breakpoint

COMMENT ON COLUMN connection_links.used_at IS
  'Set exactly once, by an UPDATE ... WHERE used_at IS NULL RETURNING. The conditional predicate is what makes two simultaneous submissions produce one stored credential.';

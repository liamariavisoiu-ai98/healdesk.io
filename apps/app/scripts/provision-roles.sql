-- =============================================================================
-- Role provisioning. Run ONCE, as a superuser or a managed host's admin user
-- (RDS's master user), BEFORE the first migration.
--
--   psql "$SUPERUSER_URL" \
--     -v migrator_password="$MIGRATOR_PASSWORD" \
--     -v app_password="$APP_PASSWORD" \
--     -f scripts/provision-roles.sql
--
-- Deliberately outside the migration journal: it creates roles, which are
-- cluster-level objects, and needs privileges the migration role must not have.
-- Re-running it is safe — it resets passwords and re-asserts attributes.
--
-- Why two roles at all:
--
--   healdesk_migrator  owns the tables. Postgres lets a table's OWNER bypass
--                      its row-level security policies, so the application
--                      must never connect as this role.
--
--   healdesk_app       the runtime role. Privileges only via the grants in
--                      0003, no BYPASSRLS, owns nothing. DATABASE_URL points here.
--
-- Getting this wrong is silent. Neon's `neondb_owner` and Supabase's
-- `service_role` both bypass RLS, so connecting the app as either would leave
-- every policy in place and doing nothing at all.
-- tests/tenant-isolation.test.ts asserts rolsuper = false AND rolbypassrls = false.
-- =============================================================================

\set ON_ERROR_STOP on

-- Create the roles if absent. No password here: psql does NOT interpolate its
-- variables inside dollar-quoted blocks, so the passwords are set below in
-- plain statements where interpolation does happen.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healdesk_migrator') THEN
    CREATE ROLE healdesk_migrator LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healdesk_app') THEN
    CREATE ROLE healdesk_app LOGIN;
  END IF;
END
$$;

ALTER ROLE healdesk_migrator PASSWORD :'migrator_password';
ALTER ROLE healdesk_app      PASSWORD :'app_password';

-- Belt and braces: the attributes that would defeat RLS must be off, in case
-- the roles already existed with different settings. A superuser strips them.
-- A managed host's admin is not a superuser (RDS's master user is not), and
-- Postgres refuses it any mention of SUPERUSER, even to turn it off, so there
-- the roles are checked instead: CREATE ROLE above made them with all of these
-- off, and a role found otherwise stops the script rather than being trusted.
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE healdesk_app      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    ALTER ROLE healdesk_migrator NOSUPERUSER NOBYPASSRLS;
  ELSIF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE (rolname = 'healdesk_app' AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
       OR (rolname = 'healdesk_migrator' AND (rolsuper OR rolbypassrls))
  ) THEN
    RAISE EXCEPTION 'healdesk_app or healdesk_migrator holds an attribute that defeats row-level security; drop the role and run this again';
  END IF;
END
$$;

-- Nothing reachable by default.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

GRANT USAGE, CREATE ON SCHEMA public TO healdesk_migrator;
-- The runtime role needs to reach the schema; table privileges arrive in 0003.
GRANT USAGE ON SCHEMA public TO healdesk_app;

-- Database-level privileges. These need a literal database name, hence the
-- format() interpolation.
--
-- CREATE on the database (not just on `public`) is required because the
-- migration runner puts its journal table in its own `drizzle` schema, and
-- creating a schema is a database-level privilege. Without it migrations fail
-- with a bare 42501 that points at nothing useful.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO healdesk_app', current_database());
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO healdesk_migrator', current_database());
END
$$;

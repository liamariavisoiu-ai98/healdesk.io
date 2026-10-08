-- =============================================================================
-- Role provisioning. Run BEFORE the first migration, connected to the app's
-- database as a role that can create roles and owns that database:
--
--   * on RDS, the master user (CREATEROLE, CREATEDB, owner of the database
--     named at creation; NOT a superuser), from the db-admin image
--     (infra/aws/images/db-admin), which runs exactly this file;
--   * in CI and on a laptop, the container's superuser (ci.yml, dev-db.sh).
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v migrator_password="$MIGRATOR_PASSWORD" \
--     -v app_password="$APP_PASSWORD" \
--     -f scripts/provision-roles.sql
--
-- Deliberately outside the migration journal: it creates roles, which are
-- cluster-level objects, and needs privileges the migration role must not have.
-- Re-running it is safe — it resets passwords and re-checks attributes.
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

-- The runtime role may not create databases or roles. Settable by any role
-- with CREATEROLE that holds those attributes itself, as RDS's master does.
ALTER ROLE healdesk_app NOCREATEDB NOCREATEROLE;

-- Check, rather than set, the attributes that would defeat RLS. Only a
-- superuser may even name SUPERUSER in ALTER ROLE, NOSUPERUSER included, and
-- naming BYPASSRLS needs BYPASSRLS, so the `ALTER ROLE ... NOSUPERUSER
-- NOBYPASSRLS` this file used to run stopped here on RDS, after the
-- passwords and before every grant below. CREATE ROLE's defaults are already
-- NOSUPERUSER NOBYPASSRLS; what can go wrong is a role that existed before
-- this ran, so fail loudly and let a superuser (or the master, dropping and
-- re-running) fix it.
--
-- Membership is checked for the same reason: a role carries the privileges of
-- every role it belongs to, so a runtime role inside the migrator (an owner)
-- or rds_superuser would hold what this split exists to withhold while its
-- own attributes look clean.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN ('healdesk_app', 'healdesk_migrator')
                AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'healdesk_app or healdesk_migrator is SUPERUSER or BYPASSRLS: drop the role and re-run this file';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members m
               JOIN pg_roles u ON u.oid = m.member
              WHERE u.rolname IN ('healdesk_app', 'healdesk_migrator')) THEN
    RAISE EXCEPTION 'healdesk_app or healdesk_migrator is a member of another role: revoke the membership and re-run this file';
  END IF;
END
$$;

-- Nothing reachable by default. On PostgreSQL 15 and later `public` belongs to
-- pg_database_owner, so the database's owner can do this without being a
-- superuser.
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

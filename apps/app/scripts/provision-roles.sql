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

-- The attributes that would defeat RLS must be off, in case the roles existed
-- before this ran with different settings. A superuser (CI, a laptop) strips
-- them. Nobody else may: only a superuser may even name SUPERUSER in ALTER
-- ROLE, NOSUPERUSER included, and naming BYPASSRLS needs BYPASSRLS, so on RDS,
-- whose master user is not a superuser, the `ALTER ROLE ... NOSUPERUSER
-- NOBYPASSRLS` this file used to run stopped here, after the passwords and
-- before every grant below. There the roles are checked instead: CREATE ROLE
-- above made them with every one of these off, and a role found otherwise
-- stops the script rather than being trusted.
--
-- Membership is checked for the same reason: a role carries the privileges of
-- every role it belongs to, so a runtime role inside the migrator (an owner)
-- or rds_superuser would hold what this split exists to withhold while its
-- own attributes look clean.
DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE healdesk_app      NOSUPERUSER NOBYPASSRLS;
    ALTER ROLE healdesk_migrator NOSUPERUSER NOBYPASSRLS;
  END IF;

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

-- =============================================================================
-- healdesk_readonly: the role of the db-query task (docs/design/db-access-
-- 2026-10-22.md). Created only when the caller passes -v readonly_password,
-- which the db-bootstrap task does and CI and dev-db.sh do not, so a database
-- without the variable is left exactly as it was.
--
-- It reads business and configuration tables and nothing else: the SELECT
-- grants are not here (only a table's owner can grant on it) but in
-- scripts/readonly-grants.ts, which the migrate task runs as the migrator after
-- every migration, from scripts/readonly-tables.ts. This role owns nothing, has
-- no BYPASSRLS, and its sessions are read only with short time limits whatever
-- the client asks for.
-- =============================================================================
\if :{?readonly_password}

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healdesk_readonly') THEN
    CREATE ROLE healdesk_readonly LOGIN;
  END IF;
END
$$;

ALTER ROLE healdesk_readonly PASSWORD :'readonly_password';
ALTER ROLE healdesk_readonly NOCREATEDB NOCREATEROLE;
ALTER ROLE healdesk_readonly SET default_transaction_read_only = on;
ALTER ROLE healdesk_readonly SET statement_timeout = '30s';
ALTER ROLE healdesk_readonly SET idle_in_transaction_session_timeout = '30s';

-- As for the other two roles: found otherwise, the script stops rather than
-- trusting a role that existed before with other attributes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'healdesk_readonly'
                AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'healdesk_readonly is SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB: drop the role and re-run this file';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members m
               JOIN pg_roles u ON u.oid = m.member
              WHERE u.rolname = 'healdesk_readonly') THEN
    RAISE EXCEPTION 'healdesk_readonly is a member of another role: revoke the membership and re-run this file';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO healdesk_readonly', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO healdesk_readonly;

\endif

-- =============================================================================
-- healdesk_writer: the role of the db-apply task (docs/design/db-access-2026-
-- 10-22.md, "The write path"). Created only when the caller passes -v
-- writer_password, as for healdesk_readonly above, so a database without the
-- variable is left as it was.
--
-- INSERT and UPDATE on a short list of tables, and SELECT where the read-only
-- role has it: none of that is granted here (only a table's owner can grant)
-- but in scripts/writer-grants.ts, from scripts/readonly-tables.ts, run by the
-- migrate task. It owns nothing, has no BYPASSRLS, and cannot delete. Unlike
-- the read-only role its sessions are not read only, since writing is the job;
-- they carry short time limits instead, and every statement it runs is confined
-- by row-level security to the one clinic the run sets.
-- =============================================================================
\if :{?writer_password}

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healdesk_writer') THEN
    CREATE ROLE healdesk_writer LOGIN;
  END IF;
END
$$;

ALTER ROLE healdesk_writer PASSWORD :'writer_password';
ALTER ROLE healdesk_writer NOCREATEDB NOCREATEROLE;
ALTER ROLE healdesk_writer SET statement_timeout = '30s';
ALTER ROLE healdesk_writer SET lock_timeout = '5s';
ALTER ROLE healdesk_writer SET idle_in_transaction_session_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'healdesk_writer'
                AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION 'healdesk_writer is SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB: drop the role and re-run this file';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_auth_members m
               JOIN pg_roles u ON u.oid = m.member
              WHERE u.rolname = 'healdesk_writer') THEN
    RAISE EXCEPTION 'healdesk_writer is a member of another role: revoke the membership and re-run this file';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO healdesk_writer', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO healdesk_writer;

\endif

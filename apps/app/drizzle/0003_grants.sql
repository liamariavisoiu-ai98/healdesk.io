-- =============================================================================
-- Privileges for the runtime role.
--
-- RLS decides WHICH ROWS a role may touch. Grants decide WHETHER it may touch
-- the table at all, and with which verbs. Both are needed: a policy is
-- meaningless if the role has no privileges, and a broad grant is dangerous
-- without a policy.
--
-- Runs after 0002 so the policies exist before anything is reachable.
-- =============================================================================

-- Identity plane. No clinic_id, so no RLS — Better Auth must read these before
-- a tenant is known. They hold no PHI: a clinic employee's work email is
-- business contact data.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", "session", "account", "verification",
  "organization", "member", "invitation"
TO healdesk_app;
--> statement-breakpoint

-- Tenant plane. Full DML, but every statement is filtered by the policies in
-- 0002 and by the tenant GUC that withTenant() sets.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  clinics,
  clinic_memberships,
  provider_connections,
  ad_interactions,
  contacts,
  conversations,
  appointments,
  transactions
TO healdesk_app;
--> statement-breakpoint

-- audit_log is APPEND-ONLY, enforced here rather than by convention.
--
-- An audit trail the application can rewrite is not an audit trail. Withholding
-- UPDATE and DELETE means even a fully compromised application process cannot
-- erase evidence of what it did — only a superuser or the table owner can, and
-- the app connects as neither.
GRANT SELECT, INSERT ON audit_log TO healdesk_app;
--> statement-breakpoint

-- security_events is likewise append-only. It has no clinic_id (a failed
-- sign-in has no tenant), so it carries no RLS policy and is readable only
-- through the admin console.
GRANT SELECT, INSERT ON security_events TO healdesk_app;
--> statement-breakpoint

-- Sequences: none of the tables use serial ids (all uuid/text), but grant
-- defensively so adding one later doesn't fail at runtime in production.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO healdesk_app;
--> statement-breakpoint

-- Anything created later by the migrator gets the same baseline automatically.
-- Note the deliberate omission of audit_log-style tables from this default —
-- new append-only tables must be granted explicitly and consciously.
ALTER DEFAULT PRIVILEGES FOR ROLE healdesk_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO healdesk_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE healdesk_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO healdesk_app;
--> statement-breakpoint

-- The runtime role must never own or alter schema objects.
REVOKE CREATE ON SCHEMA public FROM healdesk_app;

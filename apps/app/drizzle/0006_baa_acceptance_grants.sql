-- =============================================================================
-- baa_acceptances is a legal record, so it is append-only.
--
-- The ALTER DEFAULT PRIVILEGES in 0003 grants full DML on every new table the
-- migrator creates, which is the right default for tenant tables and the wrong
-- one here. A business-associate agreement acceptance that the application can
-- edit afterwards is not evidence of anything.
--
-- This is the pattern to repeat for any future record that exists to prove
-- something happened: let the default grant land, then take back UPDATE and
-- DELETE deliberately.
-- =============================================================================

REVOKE UPDATE, DELETE ON baa_acceptances FROM healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE baa_acceptances IS
  'Append-only. Records which BAA version an organization accepted, its hash, and by whom. UPDATE and DELETE are withheld from the runtime role on purpose.';

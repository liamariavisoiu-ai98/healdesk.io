-- =============================================================================
-- BAA 1.2.2 is released, and the go-live floor moves to it (9 October 2026).
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- The owner released BAA 1.2.2 on 9 October 2026 (packages/catalog/src/baa.ts,
-- B1-B3; docs/counsel/agreement-changes.md §13): 1.2.1 with the subcontractor
-- list given on request instead of at healdesk.io/subprocessors, which is
-- gone; hello@healdesk.io as healdesk's notice email instead of legal@, which
-- is no longer used; and the product spec's breach wording, "without
-- unreasonable delay and in no case later than 60 calendar days", for a
-- breach, a security incident and an improper use or disclosure alike.
--
-- No clinic had signed 1.2.1, so the release raised MIN_ACCEPTABLE_BAA_VERSION
-- straight to 1.2.2, with no overlap window (BAA_RELEASE_OVERLAP stays
-- empty). isBaaVersionAcceptable() in @healdesk/catalog therefore accepts 1.2.2
-- and nothing else, and this function, its SQL mirror, must say the same:
-- without this migration go-live (app_mark_clinic_production) and a supersede
-- (app_supersede_agreement) would refuse every 1.2.2 signer and keep accepting
-- 1.2.1, a document that points clinics at a page that no longer exists.
-- tests/database-audit.test.ts holds the two together.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no real account is bound
-- to any agreement. A synthetic account bound to 1.2.1 can no longer go live;
-- it re-signs 1.2.2 first, as a superseded signer would.
--
-- The destruction rule needs no change: app_destruction_rule() (0058) is an
-- allow-list of the versions that state the export rule, and 1.2.2 states the
-- thirty days, as 1.2.1 does (DESTRUCTION_RULES in lib/offboarding). Only the
-- console's wording of the job and two comments name the versions, and they
-- now say "1.2.2 and earlier".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The acceptable versions: isBaaVersionAcceptable(), written out
-- -----------------------------------------------------------------------------
-- 0048's definition, with 1.2.2 in place of 1.2.1. An allow-list, so a draft,
-- an unknown string or NULL is refused, and so is every superseded version.
-- CREATE OR REPLACE keeps the function's owner, grants and every caller.
CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.2.2']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog, which is 1.2.2 since 9 October 2026 (0061). Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The thirty days, as the console and the comments name them
-- -----------------------------------------------------------------------------
UPDATE scheduled_jobs
   SET cadence = 'Hourly; destroys each offboarded clinic''s patient data when the agreement its service ended under says: under BAA 1.2.2 and earlier from day 29, export or not; under BAA 1.3.0 and the DPA from day 29 once the export is delivered (from the delivery when later) and from day 89 without it'
 WHERE name = 'offboarding-destroy';--> statement-breakpoint

COMMENT ON FUNCTION app_destruction_due(uuid) IS
  'Whether a clinic''s data may be destroyed now, by the database''s clock: under the thirty days (BAA 1.2.2 and earlier, none, unknown) from day 29 after offboarding_started_at; under the export rule (BAA 1.3.0, DPA 1.0.0) from day 29 once export_delivered_at is set, and from day 89 regardless. Each a day before the agreement''s thirty or ninety days, for an hourly job. Days of twenty-four hours: it runs in UTC, whatever zone the caller set. The floor under app_destroy_booking_requests, app_destroy_contact_evidence, app_destroy_clinic_providers and app_mark_clinic_destroyed.';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroy_after IS
  'Thirty days after offboarding_started_at, the thirty days every agreement counts. Destruction is due a day before it: under the thirty days (BAA 1.2.2 and earlier) whatever the export; under the export rule (BAA 1.3.0, DPA 1.0.0) once the export is delivered, from the delivery when that is later, and a day before ninety days after the start regardless. app_destruction_due() and lib/offboarding say which. Written only by app_start_offboarding(); a new clinic cannot carry it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.2.2')
     OR app_baa_version_acceptable('1.2.1')
     OR app_baa_version_acceptable('1.2.0')
     OR app_baa_version_acceptable('1.3.0')
     OR app_baa_version_acceptable('1.0.0')
     OR app_baa_version_acceptable('9.9.9')
     OR app_baa_version_acceptable('')
     OR app_baa_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must accept 1.2.2 and nothing else: not 1.2.1, 1.2.0, the 1.3.0 draft, 1.0.0, an unknown version, the empty string or NULL.';
  END IF;
  IF app_destruction_rule('1.2.2') <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule does not give 1.2.2 the thirty days its Term clause states.';
  END IF;
END;
$$;

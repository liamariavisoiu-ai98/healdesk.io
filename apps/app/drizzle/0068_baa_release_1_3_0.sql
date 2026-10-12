-- =============================================================================
-- BAA 1.3.0 and calendar-election/1.0.0 are released (12 October 2026), and
-- the go-live floor moves to 1.3.0.
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- The owner released BAA 1.3.0, the calendar-dependent agreement, and the
-- calendar election that goes with it on 12 October 2026, on the owner's own
-- review and after Claude's audit of the full text against the code (plan
-- C19; packages/catalog/src/baa.ts and calendar-terms.ts;
-- docs/counsel/agreement-changes.md §12.15). 1.3.0 is BAA_TEMPLATES[0], so
-- checkout offers it.
--
-- No clinic had signed 1.2.2, so 1.3.0 replaces it outright (owner, 12
-- October 2026: "1.2.2 does not need to stay signable. Just replace it."):
-- MIN_ACCEPTABLE_BAA_VERSION is 1.3.0 and BAA_RELEASE_OVERLAP is empty, the
-- treatment 0062 gave 1.2.2 over 1.2.1. The reason the prepared release kept the
-- floor at 1.2.2, that nothing moves a 1.2.2 signer onto 1.3.0, protected
-- clinics holding 1.2.2, and there are none. isBaaVersionAcceptable() in
-- @healdesk/catalog therefore accepts 1.3.0 and nothing else, and
-- app_baa_version_acceptable(), its SQL mirror, must say the same: without
-- this migration go-live (app_mark_clinic_production) and a supersede
-- (app_supersede_agreement) would refuse every 1.3.0 signer and keep
-- accepting 1.2.2.
--
-- calendar-election/1.0.0 is released with it (CALENDAR_ELECTIONS,
-- approvedByCounsel true), so app_calendar_election_released(), the election
-- guard's copy of the catalogue (0057), lists it: an election under it now
-- counts for every clinic, not only a demo clinic, and the guard requires a
-- new row under it to say document_released true. Rows recorded before keep
-- what they said, since the guard refuses UPDATE for every role, and only a
-- demo clinic could record one. The DPA's own election
-- (calendar-election-dpa/1.0.0) is not released, as the DPA is not, and stays
-- off the list. tests/database-audit.test.ts holds both lists to the
-- catalogue.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no real account is bound
-- to any agreement. A synthetic account bound to 1.2.2 can no longer go live;
-- it re-signs 1.3.0 first, as a superseded signer would.
--
-- The destruction rule needs no change: app_destruction_rule() (0058) has
-- given 1.3.0 the export rule its Term clause states since 0058, and 1.2.2
-- the thirty days; the assertions below hold both.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The acceptable versions: isBaaVersionAcceptable(), written out
-- -----------------------------------------------------------------------------
-- 0062's definition, with 1.3.0 in place of 1.2.2. An allow-list, so a draft,
-- an unknown string or NULL is refused, and so is every version below the
-- floor.
-- CREATE OR REPLACE keeps the function's owner, grants and every caller.
CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.3.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog, which is 1.3.0 since 12 October 2026 (baa_release_1_3_0). Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The released election documents: CALENDAR_ELECTIONS, written out
-- -----------------------------------------------------------------------------
-- 0057's definition, with calendar-election/1.0.0 in its empty list. An
-- allow-list, so a draft, an unknown string or NULL is unreleased, and an
-- election under one still counts only for a demo clinic.
CREATE OR REPLACE FUNCTION app_calendar_election_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['calendar-election/1.0.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_calendar_election_released(text) IS
  'True for the calendar election document versions released for use: CALENDAR_ELECTIONS with approvedByCounsel true in @healdesk/catalog, written out (calendar-election/1.0.0, released with BAA 1.3.0 on 12 October 2026; baa_release_1_3_0). Must equal the catalogue (parity test in tests/database-audit.test.ts); a release needs a migration redefining it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.3.0')
     OR app_baa_version_acceptable('1.2.2')
     OR app_baa_version_acceptable('1.2.1')
     OR app_baa_version_acceptable('1.2.0')
     OR app_baa_version_acceptable('1.0.0')
     OR app_baa_version_acceptable('1.1.0-draft')
     OR app_baa_version_acceptable('0.1.0-draft')
     OR app_baa_version_acceptable('dpa/1.0.0')
     OR app_baa_version_acceptable('9.9.9')
     OR app_baa_version_acceptable('')
     OR app_baa_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must accept 1.3.0 and nothing else: not 1.2.2, 1.2.1, 1.2.0, 1.0.0, a draft, the DPA, an unknown version, the empty string or NULL.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election/9.9.9')
     OR app_calendar_election_released('')
     OR app_calendar_election_released(NULL) THEN
    RAISE EXCEPTION 'app_calendar_election_released must list calendar-election/1.0.0 and nothing else: not the DPA''s election, an unknown version, the empty string or NULL.';
  END IF;
  IF app_destruction_rule('1.3.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule does not give 1.3.0 the export rule and 1.2.2 the thirty days their Term clauses state.';
  END IF;
END;
$$;

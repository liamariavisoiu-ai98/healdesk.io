-- =============================================================================
-- BAA 1.5.0 is released (14 October 2026), and the go-live floor moves to it.
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- On 14 October 2026 the owner decided that a transcript's sealed copy is
-- deleted the moment delivery is confirmed (0072): in the same transaction as
-- SES's report that the practice's mail server accepted the email; kept and
-- sent again after a failure or a return until it is delivered, but never
-- held more than 30 days after it was queued; and deleted 72 hours after a
-- send nothing answered. BAA 1.4.0 promises one encrypted copy held "until
-- seven days after the email was first accepted for delivery", and answers
-- patients from the email "after them". 1.5.0 says what the product does
-- instead, in clauses 11 and 14, and nothing else changes
-- (packages/catalog/src/baa.ts, above MINIMUM_NECESSARY_1_5;
-- docs/counsel/agreement-changes.md §15). The owner released it the same day
-- without external counsel; it is BAA_TEMPLATES[0], so checkout offers it.
--
-- No clinic had signed 1.4.0 (the product has not launched), so 1.5.0
-- replaces it outright, the treatment 0070 gave 1.3.0:
-- MIN_ACCEPTABLE_BAA_VERSION is 1.5.0 and BAA_RELEASE_OVERLAP is empty.
-- isBaaVersionAcceptable() in @healdesk/catalog therefore accepts 1.5.0 and
-- nothing else, and app_baa_version_acceptable(), its SQL mirror, must say
-- the same: without this migration go-live (app_mark_clinic_production) and
-- a supersede (app_supersede_agreement) would refuse every 1.5.0 signer and
-- keep accepting 1.4.0.
--
-- The destruction rule: 1.5.0's Term clause is 1.3.0's own clause object, as
-- 1.4.0's is (the export delivered unasked within thirty days, destruction at
-- thirty days with it and at ninety without), so app_destruction_rule() gives
-- 1.5.0 the export rule 0070 gave 1.4.0. It is an allow-list, so a version
-- left off it would fall to the thirty days, which its text does not state.
-- 1.4.0 and 1.3.0 keep theirs: a synthetic clinic bound to either before
-- today still offboards by what it signed. DESTRUCTION_RULES in
-- lib/offboarding/offboarding.ts says the same, and the parity test in
-- tests/destruction-clock.test.ts holds the two together.
--
-- The calendar election needs no change: calendar-election/1.0.0 replaces the
-- Google Calendar clause of whichever Business Associate Agreement the
-- practice signed, and 1.5.0 carries 1.3.0's calendar clauses as the same
-- objects. The assertions below hold its list as 0070 left it.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no real account is bound
-- to any agreement. A synthetic account bound to 1.4.0 can no longer go live;
-- it re-signs 1.5.0 first, as a superseded signer would.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The acceptable versions: isBaaVersionAcceptable(), written out
-- -----------------------------------------------------------------------------
-- 0070's definition, with 1.5.0 in place of 1.4.0. An allow-list, so a draft,
-- an unknown string or NULL is refused, and so is every version below the
-- floor. CREATE OR REPLACE keeps the function's owner, grants and every
-- caller.
CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.5.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog, which is 1.5.0 since 14 October 2026 (baa_release_1_5_0). Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The destruction rule: DESTRUCTION_RULES, written out
-- -----------------------------------------------------------------------------
-- 0070's definition, with 1.5.0 beside 1.4.0, 1.3.0 and dpa/1.0.0. Total and
-- never NULL; NULL (no agreement) and any version not listed read as the
-- thirty days. CREATE OR REPLACE keeps 0058's REVOKE from PUBLIC and its
-- grant to healdesk_app, and every caller (app_destruction_due among them).
CREATE OR REPLACE FUNCTION app_destruction_rule(version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version = ANY (ARRAY['1.5.0', '1.4.0', '1.3.0', 'dpa/1.0.0']) THEN 'export_or_ninety'
           ELSE 'thirty_days'
         END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_destruction_rule(text) IS
  'The destruction rule a stored agreement version states: export_or_ninety for BAA 1.5.0, 1.4.0 and 1.3.0, whose Term clause is the same object, and DPA 1.0.0 (dpa/1.0.0), thirty_days for every other version, an unknown one and NULL. The SQL mirror of DESTRUCTION_RULES in lib/offboarding/offboarding.ts (parity test in tests/destruction-clock.test.ts); 1.5.0 added by baa_release_1_5_0.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.5.0')
     OR app_baa_version_acceptable('1.4.0')
     OR app_baa_version_acceptable('1.3.0')
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
    RAISE EXCEPTION 'app_baa_version_acceptable must accept 1.5.0 and nothing else: not 1.4.0, 1.3.0, 1.2.2, 1.2.1, 1.2.0, 1.0.0, a draft, the DPA, an unknown version, the empty string or NULL.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election/9.9.9')
     OR app_calendar_election_released('')
     OR app_calendar_election_released(NULL) THEN
    RAISE EXCEPTION 'app_calendar_election_released must list calendar-election/1.0.0 and nothing else: not the DPA''s election, an unknown version, the empty string or NULL.';
  END IF;
  IF app_destruction_rule('1.5.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.4.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.3.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days'
     OR app_destruction_rule('1.0.0') <> 'thirty_days'
     OR app_destruction_rule('1.5.1') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule(NULL) <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule does not give 1.5.0, 1.4.0, 1.3.0 and dpa/1.0.0 the export rule their Term clauses state, and the thirty days to 1.2.2, 1.0.0, an unknown version and none.';
  END IF;
END;
$$;

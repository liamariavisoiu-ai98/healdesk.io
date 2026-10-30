-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- DPA 1.1.0 is released (owner, <DAY> 2026). This migration changes no table,
-- so drizzle generated it empty (--custom); everything below is the part
-- drizzle cannot express.
--
-- PREPARED, NOT APPLIED. This file is kept in
-- docs/design/launch-readiness-2026-10-27/ until the owner releases 1.1.0.
-- It goes into apps/app/drizzle/ only in the commit that sets
-- DPA_1_1_0_RELEASED to true in packages/catalog/src/dpa.ts, through
-- `npx drizzle-kit generate --custom --name dpa_release_1_1_0` run in apps/app
-- and this text pasted over the empty file it creates, with <DAY> replaced by
-- the day of the owner's word (dpa-1-1-0-owner-checklist.md, step 4).
-- apps/app/tests/dpa-release-1-1-0.test.ts holds both allow-lists below to
-- what the catalogue says once released, before the release; after it, the
-- parity tests in tests/go-live.test.ts (app_dpa_version_released) and
-- tests/destruction-clock.test.ts (app_destruction_rule) hold them to the
-- catalogue as it then is.
--
-- DPA 1.0.0's Safeguards clause ends its telephone exception with "healdesk
-- places no calls and sends no SMS." The owner allowed one optional text
-- after a booking call, carrying fixed wording and the practice's own
-- payment link (28 October 2026); BAA 1.6.0 says so (0136). 1.1.0 is 1.0.0
-- with only that sentence pair changed, in BAA 1.6.0's words: "healdesk
-- places no calls and sends no SMS, except that the assistant is engineered
-- and designed to offer a caller a single text message that carries fixed
-- wording and Practice's own payment link, where Practice has chosen that
-- option. This exception, that text included, does not extend to any other
-- channel or content." (packages/catalog/src/dpa.ts, DPA_NO_SMS_1_1;
-- docs/counsel/agreement-changes.md §21.)
--
-- What the database has to say with the catalogue:
--
--   * app_dpa_version_released() (0104's definition, the latest) lists
--     dpa/1.1.0 beside dpa/1.0.0. It is go-live's copy of the DPA's flag,
--     through app_agreement_version_acceptable() (0090, unchanged): without
--     this, app_mark_clinic_production() and app_go_live_missing() would
--     refuse every 1.1.0 signer ("not released") while checkout signed and
--     provisioning bound it. dpa/1.0.0 stays listed: it is released, a
--     practice may hold it, and the DPA has no floor (go-live accepts every
--     released DPA version; getDpaTemplate(v).approvedByCounsel, which the
--     parity test in tests/go-live.test.ts holds this function to).
--   * app_destruction_rule() (0091's definition, the latest) gives dpa/1.1.0
--     the export rule its Term clause states: it is 1.0.0's Term clause, the
--     same object. An allow-list, so without this a clinic bound to 1.1.0
--     would offboard on the thirty days, which its agreement does not state.
--     DESTRUCTION_RULES (apps/app lib/offboarding/offboarding.ts) lists
--     1.1.0 from the release, and tests/destruction-clock.test.ts holds the
--     two together.
--
-- Unchanged, and asserted below: app_baa_version_acceptable() never accepts
-- a DPA and still accepts BAA 1.6.0 alone (0136);
-- app_calendar_election_released() lists calendar-election/1.0.0 and
-- calendar-election-dpa/1.0.0 (0104): 1.1.0 carries 1.0.0's calendar
-- clauses as the same objects, so the DPA's election form amends it as it
-- amends 1.0.0, and the election guard reads the agreement's kind from its
-- "dpa/" prefix, not its version.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed
-- data (CLAUDE.md, "Until BAA coverage is in place"), and every function is
-- replaced with CREATE OR REPLACE, keeping its owner, grants and callers.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The released DPA versions: getDpaTemplate(v).approvedByCounsel, written out
-- -----------------------------------------------------------------------------
-- 0104's definition, with dpa/1.1.0 beside dpa/1.0.0. An allow-list, so a
-- later draft, an unknown string or NULL is refused.
CREATE OR REPLACE FUNCTION app_dpa_version_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['dpa/1.1.0', 'dpa/1.0.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_dpa_version_released(text) IS
  'The released DPA versions, written out: dpa/1.0.0, released by the owner on 20 October 2026 (dpa_release_1_0_0), and dpa/1.1.0, released on <DAY> 2026 (dpa_release_1_1_0). Must equal getDpaTemplate(v).approvedByCounsel in @healdesk/catalog (parity test in tests/go-live.test.ts); a release needs a migration redefining it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The destruction rule: DESTRUCTION_RULES, written out
-- -----------------------------------------------------------------------------
-- 0091's definition, with dpa/1.1.0 beside dpa/1.0.0. Total and never NULL;
-- NULL (no agreement) and any version not listed read as the thirty days.
-- CREATE OR REPLACE keeps 0058's REVOKE from PUBLIC and its grant to
-- healdesk_app, and every caller (app_destruction_due among them).
CREATE OR REPLACE FUNCTION app_destruction_rule(version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version = ANY (ARRAY['1.6.0', '1.5.1', '1.5.0', '1.4.0', '1.3.0', 'dpa/1.1.0', 'dpa/1.0.0']) THEN 'export_or_ninety'
           ELSE 'thirty_days'
         END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_destruction_rule(text) IS
  'The destruction rule a stored agreement version states: export_or_ninety for BAA 1.6.0, 1.5.1, 1.5.0, 1.4.0 and 1.3.0, whose Term clauses state the same export-or-ninety rule, and DPA 1.1.0 and 1.0.0 (dpa/1.1.0, dpa/1.0.0), whose Term clause is the same; thirty_days for every other version, an unknown one and NULL. The SQL mirror of DESTRUCTION_RULES in lib/offboarding/offboarding.ts (parity test in tests/destruction-clock.test.ts); 1.5.1 added by baa_release_1_5_1, 1.6.0 by baa_draft_1_6_0, dpa/1.1.0 by dpa_release_1_1_0.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_dpa_version_released('dpa/1.1.0')
     OR NOT app_dpa_version_released('dpa/1.0.0')
     OR app_dpa_version_released('dpa/1.2.0')
     OR app_dpa_version_released('dpa/9.9.9')
     OR app_dpa_version_released('1.6.0')
     OR app_dpa_version_released('')
     OR app_dpa_version_released(NULL) THEN
    RAISE EXCEPTION 'app_dpa_version_released must list dpa/1.1.0 and dpa/1.0.0 and nothing else: not an unknown DPA version, a BAA, the empty string or NULL.';
  END IF;
  IF NOT app_agreement_version_acceptable('dpa/1.1.0')
     OR NOT app_agreement_version_acceptable('dpa/1.0.0')
     OR NOT app_agreement_version_acceptable('1.6.0')
     OR app_agreement_version_acceptable('1.5.1')
     OR app_agreement_version_acceptable('dpa/9.9.9')
     OR app_agreement_version_acceptable('')
     OR app_agreement_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_agreement_version_acceptable must accept the released DPA versions (dpa/1.1.0, dpa/1.0.0) and the BAA floor (1.6.0), and nothing else.';
  END IF;
  IF app_baa_version_acceptable('dpa/1.1.0')
     OR app_baa_version_acceptable('dpa/1.0.0')
     OR NOT app_baa_version_acceptable('1.6.0') THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must still accept BAA 1.6.0 and never a DPA.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR NOT app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election-dpa/1.1.0') THEN
    RAISE EXCEPTION 'app_calendar_election_released must still list calendar-election/1.0.0 and calendar-election-dpa/1.0.0 and nothing else.';
  END IF;
  IF app_destruction_rule('dpa/1.1.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.6.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.5.1') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days'
     OR app_destruction_rule('dpa/1.2.0') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule(NULL) <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule must give dpa/1.1.0 the export rule its Term clause states, keep it for dpa/1.0.0, 1.6.0 and 1.5.1, and give the thirty days to 1.2.2, an unknown version and none.';
  END IF;
END;
$$;

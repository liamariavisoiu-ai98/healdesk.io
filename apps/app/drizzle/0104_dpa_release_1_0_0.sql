-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- The Data Protection Agreement (dpa/1.0.0) and its calendar election form
-- (calendar-election-dpa/1.0.0) are released (owner, 20 October 2026:
-- "Release the DPA now."). drizzle generated this empty (--custom); no table
-- changes, and everything below is the part drizzle cannot express.
--
-- The owner released both on the owner's own instruction and without
-- external counsel (packages/catalog/src/dpa.ts and dpa-calendar-election.ts,
-- approvedByCounsel true; docs/counsel/agreement-changes.md §18). Nothing in
-- either text marked it a draft, so no hash moved. From today a practice that
-- answers "No" to billing health insurance electronically (med spas, hair
-- restoration, massage and chiropractic) signs the DPA at checkout, where it
-- signed the BAA until now, and a veterinary practice, which checkout refused
-- because it had no agreement to sign, signs the DPA without being asked.
--
-- What the database has to say with the catalogue:
--
--   * app_dpa_version_released() (0090) lists dpa/1.0.0. It is go-live's copy
--     of the DPA's flag, through app_agreement_version_acceptable() (0090,
--     unchanged): without this, app_mark_clinic_production() and
--     app_go_live_missing() would keep refusing every DPA practice by name
--     ("not released") while checkout signed and provisioning bound it.
--     tests/go-live.test.ts holds the two together.
--   * app_calendar_election_released() (0068's definition, the latest) lists
--     calendar-election-dpa/1.0.0 beside calendar-election/1.0.0, so a DPA
--     location's election counts for every clinic, not only a demo clinic,
--     and the guard requires a new row under it to say document_released
--     true. tests/database-audit.test.ts holds the list to the catalogue.
--   * app_calendar_election_guard() (0100's definition, the latest, copied
--     with one check added) refuses an election whose form is not the one for
--     the kind of the agreement in effect. Until today the release list did that work: a
--     DPA could not be in force and its form was a draft, so no non-demo
--     clinic could record either mismatch. With both forms released, a
--     writer that handed a DPA practice the BAA's form (which amends "the
--     Business Associate Agreement" and calls a client a patient), or the
--     reverse, would have been believed; calendarElectionFor in the catalogue
--     is the rule, and this is the database's copy of it.
--
-- Unchanged, and asserted below: app_baa_version_acceptable() never accepts
-- the DPA (it is its own kind, not a BAA version); the BAA floor is 1.5.1;
-- app_destruction_rule() has given dpa/1.0.0 the export rule its Term clause
-- states since 0058.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed
-- data (CLAUDE.md, "Until BAA coverage is in place"), every function is
-- replaced with CREATE OR REPLACE (owner, grants and callers kept), and the
-- guard binds INSERTs only, so no stored row is re-judged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The released DPA versions: getDpaTemplate(v).approvedByCounsel, written out
-- -----------------------------------------------------------------------------
-- 0090's definition, with dpa/1.0.0 in its empty list. An allow-list, so a
-- later draft, an unknown string or NULL is refused.
CREATE OR REPLACE FUNCTION app_dpa_version_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['dpa/1.0.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_dpa_version_released(text) IS
  'The released DPA versions, written out: dpa/1.0.0, released by the owner on 20 October 2026 (dpa_release_1_0_0). Must equal getDpaTemplate(v).approvedByCounsel in @healdesk/catalog (parity test in tests/go-live.test.ts); a release needs a migration redefining it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The released election documents: CALENDAR_ELECTIONS and
-- DPA_CALENDAR_ELECTIONS, written out
-- -----------------------------------------------------------------------------
-- 0068's definition, with calendar-election-dpa/1.0.0 beside
-- calendar-election/1.0.0. An allow-list, so a draft, an unknown string or
-- NULL is unreleased, and an election under one counts only for a demo
-- clinic.
CREATE OR REPLACE FUNCTION app_calendar_election_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['calendar-election/1.0.0', 'calendar-election-dpa/1.0.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_calendar_election_released(text) IS
  'True for the calendar election document versions released for use: CALENDAR_ELECTIONS and DPA_CALENDAR_ELECTIONS with approvedByCounsel true in @healdesk/catalog, written out (calendar-election/1.0.0, released with BAA 1.3.0 on 12 October 2026, baa_release_1_3_0; calendar-election-dpa/1.0.0, released with the DPA on 20 October 2026, dpa_release_1_0_0). Must equal the catalogue (parity test in tests/database-audit.test.ts); a release needs a migration redefining it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The election guard: 0100's, with the form held to its agreement's kind
-- -----------------------------------------------------------------------------
-- 0100's definition copied exactly (no later migration redefined it), with
-- the agreement in effect's version read beside its id and one check added
-- after the `agreement` branch, which records the signed document itself and
-- is untouched. 0100's comment above it stands for everything else.
-- CREATE OR REPLACE keeps the trigger calendar_elections_guard, which calls
-- it by name.
CREATE OR REPLACE FUNCTION app_calendar_election_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  billing_clinic uuid;
  in_effect uuid;
  signed record;
  via_link record;
  member_role clinic_role;
  owner_basis boolean;
  previous_kind text;
  in_effect_version text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'calendar_elections is append-only: a location''s calendar terms change by recording another election'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.organization_id, c.billing_clinic_id INTO org, billing_clinic
    FROM clinics c
   WHERE c.id = NEW.clinic_id;
  SELECT a.agreement_id, a.document_version INTO in_effect, in_effect_version
    FROM app_agreement_in_effect(org) a;
  IF in_effect IS NULL OR NEW.agreement_id IS DISTINCT FROM in_effect THEN
    RAISE EXCEPTION 'calendar_elections: an election is recorded against the agreement in effect for the location''s organisation'
      USING ERRCODE = '23514';
  END IF;

  -- Two elections racing for one number meet the unique index; the loser's
  -- caller retries once, and is judged again here against the winner.
  SELECT coalesce(max(el.sequence), 0) + 1 INTO NEW.sequence
    FROM calendar_elections el
   WHERE el.clinic_id = NEW.clinic_id;

  IF NEW.source = 'agreement' THEN
    -- The signed clause "governs the calendar of the location Practice sets
    -- up when it signs this agreement"; for any other location "the calendar
    -- election Practice records for that location takes the place of this
    -- clause" (CALENDAR_LOCATION_PARAGRAPH). Provisioning makes a new
    -- organisation for each signature, and a location added later always
    -- names its billing clinic, so that location records an election, and
    -- its first one widens and needs the owner (plan §2.9).
    IF billing_clinic IS NOT NULL THEN
      RAISE EXCEPTION 'calendar_elections: an agreement row records the signed clause only for the location set up at signing; another location records an election'
        USING ERRCODE = '23514';
    END IF;
    -- 0100: the first row under its agreement. The signature is the
    -- location's terms from the moment its agreement is in force, at
    -- provisioning or when it supersedes the agreement before it
    -- (recordSupersedingTerms, in the transaction that binds it), and every
    -- later change under that agreement is an election. So a second
    -- agreement row under the same agreement is refused, and so is one after
    -- an election under it: neither could be what the location agreed last.
    IF EXISTS (SELECT 1
                 FROM calendar_elections el
                WHERE el.clinic_id = NEW.clinic_id
                  AND el.agreement_id = NEW.agreement_id) THEN
      RAISE EXCEPTION 'calendar_elections: an agreement row is the first row recorded under its agreement; a later change under it records an election'
        USING ERRCODE = '23514';
    END IF;
    SELECT b.document_version, b.document_hash, b.variables INTO signed
      FROM baa_acceptances b
     WHERE b.id = NEW.agreement_id;
    IF NEW.document_version IS DISTINCT FROM signed.document_version
       OR NEW.document_hash IS DISTINCT FROM signed.document_hash
       OR NOT coalesce((signed.variables -> 'appliedClauses') ? NEW.clause_id, false)
       OR NEW.calendar_account IS DISTINCT FROM signed.variables ->> 'calendarAccount'
       OR NEW.booking_system IS DISTINCT FROM signed.variables ->> 'bookingSystem'
       OR (signed.variables ? 'bookingSync'
           AND NEW.booking_sync IS DISTINCT FROM signed.variables ->> 'bookingSync')
    THEN
      RAISE EXCEPTION 'calendar_elections: an agreement row records exactly the calendar terms the practice signed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- 0104: the form of the agreement's kind (calendarElectionFor). The BAA's
  -- form takes the place of the calendar clause "of the Business Associate
  -- Agreement" and calls the person a booking is for a patient; the DPA's
  -- names the Data Protection Agreement and calls them a client. Each amends
  -- only its own kind, so a dpa/ agreement takes a calendar-election-dpa/
  -- document and any other agreement a document that is not one. With both
  -- forms released, the release list alone no longer tells them apart.
  IF (in_effect_version LIKE 'dpa/%')
     IS DISTINCT FROM (coalesce(NEW.document_version, '') LIKE 'calendar-election-dpa/%') THEN
    RAISE EXCEPTION 'calendar_elections: an election is recorded on the form of its agreement''s kind: calendar-election-dpa/ for a Data Protection Agreement, never for a Business Associate Agreement'
      USING ERRCODE = '23514';
  END IF;

  -- What the document is and what the booking system does are the
  -- catalogue's to say, not the writer's (the two functions above). The
  -- sync then fixes the kind with the account (calendar_elections_kind_consistent).
  IF NEW.document_released IS DISTINCT FROM app_calendar_election_released(NEW.document_version) THEN
    RAISE EXCEPTION 'calendar_elections: document_released is what app_calendar_election_released() says of the version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.booking_sync IS DISTINCT FROM
       (CASE WHEN app_booking_system_live(NEW.booking_system) THEN 'live' ELSE 'manual' END) THEN
    RAISE EXCEPTION 'calendar_elections: booking_sync is what app_booking_system_live() says of the booking system'
      USING ERRCODE = '23514';
  END IF;

  IF NOT NEW.document_released AND NOT app_clinic_is_demo(NEW.clinic_id) THEN
    RAISE EXCEPTION 'calendar_elections: that election document is not released, and only a demo clinic may record a draft'
      USING ERRCODE = '42501';
  END IF;

  -- The text is the evidence, and the server rendered and hashed it
  -- (hashCalendarElection: SHA-256 of the UTF-8 text); a hash from anywhere
  -- else would point at nothing.
  IF NEW.document_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.rendered_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'calendar_elections: document_hash must be the SHA-256 of rendered_text'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source = 'calendar_link' THEN
    SELECT l.audience, l.used_at, l.expires_at, l.sent_to, l.pending_election INTO via_link
      FROM connection_links l
     WHERE l.id = NEW.link_id
       AND l.clinic_id = NEW.clinic_id
       AND l.purpose = 'calendar';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calendar_elections: the link is not one of this location''s calendar links'
        USING ERRCODE = '23514';
    END IF;
    -- A link speaks for its holder while it is live, by the clock link
    -- resolution uses (now()): the election is recorded before the same
    -- transaction consumes the link (plan §2.6), never after it was spent or
    -- once it has expired.
    IF via_link.used_at IS NOT NULL OR via_link.expires_at <= now() THEN
      RAISE EXCEPTION 'calendar_elections: that calendar link is spent or expired'
        USING ERRCODE = '42501';
    END IF;
    -- Who could have held it is the link's own record, copied.
    IF NEW.link_sent_to IS DISTINCT FROM via_link.sent_to THEN
      RAISE EXCEPTION 'calendar_elections: link_sent_to is the sent_to of the link the election came through'
        USING ERRCODE = '23514';
    END IF;
    -- A confirm link records the election it asks the owner to confirm and
    -- no other. Not its hash: the stored text carries the name the owner
    -- types on confirming, so the confirm page compares the re-rendered
    -- document instead (plan §4.1).
    IF via_link.pending_election IS NOT NULL
       AND (NEW.booking_system IS DISTINCT FROM via_link.pending_election ->> 'bookingSystem'
            OR NEW.calendar_account IS DISTINCT FROM via_link.pending_election ->> 'calendarAccount'
            OR NEW.document_version IS DISTINCT FROM via_link.pending_election ->> 'documentVersion')
    THEN
      RAISE EXCEPTION 'calendar_elections: a confirm link records only the election it asked the owner to confirm'
        USING ERRCODE = '23514';
    END IF;
    owner_basis := via_link.audience = 'owner';
  ELSE
    SELECT m.role INTO member_role
      FROM clinic_memberships m
     WHERE m.clinic_id = NEW.clinic_id
       AND m.user_id = NEW.elected_by_user_id
       AND m.revoked_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'calendar_elections: that user holds no active membership of this location'
        USING ERRCODE = '42501';
    END IF;
    owner_basis := member_role = 'owner';
  END IF;

  IF NEW.owner_confirmed AND NOT owner_basis THEN
    RAISE EXCEPTION 'calendar_elections: only the practice owner confirms an election, through an owner link or their own sign-in'
      USING ERRCODE = '42501';
  END IF;

  SELECT el.terms_kind INTO previous_kind
    FROM calendar_elections el
   WHERE el.clinic_id = NEW.clinic_id
     AND el.agreement_id = in_effect
   ORDER BY el.sequence DESC
   LIMIT 1;
  IF NEW.terms_kind IN ('covered', 'uncovered')
     AND (coalesce(previous_kind, 'none') NOT IN ('covered', 'uncovered')
          OR (previous_kind = 'covered' AND NEW.terms_kind = 'uncovered'))
     AND NOT NEW.owner_confirmed
  THEN
    RAISE EXCEPTION 'calendar_elections: an election that lets more reach Google needs the practice owner''s confirmation'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_dpa_version_released('dpa/1.0.0')
     OR app_dpa_version_released('dpa/9.9.9')
     OR app_dpa_version_released('1.5.1')
     OR app_dpa_version_released('')
     OR app_dpa_version_released(NULL) THEN
    RAISE EXCEPTION 'app_dpa_version_released must list dpa/1.0.0 and nothing else: not an unknown DPA version, a BAA, the empty string or NULL.';
  END IF;
  IF NOT app_agreement_version_acceptable('dpa/1.0.0')
     OR NOT app_agreement_version_acceptable('1.5.1')
     OR app_agreement_version_acceptable('1.5.0')
     OR app_agreement_version_acceptable('1.6.0')
     OR app_agreement_version_acceptable('dpa/9.9.9')
     OR app_agreement_version_acceptable('')
     OR app_agreement_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_agreement_version_acceptable must accept the released DPA (dpa/1.0.0) and the BAA floor (1.5.1), and nothing else: not 1.5.0, the 1.6.0 draft, an unknown DPA version, the empty string or NULL.';
  END IF;
  -- The DPA is its own kind, never a BAA version.
  IF app_baa_version_acceptable('dpa/1.0.0')
     OR NOT app_baa_version_acceptable('1.5.1') THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must keep accepting 1.5.1 and never the DPA.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR NOT app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election/9.9.9')
     OR app_calendar_election_released('calendar-election-dpa/9.9.9')
     OR app_calendar_election_released('dpa/1.0.0')
     OR app_calendar_election_released('')
     OR app_calendar_election_released(NULL) THEN
    RAISE EXCEPTION 'app_calendar_election_released must list calendar-election/1.0.0 and calendar-election-dpa/1.0.0 and nothing else: not an unknown version of either, the DPA itself, the empty string or NULL.';
  END IF;
  IF app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.5.1') <> 'export_or_ninety' THEN
    RAISE EXCEPTION 'app_destruction_rule must keep giving dpa/1.0.0 and 1.5.1 the export rule their Term clauses state.';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'app_calendar_election_guard'
          AND NOT p.prosecdef
          AND p.prosrc LIKE '%calendar-election-dpa/ for a Data Protection Agreement, never for a Business Associate Agreement%'
          AND p.prosrc LIKE '%an agreement row is the first row recorded under its agreement%'
          AND p.prosrc LIKE '%only for the location set up at signing%'
          AND p.prosrc LIKE '%exactly the calendar terms the practice signed%'
          AND p.prosrc LIKE '%against the agreement in effect%'
          AND p.prosrc LIKE '%app_calendar_election_released%'
          AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'app_calendar_election_guard must be invoker, pin its search_path, keep every refusal 0100 left it, and hold an election''s form to its agreement''s kind.';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_trigger g
        WHERE g.tgrelid = 'calendar_elections'::regclass
          AND g.tgname = 'calendar_elections_guard'
          AND g.tgenabled <> 'D') THEN
    RAISE EXCEPTION 'calendar_elections_guard is missing or disabled.';
  END IF;
END;
$$;

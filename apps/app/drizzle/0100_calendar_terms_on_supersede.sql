-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- A superseding agreement records the location's calendar terms (owner,
-- 19 October 2026: "go ahead and build it"). drizzle generated this empty
-- (--custom); the CHECK below is mirrored in schema.ts and in 0100's
-- snapshot, and the rest is the part drizzle cannot express.
--
-- The failure. A location's calendar terms are its newest calendar_elections
-- row anchored to the agreement in effect, never falling back to an older
-- agreement (calendarTermsFor, app_calendar_write_permitted). Provisioning
-- records the signature's terms as the location's `agreement` row
-- (recordAgreementTerms). When app_supersede_agreement() (0051) put a later
-- signature in force, nothing was recorded under it: the DPA→BAA re-sign
-- (signAgreementResign, package WP9) left the location `needs_election`, and
-- the calendar watch's terms sweep (sweepCalendarTerms) reads that as the
-- terms having ended. Within one five-minute run it erased the clinic's
-- Google Calendar connection and revoked the grant at Google, and getting
-- back meant an election and a fresh sign-in at Google. The BAA→BAA re-sign
-- (package R11) would have done the same.
--
-- The decision. The new signature IS the location's calendar terms: it
-- carries a calendar clause and the two answers that chose it, as the first
-- signature did. recordSupersedingTerms (lib/booking/elections.ts) records it
-- as an `agreement` row under the new agreement, in the transaction that
-- binds it, for the location set up at signing (the organisation's clinic
-- with no billing_clinic_id), and the old election is not carried forward.
-- An election recorded under the old agreement stays the evidence of what
-- held then; under the new one the signature decides, and a later change is
-- an election again. Other locations (billing_clinic_id set) are left as
-- they were: their elections stay under the old agreement and they read
-- `needs_election` until they record one, because whether elections carry
-- across is not decided, and no such location exists yet
-- (LOCATION_CLINICS_READY is false).
--
-- Why the schema changes. 0057's CHECK calendar_elections_agreement_shape
-- held an agreement row to sequence 1, and the sequence counts a location's
-- rows across every agreement, so the location's agreement row under a
-- second agreement (sequence 2 or later) could not be written. The CHECK
-- keeps the rest of the row's shape (a released document nobody had to
-- confirm), and the rule that made "sequence 1" right moves into the guard,
-- where it can be said per agreement: an agreement row is the first row
-- recorded under its agreement. So at provisioning it is still sequence 1,
-- a second agreement row under the same agreement is still refused, and so
-- is one recorded after an election under it.
--
-- app_calendar_election_guard() below is 0057's definition copied exactly,
-- with that one check added in its `agreement` branch (no later migration
-- redefined it). Every other refusal there stands: an agreement row only for
-- the location set up at signing (no billing_clinic_id), only with exactly
-- the values the signed acceptance stores, and only under the agreement in
-- effect. 0057's comment above it, that a supersede leaves the location
-- needing an election and fails closed until the design record's open item
-- 2 is settled, is settled here (docs/design/google-calendar-2026-10-05.md,
-- §9 item 2).
--
-- Safe to apply in place: every row already passes the relaxed CHECK, and
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- tests/google-calendar-schema.test.ts pins both rules as the runtime role,
-- and tests/agreement-resign.test.ts the re-sign that relies on them.
-- =============================================================================

ALTER TABLE "calendar_elections" DROP CONSTRAINT "calendar_elections_agreement_shape";--> statement-breakpoint
ALTER TABLE "calendar_elections" ADD CONSTRAINT "calendar_elections_agreement_shape" CHECK ("calendar_elections"."source" <> 'agreement' or ("calendar_elections"."document_released" and not "calendar_elections"."owner_confirmed"));--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The election guard: 0057's, with an agreement row the first under its agreement
-- -----------------------------------------------------------------------------
-- 0057's comment, as it stands for this definition: on every INSERT the row
-- is anchored to the organisation's agreement in effect; it takes the
-- location's next sequence number; an `agreement` row is recorded only for
-- the location set up at signing, only as the first row under its agreement
-- (added here), and must be exactly what the practice signed; any other row
-- is held to the catalogue's copies, a released document unless the clinic
-- is a demo clinic, the hash of its own text, one of this location's live
-- calendar links or one of its members' own sign-in, and the owner for an
-- election that widens what reaches Google. UPDATE and DELETE are refused
-- for every role. Invoker rights, so another clinic's rows, links and members
-- are invisible rather than mismatched. CREATE OR REPLACE keeps the trigger
-- calendar_elections_guard, which calls it by name.
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
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'calendar_elections is append-only: a location''s calendar terms change by recording another election'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.organization_id, c.billing_clinic_id INTO org, billing_clinic
    FROM clinics c
   WHERE c.id = NEW.clinic_id;
  SELECT a.agreement_id INTO in_effect FROM app_agreement_in_effect(org) a;
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

COMMENT ON CONSTRAINT calendar_elections_agreement_shape ON calendar_elections IS
  'An agreement row is a released, signed document nobody had to confirm. That it is the first row under its agreement is the guard''s (app_calendar_election_guard, 0100): sequence 1 at provisioning, later for the location''s terms under an agreement that superseded the one before.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  shape text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO shape
    FROM pg_constraint c
   WHERE c.conrelid = 'calendar_elections'::regclass
     AND c.conname = 'calendar_elections_agreement_shape';
  IF shape IS NULL OR shape LIKE '%sequence%' OR shape NOT LIKE '%document_released%'
     OR shape NOT LIKE '%owner_confirmed%' THEN
    RAISE EXCEPTION 'calendar_elections_agreement_shape must hold an agreement row to a released, unconfirmed document and leave its sequence to the guard: %', shape;
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'app_calendar_election_guard'
          AND NOT p.prosecdef
          AND p.prosrc LIKE '%an agreement row is the first row recorded under its agreement%'
          AND p.prosrc LIKE '%only for the location set up at signing%'
          AND p.prosrc LIKE '%exactly the calendar terms the practice signed%'
          AND p.prosrc LIKE '%against the agreement in effect%'
          AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')) THEN
    RAISE EXCEPTION 'app_calendar_election_guard must be invoker, pin its search_path, and keep every agreement-row refusal with 0100''s first-under-its-agreement rule.';
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

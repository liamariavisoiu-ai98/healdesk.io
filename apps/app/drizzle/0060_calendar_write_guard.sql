ALTER TABLE "appointments" ADD COLUMN "calendar_id" text;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD COLUMN "calendar_id" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_calendar_id_check" CHECK ("appointments"."calendar_id" is null or (char_length("appointments"."calendar_id") between 1 and 255 and "appointments"."calendar_id" !~ '[[:space:][:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "slot_holds" ADD CONSTRAINT "slot_holds_calendar_id_check" CHECK (char_length("slot_holds"."calendar_id") between 1 and 255 and "slot_holds"."calendar_id" !~ '[[:space:][:cntrl:]]');--> statement-breakpoint

-- =============================================================================
-- Migration B of the Google Calendar build (plan of 5 October 2026, §11.1,
-- §11.6, §7.12; addendum, "Named-provider booking IS in v1"). Everything
-- above this line was generated from schema.ts, but for the default
-- slot_holds.calendar_id is added with: 'primary', so that a table that
-- already holds rows can take a NOT NULL column. It is dropped again below
-- (section 1), as schema.ts has it. Everything below is written by hand.
--
-- Two things, in the commit that makes the desk path's writer terms-aware
-- and Google-only (lib/booking/calendar.ts), so main is never red:
--
--   1. The overlap guard keys on the clinic AND the calendar. Named
--      providers are in v1: one Google calendar per provider on the
--      location's one connection, so two providers' bookings at the same
--      time must not refuse each other, while two on one calendar must.
--      A hold always names its calendar (`primary`, the default, is the
--      account's main calendar, as the adapter reads a connection that names
--      none). A healdesk booking names the calendar it was written to; one
--      that names none occupies every calendar of its location, which is
--      what 0057 made of every booking, so nothing that existed before this
--      migration can start overlapping. The lock stays one per clinic: it
--      serialises whoever occupies time at the location, and is coarser than
--      the check it guards, which is the safe way round.
--
--   2. app_appointment_write_guard: the desk path may start a Google write
--      only while the location's calendar terms, its connection and its
--      clinic still allow it (app_calendar_write_permitted, without
--      Auto-confirm, which gates only the assistant's own bookings), whatever
--      the application believes; a booking is never inserted with a write
--      already started; and an appointment's event key and calendar, which
--      name the Google event, never change once written.
--
-- Safe to run: the two new columns are nullable, or take a default for the
-- rows already there that is dropped at once; no product path has placed a
-- slot hold yet (the engine is C13), so every hold that exists is a test's,
-- on `primary`; the redefined guards answer exactly as before for every row
-- that exists, all of which are on one calendar or none; and the write guard
-- refuses only a move into `writing` (or a row born there), which the desk
-- path now makes only where the same function says yes.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Overlap, per clinic and calendar
-- -----------------------------------------------------------------------------
-- The default above only let the column onto rows that already existed. A
-- hold always names its calendar: one that left it out would key the guard
-- on `primary` and could overlap a named provider's time unnoticed, so an
-- insert without it is refused (NOT NULL).
ALTER TABLE slot_holds ALTER COLUMN calendar_id DROP DEFAULT;--> statement-breakpoint

-- 0057's definition, with the calendar. NULL as the target means "every
-- calendar of the location" (a booking that names none); a booking row with
-- no calendar is met by every target. Invoker rights: the caller's tenant.
CREATE OR REPLACE FUNCTION app_calendar_time_conflict(target_clinic uuid, target_calendar text,
                                                      span_start timestamptz, span_end timestamptz,
                                                      except_holder text, except_appointment uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM slot_holds h
                  WHERE h.clinic_id = target_clinic
                    AND (target_calendar IS NULL OR h.calendar_id = target_calendar)
                    AND h.holder_ref IS DISTINCT FROM except_holder
                    AND h.starts_at > span_start - interval '480 minutes' AND h.starts_at < span_end
                    AND span_start < h.ends_at
                    AND ((h.status = 'held' AND h.expires_at > clock_timestamp())
                         OR (h.status IN ('writing', 'unknown', 'reserved') AND h.blocks_until > clock_timestamp())))
      OR EXISTS (SELECT 1 FROM appointments a
                  WHERE a.clinic_id = target_clinic
                    AND (target_calendar IS NULL OR a.calendar_id IS NULL OR a.calendar_id = target_calendar)
                    AND a.id IS DISTINCT FROM except_appointment
                    AND a.booking_origin IS NOT NULL AND a.status IN ('scheduled', 'confirmed')
                    AND a.scheduled_for > span_start - interval '480 minutes' AND a.scheduled_for < span_end
                    AND span_start < a.scheduled_for + make_interval(mins => coalesce(a.duration_minutes, 30)))
$$;--> statement-breakpoint

-- 0057's hold guard, unchanged but for the calendar it asks about.
CREATE OR REPLACE FUNCTION app_slot_hold_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'held' THEN
    RAISE EXCEPTION 'slot_holds: a hold starts held; % is reached only by a transition', NEW.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.insert_attempted_at IS NOT NULL
     OR NEW.blocks_until IS NOT NULL OR NEW.next_check_at IS NOT NULL OR NEW.appointment_id IS NOT NULL
     OR NEW.outcome_reason IS NOT NULL OR NEW.released_at IS NOT NULL OR NEW.check_attempts <> 0
  THEN
    RAISE EXCEPTION 'slot_holds: a new hold carries no lease, write or outcome'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at > clock_timestamp() THEN
    RAISE EXCEPTION 'slot_holds: a hold cannot be placed in the future'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.channel = 'web_chat' AND NEW.contact_id IS NULL THEN
    RAISE EXCEPTION 'slot_holds: a web chat hold names the contact who asked for it'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || NEW.clinic_id::text, 0));
  IF app_calendar_time_conflict(NEW.clinic_id, NEW.calendar_id, NEW.starts_at,
                                NEW.starts_at + make_interval(mins => NEW.duration_minutes),
                                NEW.holder_ref, NULL) THEN
    RAISE EXCEPTION 'slot_holds: that time is already held or booked through healdesk'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- 0057's booking guard, unchanged but for the calendar it asks about.
CREATE OR REPLACE FUNCTION app_appointment_time_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.booking_origin IS DISTINCT FROM OLD.booking_origin THEN
    RAISE EXCEPTION 'appointments: booking_origin is written once, when the booking is recorded'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.booking_origin IS NULL OR NEW.status NOT IN ('scheduled', 'confirmed') THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || NEW.clinic_id::text, 0));
  IF app_calendar_time_conflict(NEW.clinic_id, NEW.calendar_id, NEW.scheduled_for,
                                NEW.scheduled_for + make_interval(mins => coalesce(NEW.duration_minutes, 30)),
                                NULL, NEW.id) THEN
    RAISE EXCEPTION 'appointments: that time is already held or booked through healdesk'
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Both guards now call the calendar-aware function; the clinic-wide one goes,
-- so nothing can ask the old question by mistake.
DROP FUNCTION app_calendar_time_conflict(uuid, timestamptz, timestamptz, text, uuid);--> statement-breakpoint

-- A hold's calendar is part of what it holds, like its time: it never moves,
-- for any role. The runtime role has no UPDATE on the column (slot_holds'
-- UPDATE grant is column by column, 0057, and names it nowhere); this binds
-- the migrator too.
CREATE OR REPLACE FUNCTION app_slot_hold_calendar_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.calendar_id IS DISTINCT FROM OLD.calendar_id THEN
    RAISE EXCEPTION 'slot_holds: a hold''s calendar never changes; hold the time on the other calendar instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER slot_holds_calendar_fixed
  BEFORE UPDATE ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_slot_hold_calendar_fixed();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. The desk path's Google write (plan §7.12, §11.6)
-- -----------------------------------------------------------------------------
-- The desk path claims an appointment's write by moving it to `writing` with
-- a fresh lease (a stuck claim is reclaimed the same way). Either is refused
-- (23514) unless app_calendar_write_permitted(clinic, false) says healdesk
-- may write to this location's Google Calendar now: covered or uncovered
-- terms under the agreement in effect, a healthy connection of the account
-- kind those terms name, and a location that is not leaving. Auto-confirm is
-- not asked: it gates the assistant's own bookings, never a confirmation
-- staff made. So a write the terms no longer allow cannot start, whatever
-- the application read a moment earlier.
--
-- The refusal names `appointments_write_permitted` as its constraint, so the
-- writer can tell it from any other check and record the booking as one for
-- staff to add by hand (lib/booking/calendar.ts).
--
-- A booking is inserted with its write not started (`none`, or `written`
-- when the record step finds the assistant's event already in Google), and
-- the write is then claimed as described above. A row inserted already
-- `writing`, or carrying a lease, would be a write nobody claimed and this
-- guard never judged: refused (23514, `appointments_write_claimed`).
--
-- The event key ("hold:" + the hold's id, or the request's id) is what the
-- Google event's id is derived from, and the calendar is where the event
-- lives: a key or calendar that changed after a write would point the
-- read-back at nothing and let a retry write the booking twice. The key is
-- written once (NULL to a value); the calendar is set at insert and never
-- changes. Both for every role.
CREATE OR REPLACE FUNCTION app_appointment_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.calendar_write_status = 'writing' OR NEW.calendar_write_lease IS NOT NULL THEN
      RAISE EXCEPTION 'appointments: a booking is recorded before its calendar write starts, and the write is claimed afterwards'
        USING ERRCODE = '23514', CONSTRAINT = 'appointments_write_claimed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.calendar_event_key IS NOT NULL
     AND NEW.calendar_event_key IS DISTINCT FROM OLD.calendar_event_key THEN
    RAISE EXCEPTION 'appointments: calendar_event_key is written once'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.calendar_id IS DISTINCT FROM OLD.calendar_id THEN
    RAISE EXCEPTION 'appointments: calendar_id is written when the booking is recorded, and never changes'
      USING ERRCODE = '42501';
  END IF;
  IF ((NEW.calendar_write_status = 'writing'
        AND OLD.calendar_write_status IS DISTINCT FROM 'writing')
      OR (NEW.calendar_write_lease IS NOT NULL
        AND NEW.calendar_write_lease IS DISTINCT FROM OLD.calendar_write_lease))
     AND NOT app_calendar_write_permitted(NEW.clinic_id, false)
  THEN
    RAISE EXCEPTION 'appointments: the calendar terms or the Google connection no longer let healdesk write to this calendar'
      USING ERRCODE = '23514', CONSTRAINT = 'appointments_write_permitted';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER appointments_write_guard
  BEFORE INSERT OR UPDATE OF calendar_write_status, calendar_write_lease, calendar_event_key, calendar_id
  ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_appointment_write_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Comments
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN slot_holds.calendar_id IS
  'The Google calendar the time is held on: the location''s own (its connection''s metadata.calendarId) or a named provider''s. The overlap guard keys on the clinic and this calendar. Never changes.';--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_id IS
  'The Google calendar a healdesk booking occupies and is written to. NULL on a healdesk booking means every calendar of the location; NULL elsewhere means nothing (booking_origin NULL occupies no time). Set at insert, never changed (app_appointment_write_guard).';--> statement-breakpoint
COMMENT ON FUNCTION app_calendar_time_conflict(uuid, text, timestamptz, timestamptz, text, uuid) IS
  'Whether [span_start, span_end) on target_calendar (NULL: any) overlaps a live slot hold of another holder or a live healdesk appointment (booking_origin set) other than except_appointment; a booking naming no calendar meets every one. Call it after taking the clinic''s calendar lock. Invoker; VOLATILE, so it reads committed state.';--> statement-breakpoint
COMMENT ON FUNCTION app_appointment_write_guard() IS
  'Refuses (23514, appointments_write_permitted) a move of an appointment into calendar_write_status writing, or a new write lease, unless app_calendar_write_permitted(clinic, false); refuses (23514, appointments_write_claimed) an appointment inserted writing or with a lease; keeps calendar_event_key written once and calendar_id fixed (42501).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Audit: fail the migration if any of it did not land
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(v.tg, ', ') INTO offending
    FROM (VALUES ('appointments', 'appointments_write_guard'),
                 ('appointments', 'appointments_time_guard'),
                 ('slot_holds', 'slot_holds_calendar_fixed'),
                 ('slot_holds', 'slot_holds_guard')) AS v(rel, tg)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_trigger g
      WHERE g.tgrelid = v.rel::regclass
        AND g.tgname = v.tg
        AND g.tgenabled <> 'D');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or disabled trigger(s): %', offending;
  END IF;

  SELECT string_agg(f, ', ') INTO offending
    FROM unnest(ARRAY['app_calendar_time_conflict', 'app_slot_hold_guard',
                      'app_appointment_time_guard', 'app_slot_hold_calendar_fixed',
                      'app_appointment_write_guard']) AS f
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = f
        AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing, or without a pinned search_path: %', offending;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'app_calendar_time_conflict') <> 1 THEN
    RAISE EXCEPTION 'app_calendar_time_conflict must have exactly one definition, the calendar-aware one';
  END IF;

  IF has_column_privilege('healdesk_app', 'slot_holds', 'calendar_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app must not hold UPDATE on slot_holds.calendar_id';
  END IF;

  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'slot_holds' AND column_name = 'calendar_id') IS NOT NULL THEN
    RAISE EXCEPTION 'slot_holds.calendar_id must have no default: every hold names its calendar';
  END IF;

  -- TRIGGER_TYPE_INSERT is bit 2 of tgtype: the guard must judge inserts too.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger g
                  WHERE g.tgrelid = 'appointments'::regclass
                    AND g.tgname = 'appointments_write_guard'
                    AND (g.tgtype & 4) <> 0) THEN
    RAISE EXCEPTION 'appointments_write_guard must fire on INSERT as well as UPDATE';
  END IF;
END;
$$;

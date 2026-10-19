ALTER TABLE "agreement_resigns" DROP CONSTRAINT "agreement_resigns_baa_version_unpaused_check";--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD COLUMN "held_pauses" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_held_pauses_check" CHECK (jsonb_typeof("agreement_resigns"."held_pauses") = 'array');--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_baa_version_unpaused_check" CHECK ("agreement_resigns"."reason" <> 'baa_version' or ("agreement_resigns"."paused_at" is null and "agreement_resigns"."held_pauses" = '[]'::jsonb));--> statement-breakpoint
-- =============================================================================
-- The pauses a DPA→BAA re-sign holds at the other clinics of its organisation
-- (wave 2, R11's check, 19 October 2026). The statements above were generated
-- from schema.ts; everything below is the part drizzle cannot express.
--
-- 0098 had the DPA re-sign pause AYA at every clinic of the organisation, but
-- recorded only the pause on the clinic holding the row (paused_at). At a
-- location whose staff had paused AYA for an hour, the re-sign made that
-- pause indefinite (settings.ts keeps the practice's own label and start and
-- clears only the end), and signing then lifted nothing there: the release
-- recognised only a pause carrying healdesk's own label. The location stayed
-- paused, its calls passing to the direct line, with no end and no email.
--
-- held_pauses records, at the opening, each pause the re-sign put in force or
-- extended at a clinic of the organisation, its own included,
-- [{clinicId, pausedAt, until}], until being the end a timed pause had before
-- the re-sign made it indefinite. The release gives back exactly those whose
-- start is still that one: lifted, or a timed pause's end restored while it
-- is still to come (lib/agreements/resign.ts).
-- Fixed once written, like paused_at: 0088's guard, redefined below to name
-- it. The runtime role writes it only on INSERT, having no UPDATE on it
-- (0088's column grant). A BAA-version re-sign holds none (the CHECK above,
-- beside paused_at).
--
-- Safe to apply in place: a column with a default, CHECKs every row passes,
-- a guard redefined. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- 0088's guard with held_pauses beside paused_at.
CREATE OR REPLACE FUNCTION app_agreement_resign_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.from_agreement_id IS DISTINCT FROM OLD.from_agreement_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.paused_at IS DISTINCT FROM OLD.paused_at
     OR NEW.held_pauses IS DISTINCT FROM OLD.held_pauses THEN
    RAISE EXCEPTION 'agreement_resigns: which clinic, which agreement, why, who asked and the pause are fixed once opened.';
  END IF;
  IF OLD.status <> 'open' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'agreement_resigns: a % re-sign is final.', OLD.status;
  END IF;
  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'signed', 'withdrawn') THEN
    RAISE EXCEPTION 'agreement_resigns: open cannot become %.', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DO $$
BEGIN
  IF has_column_privilege('healdesk_app', 'agreement_resigns', 'held_pauses', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE agreement_resigns.held_pauses; a re-sign could forget the pause it holds.';
  END IF;
END
$$;--> statement-breakpoint

COMMENT ON COLUMN agreement_resigns.held_pauses IS
  'Each pause a DPA→BAA re-sign put in force, or extended, at a clinic of the organisation, its own included: [{clinicId, pausedAt, until}], until being the end a timed pause had before. Signing or withdrawing gives back exactly those (lib/agreements/resign.ts). Always [] for baa_version. Fixed once written (0102).';

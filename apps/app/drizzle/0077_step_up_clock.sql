-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- A step-up and a second factor are never dated ahead of now (package D's
-- review, 14 October 2026). Everything here is hand-written: drizzle-kit has
-- nothing to generate, because no column changes.
--
-- step_ups and user_factors are identity-plane tables with no RLS, and the
-- runtime role may INSERT into both, so it could write a step-up created and
-- last active thirty days from now. The 8-hour limit is counted from
-- created_at and the 15-minute one from last_activity_at
-- (lib/factors/step-ups.ts), so such a row would open patient pages for a
-- month; its UPDATE (last_activity_at) grant could likewise move a live
-- step-up's activity into the future and keep it from ever going idle.
--
-- Column-scoped INSERT grants that leave the timestamps out would not do:
-- drizzle names every column in an INSERT, DEFAULT for the ones not given,
-- and Postgres checks the privilege of every column named, so the app's own
-- inserts would be refused. A trigger, for every role, refuses the one thing
-- that gains anything: a time after now(). A row dated in the past only
-- lapses sooner, which is what the clock tests write as the migrator.
--
--   * INSERT: created_at and last_activity_at (step_ups), created_at and
--     last_used_at (user_factors) no later than now();
--   * UPDATE: a change to last_activity_at (step_ups) or last_used_at
--     (user_factors) no later than now(). An unchanged value passes, so a
--     touch that keeps a later activity a concurrent request wrote
--     (greatest(last_activity_at, now()), step-ups.ts) is not refused.
--
-- now() is the transaction's start, which is what the columns' defaults and
-- the app's own writes (sql`now()`) use. Safe to apply in place: apps/app has
-- only ever held synthetic and seed data (CLAUDE.md), and no row written by
-- the app is dated ahead. tests/database-audit.test.ts pins both triggers and
-- runs the forgeries as the runtime role.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_step_up_not_ahead()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at > now() OR NEW.last_activity_at > now() THEN
      RAISE EXCEPTION
        'step_ups: a step-up cannot be dated ahead of now'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at
        AND NEW.last_activity_at > now() THEN
    RAISE EXCEPTION
      'step_ups: activity cannot be dated ahead of now'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER step_ups_not_ahead
  BEFORE INSERT OR UPDATE ON step_ups
  FOR EACH ROW
  EXECUTE FUNCTION app_step_up_not_ahead();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_user_factor_not_ahead()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at > now() OR NEW.last_used_at > now() THEN
      RAISE EXCEPTION
        'user_factors: a factor cannot be dated ahead of now'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.last_used_at IS DISTINCT FROM OLD.last_used_at
        AND NEW.last_used_at > now() THEN
    RAISE EXCEPTION
      'user_factors: a use cannot be dated ahead of now'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER user_factors_not_ahead
  BEFORE INSERT OR UPDATE ON user_factors
  FOR EACH ROW
  EXECUTE FUNCTION app_user_factor_not_ahead();--> statement-breakpoint

COMMENT ON FUNCTION app_step_up_not_ahead() IS
  'Refuses a step_ups row created or last active after now(), and a move of last_activity_at past now(): the idle and 8-hour limits are counted from them (0077).';--> statement-breakpoint
COMMENT ON FUNCTION app_user_factor_not_ahead() IS
  'Refuses a user_factors row created or last used after now(), and a move of last_used_at past now() (0077).';

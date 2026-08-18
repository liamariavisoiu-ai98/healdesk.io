-- =============================================================================
-- Collect when the clinic's own front desk is open.
--
-- This is the missing input to `recovery_reason = 'after_hours'`, added in
-- 0019. Ingestion cannot conclude that a 9pm call would have gone unanswered
-- without knowing the clinic shuts at 5 — so without this column that reason
-- can never be recorded, and the monthly report keeps understating by its
-- largest category.
--
-- NULL is deliberate and is NOT "closed". It means not yet collected, and where
-- it is null ingestion records no after-hours reason at all. There is no default
-- on purpose: a clinic wrongly assumed to close at 5 would have its 6pm calls
-- claimed as recovered while its own staff answered them, which overstates the
-- one figure a clinic checks us on. Wrong-low is survivable; wrong-high is not.
--
-- Shape is validated in application code (lib/clinic/opening-hours.ts) rather
-- than by a check constraint: the format is a per-weekday list of [open, close]
-- pairs, which is unreadable as SQL and would have to be dropped and recreated
-- every time it changed.
-- =============================================================================

ALTER TABLE "clinics" ADD COLUMN "opening_hours" jsonb;--> statement-breakpoint

COMMENT ON COLUMN clinics.opening_hours IS
  'When the clinic''s own front desk is open, in the clinic timezone. Input to recovery_reason = after_hours. NULL means not yet collected and is NOT closed — no after-hours recovery is recorded while it is null. Format: {"mon": [["09:00","17:00"]], ...}, empty array means closed that day.';

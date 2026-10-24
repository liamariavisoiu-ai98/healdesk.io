-- =============================================================================
-- The desk sweep's retry ladder for calendar writes (ops automation Phase 5,
-- lane P5a; design E3 §2.3, owner-approved 23 October 2026).
--
-- A desk write whose Google answer never came (`unknown`) was retried by the
-- five-minute sweep only while the row had been touched in the last 24
-- hours, with no spacing: five attempts could burn in twenty-five minutes of
-- a Google outage, and a slot next week was never tried again after a
-- weekend down. calendar_write_next_at is when the sweep may try it next,
-- set after each attempt that ended unknown (+2 min, +10 min, +30 min, +2 h,
-- +6 h; lib/booking/calendar.ts) and cleared when the write settles. The
-- sweep now keeps going until the slot starts, never after.
--
-- appointments keeps its table-level grants, row-level security and write
-- guard (0057, 0060); nothing else changes. The index covers only the
-- unsettled rows the sweep reads.
-- =============================================================================
ALTER TABLE "appointments" ADD COLUMN "calendar_write_next_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "appointments_calendar_write_due_idx" ON "appointments" USING btree ("clinic_id","calendar_write_next_at") WHERE "appointments"."calendar_write_status" in ('unknown', 'writing');--> statement-breakpoint
COMMENT ON COLUMN appointments.calendar_write_next_at IS
  'When the desk sweep may try an unknown calendar write again; null when nothing waits (lib/booking/calendar.ts).';

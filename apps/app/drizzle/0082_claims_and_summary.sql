ALTER TABLE "appointments" ADD COLUMN "listed_price_cents" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "listed_price_kind" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_listed_price_check" CHECK (("appointments"."listed_price_cents" is null and "appointments"."listed_price_kind" is null) or ("appointments"."listed_price_cents" >= 0 and "appointments"."listed_price_kind" in ('exact', 'from', 'range', 'per_unit')));--> statement-breakpoint
-- =============================================================================
-- The claims function, Home's numbers after go-live, the daily summary (L13)
-- and the weekly recap (L14): package WP4, 19 October 2026. Everything above
-- this line was generated from schema.ts; everything below is the part
-- drizzle cannot express. L13's and L14's kinds are already in both kinds
-- CHECKs (S0); they are queued in billing_notices and recorded in
-- report_deliveries like every other notice.
--
-- appointments.listed_price_cents and listed_price_kind: the clinic's own
-- listed price for the booked service, snapshotted when the booking is
-- recorded (insertAppointment, lib/meta/booking-requests.ts), which is what
-- "booked value" multiplies by (lib/reporting/claims.ts). Patient data under
-- the agreement like the rest of the row, so nothing new is needed for it:
-- the BAA gate already covers inserts into appointments, destruction, the
-- purge and erasure delete the whole row, the exports select every column,
-- and the runtime role's table-level grants cover the two columns. Written
-- once: the trigger below refuses a change from any role, so an edit to
-- Knowledge → Prices never rewrites what a booking was worth when it was
-- made. A phase-two vendor upsert (lib/sync/upsert.ts) writes neither.
--
-- daily-summary: L13's switch, seeded OFF like every job that mails
-- customers (lib/scheduler/jobs.ts). Hourly from the tick: at each live
-- clinic's opening time on its working days, while its Daily summary switch
-- is on, it queues the summary (lib/scheduler/daily-summary.ts).
-- weekly-recap keeps its row and its switch (0034); its cadence now says
-- what it does since the recap moved onto the outbox.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_appointment_listed_price_frozen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.listed_price_cents IS DISTINCT FROM OLD.listed_price_cents
     OR NEW.listed_price_kind IS DISTINCT FROM OLD.listed_price_kind THEN
    RAISE EXCEPTION 'appointments: the listed price is written once, when the booking is recorded'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_appointment_listed_price_frozen() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER appointments_listed_price_frozen
  BEFORE UPDATE OF listed_price_cents, listed_price_kind ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_appointment_listed_price_frozen();--> statement-breakpoint
COMMENT ON COLUMN appointments.listed_price_cents IS
  'The clinic''s listed price for the booked service when the booking was recorded, in cents: the low end of an exact, from or range price, or the price of one unit. Null when the service had no listed price. Written once.';--> statement-breakpoint
COMMENT ON COLUMN appointments.listed_price_kind IS
  'How that price was stated: exact, from, range or per_unit. A per_unit price is never multiplied into booked value. Written once.';--> statement-breakpoint
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('daily-summary', 'Hourly; at each live clinic''s opening time on its working days, while its Daily summary switch is on, queues the daily summary (L13): the day''s counts, every booking and request since the last one, every request still open, and on the week''s first, last week''s recap', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint
UPDATE scheduled_jobs
   SET cadence = 'Hourly; on each live clinic''s Monday from 08:00 its time, while no daily summary can carry it (the Daily summary switch is off, or no opening hours are on file), queues last week''s recap (L14) to the clinic''s address'
 WHERE name = 'weekly-recap';

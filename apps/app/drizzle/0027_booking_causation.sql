-- The call-to-booking link, and the provenance that keeps it honest.
--
-- `appointments.conversation_id` has existed since 0000 and nothing ever wrote
-- it. `upsertAppointments` is the only writer of this table and never set the
-- column, while attribution/report.ts INNER JOINs on it to count bookings and
-- sync/reconcile-store.ts left-joins it to decide which revenue was recovered.
-- An inner join on a permanently null column returns nothing, so a flawless
-- connector would still have reported zero bookings and $0.00 recovered.
--
-- The link is now written where it is actually known: the agent books, so the
-- agent records which call produced it. That introduces the second problem this
-- column solves.
--
-- report.ts joins to appointments on purpose, and says why: "so a booking means
-- a real appointment row, not just an outcome label the agent set on its way
-- out of the call." Once healdesk writes appointment rows itself — which it
-- must, because for a clinic with no booking software nobody else will — that
-- check stops proving anything, since we would be corroborating our own claim.
-- `external_confirmed_at` restores it. It is written ONLY by upsertAppointments,
-- when a sync reads the appointment back out of the clinic's own system.
--
-- Null therefore means one of two things and the report must not conflate them:
-- we booked it and no sync has seen it yet, or the clinic runs no booking
-- software and nothing ever will.

ALTER TABLE "appointments" ADD COLUMN "external_confirmed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "appointments_confirmed_idx" ON "appointments" USING btree ("clinic_id","external_confirmed_at") WHERE "appointments"."external_confirmed_at" is not null;
-- The hourly location-quantity check (lib/billing/location-quantity.ts).
--
-- An account's subscription carries one package item whose quantity is the
-- number of locations it pays for, and since the central model of
-- 20 October 2026 (drizzle/0108) the locations themselves are rows of
-- clinic_locations. Nothing compared the two: a quantity changed by hand in
-- the Stripe Dashboard, or an add whose charge went through while its
-- location never became active, would bill a practice for locations it does
-- not have (or answer for ones it does not pay for) with nobody told.
--
-- The check reads, never writes: per billing clinic, Stripe's quantity on
-- the package item (one subscriptions.retrieve) against the active
-- locations plus a pending one whose charge is on record. A mismatch raises
-- one ops alert per episode, ids, counts and times only, and its end raises
-- one more; the ops log (ops_alerts) is the episode's record, so no table
-- is added here.
--
-- One job row, seeded OFF like every job that acts on clinics' accounts:
-- the owner switches it on from /admin's job list when extra locations are
-- switched on (lib/locations.ts LOCATIONS_READY_PACKAGES).
--
-- Safe to apply in place: one job row, no schema change.

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('location-quantity', 'Hourly; reads each account''s subscription in Stripe and compares the quantity it bills for locations with the account''s active locations, plus one being added whose charge is recorded. A mismatch is told to ops once until the counts agree again. Reads only: never changes a subscription. Off until the owner switches it on with extra locations', false)
ON CONFLICT (name) DO NOTHING;

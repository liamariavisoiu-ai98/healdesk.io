ALTER TABLE "clinic_locations" ADD COLUMN "details_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinic_locations" ADD CONSTRAINT "clinic_locations_details_confirmed_check" CHECK ("clinic_locations"."details_confirmed_at" is null or ("clinic_locations"."position" > 1 and "clinic_locations"."address" is not null and "clinic_locations"."opening_hours" is not null and "clinic_locations"."published_phone_e164" is not null));--> statement-breakpoint
-- =============================================================================
-- A later location's details, confirmed (21 October 2026). The two statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- When a location is added from Billing, its row carries the name and street
-- address typed there and nothing else: no hours, no number for it. The toast
-- and the location_added email tell the practice to "confirm its address,
-- hours and phone numbers" next, and the owner decided on 21 October 2026 to
-- keep those words and build the page they point to (Settings, one level
-- down: /c/<slug>/settings/locations/<id>, lib/portal/location-details.ts).
-- This column is what that page sets: the moment the practice said the
-- location's details are right. Until it is set, Home and Settings show the
-- location as waiting on its details.
--
-- What it guards, for every role (the CHECK above and the trigger below):
--
--   - only a later location is confirmed; the main location's facts are
--     confirmed in the setup wizard and live on clinics, so its column stays
--     null;
--   - a confirmed location has an address, its hours and its own number (the
--     CHECK), so it can never be emptied of what confirming checked;
--   - the stamp is the database's clock, set once on null -> confirmed, and
--     never moved or cleared after; a retired location is never confirmed;
--   - an insert never arrives confirmed.
--
-- Business contact data, no patient: no BAA gate. Destruction: none of its
-- own. The column lives and dies with its row, which the account's closure
-- deletes (app_close_account, 0108); retention has nothing to purge in it.
-- The runtime role gets UPDATE on the column, beside the facts 0108 granted.
--
-- Safe to apply in place: a nullable column added with no default, a CHECK
-- every existing row passes (the column is null on all of them), one column
-- grant and one trigger.
-- =============================================================================

GRANT UPDATE (details_confirmed_at) ON clinic_locations TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_clinic_location_confirmation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.details_confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'clinic_locations: a location is added unconfirmed; its details are confirmed on its Settings page'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.details_confirmed_at IS NOT DISTINCT FROM OLD.details_confirmed_at THEN
    RETURN NEW;
  END IF;
  IF OLD.details_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'clinic_locations: a location''s details are confirmed once, and the time is never moved or cleared'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status = 'retired' THEN
    RAISE EXCEPTION 'clinic_locations: a retired location is not confirmed'
      USING ERRCODE = '42501';
  END IF;
  NEW.details_confirmed_at := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_location_confirmation_guard() FROM PUBLIC;--> statement-breakpoint
-- Named to fire after clinic_locations_guard and clinic_locations_closed_account
-- (Postgres fires BEFORE triggers in name order), so a closed account's
-- refusal and the lifecycle's come first.
CREATE TRIGGER clinic_locations_zz_confirmation
  BEFORE INSERT OR UPDATE ON clinic_locations
  FOR EACH ROW EXECUTE FUNCTION app_clinic_location_confirmation_guard();

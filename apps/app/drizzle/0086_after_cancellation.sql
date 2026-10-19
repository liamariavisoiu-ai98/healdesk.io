ALTER TABLE "clinics" ADD COLUMN "destruction_notice_address" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_destruction_notice_address_check" CHECK ("clinics"."destruction_notice_address" is null or ("clinics"."destroyed_at" is not null and char_length("clinics"."destruction_notice_address") between 3 and 254 and "clinics"."destruction_notice_address" ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$'));--> statement-breakpoint
-- =============================================================================
-- After cancellation (Annex X5, E3–E6): the address E6 goes to. The two
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express.
--
-- E6, "Your data has been destroyed", goes to the address captured before
-- destruction, not to the clinic's address as it stands when the email goes:
-- by then the sign-in it would be read from may not be there (a destruction
-- that one day takes the clinic's user and memberships, an address change
-- in flight). So destroyClinicData reads the clinic's one address before it
-- deletes anything and writes it here beside the destroyed stamp, in the
-- same transaction (lib/offboarding/after-cancellation.ts): a destruction
-- that rolls back captures nothing, and one that commits always has it.
--
-- Why a column on clinics, against the keep-list: destruction keeps the
-- clinic row (a customer we had; lib/offboarding's header, "What goes, and
-- what stays"), and the address is the clinic's own business contact data,
-- never a patient's, so it may survive the destruction it reports. It is
-- not one of the records the agreements keep (the signed agreement, the
-- record of disclosures, the billing history), so it is kept no longer than
-- its one use: E6's sender clears it once the email is sent, or once it has
-- failed for good, and in any case DESTRUCTION_NOTICE_DAYS after the
-- destruction. The CHECK keeps it to a destroyed clinic, so it can never
-- hold the address of one still in service.
--
-- The runtime role writes and clears it (destruction runs as that role), so
-- it gets the column's UPDATE: column-level grants do not reach a column
-- added later (0031), and tests/database-audit.test.ts holds every other
-- clinics column to its grant.
--
-- app_destruction_notices_owed() is how the hourly sender finds the clinics
-- that still hold one, across tenants: ids and the destroyed stamp only,
-- never the address, which the sender reads inside the clinic's own tenant.
--
-- Safe to apply in place: one nullable column, one CHECK every existing row
-- passes, one function. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md).
-- =============================================================================

GRANT UPDATE (destruction_notice_address) ON clinics TO healdesk_app;--> statement-breakpoint

CREATE FUNCTION app_destruction_notices_owed()
RETURNS TABLE (clinic_id uuid, destroyed_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.destroyed_at
    FROM clinics c
   WHERE c.destruction_notice_address IS NOT NULL
   ORDER BY c.destroyed_at, c.id
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_destruction_notices_owed() IS
  'The clinics still holding the address captured for E6 ("Your data has been destroyed"): ids and the destroyed stamp, never the address. For the hourly sender, which reads and clears the address inside each clinic''s own tenant. No patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destruction_notices_owed() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destruction_notices_owed() TO healdesk_app;--> statement-breakpoint

COMMENT ON COLUMN clinics.destruction_notice_address IS
  'The clinic''s one address, captured by destroyClinicData before it deletes anything and written beside the destroyed stamp, for E6 alone. Business contact data. Cleared once E6 is sent, once it fails for good, or DESTRUCTION_NOTICE_DAYS after the destruction. Only a destroyed clinic holds one.';

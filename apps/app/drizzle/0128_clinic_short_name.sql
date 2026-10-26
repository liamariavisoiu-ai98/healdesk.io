-- =============================================================================
-- What patients call the clinic (26 October 2026; owner: "build it", from
-- docs/design/clinic-nickname-2026-10-26.md). The assistant says a clinic's
-- full name once, in its opening line, and this short form after it ("Lumen"
-- for "Lumen Aesthetics & Wellness"). Null means the form worked out from the
-- name (@healdesk/catalog shortClinicName). Clinic configuration, never PHI;
-- written by saveSetupSettings through the same table grant as every other
-- setting, under clinic_settings' row-level security. Generated from schema.ts.
-- =============================================================================
ALTER TABLE "clinic_settings" ADD COLUMN "short_name" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_short_name_check" CHECK ("clinic_settings"."short_name" is null or char_length("clinic_settings"."short_name") between 1 and 40);

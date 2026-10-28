-- =============================================================================
-- The payment switches (28 October 2026; owner, in chat;
-- docs/design/launch-readiness-2026-10-27/portal-dashboard-lanes.md).
-- "Text the payment link" (off by default) and "What the assistant asks the
-- patient to pay" (deposit only, or the full price), each a clinic_settings
-- column under the table's existing row-level security and table grant.
-- clinic_settings_history takes the three payment switches a lost fact sets
-- back (deposits, the text, full payment), so each reset keeps its before
-- and after. Clinic configuration, never PHI. Generated from schema.ts.
-- =============================================================================
ALTER TABLE "clinic_settings_history" DROP CONSTRAINT "clinic_settings_history_field_check";--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "text_payment_link" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "payment_ask" text DEFAULT 'deposit_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_payment_ask_check" CHECK ("clinic_settings"."payment_ask" in ('deposit_only', 'full_payment'));--> statement-breakpoint
ALTER TABLE "clinic_settings_history" ADD CONSTRAINT "clinic_settings_history_field_check" CHECK ("clinic_settings_history"."field" in ('direct_line_e164', 'transfer_e164', 'urgent_help_e164', 'vet_referral_e164', 'transcript_retention_days', 'auto_confirm_bookings', 'sign_in_email', 'deposits_enabled', 'text_payment_link', 'payment_ask'));
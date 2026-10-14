ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "product_updates" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'welcome', 'steps_sent', 'address_change_confirm', 'address_changing', 'agreement_to_sign', 'data_destroyed'));
-- =============================================================================
-- Every remaining email kind in Annex X5 of the funnel and portal plan,
-- registered at once (package S0, 14 October 2026). Everything above this
-- line was generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- Why one migration: both kinds CHECKs are generated from the registries
-- (lib/email/kinds.ts, and LEDGER_DIRECT_KINDS in lib/email/direct-kinds.ts),
-- so every package that added its own kind would regenerate the same two
-- constraints, and two packages landing together would collide on them. The
-- packages now only fill in payloads and templates; the owing package of each
-- kind is named in PENDING_TEMPLATES (lib/email/templates/registry.ts).
--
--   - The outbox (billing_notices) and its ledger take L1, L7-L15, L17,
--     L18, L20, L21, L23, L25, L28-L34, E3-E5, O8 and O9.
--   - The ledger alone takes the direct kinds that have a clinic: O5's
--     confirmation and notice, L22 and E6.
--   - clinic_settings.product_updates: L33's switch, on by default, read by
--     the sender and turned off by its stop link (lib/email/stop.ts). The
--     runtime role's table-level SELECT, INSERT and UPDATE on clinic_settings
--     (0043) already cover the new column.
--
-- Both CHECKs only widen, so every row already stored still passes. No new
-- table, grant or function.
-- =============================================================================

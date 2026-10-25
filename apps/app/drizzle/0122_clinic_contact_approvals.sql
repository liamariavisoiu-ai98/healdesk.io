ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "ops_approvals" DROP CONSTRAINT "ops_approvals_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'closed_day_bookings', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'agreement_question'));--> statement-breakpoint
ALTER TABLE "ops_approvals" ADD CONSTRAINT "ops_approvals_kind_check" CHECK ("ops_approvals"."kind" in ('billing_request_retry', 'overage_invoice_retry', 'billing_event_replay', 'baa_resign_chase', 'agreement_question', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'setup_reminder_now'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'closed_day_bookings', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'agreement_question', 'welcome', 'steps_sent', 'address_change_confirm', 'address_changing', 'agreement_to_sign', 'data_destroyed', 'baa_resign_chase'));--> statement-breakpoint
-- =============================================================================
-- The clinic-contact approvals (25 October 2026; ops automation lane P6f;
-- design E6 §3 items 13 and 14, E2 "Manual buttons"; owner decisions D4, D6
-- and D12). The statements above were generated from schema.ts.
--
-- The owner wants four things he says to a clinic by email to wait for his
-- yes and be easy to adjust before they go: the chase of a BAA version
-- re-sign once L22's reminders are spent, the question of which agreement a
-- DPA "No" practice whose website takes insurance needs, and three setup
-- notices (more time, nothing to do while we finish a step, a five-minute
-- call); and "Send reminder now", the next spec reminder sooner. Each is a
-- new kind on the approval inbox's closed list, and the five emails are new
-- email kinds:
--
--   ops_approvals.kind     + baa_resign_chase, agreement_question,
--                            setup_extended, setup_waiting_on_us,
--                            setup_help_offer, setup_reminder_now
--   billing_notices.kind   + setup_extended (O18), setup_waiting_on_us (O19),
--                            setup_help_offer (O20), agreement_question (L36)
--   report_deliveries.kind + those four, and baa_resign_chase (L22c), a link
--                            email sent straight and recorded on the ledger
--
-- Only the three CHECK constraints change. ops_approvals keeps its guard
-- trigger (a proposal is fixed once made, only waiting -> approved |
-- rejected | expired and approved -> executed | failed) and
-- ops_approval_events its add-only triggers, all ENABLE ALWAYS, untouched by
-- this file; the grants are unchanged. No new table, no new job.
--
-- Safe to apply in place: each CHECK only widens, so every existing row
-- still passes it.
-- =============================================================================
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')
         AND tgenabled = 'A') <> 4 THEN
    RAISE EXCEPTION 'an approval inbox guard trigger is missing or not ENABLE ALWAYS';
  END IF;
END;
$$;

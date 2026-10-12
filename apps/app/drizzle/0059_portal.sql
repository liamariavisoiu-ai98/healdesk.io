ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'welcome', 'steps_sent'));--> statement-breakpoint
-- =============================================================================
-- The clinic portal's screens before go-live (plan Part F; milestone M3, part
-- two). Everything above this line was generated from schema.ts; everything
-- below is the part drizzle cannot express.
--
-- What this migration adds. The outbox and its ledger take three kinds:
--   - setting_changed (O4): a change to the direct line or the transfer
--     number once the value was first set (plan Part D4;
--     lib/notices/setting-changed.ts);
--   - channel_ready (O10): a channel ready on our side and still waiting on
--     the clinic an hour later (lib/notices/channel-ready.ts, a seam until
--     something records a channel's readiness);
--   - steps_sent (O11), on the ledger only: the steps a clinic sends on to the
--     person it names, and the addresses that asked for no more of them
--     (lib/notices/steps-sent.ts).
-- Both kinds CHECKs only widen, so every row already stored still passes.
--
-- Nothing below yet: no new table, no grant and no function changes here.
-- =============================================================================

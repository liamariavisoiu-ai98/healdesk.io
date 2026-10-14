ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live'));--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_kind_check" CHECK ("channel_events"."kind" in ('ready', 'waiting', 'live', 'first_answer', 'paused', 'resumed', 'turned_off', 'turned_on', 'audit_passed', 'runtime_seen'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'welcome', 'steps_sent'));--> statement-breakpoint

-- =============================================================================
-- Channel events (WP1, 14 October 2026). The statements above were generated
-- from schema.ts; everything below is the part drizzle cannot express.
--
-- What this migration adds, in one paragraph. lib/channels/events.ts is the
-- first writer of clinic_channels.ready_at, waiting_on, live_at and
-- first_answer_at, and of the matching channel_events rows. A channel goes
-- live on four inputs: setup done, its runtime present, its audit passed and
-- the operator's go-live. Two of those had nowhere to be recorded, so
-- channel_events gains two kinds: `audit_passed`, which only an operator
-- records until the practice questions exist (an ops operation through the
-- signed envelope, never a default), and `runtime_seen`, the first time
-- website chat's widget loaded on the clinic's own site. L1, "AYA is
-- answering on {channel}" (`channel_live`), joins the outbox's kinds, and the
-- ledger's CHECK follows the registry as it always has.
--
-- Grants are unchanged: channel_events stays append-only for the runtime
-- role (0044's SELECT and INSERT), so neither new kind can be rewritten or
-- erased once recorded, and both name a channel (0044's
-- channel_events_channel_required). The tables keep their FORCEd tenant
-- policies and their place in offboarding and the purge: both are
-- clinic-scoped, hold no patient data, and are already covered.
--
-- Safe to apply in place: three CHECKs widened, and the comments below.
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

COMMENT ON TABLE channel_events IS
  'Append-only history of a clinic''s channels: ready, waiting, live, first_answer, the header''s pause and resume, the Settings switch, and two of live''s inputs: audit_passed (recorded by an operator until the practice questions exist) and runtime_seen (website chat''s widget first loaded on the clinic''s own site). Billing evidence: the plan start and each step-up are charged from first_answer, which the partial unique index lets each channel record once. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN channel_events.detail IS
  'Ids, ISO dates, counts and closed codes only (how a live input was recorded, which exclusion kept an answer from counting). Never conversation content, never a caller''s number.';

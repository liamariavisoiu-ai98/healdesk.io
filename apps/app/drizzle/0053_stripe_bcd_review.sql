ALTER TABLE "billing_requests" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_plan_change_request_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_plan_change_plan_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_plan_change_interval" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "stripe_subscription_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_epoch_check" CHECK ("billing_requests"."epoch" >= 0);--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_pending_plan_change_check" CHECK (("entitlements"."pending_plan_change_request_id" is null) = ("entitlements"."pending_plan_change_plan_id" is null) and ("entitlements"."pending_plan_change_request_id" is null) = ("entitlements"."pending_plan_change_interval" is null) and ("entitlements"."pending_plan_change_interval" is null or "entitlements"."pending_plan_change_interval" in ('month', 'year')) and ("entitlements"."pending_plan_change_request_id" is null or "entitlements"."pending_plan_change_request_id" ~ '^[A-Za-z0-9_-]{1,64}$'));--> statement-breakpoint

-- =============================================================================
-- Review fixes of 7 October 2026 to the Stripe build. Everything above was
-- generated from schema.ts; below is what drizzle cannot express.
--
-- billing_requests.epoch: the drainer writes it when it re-arms a row, so
-- healdesk_app needs UPDATE on it beside the other worker columns (0050 froze
-- the rest of the row). entitlements already grants table-level UPDATE, so the
-- four new entitlements columns need no grant.
-- =============================================================================
GRANT UPDATE (epoch) ON billing_requests TO healdesk_app;--> statement-breakpoint

COMMENT ON COLUMN billing_requests.epoch IS
  'How many times the request was re-armed. Part of every idempotency key and lease owner, so a re-armed request never replays a failure Stripe cached under an earlier attempt''s key.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.pending_plan_change_request_id IS
  'A plan change in flight: set under the Stripe mutation lease before any charge, cleared when applied, so a retry adopts it instead of charging the setup-fee difference again.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.stripe_subscription_synced_at IS
  'When the subscription state last applied from Stripe was read; a snapshot read earlier than this is stale and is skipped.';

ALTER TABLE "ops_alerts" ADD COLUMN "slack_posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD COLUMN "slack_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD COLUMN "slack_error" text;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD COLUMN "slack_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops_alerts" ADD CONSTRAINT "ops_alerts_slack_attempts_check" CHECK ("ops_alerts"."slack_attempts" >= 0);--> statement-breakpoint
-- =============================================================================
-- Ops alerts reach Slack (23 October 2026; owner decisions D1 and D2 of the
-- ops automation plan, docs/design/ops-automation-2026-10-23). The statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- Until now an ops alert was a log line, this row and one email. The owner
-- asked for the same alert in Slack. apps/app posts it itself, from the
-- worker's every-minute sweep (lib/ops/slack.ts), through an Incoming Webhook
-- held in the SLACK_WEBHOOK_URL parameter; while that is unset nothing
-- posts and these columns keep their defaults.
--
-- The four columns are the Slack copy's state: when Slack took it, how many
-- posts were tried, the last failure (an HTTP status or an error's name,
-- never the webhook's address), and when the next try may start, which is
-- also the lease a try holds, so two workers never post one alert twice. The
-- runtime role may update these four; the alert itself (event, key, fields,
-- raised_at) stays frozen, as 0046 left it.
--
-- Nothing posted is stored here: the Slack text is built at post time from
-- the alert's clinic id and counts and the clinic's name (business data), by
-- the allow-list in lib/ops/slack.ts.
--
-- Safe to apply in place: nullable columns, one with a default, a CHECK every
-- existing row passes, and a column grant.
-- =============================================================================

GRANT UPDATE (slack_posted_at, slack_attempts, slack_error, slack_next_at) ON ops_alerts TO healdesk_app;--> statement-breakpoint

COMMENT ON COLUMN ops_alerts.slack_next_at IS
  'When the Slack sweep may try this alert next; also the lease a running try holds. Null until the first try.';--> statement-breakpoint
COMMENT ON COLUMN ops_alerts.slack_error IS
  'The last failed Slack post: an HTTP status or an error name. Never the webhook address, never the message.';--> statement-breakpoint

DO $$
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'event', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'dedupe_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'fields', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'raised_at', 'UPDATE')
     OR has_table_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can change an alert 0046 froze.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'slack_next_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot record a Slack post.';
  END IF;
END;
$$;

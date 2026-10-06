CREATE TABLE "email_daily_quota" (
	"day" date PRIMARY KEY NOT NULL,
	"used" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "email_daily_quota_used_check" CHECK ("email_daily_quota"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"repeats" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"message_id" text,
	"last_error" text,
	CONSTRAINT "ops_alerts_event_check" CHECK ("ops_alerts"."event" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "ops_alerts_dedupe_key_check" CHECK (char_length("ops_alerts"."dedupe_key") <= 400)
);
--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD COLUMN "delivery_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ops_alerts_dedupe_idx" ON "ops_alerts" USING btree ("event","dedupe_key","raised_at");--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_delivery_status_check" CHECK ("report_deliveries"."delivery_status" is null or "report_deliveries"."delivery_status" in ('sent', 'delivered', 'bounced', 'complained', 'suppressed', 'delayed'));--> statement-breakpoint

-- =============================================================================
-- The email platform (Annex X3 of docs/design/funnel-onboarding-portal-
-- 2026-10-06.md). Everything above this line was generated from schema.ts;
-- everything below is the part drizzle cannot express: grants, the outbox's
-- tenant walk, the comments and the audit at the end.
--
-- What this migration adds, in one paragraph. report_deliveries becomes the
-- ledger of every email to a clinic: its kinds widen to the outbox's (an
-- outbox send writes one row per recipient, keyed on the notice's id), and it
-- gains delivery_status and delivery_at, written when Resend's webhook is
-- relayed from apps/web. ops_alerts is the ops log notifyOps dedupes against
-- and keys its emails on, and email_daily_quota keeps Resend's daily count
-- for the 70-a-day alarm and the ops digest; neither has a clinic_id, because
-- both are ours rather than a tenant's. app_pending_notices lets the
-- once-a-minute sender and /api/health find unsent notices across clinics
-- without a tenant, returning ids and kinds and never a payload.
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on the two new tables, and report_deliveries has held
-- them since 0034. Every REVOKE below is therefore required, not defensive,
-- and each GRANT restates the intended set so it can be read in one place.
--
-- Safe to run: the two new tables are empty, the two new columns are
-- nullable, and every existing ledger row carries one of the four report
-- kinds the widened CHECK still allows (lib/reporting/recipients.ts has never
-- written any other).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Grants, table by table.
-- -----------------------------------------------------------------------------

-- report_deliveries: the ledger, on the offboarding keep-list (it holds no
-- patient data and is the record of every email sent). No DELETE, so "did we
-- tell them" always has an answer. UPDATE of the columns the mailers and the
-- webhook relay write, and nothing else: a row cannot be moved to another
-- clinic, kind, period or address after it is claimed.
REVOKE DELETE ON report_deliveries FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON report_deliveries FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, message_id, reason, attempted_at, sent_at, delivery_status, delivery_at) ON report_deliveries TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON report_deliveries TO healdesk_app;--> statement-breakpoint

-- ops_alerts: an append-mostly log. The alert itself (event, key, fields,
-- when it was first raised) is fixed at insert; a repeat inside the window
-- bumps its counter, and the send writes back its outcome.
REVOKE DELETE ON ops_alerts FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON ops_alerts FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (last_raised_at, repeats, sent_at, message_id, last_error) ON ops_alerts TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON ops_alerts TO healdesk_app;--> statement-breakpoint

-- email_daily_quota: one row per UTC day, raised as the header is seen and
-- stamped once when the alarm fires. The day is the key and never moves.
REVOKE DELETE ON email_daily_quota FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON email_daily_quota FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (used, observed_at, alerted_at) ON email_daily_quota TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON email_daily_quota TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_pending_notices: the unsent notices of some kinds, across clinics.
-- -----------------------------------------------------------------------------
-- The tenant walk of 0034 (app_active_connections). billing_notices FORCEs
-- row-level security, which binds the function's owner too, so a plain
-- definer SELECT returns nothing; the walk sets the tenant per clinic, exactly
-- as withTenant() does, and restores the caller's setting before returning.
-- The projection is the whole surface: clinic id, notice id, kind, the three
-- delivery columns the sender schedules by, and whether the row has been
-- tried (an attempt spent, or a wait recorded), which /api/health measures
-- lateness by. Never the payload, which the sender re-reads inside
-- withTenant() when it claims the row, and never last_error itself. Rows that
-- have used every attempt (dead letters) are left out, and so are kinds the
-- caller did not ask for, so a backlog the sender cannot send yet (a kind with
-- no template) never crowds out one it can. At most 500 rows per clinic.
CREATE OR REPLACE FUNCTION app_pending_notices(p_kinds text[], p_max_attempts integer, p_limit integer)
RETURNS TABLE (clinic_id uuid, id uuid, kind text, created_at timestamptz, send_after timestamptz, attempts integer, tried boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT n.clinic_id, n.id, n.kind, n.created_at, n.send_after, n.attempts,
             (n.attempts > 0 OR n.last_error IS NOT NULL) AS tried
        FROM billing_notices n
       WHERE n.clinic_id = c.id
         AND n.sent_at IS NULL
         AND n.attempts < p_max_attempts
         AND n.kind = ANY (p_kinds)
       ORDER BY n.send_after
       LIMIT greatest(least(p_limit, 500), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_pending_notices(text[], integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_pending_notices(text[], integer, integer) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The billing-notices job row stays the sender's on/off switch (seeded off in
-- 0043), and its cadence now says what it runs: the sender left the hourly
-- tick for the `notices` queue, every minute. Only the description changes;
-- whether it is switched on is ops' decision and is left as it is.
-- -----------------------------------------------------------------------------
UPDATE scheduled_jobs
   SET cadence = 'Every minute, from the notices queue; sends due email notices and retries, and holds kinds with no template yet'
 WHERE name = 'billing-notices';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN report_deliveries.delivery_status IS
  'What Resend''s webhook last reported, relayed from apps/web: sent, delivered, delayed, bounced (permanent only; a soft bounce is delayed), complained or suppressed. An address is undeliverable while its latest row says bounced, complained or suppressed. Never a lower-ranked status over a higher one.';--> statement-breakpoint
COMMENT ON COLUMN report_deliveries.delivery_at IS
  'The provider event''s own timestamp, not the time we received it.';--> statement-breakpoint
COMMENT ON TABLE ops_alerts IS
  'The ops log: one row per notifyOps alert (Annex X5, I1), deduplicated on (event, dedupe_key) within an hour, and the state row the alert email''s idempotency key is built from. Ids, counts and categories only. Ours, not a tenant''s: no clinic_id, no RLS.';--> statement-breakpoint
COMMENT ON TABLE email_daily_quota IS
  'Resend''s daily email count per UTC day, from the x-resend-daily-quota response header (it counts both apps). notifyOps fires once at 70 (alerted_at); the free plan stops at 100. Read by the ops digest.';--> statement-breakpoint
COMMENT ON FUNCTION app_pending_notices(text[], integer, integer) IS
  'Unsent, not-dead billing_notices rows of the given kinds across clinics, as (clinic id, notice id, kind, created_at, send_after, attempts, tried), for the notices sender and /api/health. A tenant walk because billing_notices FORCEs RLS; restores app.clinic_id before returning. Never the payload.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'email_daily_quota'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from a table 0045 made undeletable.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'kind', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'period_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'recipient', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'event', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'dedupe_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'fields', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_alerts'::regclass, 'raised_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'email_daily_quota'::regclass, 'day', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a column 0045 froze.';
  END IF;
  IF NOT (has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'delivery_status', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'delivery_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'status', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'report_deliveries'::regclass, 'attempted_at', 'UPDATE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot UPDATE a ledger column the mailers or the webhook relay write.';
  END IF;
END;
$$;

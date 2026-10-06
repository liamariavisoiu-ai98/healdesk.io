CREATE TABLE "channel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text,
	"kind" text NOT NULL,
	"waiting_on" text,
	"actor" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_events_channel_check" CHECK ("channel_events"."channel" is null or "channel_events"."channel" in ('web', 'meta', 'voice')),
	CONSTRAINT "channel_events_kind_check" CHECK ("channel_events"."kind" in ('ready', 'waiting', 'live', 'first_answer', 'paused', 'resumed', 'turned_off', 'turned_on')),
	CONSTRAINT "channel_events_waiting_on_check" CHECK ("channel_events"."waiting_on" is null or "channel_events"."waiting_on" in ('setup', 'forwarding', 'snippet', 'meta_connect', 'whatsapp_payment_method')),
	CONSTRAINT "channel_events_channel_required" CHECK ("channel_events"."channel" is not null or "channel_events"."kind" in ('paused', 'resumed'))
);
--> statement-breakpoint
CREATE TABLE "clinic_channels" (
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ready_at" timestamp with time zone,
	"waiting_on" text,
	"live_at" timestamp with time zone,
	"first_answer_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_channels_clinic_id_channel_pk" PRIMARY KEY("clinic_id","channel"),
	CONSTRAINT "clinic_channels_channel_check" CHECK ("clinic_channels"."channel" in ('web', 'meta', 'voice')),
	CONSTRAINT "clinic_channels_waiting_on_check" CHECK ("clinic_channels"."waiting_on" is null or "clinic_channels"."waiting_on" in ('setup', 'forwarding', 'snippet', 'meta_connect', 'whatsapp_payment_method'))
);
--> statement-breakpoint
CREATE TABLE "clinic_closures" (
	"clinic_id" uuid NOT NULL,
	"closed_on" date NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_closures_clinic_id_closed_on_pk" PRIMARY KEY("clinic_id","closed_on"),
	CONSTRAINT "clinic_closures_label_check" CHECK ("clinic_closures"."label" is null or char_length("clinic_closures"."label") <= 80)
);
--> statement-breakpoint
ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "ai_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "plan_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "bought_plan_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "setup_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_channels" ADD CONSTRAINT "clinic_channels_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_closures" ADD CONSTRAINT "clinic_closures_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_first_answer_idx" ON "channel_events" USING btree ("clinic_id","channel") WHERE "channel_events"."kind" = 'first_answer';--> statement-breakpoint
CREATE INDEX "channel_events_clinic_idx" ON "channel_events" USING btree ("clinic_id","occurred_at");--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected'));--> statement-breakpoint

-- =============================================================================
-- The funnel and portal contracts (6 October 2026). Everything above this line
-- was generated from schema.ts; everything below is the part drizzle cannot
-- express: row-level security, grants, the comments and the audit at the end.
--
-- What this migration adds, in one paragraph. Each channel a clinic bought is
-- a clinic_channels row holding its state now (On/Off, ready on our side, what
-- the clinic still has to do, live, first answer), and channel_events is the
-- append-only record of how it got there, with a partial unique index that
-- lets a channel's first answer, the day its price joins the plan, be recorded
-- once. clinic_closures holds the whole days a clinic is closed, beside the
-- weekly hours that stay on clinics. entitlements gains the deferred start
-- (plan_started_at, bought_plan_id) and the end of the 30-day setup window
-- (setup_deadline_at); clinic_settings gains the end of a timed pause.
-- billing_notices' kinds now come from the registry in lib/email/kinds.ts:
-- eight join, and welcome_resend leaves, because a welcome sent again is a
-- link email with a fresh token, not an outbox row.
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on each new table by the time these statements run.
-- Every REVOKE below is therefore required, not defensive, and each GRANT
-- restates the intended set so it can be read in one place.
--
-- Safe to run: every new table is empty, every new column is nullable, and no
-- code path has ever enqueued welcome_resend (only F0's types named it), so
-- the narrower CHECK holds on every existing row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant tables: ENABLE + FORCE row-level security, one isolation policy each,
-- exactly as 0043. tests/rls-drift.test.ts asks the catalogue for every table
-- with a clinic_id and fails on any that is not both.
-- -----------------------------------------------------------------------------
ALTER TABLE clinic_channels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_channels FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_channels_tenant_isolation ON clinic_channels
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE channel_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE channel_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channel_events_tenant_isolation ON channel_events
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE clinic_closures ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_closures FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_closures_tenant_isolation ON clinic_closures
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants, table by table.
-- -----------------------------------------------------------------------------

-- clinic_channels: written at provisioning and moved along as the channel
-- opens. No DELETE, so a channel in service can never drop out of the price
-- by losing its row; UPDATE of the state columns only, so a row cannot be
-- moved to another clinic or channel, or its creation back-dated.
REVOKE DELETE ON clinic_channels FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON clinic_channels FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (enabled, ready_at, waiting_on, live_at, first_answer_at, updated_at) ON clinic_channels TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_channels TO healdesk_app;--> statement-breakpoint

-- channel_events: append-only. The plan start and every step-up are charged
-- from these rows, so the runtime role can neither rewrite nor erase one.
REVOKE DELETE ON channel_events FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON channel_events FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON channel_events TO healdesk_app;--> statement-breakpoint

-- clinic_closures: a day is added, relabelled or removed, never moved; the
-- day is the key.
REVOKE UPDATE ON clinic_closures FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (label) ON clinic_closures TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON clinic_closures TO healdesk_app;--> statement-breakpoint

-- The three entitlements columns and clinic_settings.ai_paused_until need no
-- GRANT: both tables give healdesk_app table-level UPDATE (0028, 0043), which
-- covers a column added later exactly as it covers plan_code and ai_paused_at.
-- Every one of them is written after insert by a runtime path (the billing
-- lifecycle, ops extending the setup window, the pause), and the audit below
-- pins that they stay writable.

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE clinic_channels IS
  'One row per channel a clinic bought (web, meta, voice): its state now, from which lib/channels/state.ts derives the status word. enabled is the Settings On/Off. No DELETE and no UPDATE of the key for the runtime role, so a channel in service never drops out of the price. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN clinic_channels.waiting_on IS
  'The clinic''s one outstanding action while the channel is ready on our side and not yet live.';--> statement-breakpoint
COMMENT ON TABLE channel_events IS
  'Append-only history of a clinic''s channels: ready, waiting, live, first_answer, the header''s pause and resume, the Settings switch. Billing evidence: the plan start and each step-up are charged from first_answer, which the partial unique index lets each channel record once. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN channel_events.actor IS
  '''system'', ''ops'', or the label of the device whose passkey did it. Never a person''s name.';--> statement-breakpoint
COMMENT ON COLUMN channel_events.detail IS
  'Ids, ISO dates and counts only. Never conversation content.';--> statement-breakpoint
COMMENT ON INDEX channel_events_first_answer_idx IS
  'One first_answer per clinic and channel: the database''s guarantee that the plan starts, and each channel''s price joins it, once.';--> statement-breakpoint
COMMENT ON TABLE clinic_closures IS
  'Whole local days a clinic is closed, on top of its weekly hours (clinics.opening_hours). closed_on is a date in the clinic''s own time zone. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.plan_started_at IS
  'When the first plan invoice was paid: the monthly plan has started. Null before, and on every clinic provisioned before the deferred start.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.bought_plan_id IS
  'The catalog package bought at checkout. plan_code follows the package Stripe bills (the channels in service); this stays what was sold, and the metered rates stay its.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.setup_deadline_at IS
  'The end of the 30-day setup window: the end of the 30th day after purchase, set at provisioning and extended only by ops. A clinic with no live channel by then is closed by a job; the setup fee is not refunded.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.ai_paused_until IS
  'When a pause ends by itself. Read only while ai_paused_at is set; null then means paused until someone turns AYA back on.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'channel_events'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from a table 0044 made undeletable.';
  END IF;
  IF has_any_column_privilege('healdesk_app'::name, 'channel_events'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE channel_events, which 0044 made append-only.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'channel', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'created_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_closures'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_closures'::regclass, 'closed_on', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a column 0044 froze.';
  END IF;
  IF NOT (has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'plan_started_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'bought_plan_id', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'setup_deadline_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'ai_paused_until', 'UPDATE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot UPDATE a column 0044 added for a runtime writer.';
  END IF;
END;
$$;

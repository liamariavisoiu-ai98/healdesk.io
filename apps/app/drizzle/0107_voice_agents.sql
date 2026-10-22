CREATE TABLE "voice_agents" (
	"clinic_id" uuid PRIMARY KEY NOT NULL,
	"engine" text DEFAULT 'custom' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retell_agent_id" text,
	"retell_llm_id" text,
	"phone_number_e164" text,
	"config_hash" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"number_ordered_at" timestamp with time zone,
	"drift_repairs" integer DEFAULT 0 NOT NULL,
	"drift_flagged_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "voice_agents_engine_check" CHECK ("voice_agents"."engine" in ('custom', 'native')),
	CONSTRAINT "voice_agents_status_check" CHECK ("voice_agents"."status" in ('pending', 'provisioning', 'ready', 'failed', 'deprovisioning', 'released')),
	CONSTRAINT "voice_agents_agent_id_check" CHECK ("voice_agents"."retell_agent_id" is null or "voice_agents"."retell_agent_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "voice_agents_llm_id_check" CHECK ("voice_agents"."retell_llm_id" is null or "voice_agents"."retell_llm_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "voice_agents_number_check" CHECK ("voice_agents"."phone_number_e164" is null or "voice_agents"."phone_number_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "voice_agents_hash_check" CHECK ("voice_agents"."config_hash" is null or "voice_agents"."config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voice_agents_error_check" CHECK ("voice_agents"."last_error" is null or char_length("voice_agents"."last_error") between 1 and 200),
	CONSTRAINT "voice_agents_attempts_check" CHECK ("voice_agents"."attempts" >= 0 and "voice_agents"."drift_repairs" >= 0),
	CONSTRAINT "voice_agents_ready_check" CHECK ("voice_agents"."status" <> 'ready' or ("voice_agents"."retell_agent_id" is not null and "voice_agents"."phone_number_e164" is not null and "voice_agents"."config_hash" is not null)),
	CONSTRAINT "voice_agents_released_check" CHECK (("voice_agents"."status" = 'released') = ("voice_agents"."released_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "voice_number_order_days" (
	"day" date PRIMARY KEY NOT NULL,
	"ordered" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "voice_number_order_days_ordered_check" CHECK ("voice_number_order_days"."ordered" >= 0)
);
--> statement-breakpoint
ALTER TABLE "voice_agents" ADD CONSTRAINT "voice_agents_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- =============================================================================
-- Each clinic's Retell agent and AYA number, written by code (owner, 21
-- October 2026: "go ahead" with automated voice provisioning). The statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- One row per clinic that bought voice (lib/voice/provision.ts): Retell's ids
-- for its agent and number, the engine (custom, today's WebSocket endpoint;
-- native, a later package), where the set-up stands, a hash of the
-- configuration last written, and our own reason when a run stops. Business
-- data about our vendor set-up: no caller, no call, no words, no secret.
--
-- A tenant row like every table with a clinic_id (tests/rls-drift.test.ts).
-- No BAA gate trigger: nothing here is about a patient, and the demo clinic's
-- agent is provisioned the same way. The runtime role inserts and updates the
-- bookkeeping; the clinic is fixed once written and nothing deletes a row: it
-- is the record that the number was released (KEPT_FOR_GOOD,
-- lib/offboarding/account-closure.ts).
-- =============================================================================
ALTER TABLE voice_agents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE voice_agents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY voice_agents_tenant_isolation ON voice_agents
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
REVOKE ALL ON voice_agents FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON voice_agents TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (engine, status, retell_agent_id, retell_llm_id, phone_number_e164, config_hash, last_synced_at,
  last_error, attempts, number_ordered_at, drift_repairs, drift_flagged_at, released_at, updated_at)
  ON voice_agents TO healdesk_app;--> statement-breakpoint
COMMENT ON TABLE voice_agents IS
  'Each clinic''s Retell agent and AYA number, written by code (lib/voice/provision.ts): engine, Retell ids, the number, status, a hash of the configuration last written, last error in our words, attempts. No patient, no call, no secret.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The daily cap on numbers bought (HEALDESK_VOICE_PROVISION_DAILY_CAP) is
-- across every clinic, which nothing inside one tenant can count: a SECURITY
-- DEFINER function does not bypass a FORCEd policy (0024's note). So the
-- counter is its own table, a UTC day and a count, no clinic_id and nothing
-- about anyone. The runtime role takes a slot with one conditional upsert
-- (lib/voice/provision.ts, reserveOrder); nothing deletes a day.
-- -----------------------------------------------------------------------------
REVOKE ALL ON voice_number_order_days FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON voice_number_order_days TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (ordered) ON voice_number_order_days TO healdesk_app;--> statement-breakpoint
COMMENT ON TABLE voice_number_order_days IS
  'How many AYA numbers were ordered from Retell on each UTC day, across every clinic: the daily spend cap''s counter (lib/voice/provision.ts). A date and a count only.';

CREATE TABLE "billing_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"recipients_count" integer,
	CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'welcome_resend'))
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"party_ref" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"conversation_started_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone NOT NULL,
	"conversations_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chat_threads_clinic_id_channel_party_ref_pk" PRIMARY KEY("clinic_id","channel","party_ref"),
	CONSTRAINT "chat_threads_channel_check" CHECK ("chat_threads"."channel" in ('messenger', 'instagram', 'whatsapp', 'web_chat'))
);
--> statement-breakpoint
CREATE TABLE "checkout_intents" (
	"ref" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"agreement_id" uuid NOT NULL,
	"contact_email" text NOT NULL,
	"plan" text NOT NULL,
	"billing_interval" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"stripe_subscription_id" text,
	"consumed_at" timestamp with time zone,
	"provisioned_clinic_id" uuid,
	"handoff_issued_at" timestamp with time zone,
	CONSTRAINT "checkout_intents_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "checkout_intents_interval_check" CHECK ("checkout_intents"."billing_interval" in ('month', 'year'))
);
--> statement-breakpoint
CREATE TABLE "clinic_settings" (
	"clinic_id" uuid PRIMARY KEY NOT NULL,
	"deposits_enabled" boolean DEFAULT false NOT NULL,
	"book_voice_without_deposit" boolean DEFAULT true NOT NULL,
	"book_chat_without_deposit" boolean DEFAULT false NOT NULL,
	"deposit_uncollectable" text DEFAULT 'book_and_flag' NOT NULL,
	"deposit_hold_minutes" integer DEFAULT 60 NOT NULL,
	"ai_paused_at" timestamp with time zone,
	"ai_paused_by_label" text,
	"direct_line_e164" text,
	"direct_line_set_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_settings_uncollectable_check" CHECK ("clinic_settings"."deposit_uncollectable" in ('book_and_flag', 'hold_and_alert', 'decline_and_alert')),
	CONSTRAINT "clinic_settings_hold_minutes_check" CHECK ("clinic_settings"."deposit_hold_minutes" between 30 and 1440),
	CONSTRAINT "clinic_settings_direct_line_check" CHECK ("clinic_settings"."direct_line_e164" is null or "clinic_settings"."direct_line_e164" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "deposit_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"appointment_id" uuid,
	"channel" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_account_id" text NOT NULL,
	"checkout_session_id" text,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"last_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposit_payments_checkout_session_id_unique" UNIQUE("checkout_session_id"),
	CONSTRAINT "deposit_payments_channel_check" CHECK ("deposit_payments"."channel" in ('web', 'meta')),
	CONSTRAINT "deposit_payments_amount_check" CHECK ("deposit_payments"."amount_cents" > 0),
	CONSTRAINT "deposit_payments_status_check" CHECK ("deposit_payments"."status" in ('creating', 'open', 'paid', 'expired', 'failed', 'cancelled', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "meta_inbound_messages" (
	"clinic_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"message_ref" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_inbound_messages_clinic_id_platform_message_ref_pk" PRIMARY KEY("clinic_id","platform","message_ref"),
	CONSTRAINT "meta_inbound_messages_platform_check" CHECK ("meta_inbound_messages"."platform" in ('messenger', 'instagram', 'whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "overage_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"voice_units" integer DEFAULT 0 NOT NULL,
	"chat_units" integer DEFAULT 0 NOT NULL,
	"voice_rate_cents" integer DEFAULT 0 NOT NULL,
	"chat_rate_cents" integer DEFAULT 0 NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"stripe_invoice_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invoiced_at" timestamp with time zone,
	CONSTRAINT "overage_invoices_status_check" CHECK ("overage_invoices"."status" in ('pending', 'invoiced', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "sign_in_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"purpose" text NOT NULL,
	"source_ref" text,
	"redirect_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"consumed_ip" "inet",
	"issued_by" text,
	CONSTRAINT "sign_in_links_token_hash_length" CHECK (octet_length("sign_in_links"."token_hash") = 32),
	CONSTRAINT "sign_in_links_purpose_check" CHECK ("sign_in_links"."purpose" in ('checkout', 'welcome', 'sign_in', 'invite')),
	CONSTRAINT "sign_in_links_redirect_check" CHECK ("sign_in_links"."redirect_to" is null or ("sign_in_links"."redirect_to" like '/%' and "sign_in_links"."redirect_to" not like '//%' and "sign_in_links"."redirect_to" !~ '[\\[:cntrl:]]')),
	CONSTRAINT "sign_in_links_expiry_check" CHECK ("sign_in_links"."expires_at" > "sign_in_links"."created_at"),
	CONSTRAINT "sign_in_links_consumed_ip_check" CHECK ("sign_in_links"."consumed_ip" is null or "sign_in_links"."used_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "stripe_connect_events" (
	"stripe_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"account" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"resolved_clinic_id" uuid,
	CONSTRAINT "stripe_connect_events_outcome_check" CHECK ("stripe_connect_events"."outcome" is null or "stripe_connect_events"."outcome" in ('processed', 'ignored', 'failed', 'dead_letter'))
);
--> statement-breakpoint
CREATE TABLE "stripe_connect_states" (
	"state_hash" "bytea" PRIMARY KEY NOT NULL,
	"target_clinic_id" uuid NOT NULL,
	"user_id" text,
	"return_to" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "stripe_connect_states_hash_length" CHECK (octet_length("stripe_connect_states"."state_hash") = 32),
	CONSTRAINT "stripe_connect_states_return_check" CHECK ("stripe_connect_states"."return_to" in ('portal', 'ops'))
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"location_clinic_id" uuid NOT NULL,
	"meter" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"quantity" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"window_start" timestamp with time zone,
	"included" integer NOT NULL,
	"used_before" integer NOT NULL,
	"over_allowance" integer DEFAULT 0 NOT NULL,
	"stripe_reported_at" timestamp with time zone,
	"stripe_report_attempts" integer DEFAULT 0 NOT NULL,
	"stripe_report_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_meter_check" CHECK ("usage_events"."meter" in ('voice_minutes', 'chat_conversations')),
	CONSTRAINT "usage_events_source_check" CHECK ("usage_events"."source" in ('voice_call', 'meta', 'web_chat')),
	CONSTRAINT "usage_events_quantity_check" CHECK ("usage_events"."quantity" > 0),
	CONSTRAINT "usage_events_over_check" CHECK ("usage_events"."over_allowance" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "billing_clinic_id" uuid;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "stripe_connect_disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "usage_alerts_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "locations" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "first_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "paid_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "last_paid_invoice_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "open_invoice_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "open_invoice_url" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "metered_price_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "setup_fee_refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "setup_fee_refunded_usd" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "first_period_refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_payments" ADD CONSTRAINT "deposit_payments_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposit_payments" ADD CONSTRAINT "deposit_payments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_inbound_messages" ADD CONSTRAINT "meta_inbound_messages_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overage_invoices" ADD CONSTRAINT "overage_invoices_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_links" ADD CONSTRAINT "sign_in_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_location_clinic_id_clinics_id_fk" FOREIGN KEY ("location_clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_notices_dedupe_idx" ON "billing_notices" USING btree ("clinic_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "billing_notices_pending_idx" ON "billing_notices" USING btree ("send_after") WHERE "billing_notices"."sent_at" is null;--> statement-breakpoint
CREATE INDEX "checkout_intents_expires_idx" ON "checkout_intents" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "deposit_payments_appointment_idx" ON "deposit_payments" USING btree ("clinic_id","appointment_id");--> statement-breakpoint
CREATE INDEX "meta_inbound_messages_received_idx" ON "meta_inbound_messages" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "overage_invoices_window_idx" ON "overage_invoices" USING btree ("clinic_id","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_links_token_hash_idx" ON "sign_in_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_links_source_idx" ON "sign_in_links" USING btree ("purpose","source_ref") WHERE "sign_in_links"."source_ref" is not null;--> statement-breakpoint
CREATE INDEX "sign_in_links_user_idx" ON "sign_in_links" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "stripe_connect_events_attention_idx" ON "stripe_connect_events" USING btree ("outcome","received_at") WHERE "stripe_connect_events"."outcome" in ('failed', 'dead_letter');--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_source_idx" ON "usage_events" USING btree ("clinic_id","meter","source","source_ref");--> statement-breakpoint
CREATE INDEX "usage_events_window_idx" ON "usage_events" USING btree ("clinic_id","window_start");--> statement-breakpoint
CREATE INDEX "usage_events_unreported_idx" ON "usage_events" USING btree ("clinic_id","occurred_at") WHERE "usage_events"."over_allowance" > 0 and "usage_events"."stripe_reported_at" is null;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_billing_clinic_id_clinics_id_fk" FOREIGN KEY ("billing_clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinics_billing_clinic_idx" ON "clinics" USING btree ("billing_clinic_id") WHERE "clinics"."billing_clinic_id" is not null;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_billing_clinic_not_self" CHECK ("clinics"."billing_clinic_id" is null or "clinics"."billing_clinic_id" <> "clinics"."id");--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_locations_check" CHECK ("entitlements"."locations" >= 1);--> statement-breakpoint

-- =============================================================================
-- The Stripe launch (design of 5 October 2026). Everything above this line was
-- generated from schema.ts; everything below is the part drizzle cannot
-- express: row-level security, grants, triggers, the definer functions, the
-- console projection, the job seeds and the comments.
--
-- What this migration adds, in one paragraph. A purchase is stored before
-- Stripe Checkout (checkout_intents) so Stripe carries an opaque ref and
-- nothing else; clinic staff get in through single-use links (sign_in_links);
-- per-clinic switches live in clinic_settings; every billed call or chat
-- conversation is a usage_events row, counted against the BILLING clinic's
-- pooled allowance, with chat_threads deciding when a conversation starts and
-- meta_inbound_messages making a Meta redelivery a no-op; billing emails go
-- through an outbox (billing_notices); annual overage is invoiced per closed
-- month (overage_invoices); deposits are links on the clinic's own connected
-- Stripe account (deposit_payments), with their Connect webhook ledger
-- (stripe_connect_events) and single-use OAuth state (stripe_connect_states).
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on each new table by the time these statements run.
-- Every REVOKE below is therefore required, not defensive, and each GRANT
-- restates the intended set so it can be read in one place.
--
-- Safe to run: every new table is empty, every new column has a default or is
-- nullable, and apps/app has only ever held synthetic and seed data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant tables: ENABLE + FORCE row-level security, one isolation policy each.
-- FORCE because the migrator owns the tables and an owner bypasses policies
-- otherwise; tests/rls-drift.test.ts asks the catalogue for every table with a
-- clinic_id and fails on any that is not both.
-- -----------------------------------------------------------------------------
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_settings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_settings_tenant_isolation ON clinic_settings
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY usage_events_tenant_isolation ON usage_events
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_threads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY chat_threads_tenant_isolation ON chat_threads
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE meta_inbound_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meta_inbound_messages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY meta_inbound_messages_tenant_isolation ON meta_inbound_messages
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE billing_notices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_notices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY billing_notices_tenant_isolation ON billing_notices
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE overage_invoices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE overage_invoices FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY overage_invoices_tenant_isolation ON overage_invoices
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE deposit_payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE deposit_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY deposit_payments_tenant_isolation ON deposit_payments
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The BAA gate on deposit_payments: a row is tied to an appointment, so it is
-- patient-adjacent and must not be written for a production clinic without a
-- signed agreement. tests/database-audit.test.ts pins the exact list.
-- -----------------------------------------------------------------------------
CREATE TRIGGER deposit_payments_baa_gate
  BEFORE INSERT OR UPDATE ON deposit_payments
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants, table by table.
-- -----------------------------------------------------------------------------

-- checkout_intents: the full set. The billing-housekeeping job purges expired
-- and long-consumed intents, which is why DELETE stays.
GRANT SELECT, INSERT, UPDATE, DELETE ON checkout_intents TO healdesk_app;--> statement-breakpoint

-- sign_in_links: append-then-consume, the connection_links rules (0024). No
-- DELETE, so a redeemed link cannot be erased; UPDATE of the two consumption
-- columns only, so a link cannot be re-pointed at another user, re-armed or
-- given a longer life.
REVOKE DELETE ON sign_in_links FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON sign_in_links FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (used_at, consumed_ip) ON sign_in_links TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON sign_in_links TO healdesk_app;--> statement-breakpoint

-- clinic_settings: upserted, never deleted (a missing row means defaults, and
-- a deleted row would silently switch a clinic back to them).
GRANT SELECT, INSERT, UPDATE ON clinic_settings TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON clinic_settings FROM healdesk_app;--> statement-breakpoint

-- usage_events: the ledger overage is billed from. Append-only apart from the
-- three columns the Stripe reporter writes back.
REVOKE DELETE ON usage_events FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON usage_events FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (stripe_reported_at, stripe_report_attempts, stripe_report_error) ON usage_events TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON usage_events TO healdesk_app;--> statement-breakpoint

-- chat_threads: working state, the full set.
GRANT SELECT, INSERT, UPDATE, DELETE ON chat_threads TO healdesk_app;--> statement-breakpoint

-- meta_inbound_messages: inserted once, purged after 7 days, never changed.
REVOKE UPDATE ON meta_inbound_messages FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON meta_inbound_messages TO healdesk_app;--> statement-breakpoint

-- billing_notices: an outbox. The notice itself (kind, dedupe key, payload)
-- is fixed at insert; only the delivery columns move. No DELETE, so "did we
-- tell them" always has an answer.
REVOKE DELETE ON billing_notices FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON billing_notices FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (send_after, sent_at, attempts, last_error, recipients_count) ON billing_notices TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON billing_notices TO healdesk_app;--> statement-breakpoint

-- overage_invoices, deposit_payments, stripe_connect_events: money records and
-- their ledger. Updated as they progress, never deleted.
GRANT SELECT, INSERT, UPDATE ON overage_invoices TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON overage_invoices FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON deposit_payments TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON deposit_payments FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON stripe_connect_events TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON stripe_connect_events FROM healdesk_app;--> statement-breakpoint

-- stripe_connect_states: short-lived and single-use; housekeeping deletes
-- states older than a day.
GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_connect_states TO healdesk_app;--> statement-breakpoint

-- The two new clinics columns, by name (0031: a new clinics column is not
-- updatable until it is granted; tests/database-audit.test.ts asserts it).
GRANT UPDATE (billing_clinic_id, stripe_connect_disconnected_at) ON clinics TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- sign_in_links: once consumed, frozen. Copied from
-- app_connection_link_no_rewrite (0024). The column grant above already stops
-- the runtime role touching anything but used_at and consumed_ip; this stops
-- it rewriting those two on a link that has been spent, so a consumed link
-- cannot be re-armed by clearing used_at and its redemption record cannot be
-- edited after the fact.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_sign_in_link_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.used_at IS NOT NULL THEN
    RAISE EXCEPTION
      'sign_in_links row is already consumed and cannot be modified'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.redirect_to IS DISTINCT FROM OLD.redirect_to
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
  THEN
    RAISE EXCEPTION
      'sign_in_links is append-then-consume: only used_at and consumed_ip may change'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sign_in_links_no_rewrite
  BEFORE UPDATE ON sign_in_links
  FOR EACH ROW
  EXECUTE FUNCTION app_sign_in_link_no_rewrite();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_user_clinic_grants: which clinics a signed-in user may open, and as what.
-- -----------------------------------------------------------------------------
-- The tenant walk of 0034 (app_active_connections). clinic_memberships FORCEs
-- row-level security, which binds the function's owner too, so a plain
-- definer SELECT returns nothing; the walk sets the tenant per clinic, exactly
-- as withTenant() does, and restores the caller's setting before returning.
-- The loop is limited to clinics in the user's own organisations (through
-- Better Auth's `member`), so every grant needs a member row as well:
-- provisioning and invitations write both. The projection is the whole
-- surface: clinic id, slug, name, role and last seen. Revoked grants never
-- appear.
CREATE OR REPLACE FUNCTION app_user_clinic_grants(target_user text)
RETURNS TABLE (clinic_id uuid, slug text, name text, role clinic_role, last_seen_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN
    SELECT cl.id, cl.slug, cl.name
      FROM clinics cl
     WHERE cl.organization_id IN (SELECT m.organization_id FROM member m WHERE m.user_id = target_user)
     ORDER BY cl.created_at
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT cm.clinic_id, c.slug, c.name, cm.role, cm.last_seen_at
        FROM clinic_memberships cm
       WHERE cm.clinic_id = c.id
         AND cm.user_id = target_user
         AND cm.revoked_at IS NULL;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_user_clinic_grants(text) IS
  'The clinic portal''s grant list for one user: active clinic_memberships rows in the user''s own organisations, as (clinic id, slug, name, role, last seen). A tenant walk because clinic_memberships FORCEs RLS; restores app.clinic_id before returning. No patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_clinic_grants(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_clinic_grants(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_clinics_for_stripe_account: which clinic(s) a Connect event belongs to.
-- -----------------------------------------------------------------------------
-- The Connect webhook arrives with an account id and no tenant. clinics
-- enables RLS but does not FORCE it, so a definer SELECT (running as the
-- owner) sees every clinic; the runtime role alone would see none. Ids only.
CREATE OR REPLACE FUNCTION app_clinics_for_stripe_account(acct text)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id FROM clinics c WHERE c.stripe_connect_account_id = acct ORDER BY c.created_at
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_for_stripe_account(text) IS
  'Clinic ids whose stored Stripe Connect account is the given acct_ id. For the Connect webhook, which has no tenant until this answers. Ids only.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_for_stripe_account(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_for_stripe_account(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_location_clinics: a billing clinic and every location billed on it.
-- -----------------------------------------------------------------------------
-- Same reasoning as above: from inside one tenant the runtime role cannot see
-- the sibling clinics, and usage, alerts and the Billing screen need the whole
-- set. The billing clinic comes first, then its locations oldest first. Ids
-- only; nothing is returned for an id that is not a clinic.
CREATE OR REPLACE FUNCTION app_location_clinics(billing_clinic uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id
    FROM clinics c
   WHERE c.id = billing_clinic OR c.billing_clinic_id = billing_clinic
   ORDER BY (c.id <> billing_clinic), c.created_at
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_location_clinics(uuid) IS
  'The billing clinic plus every clinic whose billing_clinic_id points at it, billing clinic first. Ids only.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_location_clinics(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_location_clinics(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The console projection, with the two new clinic columns
-- -----------------------------------------------------------------------------
-- A return type cannot change under CREATE OR REPLACE, so drop and recreate,
-- exactly as 0041 did.
DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, synthflow_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz,
  published_phone_e164 text, forwarding_test_until timestamptz, forwarding_test_observed jsonb,
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz,
  meta_front_door_enabled boolean,
  booking_mode text, direct_booking_elected_at timestamptz, direct_booking_withdrawn_at timestamptz,
  timezone_confirmed_at timestamptz,
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text,
  billing_clinic_id uuid, stripe_connect_disconnected_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone, c.specialty, c.plan,
         c.attribution_mode, c.data_classification,
         c.is_covered_entity, c.baa_signed_at, c.created_at,
         c.phone_system_type, c.call_routing, c.call_routing_confirmed_at,
         c.carrier, c.synthflow_number_e164,
         (c.opening_hours IS NOT NULL) AS opening_hours_present,
         c.onboarding, c.agent_approved_at, c.went_live_at,
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at,
         c.published_phone_e164, c.forwarding_test_until, c.forwarding_test_observed,
         c.stripe_connect_account_id, c.stripe_connect_connected_at,
         c.meta_front_door_enabled,
         c.booking_mode, c.direct_booking_elected_at, c.direct_booking_withdrawn_at,
         c.timezone_confirmed_at,
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source,
         c.billing_clinic_id, c.stripe_connect_disconnected_at
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding, booking-mode and billing-location state only — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The five billing jobs, seeded OFF like every job but the heartbeat. An
-- operator switches each on from the console once there are real tenants.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('usage-meter-report', 'Hourly; reports overage on monthly plans to Stripe''s meters', false),
  ('annual-overage-invoice', 'Daily at 05 UTC; invoices annual plans'' overage per closed month', false),
  ('usage-alerts', 'Hourly; queues the 80% and 100% allowance emails', false),
  ('billing-notices', 'Hourly backstop; sends queued billing emails to owners and billing contacts', false),
  ('billing-housekeeping', 'Daily at 06 UTC; purges expired checkout intents and Meta message refs', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE checkout_intents IS
  'Business contact data of a clinic buyer (name, work email, clinic name and the package chosen), held from just before Stripe Checkout until provisioning. Not PHI. Stripe carries only the opaque ref. Purged when expired and unconsumed, or 90 days after consumption.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.provisioned_clinic_id IS
  'A stored result, deliberately not called clinic_id: the RLS drift test demands a policy on every column by that name, and this table has no tenant.';--> statement-breakpoint
COMMENT ON TABLE sign_in_links IS
  'Single-use sign-in links for the clinic portal (checkout handoff, welcome email, sign-in, invitation). Stores SHA-256(token), never the token. Append-then-consume: no DELETE, UPDATE of used_at and consumed_ip only, and frozen once used (app_sign_in_link_no_rewrite).';--> statement-breakpoint
COMMENT ON TABLE clinic_settings IS
  'Per-clinic switches the portal edits: deposits, Pause AI and the direct line every fallback forwards to. A missing row means the defaults. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.direct_line_e164 IS
  'A clinic line that does not forward back to us, E.164. Must differ from the published number and the Synthflow number (enforced in lib/billing/settings.ts), or a fallback would loop.';--> statement-breakpoint
COMMENT ON TABLE usage_events IS
  'The usage ledger: one row per billed call (minutes, rounded up per call) or chat conversation, against the BILLING clinic''s pooled allowance. source_ref is a sha256 hex, never a vendor id. Append-only apart from the Stripe reporting columns.';--> statement-breakpoint
COMMENT ON TABLE chat_threads IS
  'One person''s thread on one channel, for counting chat conversations: a new conversation starts after 24 hours without a message from them. party_ref is a sha256 hex of the platform sender id; no message content.';--> statement-breakpoint
COMMENT ON TABLE meta_inbound_messages IS
  'Meta message ids already handled (sha256 hex), so a redelivered webhook is skipped entirely. Purged after 7 days.';--> statement-breakpoint
COMMENT ON TABLE billing_notices IS
  'Billing-email outbox, sent to the owners and billing contacts of the billing clinic. payload carries no PHI: amounts in cents, ISO dates, Stripe-hosted invoice URLs, plan ids, meter names, location counts.';--> statement-breakpoint
COMMENT ON TABLE overage_invoices IS
  'Annual plans only: one row per closed allowance month, recording the overage invoiced (or skipped at zero) for it.';--> statement-breakpoint
COMMENT ON TABLE deposit_payments IS
  'Deposit links on the clinic''s own connected Stripe account. id is the opaque reference Stripe sees; no treatment name or patient detail is ever sent. Carries the BAA gate.';--> statement-breakpoint
COMMENT ON TABLE stripe_connect_events IS
  'Dedupe and dead-letter ledger for the Stripe Connect webhook. Deliberately no payload: Connect events on a clinic''s account carry its payers'' details.';--> statement-breakpoint
COMMENT ON TABLE stripe_connect_states IS
  'Single-use Stripe Connect OAuth state, stored as SHA-256. target_clinic_id is not called clinic_id because the callback must read the row before any tenant is known.';--> statement-breakpoint
COMMENT ON COLUMN clinics.billing_clinic_id IS
  'The clinic holding the subscription this location is billed on. NULL: the clinic is its own billing clinic.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.locations IS
  'Locations on the subscription (the package item quantity). Included allowances are per location; the pooled allowance is included × locations.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'usage_events'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'billing_notices'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'sign_in_links'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'deposit_payments'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from a ledger 0043 made append-only.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'usage_events'::regclass, 'quantity', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'usage_events'::regclass, 'over_allowance', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'billing_notices'::regclass, 'payload', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'sign_in_links'::regclass, 'token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'sign_in_links'::regclass, 'expires_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'sign_in_links'::regclass, 'user_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a column 0043 froze.';
  END IF;
END;
$$;

CREATE TABLE "billing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel_key" text DEFAULT '-' NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"done_at" timestamp with time zone,
	"outcome" text,
	"outcome_reason" text,
	CONSTRAINT "billing_requests_kind_check" CHECK ("billing_requests"."kind" in ('plan_start', 'step_up', 'close_setup', 'cancel_now')),
	CONSTRAINT "billing_requests_channel_check" CHECK ("billing_requests"."channel_key" = '-' or "billing_requests"."channel_key" in ('web', 'meta', 'voice')),
	CONSTRAINT "billing_requests_step_up_channel_check" CHECK (("billing_requests"."kind" = 'step_up') = ("billing_requests"."channel_key" <> '-')),
	CONSTRAINT "billing_requests_reason_check" CHECK ("billing_requests"."reason" in ('first_answer', 'waiting', 'deadline', 'ops', 'reconcile')),
	CONSTRAINT "billing_requests_attempts_check" CHECK ("billing_requests"."attempts" >= 0),
	CONSTRAINT "billing_requests_last_error_check" CHECK ("billing_requests"."last_error" is null or char_length("billing_requests"."last_error") <= 300),
	CONSTRAINT "billing_requests_outcome_check" CHECK ("billing_requests"."outcome" is null or "billing_requests"."outcome" in ('done', 'skipped', 'dead_letter')),
	CONSTRAINT "billing_requests_done_check" CHECK (("billing_requests"."done_at" is null) = ("billing_requests"."outcome" is null)),
	CONSTRAINT "billing_requests_outcome_reason_check" CHECK ("billing_requests"."outcome_reason" is null or "billing_requests"."outcome_reason" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "stripe_connect_states" DROP CONSTRAINT "stripe_connect_states_return_check";--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "plan_start_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "first_plan_invoice_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "stripe_mutation_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "stripe_mutation_lease_owner" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_location_request_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_location_count" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "pending_location_charged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "open_invoice_amount_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_requests" ADD CONSTRAINT "billing_requests_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_requests_key_idx" ON "billing_requests" USING btree ("clinic_id","kind","channel_key");--> statement-breakpoint
CREATE INDEX "billing_requests_due_idx" ON "billing_requests" USING btree ("next_attempt_at") WHERE "billing_requests"."done_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_payments_open_appointment_idx" ON "deposit_payments" USING btree ("clinic_id","appointment_id") WHERE "deposit_payments"."status" in ('creating', 'open') and "deposit_payments"."appointment_id" is not null;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_stripe_mutation_lease_check" CHECK (("entitlements"."stripe_mutation_lease_until" is null) = ("entitlements"."stripe_mutation_lease_owner" is null) and ("entitlements"."stripe_mutation_lease_owner" is null or char_length("entitlements"."stripe_mutation_lease_owner") between 1 and 120));--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_pending_location_check" CHECK (("entitlements"."pending_location_request_id" is null) = ("entitlements"."pending_location_count" is null) and ("entitlements"."pending_location_charged_at" is null or "entitlements"."pending_location_request_id" is not null) and ("entitlements"."pending_location_count" is null or "entitlements"."pending_location_count" >= 2) and ("entitlements"."pending_location_request_id" is null or "entitlements"."pending_location_request_id" ~ '^[A-Za-z0-9_-]{1,64}$'));--> statement-breakpoint
ALTER TABLE "stripe_connect_states" ADD CONSTRAINT "stripe_connect_states_return_check" CHECK ("stripe_connect_states"."return_to" in ('settings', 'setup', 'ops'));--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "setup_fee_refunded_at";--> statement-breakpoint
ALTER TABLE "entitlements" DROP COLUMN "setup_fee_refunded_usd";--> statement-breakpoint

-- =============================================================================
-- The Stripe build: packages B, C and D (build spec of 6 October 2026, S0).
-- Everything above this line was generated from schema.ts; everything below is
-- the part drizzle cannot express: row-level security, grants, the three
-- definer functions, the job seeds, the comments and the audit at the end.
--
-- What this migration adds, in one paragraph. billing_requests is the ledger
-- of what the engine has asked Stripe to do (start the plan, add a channel's
-- price, close an unfinished setup, cancel at once after a refund), recorded
-- in the transaction of the event that asked and carried out afterwards by a
-- worker outside any transaction; app_record_billing_request writes it on the
-- caller's BILLING clinic, so a location's transaction can record one, and
-- app_due_billing_requests lets the worker find due rows across clinics.
-- entitlements gains the plan-start stamp the worker writes, the first plan
-- invoice, a lease that lets one Stripe mutation of a subscription run at a
-- time, the state of an extra location being added and the open invoice's
-- amount; it loses the setup-fee refund columns, because the setup fee is
-- never refundable.
-- deposit_payments allows one live link per appointment, and
-- app_clinic_for_deposit finds a deposit's clinic for the Connect webhook.
-- stripe_connect_states returns to the portal's Settings, the setup wizard or
-- the operator's neutral page. Four jobs are seeded, all off.
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on billing_requests by the time these statements run.
-- Every REVOKE below is therefore required, not defensive, and each GRANT
-- restates the intended set so it can be read in one place.
--
-- Safe to run: billing_requests is new and empty; every new entitlements
-- column is nullable; nothing has ever written the two dropped columns (the
-- setup-fee refund was never built); nothing has ever minted a
-- stripe_connect_states row (Package D is its first writer), so no row holds
-- the old 'portal'; and nothing has ever created a deposit_payments row, so
-- the new unique index has nothing to collide with. apps/app has only ever
-- held synthetic and seed data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- billing_requests: ENABLE + FORCE row-level security and one isolation
-- policy, exactly as 0043. FORCE matters twice here: the migrator owns the
-- table, and the definers below run as the migrator, so without it they would
-- see every clinic's rows without declaring a tenant.
-- -----------------------------------------------------------------------------
ALTER TABLE billing_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE billing_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY billing_requests_tenant_isolation ON billing_requests
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- billing_requests: billing evidence, kept through offboarding. No DELETE, so
-- "did we ask Stripe to start this plan" always has an answer. UPDATE of the
-- worker's columns only: a request cannot be moved to another clinic, turned
-- into another kind or channel, or back-dated. `reason` moves because a
-- re-armed request records why it was re-armed.
REVOKE UPDATE, DELETE ON billing_requests FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON billing_requests TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (next_attempt_at, lease_until, attempts, last_error, done_at, outcome, outcome_reason, reason) ON billing_requests TO healdesk_app;--> statement-breakpoint

-- The eight entitlements columns need no GRANT: entitlements gives
-- healdesk_app table-level UPDATE (0028), which covers a column added later
-- exactly as it covers plan_code. Each is written after insert by a runtime
-- path (the plan-start worker, invoice.paid and payment_failed, the Stripe
-- mutation lease, the extra-location action), and the audit below pins that
-- they stay writable.

-- -----------------------------------------------------------------------------
-- app_record_billing_request: record a billing request on the caller's
-- billing clinic.
-- -----------------------------------------------------------------------------
-- The engine records a plan start or a step-up from inside the transaction
-- that records a channel's first answer, and that transaction is open on the
-- LOCATION, while the request belongs to the billing clinic that holds the
-- subscription. Opening a second transaction there would give up the
-- atomicity the ledger exists for, and nesting one would hold two pooled
-- connections. So the caller's own tenant names the clinic, this function
-- resolves its billing clinic, switches the tenant to it for the one INSERT
-- (billing_requests FORCEs RLS, which binds the owner too) and switches it
-- back, also on the way out of an error. It takes no clinic parameter, so a
-- tenant can only ever write into its own billing group. Returns whether a
-- row was inserted: one request per (clinic, kind, channel), and a repeat is
-- a no-op.
CREATE OR REPLACE FUNCTION app_record_billing_request(p_kind text, p_channel_key text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  caller uuid := NULLIF(previous, '')::uuid;
  billing uuid;
  inserted integer := 0;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'app_record_billing_request runs inside a tenant: app.clinic_id is not set'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(c.billing_clinic_id, c.id) INTO billing FROM clinics c WHERE c.id = caller;
  IF billing IS NULL THEN
    RAISE EXCEPTION 'app_record_billing_request: no clinic % for the tenant', caller
      USING ERRCODE = '23503';
  END IF;

  BEGIN
    PERFORM set_config('app.clinic_id', billing::text, true);
    INSERT INTO billing_requests (clinic_id, kind, channel_key, reason)
    VALUES (billing, p_kind, p_channel_key, p_reason)
    ON CONFLICT (clinic_id, kind, channel_key) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;

  RETURN inserted > 0;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_record_billing_request(text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_record_billing_request(text, text, text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_due_billing_requests: the requests due now, across billing clinics.
-- -----------------------------------------------------------------------------
-- The tenant walk of 0034 (app_active_connections), over billing clinics
-- only, because that is where every request lives. A row is due when it is
-- unfinished, its next attempt has come, no worker's lease on it is still
-- running and its kind is one the caller asked for (the drainer leaves
-- close_setup out while the setup-closure switch is off). The walk collects
-- each clinic's due rows under that clinic's tenant, restores the caller's
-- setting, also on the way out of an error, and only then sorts the whole set
-- by next attempt and cuts it to `max`, so the earliest work goes first
-- whichever clinic it belongs to. Ids, kinds and the due time only.
CREATE OR REPLACE FUNCTION app_due_billing_requests(p_at timestamptz, p_max integer, p_kinds text[])
RETURNS TABLE (clinic_id uuid, id uuid, kind text, next_attempt_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  lim integer := greatest(least(coalesce(p_max, 0), 500), 0);
  due billing_requests[] := ARRAY[]::billing_requests[];
  c record;
BEGIN
  BEGIN
    FOR c IN SELECT cl.id FROM clinics cl WHERE cl.billing_clinic_id IS NULL ORDER BY cl.created_at LOOP
      PERFORM set_config('app.clinic_id', c.id::text, true);
      due := due || ARRAY(
        SELECT r
          FROM billing_requests r
         WHERE r.clinic_id = c.id
           AND r.done_at IS NULL
           AND r.next_attempt_at <= p_at
           AND (r.lease_until IS NULL OR r.lease_until < p_at)
           AND r.kind = ANY (p_kinds)
         ORDER BY r.next_attempt_at
         LIMIT lim);
    END LOOP;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;

  RETURN QUERY
    SELECT d.clinic_id, d.id, d.kind, d.next_attempt_at
      FROM unnest(due) AS d
     ORDER BY d.next_attempt_at, d.requested_at
     LIMIT lim;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_due_billing_requests(timestamptz, integer, text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_due_billing_requests(timestamptz, integer, text[]) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_clinic_for_deposit: which clinic a deposit belongs to.
-- -----------------------------------------------------------------------------
-- The Connect webhook arrives with the deposit's id (the opaque
-- client_reference_id Stripe carries) and no tenant. deposit_payments FORCEs
-- row-level security, so this walks every clinic, locations included (a
-- deposit belongs to the clinic where the booking was made), sets the tenant,
-- looks for the id, stops at the first match and restores the caller's
-- setting, also on the way out of an error. The webhook then opens that
-- tenant and checks the row's account against the event's before it records
-- anything. The clinic id only, or null.
CREATE OR REPLACE FUNCTION app_clinic_for_deposit(p_ref uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  found uuid;
  c record;
BEGIN
  IF p_ref IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
      PERFORM set_config('app.clinic_id', c.id::text, true);
      SELECT d.clinic_id INTO found FROM deposit_payments d WHERE d.id = p_ref;
      EXIT WHEN found IS NOT NULL;
    END LOOP;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;
  RETURN found;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_for_deposit(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_for_deposit(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The four jobs, seeded OFF like every job but the heartbeat. Owners and the
-- point each is switched on (the build spec's job table, R36):
--   billing-requests   Package C-actions. Gate A: on before the first
--                      clinic's setup deadline (its purchase + 30 days).
--   billing-reconcile  Package C-actions. Gate A, with billing-requests.
--   setup-closure      Package C-actions. Gate A, last: it is the switch that
--                      lets the worker close accounts, which cannot be undone.
--   card-expiring      Package C-actions. Before the first plan start.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('billing-requests', 'Every minute from the billing-minute queue, and hourly from the tick as a backstop; carries out recorded plan starts, step-ups and immediate cancellations on Stripe, and setup closures while setup-closure is on', false),
  ('setup-closure', 'A switch, not a schedule: while on, the billing-requests worker closes accounts left with nothing live at the end of their 30-day setup window', false),
  ('billing-reconcile', 'Hourly; records any plan start, step-up or setup closure that is due but missing, steps up waiting channels after 30 days with a reminder a week before, and re-arms requests that can now go through', false),
  ('card-expiring', 'Daily at 07 UTC; queues the card-expiring email when the card on file expires before a renewal due within 30 days', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE billing_requests IS
  'What the engine asked Stripe to do (plan_start, step_up, close_setup, cancel_now), recorded on the BILLING clinic in the transaction of the event that asked and carried out by a worker outside any transaction. One row per (clinic, kind, channel); a finished row is re-armed, never inserted again. Billing evidence: no DELETE for the runtime role, kept through offboarding. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN billing_requests.lease_until IS
  'While in the future, a worker holds the row: the claim is a conditional UPDATE that sets this and counts the attempt.';--> statement-breakpoint
COMMENT ON COLUMN billing_requests.last_error IS
  'A closed code and a short reason, at most 300 characters. Never a Stripe payload or an exception''s text.';--> statement-breakpoint
COMMENT ON COLUMN billing_requests.outcome_reason IS
  'Why a finished request ended as it did, as a snake_case code: already_started, cancel_pending, live_channel, no_change, plan_never_started.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.plan_start_applied_at IS
  'When the plan-start worker''s Stripe update went through. The plan has started once this or plan_started_at is set.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.first_plan_invoice_id IS
  'The first plan invoice''s Stripe id, stamped when it is paid. The refunds read its package line.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.stripe_mutation_lease_until IS
  'One Stripe mutation of the subscription at a time: set with stripe_mutation_lease_owner by a conditional UPDATE, cleared by the holder once its outcome is written, and taken over by anyone once it has passed.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.stripe_mutation_lease_owner IS
  'Which worker attempt or action holds the lease: an opaque label such as billing_request:<id>:<attempt>. Never a person.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.pending_location_request_id IS
  'The extra-location request in progress, set before Stripe is charged and cleared once the location''s clinic exists, so a failure after the charge is resumed rather than charged again.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.pending_location_count IS
  'The location count the pending request makes: the current count plus one.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.pending_location_charged_at IS
  'When Stripe charged for the pending location. Set: do not charge again, only finish creating it.';--> statement-breakpoint
COMMENT ON COLUMN entitlements.open_invoice_amount_cents IS
  'What the open invoice asks for, in cents, beside open_invoice_id and open_invoice_url, so the Billing screen can show it without calling Stripe.';--> statement-breakpoint
COMMENT ON INDEX deposit_payments_open_appointment_idx IS
  'One live deposit link per appointment: a second request gets the open session back instead of a second link the patient could also pay.';--> statement-breakpoint
COMMENT ON COLUMN stripe_connect_states.return_to IS
  'Where the callback sends the browser: settings (the portal), setup (the wizard) or ops (a neutral done page for an operator''s link). Never /admin.';--> statement-breakpoint
COMMENT ON FUNCTION app_record_billing_request(text, text, text) IS
  'Records a billing request on the billing clinic of the caller''s own tenant (app.clinic_id): resolves it, switches the tenant for the one INSERT and switches it back, also on error. ON CONFLICT DO NOTHING; returns whether a row was inserted. Takes no clinic parameter, so a tenant writes only into its own billing group.';--> statement-breakpoint
COMMENT ON FUNCTION app_due_billing_requests(timestamptz, integer, text[]) IS
  'Unfinished, unleased billing_requests rows of the given kinds whose next attempt has come, across billing clinics, as (clinic id, request id, kind, next attempt), earliest first, at most max. A tenant walk because billing_requests FORCEs RLS; restores app.clinic_id before returning.';--> statement-breakpoint
COMMENT ON FUNCTION app_clinic_for_deposit(uuid) IS
  'The clinic a deposit_payments row belongs to, or null, for the Connect webhook, which has no tenant until this answers. A tenant walk because deposit_payments FORCEs RLS; restores app.clinic_id before returning. The id only.';--> statement-breakpoint
-- Three 0043 comments said a plain sha256 hex: a WhatsApp sender id is a phone
-- number, and an unkeyed hash of one can be reversed by enumerating numbers,
-- so these references are now identifierRef() HMACs (lib/identifier-ref.ts).
COMMENT ON TABLE usage_events IS
  'The usage ledger: one row per billed call (minutes, rounded up per call) or chat conversation, against the BILLING clinic''s pooled allowance. source_ref is an identifierRef() HMAC (v1:<hex>), never a vendor id. Append-only apart from the Stripe reporting columns.';--> statement-breakpoint
COMMENT ON TABLE chat_threads IS
  'One person''s thread on one channel, for counting chat conversations: a new conversation starts after 24 hours without a message from them. party_ref is an identifierRef() HMAC of the platform sender id, never the id; no message content.';--> statement-breakpoint
COMMENT ON TABLE meta_inbound_messages IS
  'Meta message ids already handled, as identifierRef() HMACs, so a redelivered webhook is skipped entirely. Purged after 7 days.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from billing_requests, which 0050 made undeletable.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'kind', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'channel_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'requested_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a billing_requests column 0050 froze.';
  END IF;
  IF NOT (has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'next_attempt_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'lease_until', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'attempts', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'last_error', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'done_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'outcome', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'outcome_reason', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'billing_requests'::regclass, 'reason', 'UPDATE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot UPDATE a billing_requests column the worker writes.';
  END IF;
  IF NOT (has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'plan_start_applied_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'first_plan_invoice_id', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'stripe_mutation_lease_until', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'stripe_mutation_lease_owner', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'pending_location_request_id', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'pending_location_count', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'pending_location_charged_at', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'entitlements'::regclass, 'open_invoice_amount_cents', 'UPDATE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot UPDATE an entitlements column 0050 added for a runtime writer.';
  END IF;
  IF has_function_privilege('public', 'app_record_billing_request(text, text, text)', 'EXECUTE')
     OR has_function_privilege('public', 'app_due_billing_requests(timestamptz, integer, text[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_clinic_for_deposit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute a definer 0050 added.';
  END IF;
  IF NOT (has_function_privilege('healdesk_app', 'app_record_billing_request(text, text, text)', 'EXECUTE')
          AND has_function_privilege('healdesk_app', 'app_due_billing_requests(timestamptz, integer, text[])', 'EXECUTE')
          AND has_function_privilege('healdesk_app', 'app_clinic_for_deposit(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot execute a definer 0050 added for it.';
  END IF;
END;
$$;

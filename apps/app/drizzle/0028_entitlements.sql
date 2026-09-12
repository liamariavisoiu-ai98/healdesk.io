-- =============================================================================
-- Entitlements: what each clinic is entitled to, and the ledger of how its
-- billing status got there.
--
-- Until now the only record of a purchase was `clinics.plan`, a text column
-- written once at provisioning and never read by anything that decided what
-- the clinic could use. Nothing knew whether a renewal had been paid, whether
-- a card had failed, or how many of the included minutes were gone. The
-- lifecycle webhook (lib/billing/events.ts) needs somewhere to write those
-- answers, and the agent needs somewhere to read them.
--
-- Two tables and one function:
--
--   entitlements          one row per clinic: plan, interval, status, period,
--                         channels, allowances, usage, setup fee paid
--   billing_transitions   append-only: every status change, who made it, why,
--                         and which Stripe event caused it
--   app_clinic_for_stripe a definer function that turns Stripe ids into a
--                         clinic id, for the one caller that has no tenant yet
--
-- Both tables carry a clinic_id, so both are RLS'd and FORCEd exactly like the
-- PHI tables; tests/rls-drift.test.ts would fail otherwise. Neither holds PHI,
-- but the isolation matters just as much: a webhook that updated the wrong
-- clinic's status would suspend a paying customer.
-- =============================================================================

CREATE TYPE "billing_status" AS ENUM (
  'demo',
  'provisioning',
  'active',
  'past_due',
  'suspended',
  'paused',
  'canceling',
  'canceled',
  'purged'
);--> statement-breakpoint

CREATE TABLE "entitlements" (
  -- Keyed on the clinic, not on a Stripe id: a clinic can exist without
  -- Stripe (a demo, the no-Stripe dev path) but a subscription cannot exist
  -- without a clinic. CASCADE so a deleted clinic does not strand a row that
  -- would otherwise keep answering a webhook for a tenant that is gone.
  "clinic_id" uuid PRIMARY KEY REFERENCES "clinics"("id") ON DELETE CASCADE,

  "stripe_customer_id" text,
  "stripe_subscription_id" text,

  "plan_code" text NOT NULL,
  "billing_interval" text NOT NULL,
  "status" "billing_status" NOT NULL DEFAULT 'provisioning',

  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "grace_ends_at" timestamp with time zone,

  "channels_enabled" jsonb NOT NULL DEFAULT '{"web":false,"meta":false,"voice":false}'::jsonb,
  "chat_channel_choice" text,

  "included_voice_minutes" integer NOT NULL DEFAULT 0,
  "included_chat_conversations" integer NOT NULL DEFAULT 0,
  "used_voice_minutes" numeric(12, 2) NOT NULL DEFAULT 0,
  "used_chat_conversations" integer NOT NULL DEFAULT 0,

  "overage_mode" text NOT NULL DEFAULT 'allow',
  "number_release_at" timestamp with time zone,
  "setup_fee_paid_usd" numeric(12, 2) NOT NULL DEFAULT 0,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "entitlements_interval_check"
    CHECK ("billing_interval" IN ('month', 'year')),
  CONSTRAINT "entitlements_chat_choice_check"
    CHECK ("chat_channel_choice" IS NULL OR "chat_channel_choice" IN ('web', 'meta')),
  CONSTRAINT "entitlements_overage_mode_check"
    CHECK ("overage_mode" IN ('allow', 'hard_cap'))
);--> statement-breakpoint

-- Partial unique indexes: NULL is "no Stripe" and many clinics may say so, but
-- no two clinics may claim the same customer or subscription. Without the
-- WHERE, Postgres would allow it anyway (NULLs are distinct in a unique
-- index), so the partial form is documentation as much as constraint. These
-- are also the indexes app_clinic_for_stripe() below runs on.
CREATE UNIQUE INDEX "entitlements_stripe_customer_idx"
  ON "entitlements" USING btree ("stripe_customer_id")
  WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_stripe_subscription_idx"
  ON "entitlements" USING btree ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entitlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "entitlements_tenant_isolation" ON "entitlements"
  FOR ALL
  USING ("clinic_id" = app_current_clinic_id())
  WITH CHECK ("clinic_id" = app_current_clinic_id());
--> statement-breakpoint

-- 0003's ALTER DEFAULT PRIVILEGES has already handed the runtime role full DML
-- on this table, so the GRANT restates intent and the REVOKE does the work. A
-- clinic's billing life ends in status 'purged', never in a missing row: the
-- row is what says the data was destroyed on purpose.
GRANT SELECT, INSERT, UPDATE ON "entitlements" TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON "entitlements" FROM healdesk_app;--> statement-breakpoint

COMMENT ON TABLE "entitlements" IS
  'One row per clinic: plan, billing status, period, enabled channels, allowances and usage. Status is written only by lib/billing/state-machine.ts. No PHI.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- billing_transitions
-- ---------------------------------------------------------------------------

CREATE TABLE "billing_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "clinic_id" uuid NOT NULL REFERENCES "clinics"("id") ON DELETE CASCADE,

  -- NULL exactly once per clinic: the seed row written at provisioning, when
  -- there was no prior state to come from.
  "from_status" "billing_status",
  "to_status" "billing_status" NOT NULL,

  "actor" text NOT NULL,
  "reason" text NOT NULL,
  "stripe_event_id" text,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT "billing_transitions_actor_check"
    CHECK ("actor" IN ('system', 'client', 'support'))
);--> statement-breakpoint

CREATE INDEX "billing_transitions_clinic_idx"
  ON "billing_transitions" USING btree ("clinic_id", "created_at");--> statement-breakpoint

ALTER TABLE "billing_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_transitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_transitions_tenant_isolation" ON "billing_transitions"
  FOR ALL
  USING ("clinic_id" = app_current_clinic_id())
  WITH CHECK ("clinic_id" = app_current_clinic_id());
--> statement-breakpoint

-- Append-only, for the same reason audit_log is: "why was this clinic
-- suspended on the 3rd" has to be answerable from rows nothing could have
-- edited since. Enforced by grant rather than by convention.
GRANT SELECT, INSERT ON "billing_transitions" TO healdesk_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON "billing_transitions" FROM healdesk_app;--> statement-breakpoint

COMMENT ON TABLE "billing_transitions" IS
  'Append-only history of billing status changes: from, to, who, why, and the Stripe event that caused it.';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- app_clinic_for_stripe
--
-- A Stripe webhook arrives knowing a customer id and a subscription id and
-- nothing else. The clinic those belong to is in `entitlements`, and
-- `entitlements` is under RLS, which reads the tenant from a setting the
-- caller cannot set because the tenant is exactly what it is trying to find.
-- An INVOKER-rights lookup would therefore see zero rows for every event.
--
-- SECURITY DEFINER runs the lookup as the table owner — but that is NOT
-- enough on its own, and this is the part that differs from
-- app_clinic_accepts_phi() in 0001. That function reads `clinics`, which is
-- enabled but not forced, so its owner bypasses the policy. `entitlements` is
-- FORCEd like every tenant table, which is the whole point of FORCE: the owner
-- is subject to the policy too, and the definer function sees nothing.
--
-- So the lookup gets its own policy, and the policy is opened by a setting
-- that only this function turns on:
--
--   1. `app.stripe_lookup` is switched on with set_config(..., is_local)
--      as the first statement of the body and off again as the last, so it
--      is on for exactly the SELECT between them. It would be tidier as a
--      SET clause on the function, which Postgres restores on exit by
--      itself — but since Postgres 15 a SET clause naming a placeholder
--      setting needs superuser, and migrations deliberately do not run as
--      one. If the SELECT throws, the surrounding transaction is aborted and
--      the flag dies with it.
--   2. The policy is `TO healdesk_migrator`, the owner the function runs as.
--      Custom settings can be set by ANY role, so without the role scope the
--      runtime role could set the flag itself and read every clinic's row.
--      It cannot become the migrator.
--   3. FOR SELECT only, and only while no tenant is declared. The function
--      returns a single uuid, never a row, so nothing about the clinic leaks
--      to a caller that only holds Stripe ids. Called inside a tenant
--      transaction it simply sees that tenant's row, like any other query.
--
-- The helper exists because tests/rls-drift.test.ts forbids current_setting()
-- inline in a policy — the planner evaluates it per row unless it is hoisted
-- through a STABLE function. search_path is pinned for the usual reason.
--
-- Subscription first, then customer. A customer can hold more than one
-- subscription over time (cancel, buy again), so the subscription is the
-- precise answer and the customer is the fallback for events that carry no
-- subscription, such as a dispute on a charge.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_stripe_lookup_active()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.stripe_lookup', true) = 'on'
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_stripe_lookup_active() IS
  'True only while app_clinic_for_stripe() has app.stripe_lookup switched on around its lookup. Read by the entitlements_stripe_lookup policy.';
--> statement-breakpoint

CREATE POLICY "entitlements_stripe_lookup" ON "entitlements"
  FOR SELECT
  TO healdesk_migrator
  USING (app_current_clinic_id() IS NULL AND app_stripe_lookup_active());
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_clinic_for_stripe(customer_id text, subscription_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  found uuid;
BEGIN
  PERFORM set_config('app.stripe_lookup', 'on', true);

  SELECT clinic_id INTO found
    FROM (
      SELECT e.clinic_id, 1 AS priority
        FROM entitlements e
       WHERE subscription_id IS NOT NULL
         AND e.stripe_subscription_id = subscription_id
      UNION ALL
      SELECT e.clinic_id, 2 AS priority
        FROM entitlements e
       WHERE customer_id IS NOT NULL
         AND e.stripe_customer_id = customer_id
    ) matches
   ORDER BY priority
   LIMIT 1;

  PERFORM set_config('app.stripe_lookup', 'off', true);
  RETURN found;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_clinic_for_stripe(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_for_stripe(text, text) TO healdesk_app;
--> statement-breakpoint

COMMENT ON FUNCTION app_clinic_for_stripe(text, text) IS
  'Clinic for a Stripe customer/subscription pair, subscription first. SECURITY DEFINER plus the app.stripe_lookup setting switched on for the duration of the lookup, because the caller has no tenant yet and entitlements is FORCEd. Returns NULL when neither id is known.';

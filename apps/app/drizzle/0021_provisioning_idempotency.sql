-- =============================================================================
-- Make provisioning idempotent, so a Stripe webhook retry cannot double-charge
-- us an account.
--
-- Stripe retries a webhook delivery for up to three days on any non-2xx. Until
-- now a retry would create a SECOND organization, clinic and invitation: the
-- slug loop in provisioning.ts sees the unique-violation on the clinic slug,
-- generates `radiance-med-spa-a3f9c1`, and succeeds. Correct for two genuinely
-- different clinics that share a name — catastrophic for one clinic delivered
-- twice.
--
-- The fix is a ledger keyed on something stable across retries: the Stripe
-- Checkout Session id. Every delivery about one purchase carries the same
-- `cs_...`, where the event id `evt_...` differs per delivery and per event
-- type — so the event id dedupes DELIVERIES while this dedupes PURCHASES, which
-- is the thing we actually care about.
--
-- ## Why the claim is a row and not an application check
--
-- It is inserted as the FIRST statement inside the same transaction as the
-- organization, clinic and invitation. Postgres's unique index then provides
-- mutual exclusion between concurrent deliveries for free, and — because it is
-- the same transaction — a provision that fails halfway rolls the claim back
-- too. A claim in its own transaction, or a status/lease column, would leave a
-- committed claim with no account behind it: every later retry would see the
-- key taken, return success, and the customer who paid could never be
-- provisioned. Silently.
--
-- ## No foreign keys, deliberately
--
-- organization_id names a row that does not exist yet when the claim is
-- written. An FK would fire on every first-time provision. This is a ledger of
-- attempts, not a relationship, and it must outlive the rows it names.
-- =============================================================================

CREATE TABLE "provisioning_attempts" (
  "idempotency_key" text PRIMARY KEY,

  -- The result, pre-computed before the claim so a replay can return the same
  -- ids without reading rows that RLS would hide from it.
  "organization_id" text NOT NULL,
  -- NOT named clinic_id, deliberately. This is a stored RESULT, not a tenant
  -- discriminator, and the RLS drift test (correctly) demands a policy on every
  -- table carrying a clinic_id. Naming it that here would either force RLS onto
  -- an identity-plane table or force an exception into the guard — both worse
  -- than a precise column name.
  "provisioned_clinic_id" uuid NOT NULL,
  "clinic_slug" text NOT NULL,
  "invitation_id" uuid NOT NULL,

  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only, enforced by grant rather than by convention.
--
-- 0003_grants.sql sets ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE/
-- DELETE on every future migrator-created table, so those privileges have
-- ALREADY been applied to this table by the time this statement runs. The
-- REVOKE is therefore required, not defensive: a ledger the application can
-- rewrite cannot arbitrate anything.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON provisioning_attempts FROM healdesk_app;
--> statement-breakpoint

-- No RLS: this is identity-plane, like baa_acceptances and security_events.
-- It carries no clinic_id and a provision has no tenant context to be read in.
COMMENT ON TABLE provisioning_attempts IS
  'Idempotency ledger for provisionClinic(). Keyed on the Stripe Checkout Session id (or agr:<agreementId> when billing is unconfigured). Claimed as the first statement inside the provisioning transaction so a failed provision rolls the claim back. Append-only by grant.';
--> statement-breakpoint

COMMENT ON COLUMN provisioning_attempts.idempotency_key IS
  'Stable across Stripe webhook retries. Never accepted from a browser — apps/web stamps it from the verified Stripe event, because returning a prior result for a caller-chosen key would leak another clinic''s ids.';

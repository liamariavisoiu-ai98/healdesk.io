-- =============================================================================
-- billing_events: the dedupe ledger and the dead-letter queue for Stripe
-- webhooks, in one table.
--
-- Stripe delivers every event at least once and retries any non-2xx for up to
-- three days. The provisioning webhook already learned this the hard way
-- (0021): a retry that is not recognised as one does the work twice. For
-- lifecycle events "twice" means two usage resets, two grace windows, or a
-- transition that throws because the clinic is already where the event wanted
-- it. So every event is recorded here, keyed on Stripe's own event id, BEFORE
-- anything is done with it, and a second delivery reads the stored outcome
-- and answers with it.
--
-- The same row is where a failed event goes to wait for a person. Retrying
-- forever is not an option: after three days of failures Stripe disables the
-- endpoint, and then every clinic's renewal is lost, not just the one that
-- broke. So `failures` counts attempts, and at MAX_FAILURES (lib/billing/
-- events.ts) the event is marked 'dead_letter', acknowledged to Stripe with a
-- 200, and kept here with its full payload so it can be replayed once the
-- cause is fixed. The index below is the queue: "what needs a human".
--
-- Identity-plane, like provisioning_attempts and security_events: no RLS. The
-- row is written before the clinic is known — resolving it is one of the steps
-- that can fail, and that failure has to land somewhere — and support needs to
-- see the queue across every clinic.
-- =============================================================================

CREATE TABLE "billing_events" (
  "stripe_event_id" text PRIMARY KEY,
  "type" text NOT NULL,

  "received_at" timestamp with time zone NOT NULL DEFAULT now(),
  "processed_at" timestamp with time zone,

  -- NOT named clinic_id, deliberately, for the same reason as
  -- provisioning_attempts.provisioned_clinic_id (0021): this is a stored
  -- RESULT, not a tenant discriminator. tests/rls-drift.test.ts demands a
  -- policy on every column called clinic_id, and a tenant policy on this table
  -- would hide from support precisely the rows they are here to look at — an
  -- event that could not be matched to a clinic has no tenant to be read in.
  "resolved_clinic_id" uuid,

  -- NULL while in flight. processed | ignored | failed | dead_letter after.
  "outcome" text,
  "failures" integer NOT NULL DEFAULT 0,
  -- The last error's name and message, capped by the writer. Never the
  -- payload, never anything that came out of a clinic's data.
  "error" text,

  -- The verified event exactly as Stripe sent it. Business contact data
  -- (the buyer's email, the clinic's name), never PHI: nothing patient-level
  -- is ever placed in Stripe metadata.
  "payload" jsonb NOT NULL,

  CONSTRAINT "billing_events_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('processed', 'ignored', 'failed', 'dead_letter'))
);--> statement-breakpoint

-- The dead-letter queue is this query.
CREATE INDEX "billing_events_attention_idx"
  ON "billing_events" USING btree ("outcome", "received_at")
  WHERE "outcome" IN ('failed', 'dead_letter');--> statement-breakpoint

-- UPDATE is needed: the outcome is written after the insert, and the failure
-- count climbs across retries. DELETE is not: a dead-lettered event is
-- resolved by replaying it and marking it processed, never by removing the
-- evidence that it failed.
GRANT SELECT, INSERT, UPDATE ON "billing_events" TO healdesk_app;--> statement-breakpoint
REVOKE DELETE ON "billing_events" FROM healdesk_app;--> statement-breakpoint

COMMENT ON TABLE "billing_events" IS
  'Every Stripe event delivered to /api/billing/events, keyed on the event id. Dedupe ledger (a repeat delivery answers with the stored outcome) and dead-letter queue (outcome = dead_letter after MAX_FAILURES attempts). Identity-plane, no RLS.';
--> statement-breakpoint

COMMENT ON COLUMN "billing_events"."resolved_clinic_id" IS
  'The clinic the event was matched to, if any. A stored result, not a tenant key; deliberately not named clinic_id so the RLS drift test does not demand a policy that would hide unmatched events from support.';

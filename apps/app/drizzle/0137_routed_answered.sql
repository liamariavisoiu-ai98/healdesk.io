CREATE TABLE "routed_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"ref_hash" text NOT NULL,
	"routed_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"answered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "routed_interactions_ref_key" UNIQUE("clinic_id","channel","ref_hash"),
	CONSTRAINT "routed_interactions_channel_check" CHECK ("routed_interactions"."channel" in ('voice', 'web', 'meta')),
	CONSTRAINT "routed_interactions_outcome_check" CHECK ("routed_interactions"."outcome" in ('pending', 'excluded', 'answered', 'missed')),
	CONSTRAINT "routed_interactions_reason_check" CHECK ("routed_interactions"."reason" is null or "routed_interactions"."reason" in ('no_agreement', 'agreement_insufficient', 'unpaid', 'not_active', 'cancel_before_start', 'suspended', 'canceled', 'not_purchased', 'channel_not_live', 'channel_off', 'ai_paused', 'outside_coverage', 'allowance_cap', 'clinic_left', 'withheld', 'caller_ended', 'outside_window', 'outbound', 'host_agreement_lapsed', 'vendor_agreement_lapsed', 'start_failed', 'late', 'no_opening', 'cut_off', 'failure_line', 'error', 'no_outcome')),
	CONSTRAINT "routed_interactions_ref_check" CHECK ("routed_interactions"."ref_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "routed_interactions_reason_shape_check" CHECK (("routed_interactions"."outcome" in ('pending', 'answered')) = ("routed_interactions"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "routed_interactions" ADD CONSTRAINT "routed_interactions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routed_interactions_clinic_routed_idx" ON "routed_interactions" USING btree ("clinic_id","routed_at");--> statement-breakpoint
CREATE INDEX "routed_interactions_pending_idx" ON "routed_interactions" USING btree ("routed_at") WHERE "routed_interactions"."outcome" = 'pending';
--> statement-breakpoint
-- =============================================================================
-- Gate B: the routed/answered counter (29 October 2026). The statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- routed_interactions holds one row per call or conversation that reached
-- AYA for a clinic, and what became of it (lib/channels/routed-answered.ts):
-- the runtime's count of what was routed to her against what she answered,
-- which Gate B asks for (plan, Gates table) and which the outage notices
-- (L17, L18) and the first-month guarantee's miss notice (L21) read. Its
-- words follow Terms §5 (lib/channels/routed-words.ts).
--
-- No patient: the channel, the SHA-256 of the runtime's own id for the call
-- or conversation (never the id), closed words and times. Each row only ever
-- moves towards the worse outcome (pending, excluded, answered, missed), so
-- a retried write, a redelivered webhook or a later message can never turn
-- a miss back into an answer; the trigger holds that, and the identity of
-- the row, against any writer. The runtime role may insert and move the
-- outcome, never delete: the row is the record a guarantee claim is checked
-- against, and it is kept for good (lib/offboarding/account-closure.ts
-- KEPT_FOR_GOOD).
--
-- app_routed_answered_work(since) is the minute sweep's walk across
-- clinics, as app_clinic_change_work (0114) walks them: each clinic with a
-- row routed since `since`, its practice (the billing clinic) and the
-- practice's first channel go-live, which starts the guarantee's first month
-- (Terms §5: "the 30 days that start on the day your first channel goes
-- live"). Ids and a date only.
--
-- Safe to apply in place: one new, empty table, its trigger, policy and
-- grants, and one function.
-- =============================================================================

CREATE OR REPLACE FUNCTION routed_interactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ranks text[] := ARRAY['pending', 'excluded', 'answered', 'missed'];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.ref_hash IS DISTINCT FROM OLD.ref_hash
     OR NEW.routed_at IS DISTINCT FROM OLD.routed_at THEN
    RAISE EXCEPTION 'routed_interactions: only the outcome of a routed call or conversation changes';
  END IF;
  IF array_position(ranks, NEW.outcome) < array_position(ranks, OLD.outcome) THEN
    RAISE EXCEPTION 'routed_interactions: an outcome only moves towards the worse (% to %)', OLD.outcome, NEW.outcome;
  END IF;
  IF OLD.answered_at IS NOT NULL AND NEW.answered_at IS DISTINCT FROM OLD.answered_at THEN
    RAISE EXCEPTION 'routed_interactions: the first answer is written once';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER routed_interactions_guard
  BEFORE UPDATE ON routed_interactions
  FOR EACH ROW EXECUTE FUNCTION routed_interactions_guard();--> statement-breakpoint

REVOKE ALL ON routed_interactions FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON routed_interactions TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (outcome, reason, answered_at, resolved_at) ON routed_interactions TO healdesk_app;--> statement-breakpoint

ALTER TABLE routed_interactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE routed_interactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY routed_interactions_tenant_isolation ON routed_interactions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_routed_answered_work(since timestamptz)
RETURNS TABLE (clinic_id uuid, practice_id uuid, practice_first_live_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
  m record;
  recent boolean;
  first_live timestamptz;
  member_live timestamptz;
BEGIN
  FOR c IN
    SELECT cl.id, coalesce(cl.billing_clinic_id, cl.id) AS practice, cl.organization_id AS org
      FROM clinics cl
     WHERE cl.destroyed_at IS NULL
     ORDER BY cl.created_at
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT exists (SELECT 1 FROM routed_interactions r WHERE r.clinic_id = c.id AND r.routed_at >= since)
      INTO recent;
    CONTINUE WHEN NOT recent;
    -- The practice's first go-live: every location of the same practice and
    -- organisation (a pointer into another organisation is no practice, as
    -- the answer gate treats it).
    first_live := NULL;
    FOR m IN
      SELECT cl2.id FROM clinics cl2
       WHERE coalesce(cl2.billing_clinic_id, cl2.id) = c.practice
         AND cl2.organization_id IS NOT DISTINCT FROM c.org
    LOOP
      PERFORM set_config('app.clinic_id', m.id::text, true);
      SELECT min(ch.live_at) INTO member_live FROM clinic_channels ch WHERE ch.clinic_id = m.id;
      first_live := least(first_live, member_live);
    END LOOP;
    clinic_id := c.id;
    practice_id := c.practice;
    practice_first_live_at := first_live;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_routed_answered_work(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_routed_answered_work(timestamptz) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_routed_answered_work(timestamptz) IS
  'The routed/answered sweep''s walk across clinics (lib/channels/answer-notices.ts): each clinic with a call or conversation routed since the argument, its practice and the practice''s first channel go-live. Ids and a date, no patient data. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one.';

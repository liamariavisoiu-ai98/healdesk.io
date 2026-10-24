CREATE TABLE "ops_approval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_label" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"draft_hash_approved" text,
	"draft_hash_sent" text,
	"outcome_code" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_approval_events_event_check" CHECK ("ops_approval_events"."event" in ('proposed', 'edited', 'approved', 'rejected', 'executed', 'failed', 'expired', 'reminded')),
	CONSTRAINT "ops_approval_events_actor_check" CHECK (char_length("ops_approval_events"."actor_label") between 1 and 200),
	CONSTRAINT "ops_approval_events_text_check" CHECK (("ops_approval_events"."ip" is null or char_length("ops_approval_events"."ip") <= 64) and ("ops_approval_events"."user_agent" is null or char_length("ops_approval_events"."user_agent") <= 256)),
	CONSTRAINT "ops_approval_events_hash_check" CHECK (("ops_approval_events"."draft_hash_approved" is null or "ops_approval_events"."draft_hash_approved" ~ '^[0-9a-f]{64}$') and ("ops_approval_events"."draft_hash_sent" is null or "ops_approval_events"."draft_hash_sent" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "ops_approval_events_outcome_check" CHECK ("ops_approval_events"."outcome_code" is null or "ops_approval_events"."outcome_code" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "ops_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_clinic_id" uuid,
	"subject_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"draft" text,
	"draft_hash" text,
	"due_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"urgency" text NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"decided_at" timestamp with time zone,
	"outcome_code" text,
	CONSTRAINT "ops_approvals_kind_check" CHECK ("ops_approvals"."kind" in ('billing_request_retry', 'overage_invoice_retry', 'billing_event_replay')),
	CONSTRAINT "ops_approvals_urgency_check" CHECK ("ops_approvals"."urgency" in ('legal_clock', 'money', 'routine')),
	CONSTRAINT "ops_approvals_status_check" CHECK ("ops_approvals"."status" in ('waiting', 'approved', 'rejected', 'expired', 'executed', 'failed')),
	CONSTRAINT "ops_approvals_subject_check" CHECK ("ops_approvals"."subject_ref" ~ '^[A-Za-z0-9_:.-]+$' and char_length("ops_approvals"."subject_ref") <= 300),
	CONSTRAINT "ops_approvals_proposed_by_check" CHECK ("ops_approvals"."proposed_by" ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "ops_approvals_payload_check" CHECK (jsonb_typeof("ops_approvals"."payload") = 'object' and position('@' in "ops_approvals"."payload"::text) = 0 and regexp_replace(regexp_replace("ops_approvals"."payload"::text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){6,}'),
	CONSTRAINT "ops_approvals_draft_check" CHECK (("ops_approvals"."draft" is null) = ("ops_approvals"."draft_hash" is null) and ("ops_approvals"."draft_hash" is null or "ops_approvals"."draft_hash" ~ '^[0-9a-f]{64}$') and ("ops_approvals"."draft" is null or char_length("ops_approvals"."draft") <= 20000)),
	CONSTRAINT "ops_approvals_decided_check" CHECK (("ops_approvals"."status" = 'waiting') = ("ops_approvals"."decided_at" is null)),
	CONSTRAINT "ops_approvals_outcome_check" CHECK ("ops_approvals"."outcome_code" is null or "ops_approvals"."outcome_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "ops_approvals_expiry_check" CHECK ("ops_approvals"."expires_at" is null or "ops_approvals"."expires_at" > "ops_approvals"."proposed_at")
);
--> statement-breakpoint
ALTER TABLE "ops_approval_events" ADD CONSTRAINT "ops_approval_events_approval_id_ops_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."ops_approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ops_approval_events_approval_idx" ON "ops_approval_events" USING btree ("approval_id","at");--> statement-breakpoint
CREATE INDEX "ops_approval_events_at_idx" ON "ops_approval_events" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_approvals_waiting_idx" ON "ops_approvals" USING btree ("kind","subject_ref") WHERE "ops_approvals"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX "ops_approvals_status_idx" ON "ops_approvals" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "ops_approvals_subject_idx" ON "ops_approvals" USING btree ("kind","subject_ref");--> statement-breakpoint
-- =============================================================================
-- The approval inbox (24 October 2026; ops automation Phase 6, lane P6a;
-- design E6 §2, owner decisions D17, D18 and D21). The statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The owner asked that every money, legal and clinic-contact step wait for
-- his explicit yes, with a record of who said yes to what that nobody can
-- rewrite. Until now the console had a separate button for each (retry a
-- billing request, retry an overage invoice, replay a Stripe event) and
-- nothing that collected "waiting for you" in one place or recorded the
-- decision as a unit.
--
--   ops_approvals        one row per thing waiting for a yes: its kind, the
--                        clinic it is about, the subject by id, ids and codes,
--                        its due time and window, and where it stands. The
--                        runtime role reads and inserts, and updates only the
--                        three columns a decision moves; a trigger allows only
--                        waiting -> approved | rejected | expired and
--                        approved -> executed | failed. Never deleted.
--   ops_approval_events  add-only: proposed, edited, approved, rejected,
--                        executed, failed, expired, reminded, with the
--                        operator account, IP address and user agent the
--                        request carried and the outcome code. The runtime
--                        role holds only SELECT and INSERT, and a trigger
--                        refuses UPDATE, DELETE and TRUNCATE to any role
--                        that issues them, the migrator included. The
--                        triggers are ENABLE ALWAYS, so a session that sets
--                        session_replication_role does not skip them. The
--                        table owner or a superuser could still drop or
--                        disable a trigger by DDL: that is a schema change
--                        in a migration, reviewed, not something a running
--                        process can do.
--
-- Not tenant tables: the console lists them across clinics and they are
-- written outside any tenant, like ops_alerts and platform_compliance. That
-- is why the clinic column is subject_clinic_id, not clinic_id (every table
-- with a clinic_id is a FORCE-RLS tenant table, tests/rls-drift.test.ts),
-- and why it has no foreign key: the record of what the owner allowed is
-- kept for good, as security_events is, after the clinic it names is
-- destroyed. No patient, no free text, no card: ids, closed codes, dates and
-- the operator's label. Both are on the read-only role's list
-- (scripts/readonly-tables.ts); neither holds a draft's text but
-- ops_approvals.draft, which no kind uses yet.
--
-- One job row, seeded OFF like every job: approvals-propose, hourly, which
-- proposes only what no automatic process retries (owner decision D17: a
-- cancellation or setup closure the billing worker dead-lettered, a Stripe
-- event parked after its retries that names a clinic), expires items past
-- their window and re-alerts. It never retries anything itself.
--
-- Safe to apply in place: two new, empty tables and one job row.
-- =============================================================================

REVOKE ALL ON ops_approvals FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON ops_approvals TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, decided_at, outcome_code) ON ops_approvals TO healdesk_app;--> statement-breakpoint
REVOKE ALL ON ops_approval_events FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON ops_approval_events TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_ops_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ops_approvals is a record of what the owner allowed: it is never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.subject_ref <> OLD.subject_ref
     OR NEW.subject_clinic_id IS DISTINCT FROM OLD.subject_clinic_id
     OR NEW.payload <> OLD.payload OR NEW.draft IS DISTINCT FROM OLD.draft
     OR NEW.draft_hash IS DISTINCT FROM OLD.draft_hash OR NEW.due_at <> OLD.due_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.urgency <> OLD.urgency
     OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at THEN
    RAISE EXCEPTION 'an approval''s proposal is fixed once made: only its status moves'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.decided_at IS NOT NULL AND NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
    RAISE EXCEPTION 'an approval''s decision time is fixed once set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.status = 'waiting' AND NEW.status IN ('approved', 'rejected', 'expired'))
          OR (OLD.status = 'approved' AND NEW.status IN ('executed', 'failed'))) THEN
    RAISE EXCEPTION 'an approval cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_ops_approvals_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER ops_approvals_guard
  BEFORE UPDATE OR DELETE ON ops_approvals
  FOR EACH ROW EXECUTE FUNCTION app_ops_approvals_guard();--> statement-breakpoint
CREATE TRIGGER ops_approvals_no_truncate
  BEFORE TRUNCATE ON ops_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION app_ops_approvals_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_ops_approval_events_add_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'ops_approval_events is add-only: % is refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_ops_approval_events_add_only() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER ops_approval_events_add_only
  BEFORE UPDATE OR DELETE ON ops_approval_events
  FOR EACH ROW EXECUTE FUNCTION app_ops_approval_events_add_only();--> statement-breakpoint
CREATE TRIGGER ops_approval_events_no_truncate
  BEFORE TRUNCATE ON ops_approval_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_ops_approval_events_add_only();--> statement-breakpoint
ALTER TABLE ops_approvals ENABLE ALWAYS TRIGGER ops_approvals_guard;--> statement-breakpoint
ALTER TABLE ops_approvals ENABLE ALWAYS TRIGGER ops_approvals_no_truncate;--> statement-breakpoint
ALTER TABLE ops_approval_events ENABLE ALWAYS TRIGGER ops_approval_events_add_only;--> statement-breakpoint
ALTER TABLE ops_approval_events ENABLE ALWAYS TRIGGER ops_approval_events_no_truncate;--> statement-breakpoint

COMMENT ON TABLE ops_approvals IS
  'Ops-only, platform-wide: each thing waiting for the owner''s yes (the approval inbox, design E6 §2): its kind from a closed list, the clinic it is about (subject_clinic_id, a stored fact, not a tenant key), the subject by id, ids and codes, its due time, window and urgency, and where it stands. Approving runs the existing ops operation in the same request. No patient and no free text; kept for good; no RLS (drizzle/0119 says why).';--> statement-breakpoint
COMMENT ON TABLE ops_approval_events IS
  'Add-only record of the approval inbox: each proposal, edit, decision, outcome, expiry and reminder, with the operator account, IP address and user agent the request carried, a draft''s hashes as approved and as sent, and the outcome code. The runtime role may only read and add; UPDATE, DELETE and TRUNCATE are refused by ENABLE ALWAYS triggers for any role that issues them (only a DDL change by the table owner could remove them). No patient, never a draft''s text.';--> statement-breakpoint

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('approvals-propose', 'Hourly; puts each cancellation or setup closure the billing worker gave up on and each Stripe event parked after its retries that names a clinic into the approval inbox, one item each, for the owner to approve or reject; nothing an automatic process still retries. Expires items past their window and re-alerts items past due. Never retries or replays anything itself. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

DO $$
DECLARE
  col record;
  trig record;
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'ops_approvals'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_table_privilege('healdesk_app'::name, 'ops_approval_events'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('healdesk_app'::name, 'ops_approval_events'::regclass, 'UPDATE')
     OR NOT has_table_privilege('healdesk_app'::name, 'ops_approvals'::regclass, 'SELECT, INSERT')
     OR NOT has_table_privilege('healdesk_app'::name, 'ops_approval_events'::regclass, 'SELECT, INSERT') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or erase the approval inbox, or cannot read and add to it.';
  END IF;
  -- Of ops_approvals, the runtime role may update the three columns a decision moves, and no other.
  FOR col IN
    SELECT attname FROM pg_attribute
     WHERE attrelid = 'ops_approvals'::regclass AND attnum > 0 AND NOT attisdropped
       AND attname NOT IN ('status', 'decided_at', 'outcome_code')
  LOOP
    IF has_column_privilege('healdesk_app'::name, 'ops_approvals'::regclass, col.attname, 'UPDATE') THEN
      RAISE EXCEPTION 'healdesk_app can update ops_approvals.%', col.attname;
    END IF;
  END LOOP;
  -- The four guards exist and fire always.
  FOR trig IN
    SELECT t.tgname, t.tgenabled FROM pg_trigger t
     WHERE t.tgname IN ('ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')
  LOOP
    IF trig.tgenabled <> 'A' THEN
      RAISE EXCEPTION 'trigger % is not ENABLE ALWAYS', trig.tgname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')) <> 4 THEN
    RAISE EXCEPTION 'an approval inbox guard trigger is missing';
  END IF;
END;
$$;

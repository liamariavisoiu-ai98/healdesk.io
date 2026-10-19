CREATE TABLE "audit_review_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"due_on" date NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"past_due_alerted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_label" text,
	"section" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_review_queue_status_check" CHECK ("audit_review_queue"."status" in ('open', 'passed', 'failed', 'superseded')),
	CONSTRAINT "audit_review_queue_section_check" CHECK ("audit_review_queue"."section" is null or ("audit_review_queue"."status" = 'failed' and "audit_review_queue"."section" in ('practice', 'prices', 'policies', 'promotions', 'quick_answers', 'never_say', 'hours', 'how_aya_talks', 'safety_net'))),
	CONSTRAINT "audit_review_queue_decided_check" CHECK (("audit_review_queue"."status" in ('open', 'superseded')) = ("audit_review_queue"."decided_at" is null) and ("audit_review_queue"."decided_at" is null) = ("audit_review_queue"."decided_by_label" is null)),
	CONSTRAINT "audit_review_queue_decided_by_check" CHECK ("audit_review_queue"."decided_by_label" is null or char_length("audit_review_queue"."decided_by_label") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "practice_question_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"input_version" text NOT NULL,
	"status" text NOT NULL,
	"cases" jsonb NOT NULL,
	"reused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_question_results_channel_check" CHECK ("practice_question_results"."channel" in ('web', 'meta', 'voice')),
	CONSTRAINT "practice_question_results_status_check" CHECK ("practice_question_results"."status" in ('passed', 'failed', 'in_review', 'error')),
	CONSTRAINT "practice_question_results_input_version_check" CHECK ("practice_question_results"."input_version" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "practice_question_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text NOT NULL,
	"trigger_section" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"agent_version" integer,
	"cases_version" text,
	"input_version" text,
	"failed_section" text,
	"failed_count" integer,
	"approved_version" integer,
	"override_label" text,
	"last_error" text,
	CONSTRAINT "practice_question_runs_clinic_run_key" UNIQUE("clinic_id","id"),
	CONSTRAINT "practice_question_runs_status_check" CHECK ("practice_question_runs"."status" in ('queued', 'running', 'not_ready', 'passed', 'failed', 'in_review', 'error', 'superseded')),
	CONSTRAINT "practice_question_runs_reason_check" CHECK ("practice_question_runs"."reason" in ('knowledge', 'settings', 'wizard', 'ops', 'sweep', 'override')),
	CONSTRAINT "practice_question_runs_trigger_section_check" CHECK ("practice_question_runs"."trigger_section" is null or "practice_question_runs"."trigger_section" in ('practice', 'prices', 'policies', 'promotions', 'quick_answers', 'never_say', 'hours', 'how_aya_talks', 'safety_net')),
	CONSTRAINT "practice_question_runs_failed_section_check" CHECK ("practice_question_runs"."failed_section" is null or "practice_question_runs"."failed_section" in ('practice', 'prices', 'policies', 'promotions', 'quick_answers', 'never_say', 'hours', 'how_aya_talks', 'safety_net')),
	CONSTRAINT "practice_question_runs_attempts_check" CHECK ("practice_question_runs"."attempts" >= 0),
	CONSTRAINT "practice_question_runs_failed_count_check" CHECK ("practice_question_runs"."failed_count" is null or "practice_question_runs"."failed_count" >= 0),
	CONSTRAINT "practice_question_runs_input_version_check" CHECK ("practice_question_runs"."input_version" is null or "practice_question_runs"."input_version" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "practice_question_runs_cases_version_check" CHECK ("practice_question_runs"."cases_version" is null or "practice_question_runs"."cases_version" ~ '^[a-z0-9.-]{1,32}$'),
	CONSTRAINT "practice_question_runs_last_error_check" CHECK ("practice_question_runs"."last_error" is null or "practice_question_runs"."last_error" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "practice_question_runs_override_check" CHECK ("practice_question_runs"."override_label" is null or ("practice_question_runs"."reason" = 'override' and "practice_question_runs"."status" = 'passed' and char_length("practice_question_runs"."override_label") between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "audit_review_queue" ADD CONSTRAINT "audit_review_queue_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_review_queue" ADD CONSTRAINT "audit_review_queue_run_fk" FOREIGN KEY ("clinic_id","run_id") REFERENCES "public"."practice_question_runs"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_question_results" ADD CONSTRAINT "practice_question_results_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_question_results" ADD CONSTRAINT "practice_question_results_run_fk" FOREIGN KEY ("clinic_id","run_id") REFERENCES "public"."practice_question_runs"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_question_runs" ADD CONSTRAINT "practice_question_runs_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_review_queue_run_idx" ON "audit_review_queue" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_review_queue_open_idx" ON "audit_review_queue" USING btree ("clinic_id","due_at") WHERE "audit_review_queue"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "practice_question_results_run_channel_idx" ON "practice_question_results" USING btree ("run_id","channel");--> statement-breakpoint
CREATE INDEX "practice_question_results_version_idx" ON "practice_question_results" USING btree ("clinic_id","channel","input_version");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_question_runs_queued_idx" ON "practice_question_runs" USING btree ("clinic_id") WHERE "practice_question_runs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "practice_question_runs_running_idx" ON "practice_question_runs" USING btree ("clinic_id") WHERE "practice_question_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "practice_question_runs_clinic_idx" ON "practice_question_runs" USING btree ("clinic_id","requested_at");
-- =============================================================================
-- The practice questions (plan Part G; spec, "The pre-launch audit"). The
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express.
--
-- A clinic's practice questions are the spec's nine cases and the disclosure
-- line, templated from its own profile and asked of each channel it bought,
-- through the brain that channel answers with (lib/engine/practice). A run
-- is asked for by a change to what the cases read, waits two minutes without
-- another, and is run by the practice-questions job, one at a time per clinic.
-- A pass approves the agent script; a failure on the clinic's own data sends
-- O9; any other failure, or a judge's, waits in audit_review_queue for a
-- person at healdesk, by the next business day.
--
-- Nothing in these tables is PHI: every case is synthetic, and AYA's answers
-- to them come from the clinic's business facts. So no BAA gate. What the
-- database holds to:
--
--   * tenant isolation, forced, on all three, and each is listed in
--     TENANT_SCOPED_TABLES;
--   * nothing is deleted by the runtime role: a run, its results and its
--     review are the record of what approved the words AYA says for the
--     clinic. Destruction keeps them, beside agent_configs (the keep-list in
--     tests/booking-request-destruction.test.ts names each);
--   * the runtime role moves a run on (status, its clock, what it read and
--     what it came to), a result's status (a review decides it), and a
--     review's decision and its past-due stamp, and nothing else: no run
--     changes clinic, reason or operator label once written;
--   * app_due_practice_runs, the tenant walk the minute job finds due runs
--     with: ids only.
--
-- Safe to apply in place: three new tables, one function and a job row, off.
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

ALTER TABLE practice_question_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE practice_question_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY practice_question_runs_tenant_isolation ON practice_question_runs
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE practice_question_results ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE practice_question_results FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY practice_question_results_tenant_isolation ON practice_question_results
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE audit_review_queue ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_review_queue FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_review_queue_tenant_isolation ON audit_review_queue
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- Grants. 0003's default privileges have already given healdesk_app all four
-- on each new table, so every REVOKE is required, and each GRANT restates the
-- intended set.
REVOKE ALL ON practice_question_runs FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON practice_question_runs TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, reason, trigger_section, run_after, lease_until, attempts, started_at, finished_at,
              agent_version, cases_version, input_version, failed_section, failed_count, approved_version,
              last_error)
  ON practice_question_runs TO healdesk_app;--> statement-breakpoint

REVOKE ALL ON practice_question_results FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON practice_question_results TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status) ON practice_question_results TO healdesk_app;--> statement-breakpoint

REVOKE ALL ON audit_review_queue FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON audit_review_queue TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, past_due_alerted_at, decided_at, decided_by_label, section)
  ON audit_review_queue TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_due_practice_runs: the runs the minute job may claim, across clinics.
-- -----------------------------------------------------------------------------
-- The tenant walk of 0046 (app_pending_notices): the table forces row-level
-- security, which binds the definer too, so the walk sets the tenant per
-- clinic and restores the caller's setting. Clinic id and run id, and only
-- what is due: a queued run whose two minutes are up, or a running one whose
-- lease ran out. The job claims each inside withTenant() (claimPracticeRun),
-- which checks the same again under the row's own conditions. It counts no
-- days, so no time-zone pin; the clock is the database's.
CREATE OR REPLACE FUNCTION app_due_practice_runs(p_limit integer)
RETURNS TABLE (clinic_id uuid, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.offboarding_started_at IS NULL ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.clinic_id, r.id
        FROM practice_question_runs r
       WHERE r.clinic_id = c.id
         AND ((r.status = 'queued' AND r.run_after <= clock_timestamp())
              OR (r.status = 'running' AND r.lease_until < clock_timestamp()))
       ORDER BY r.run_after
       LIMIT greatest(least(p_limit, 50), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_due_practice_runs(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_due_practice_runs(integer) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The practice questions record a channel's audit input (lib/channels/
-- audit-seam.ts): app_channel_record_input, 0079's definer, takes a third
-- closed way, ('audit_passed', 'practice_questions'), recorded with actor
-- 'system' rather than 'ops', since no operator made it. Otherwise 0079's
-- body as it was: inside a tenant, a bought channel, a clinic that has not
-- left, once per channel. Its owner, search path and grants are kept by
-- CREATE OR REPLACE.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_channel_record_input(p_channel text, p_kind text, p_via text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  inserted integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_channel_record_input runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT ((p_kind = 'audit_passed' AND p_via IN ('ops_attested', 'practice_questions'))
          OR (p_kind = 'runtime_seen' AND p_channel = 'web' AND p_via = 'ops_confirmed')) THEN
    RAISE EXCEPTION 'app_channel_record_input: % by % on % is not an input this records', p_kind, p_via, p_channel
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clinic_channels WHERE clinic_id = c AND channel = p_channel) THEN
    RAISE EXCEPTION 'app_channel_record_input: the clinic did not buy %', p_channel USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM clinics WHERE id = c AND (offboarding_started_at IS NOT NULL OR destroyed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'app_channel_record_input: the clinic has left' USING ERRCODE = '55000';
  END IF;
  INSERT INTO channel_events (clinic_id, channel, kind, actor, detail)
  VALUES (c, p_channel, p_kind, CASE WHEN p_via = 'practice_questions' THEN 'system' ELSE 'ops' END,
          jsonb_build_object('via', p_via))
  ON CONFLICT (clinic_id, channel, kind) WHERE kind IN ('audit_passed', 'runtime_seen') DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The job row, off: every run asks the model, and spends real tokens. The
-- owner switches it on with the engine's key in place.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('practice-questions', 'Every minute, from the practice-questions queue: runs each clinic''s due practice questions, one at a time per clinic, two minutes after its last change; hourly from the tick, asks for a run where a clinic''s inputs changed with none asked for, alerts ops on a review past its day, and sends O8 once a clinic''s tracker is complete', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

COMMENT ON TABLE practice_question_runs IS
  'One run of a clinic''s practice questions (lib/engine/practice): queued, claimed under a lease, and what it came to. Synthetic, no PHI. Kept at destruction.';--> statement-breakpoint
COMMENT ON TABLE practice_question_results IS
  'One channel''s result in a run, per audit-input version: the synthetic cases, AYA''s answers and the checks. Synthetic, no PHI. Kept at destruction.';--> statement-breakpoint
COMMENT ON TABLE audit_review_queue IS
  'Ops-only: a run a judge failed, or whose check failed on our side, waiting for a person at healdesk by due_on. Decided through the ops envelope. No PHI.';

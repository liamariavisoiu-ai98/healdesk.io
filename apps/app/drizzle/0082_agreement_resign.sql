CREATE TABLE "agreement_resigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"from_agreement_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"superseding_agreement_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "agreement_resigns_status_check" CHECK ("agreement_resigns"."status" in ('open', 'signed', 'withdrawn')),
	CONSTRAINT "agreement_resigns_reason_check" CHECK ("agreement_resigns"."reason" in ('now_covered', 'not_sure')),
	CONSTRAINT "agreement_resigns_source_check" CHECK ("agreement_resigns"."source" in ('operator', 'portal')),
	CONSTRAINT "agreement_resigns_requested_by_check" CHECK (char_length("agreement_resigns"."requested_by") between 1 and 200),
	CONSTRAINT "agreement_resigns_resolved_by_check" CHECK ("agreement_resigns"."resolved_by" is null or char_length("agreement_resigns"."resolved_by") between 1 and 254),
	CONSTRAINT "agreement_resigns_resolved_check" CHECK (("agreement_resigns"."status" = 'open') = ("agreement_resigns"."resolved_at" is null) and ("agreement_resigns"."resolved_at" is null) = ("agreement_resigns"."resolved_by" is null)),
	CONSTRAINT "agreement_resigns_signed_check" CHECK (("agreement_resigns"."status" = 'signed') = ("agreement_resigns"."signed_at" is not null and "agreement_resigns"."superseding_agreement_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_review_queue" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_review_queue" ADD COLUMN "kind" text DEFAULT 'practice_questions' NOT NULL;--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_from_agreement_id_baa_acceptances_id_fk" FOREIGN KEY ("from_agreement_id") REFERENCES "public"."baa_acceptances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_superseding_agreement_id_baa_acceptances_id_fk" FOREIGN KEY ("superseding_agreement_id") REFERENCES "public"."baa_acceptances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_resigns_open_idx" ON "agreement_resigns" USING btree ("clinic_id") WHERE "agreement_resigns"."status" = 'open';--> statement-breakpoint
CREATE INDEX "agreement_resigns_clinic_idx" ON "agreement_resigns" USING btree ("clinic_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_review_queue_agreement_open_idx" ON "audit_review_queue" USING btree ("clinic_id") WHERE "audit_review_queue"."kind" = 'agreement_kind' and "audit_review_queue"."status" = 'open';--> statement-breakpoint
ALTER TABLE "audit_review_queue" ADD CONSTRAINT "audit_review_queue_kind_check" CHECK ("audit_review_queue"."kind" in ('practice_questions', 'agreement_kind'));--> statement-breakpoint
ALTER TABLE "audit_review_queue" ADD CONSTRAINT "audit_review_queue_run_check" CHECK (("audit_review_queue"."kind" = 'practice_questions') = ("audit_review_queue"."run_id" is not null));--> statement-breakpoint

-- =============================================================================
-- The DPA→BAA re-sign, and the misclassification signal (package WP9, plan
-- Part L, Annex X5 L22). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- agreement_resigns: a practice under the Data Protection Agreement whose
-- covered-entity answer becomes "Yes" or "Not sure" is no longer covered by
-- it, and from that write app_clinic_accepts_phi() refuses its data (0051).
-- The row is opened in the same transaction (lib/agreements/resign.ts) and
-- closed when the BAA the practice signs through L22's link is put in force
-- by app_supersede_agreement(), or when ops records "No" after all. Its link
-- is signed, never stored, and names the row: it works only while the row is
-- open, so signing spends every link L22 and its reminders carried.
--
-- audit_review_queue takes a second kind of review: `agreement_kind`, the
-- misclassification signal, a DPA practice that answered "No" whose own
-- website says it accepts insurance. It has no run, so run_id is nullable
-- for it and only for it (the CHECK above), the composite foreign key to the
-- run is not checked on a NULL (MATCH SIMPLE), and one is open per clinic.
-- Every existing review is a practice-questions review, which the column's
-- default records.
--
-- Contract metadata and business data, never a patient: no BAA gate on
-- either. Safe to apply in place: a new, empty table with its policy, grants,
-- trigger and one function; a column with a default and a relaxed NOT NULL
-- on a table whose every row keeps its run.
-- =============================================================================

ALTER TABLE agreement_resigns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agreement_resigns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agreement_resigns_tenant_isolation ON agreement_resigns
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants. 0003's default privileges have already given healdesk_app full DML
-- on the new table, so each REVOKE is required, not defensive. The runtime
-- role opens a re-sign and closes it; it never rewrites which clinic, which
-- agreement, why or who asked, never moves the pause it recorded, and never
-- deletes one: destruction keeps the row (tests/booking-request-destruction
-- .test.ts, KEPT_AT_DESTRUCTION).
-- -----------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON agreement_resigns FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON agreement_resigns TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, signed_at, superseding_agreement_id, resolved_at, resolved_by)
  ON agreement_resigns TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- One way only: open -> signed or withdrawn, and a closed re-sign never moves
-- again, for every role. The grants keep the runtime role off the identity
-- columns; this keeps them fixed for the migrator's own scripts too.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_agreement_resign_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.from_agreement_id IS DISTINCT FROM OLD.from_agreement_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.paused_at IS DISTINCT FROM OLD.paused_at THEN
    RAISE EXCEPTION 'agreement_resigns: which clinic, which agreement, why, who asked and the pause are fixed once opened.';
  END IF;
  IF OLD.status <> 'open' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'agreement_resigns: a % re-sign is final.', OLD.status;
  END IF;
  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'signed', 'withdrawn') THEN
    RAISE EXCEPTION 'agreement_resigns: open cannot become %.', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER agreement_resigns_transition
  BEFORE UPDATE ON agreement_resigns
  FOR EACH ROW EXECUTE FUNCTION app_agreement_resign_transition_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_open_agreement_resigns: the hourly job's walk, across clinics, for L22's
-- reminders at 3 and 7 days and the ops alert at 7. The table forces
-- row-level security, which binds the definer too, so the walk sets the
-- tenant per clinic and restores the caller's setting, as 0080's
-- app_due_practice_runs does. Ids only: the job opens each re-sign inside
-- withTenant() and reads it under RLS. It counts no days itself, so no
-- time-zone pin.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_open_agreement_resigns()
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
        FROM agreement_resigns r
       WHERE r.clinic_id = c.id
         AND r.status = 'open';
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_open_agreement_resigns() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_open_agreement_resigns() TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE agreement_resigns IS
  'A practice''s re-sign from the Data Protection Agreement to the BAA (plan Part L, L22): opened when its covered-entity answer stops the DPA covering it, closed when app_supersede_agreement() puts the signed BAA in force or ops withdraws it. Its link is signed and never stored. paused_at is the header pause it holds AYA under. Contract metadata; no patient.';--> statement-breakpoint
COMMENT ON COLUMN audit_review_queue.kind IS
  'practice_questions: a run of the practice questions (run_id names it). agreement_kind: a DPA practice that answered No whose website says it accepts insurance (WP9); no run.';

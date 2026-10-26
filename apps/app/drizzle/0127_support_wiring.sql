ALTER TABLE "ops_approvals" DROP CONSTRAINT "ops_approvals_draft_check";--> statement-breakpoint
ALTER TABLE "ops_approvals" ADD CONSTRAINT "ops_approvals_draft_check" CHECK ((("ops_approvals"."draft" is null) = ("ops_approvals"."draft_hash" is null) or ("ops_approvals"."kind" = 'support_reply_send' and "ops_approvals"."draft" is null)) and ("ops_approvals"."draft_hash" is null or "ops_approvals"."draft_hash" ~ '^[0-9a-f]{64}$') and ("ops_approvals"."draft" is null or char_length("ops_approvals"."draft") <= 20000));--> statement-breakpoint
-- =============================================================================
-- Wiring the support slice together (25 October 2026; ops automation Phase 7,
-- lane P7e; design E5 §2.2-§2.3). The two statements above were generated
-- from schema.ts; everything below is the part drizzle cannot express.
--
-- Lanes P7a (cases), P7b (the drafter) and P7c (approve and send) each
-- stopped at a file they did not own. This migration holds the database's
-- half of joining them:
--
--   scheduled_jobs  two rows, seeded OFF like every job: `support-send`
--                   (every minute, the retries of an approved reply that
--                   did not go at approval) and `support-draft` (lane P7b's
--                   drafter, whose row lane P7b handed on and 0126 did not
--                   carry: without it the job only logged "no job row").
--   ops_approvals   a support reply's approval item keeps the reply as the
--                   clinic would read it in `draft`, which 0119 made
--                   immutable. That prose outlived the 12 months the sent
--                   text is kept (support_messages.text, swept by
--                   sweepSentReplyText) and outlived the clinic itself,
--                   since the item has no foreign key and is never deleted.
--                   So, for kind support_reply_send ONLY, `draft` may now go
--                   from text to NULL and nothing else: the guard allows that
--                   one change with every other column, status and decision
--                   included, unchanged; the draft CHECK allows that kind a
--                   NULL draft beside its hash. The hash stays, and so does
--                   every ops_approval_events row (with the approved and sent
--                   hashes): the record of what was approved is kept, the
--                   words are not. Every other kind's draft, and every other
--                   column of every kind, is as fixed as 0119 made it.
--                   The runtime role still cannot update `draft`: only two
--                   SECURITY DEFINER functions do it.
--   app_forget_support_reply_drafts(now)  the nightly 12-month sweep: every
--                   support_reply_send item decided more than 365 days
--                   before the earlier of the time passed and the
--                   database's own clock (so a caller can never forget a
--                   draft early), its draft set to NULL. Returns the count.
--   app_destroy_support_cases(clinic)  as 0125, and now also the clinic's
--                   support_reply_send items' drafts set to NULL in the same
--                   transaction: a clinic's support data goes WITH the
--                   clinic (owner, 25 October 2026). The items themselves
--                   stay, without words, as the record of what the owner
--                   allowed, as 0119 keeps every item.
--
-- Safe to apply in place: a CHECK widened, a guard narrowed to one more
-- allowed change, two functions, two job rows.
-- =============================================================================

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('support-send', 'Every minute, from the support-send queue, and hourly from the tick: tries again each support reply the owner approved whose send did not go through, on the email outbox''s schedule (after 1, 5, 30, 120 and 360 minutes), and stops after six tries with an ops alert. Sends only the frozen text the owner approved, to the practice''s one address. Off until the owner switches it on', false),
  ('support-draft', 'Every minute, from the support-draft queue: drafts up to three new support cases that name a practice, each from the case''s fields and the practice''s account, checked by the eight reply rules, for the owner to edit and send. Sends nothing. Off until the owner switches it on, with ANTHROPIC_API_KEY set', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

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
  -- 0127: a support reply's copy of its words may be forgotten (the 12-month
  -- sweep, the clinic's destruction), and nothing else about the item moves.
  IF OLD.kind = 'support_reply_send' AND OLD.draft IS NOT NULL AND NEW.draft IS NULL
     AND ROW(NEW.id, NEW.kind, NEW.subject_clinic_id, NEW.subject_ref, NEW.payload, NEW.draft_hash,
             NEW.due_at, NEW.expires_at, NEW.urgency, NEW.proposed_by, NEW.proposed_at,
             NEW.status, NEW.decided_at, NEW.outcome_code)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.kind, OLD.subject_clinic_id, OLD.subject_ref, OLD.payload, OLD.draft_hash,
             OLD.due_at, OLD.expires_at, OLD.urgency, OLD.proposed_by, OLD.proposed_at,
             OLD.status, OLD.decided_at, OLD.outcome_code) THEN
    RETURN NEW;
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
ALTER TABLE support_cases ENABLE ALWAYS TRIGGER support_cases_guard;--> statement-breakpoint
ALTER TABLE ops_approvals ENABLE ALWAYS TRIGGER ops_approvals_guard;--> statement-breakpoint
ALTER TABLE ops_approvals ENABLE ALWAYS TRIGGER ops_approvals_no_truncate;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_forget_support_reply_drafts(as_of timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  cutoff timestamptz := least(coalesce(as_of, now()), now()) - interval '365 days';
  gone integer;
BEGIN
  UPDATE ops_approvals a SET draft = NULL
   WHERE a.kind = 'support_reply_send'
     AND a.draft IS NOT NULL
     AND a.status <> 'waiting'
     AND a.decided_at <= cutoff;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_forget_support_reply_drafts(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_forget_support_reply_drafts(timestamptz) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_forget_support_reply_drafts(timestamptz) IS
  'Sets ops_approvals.draft to NULL for every support_reply_send item decided more than 365 days before the earlier of the time passed and now() (0127): the 12-month rule for a support reply''s words, beside sweepSentReplyText. The item, its hash and its events stay. Returns the count.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_destroy_support_cases(target_clinic uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  gone integer;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_destroy_support_cases: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;
  -- The clinic's row first, FOR UPDATE, so a case being opened for it
  -- (the guard reads the row FOR SHARE) commits before the delete below
  -- and is taken, or waits for destroyed_at and is refused.
  PERFORM 1 FROM clinics c WHERE c.id = target_clinic FOR UPDATE;
  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its support cases.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  -- Messages go by the cascade from their case.
  DELETE FROM support_cases s WHERE s.subject_clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  -- 0127: the words of the clinic's replies in the approval inbox go with it;
  -- the items stay, without them, as the record of what the owner allowed.
  UPDATE ops_approvals a SET draft = NULL
   WHERE a.kind = 'support_reply_send' AND a.subject_clinic_id = target_clinic AND a.draft IS NOT NULL;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_support_cases(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_support_cases(uuid) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_support_cases(uuid) IS
  'Deletes every support case (support_cases, 0125) of the clinic passed, open or closed, with its messages, and sets the draft of its support_reply_send approval items to NULL (0127), for destroyClinicData. Refuses unless that clinic is app.clinic_id and app_destruction_due() says it is due. Returns the count of cases.';--> statement-breakpoint

COMMENT ON TABLE support_messages IS
  'What passed on a support case (0125): a chat escalation''s fields (never words), and later screened inbound text, drafts and approved replies. A reply''s approved text, subject and hash are fixed by trigger once approved (0126); its text is deleted here 12 months after it was sent, and its approval item''s copy at the same age (0127). Withheld from the read-only role.';--> statement-breakpoint

DO $$
DECLARE
  forget oid := 'app_forget_support_reply_drafts(timestamptz)'::regprocedure;
  destroy oid := 'app_destroy_support_cases(uuid)'::regprocedure;
  r name;
  trig record;
BEGIN
  -- The runtime role still cannot touch a draft itself, nor anything but a decision's three columns.
  IF has_column_privilege('healdesk_app'::name, 'ops_approvals'::regclass, 'draft', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'ops_approvals'::regclass, 'draft_hash', 'UPDATE')
     OR has_table_privilege('healdesk_app'::name, 'ops_approvals'::regclass, 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or erase an approval item.';
  END IF;
  IF NOT has_function_privilege('healdesk_app'::name, forget, 'EXECUTE')
     OR NOT has_function_privilege('healdesk_app'::name, destroy, 'EXECUTE') THEN
    RAISE EXCEPTION 'healdesk_app cannot call the support retention functions.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid IN (forget, destroy) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can call a support retention function.';
  END IF;
  FOREACH r IN ARRAY ARRAY['healdesk_readonly', 'healdesk_writer']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND (has_function_privilege(r, forget, 'EXECUTE') OR has_function_privilege(r, destroy, 'EXECUTE')) THEN
      RAISE EXCEPTION '% can call a support retention function.', r;
    END IF;
  END LOOP;
  FOR trig IN
    SELECT t.tgname, t.tgenabled FROM pg_trigger t
     WHERE t.tgname IN ('support_cases_guard', 'ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')
  LOOP
    IF trig.tgenabled <> 'A' THEN
      RAISE EXCEPTION 'trigger % is not ENABLE ALWAYS', trig.tgname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('support_cases_guard', 'ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')) <> 5 THEN
    RAISE EXCEPTION 'an approval inbox guard trigger is missing';
  END IF;
END
$$;

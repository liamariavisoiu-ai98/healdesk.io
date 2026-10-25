CREATE TABLE "support_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"subject_clinic_id" uuid,
	"source" text NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"category" text NOT NULL,
	"symptom" text NOT NULL,
	"urgency" text NOT NULL,
	"assignee_label" text,
	"reply_by_on" date NOT NULL,
	"snoozed_until" timestamp with time zone,
	"phi_suspected" boolean DEFAULT false NOT NULL,
	"hidden_numbers" integer DEFAULT 0 NOT NULL,
	"hidden_emails" integer DEFAULT 0 NOT NULL,
	"hidden_treatments" integer DEFAULT 0 NOT NULL,
	"clinical_matches" integer DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_inbound_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_outbound_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"inbound_text_delete_after" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_cases_ref_check" CHECK ("support_cases"."ref" ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'),
	CONSTRAINT "support_cases_source_check" CHECK ("support_cases"."source" in ('email', 'chat')),
	CONSTRAINT "support_cases_state_check" CHECK ("support_cases"."state" in ('new', 'drafting', 'drafted', 'needs_edit', 'waiting_clinic', 'snoozed', 'closed')),
	CONSTRAINT "support_cases_category_check" CHECK ("support_cases"."category" in ('forwarding', 'calendar', 'channel', 'plan', 'billing', 'transcript', 'sign_in', 'other')),
	CONSTRAINT "support_cases_symptom_check" CHECK ("support_cases"."symptom" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "support_cases_urgency_check" CHECK ("support_cases"."urgency" in ('now', 'today', 'this_week')),
	CONSTRAINT "support_cases_closed_check" CHECK (("support_cases"."state" = 'closed') = ("support_cases"."closed_at" is not null) and ("support_cases"."state" = 'closed') = ("support_cases"."closed_reason" is not null) and ("support_cases"."closed_reason" is null or "support_cases"."closed_reason" in ('replied_by_hand', 'no_reply_needed', 'duplicate', 'not_a_clinic', 'spam', 'no_further_reply'))),
	CONSTRAINT "support_cases_snoozed_check" CHECK (("support_cases"."state" = 'snoozed') = ("support_cases"."snoozed_until" is not null)),
	CONSTRAINT "support_cases_assignee_check" CHECK ("support_cases"."assignee_label" is null or (char_length("support_cases"."assignee_label") between 1 and 60 and "support_cases"."assignee_label" ~ '^[A-Za-z][A-Za-z .''-]*$')),
	CONSTRAINT "support_cases_counts_check" CHECK ("support_cases"."hidden_numbers" >= 0 and "support_cases"."hidden_emails" >= 0 and "support_cases"."hidden_treatments" >= 0 and "support_cases"."clinical_matches" >= 0 and ("support_cases"."phi_suspected" or "support_cases"."hidden_numbers" + "support_cases"."hidden_emails" + "support_cases"."hidden_treatments" + "support_cases"."clinical_matches" = 0)),
	CONSTRAINT "support_cases_chat_check" CHECK ("support_cases"."source" <> 'chat' or ("support_cases"."subject_clinic_id" is not null and not "support_cases"."phi_suspected" and "support_cases"."hidden_numbers" + "support_cases"."hidden_emails" + "support_cases"."hidden_treatments" + "support_cases"."clinical_matches" = 0))
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" uuid,
	"fields_json" jsonb,
	"message_id" text,
	"in_reply_to" text,
	"subject_screened" text,
	"text" text,
	"draft_text" text,
	"draft_version" integer,
	"facts_json" jsonb,
	"checks_json" jsonb,
	"approved_by_label" text,
	"approved_at" timestamp with time zone,
	"delivery_id" uuid,
	"attachments_json" jsonb,
	"received_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_messages_direction_check" CHECK ("support_messages"."direction" in ('in', 'out')),
	CONSTRAINT "support_messages_kind_check" CHECK ("support_messages"."kind" in ('email', 'chat_escalation', 'ack', 'reply')),
	CONSTRAINT "support_messages_chat_check" CHECK (("support_messages"."kind" = 'chat_escalation') = ("support_messages"."request_id" is not null) and ("support_messages"."kind" <> 'chat_escalation' or ("support_messages"."direction" = 'in' and "support_messages"."text" is null and "support_messages"."subject_screened" is null and "support_messages"."draft_text" is null and "support_messages"."attachments_json" is null and "support_messages"."message_id" is null and "support_messages"."in_reply_to" is null and "support_messages"."fields_json" is not null))),
	CONSTRAINT "support_messages_fields_check" CHECK ("support_messages"."fields_json" is null or (jsonb_typeof("support_messages"."fields_json") = 'object' and char_length("support_messages"."fields_json"::text) <= 1000 and position('@' in "support_messages"."fields_json"::text) = 0 and "support_messages"."fields_json"::text !~ '[0-9]{3,}')),
	CONSTRAINT "support_messages_inbound_check" CHECK ("support_messages"."direction" <> 'in' or ("support_messages"."draft_text" is null and "support_messages"."draft_version" is null and "support_messages"."approved_by_label" is null and "support_messages"."approved_at" is null and "support_messages"."delivery_id" is null and "support_messages"."sent_at" is null)),
	CONSTRAINT "support_messages_text_check" CHECK (("support_messages"."text" is null or char_length("support_messages"."text") <= 20000) and ("support_messages"."draft_text" is null or char_length("support_messages"."draft_text") <= 20000) and ("support_messages"."subject_screened" is null or char_length("support_messages"."subject_screened") <= 300) and ("support_messages"."message_id" is null or char_length("support_messages"."message_id") <= 998) and ("support_messages"."in_reply_to" is null or char_length("support_messages"."in_reply_to") <= 998)),
	CONSTRAINT "support_messages_draft_check" CHECK (("support_messages"."draft_text" is null) = ("support_messages"."draft_version" is null) and ("support_messages"."draft_version" is null or "support_messages"."draft_version" >= 1)),
	CONSTRAINT "support_messages_approved_check" CHECK (("support_messages"."approved_by_label" is null) = ("support_messages"."approved_at" is null) and ("support_messages"."approved_by_label" is null or (char_length("support_messages"."approved_by_label") between 1 and 60 and "support_messages"."approved_by_label" ~ '^[A-Za-z][A-Za-z .''-]*$')))
);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_subject_clinic_id_clinics_id_fk" FOREIGN KEY ("subject_clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_cases_ref_key" ON "support_cases" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "support_cases_open_chat_key" ON "support_cases" USING btree ("subject_clinic_id","category") WHERE "support_cases"."source" = 'chat' and "support_cases"."state" <> 'closed';--> statement-breakpoint
CREATE INDEX "support_cases_state_idx" ON "support_cases" USING btree ("state","reply_by_on");--> statement-breakpoint
CREATE INDEX "support_cases_clinic_idx" ON "support_cases" USING btree ("subject_clinic_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_request_key" ON "support_messages" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "support_messages_case_idx" ON "support_messages" USING btree ("case_id","created_at");--> statement-breakpoint
-- =============================================================================
-- The support team's cases (25 October 2026; ops automation Phase 7, lane
-- P7a; design E5 §2.2). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- The portal's support chat already escalates to hello@ (I3) and tells the
-- clinic when a person will reply (L25), but nothing recorded the request
-- as a thing with a state: the owner's only view was a list of escalations
-- with a "Mark replied" button. The owner wants a calm, automated support
-- team where every request is a CASE with a state and a reply-by day, and
-- every composed reply is drafted for him to approve (lanes P7b, P7c).
--
--   support_cases     one row per request: its ref (five characters of
--                     Crockford base32, printed HD-xxxxx), the clinic it is
--                     about (null for an email nobody matched, which only
--                     the later inbound slice can write), where it came
--                     from, its state, topic, symptom and urgency, who has
--                     it, the reply-by day, and when and why it closed. No
--                     text. One open chat case per clinic and topic (a
--                     partial unique index), so a second escalation about
--                     the same thing joins the first. Closed is final.
--   support_messages  what passed on a case. A chat escalation holds its
--                     request id and its fields, ids from fixed lists, and
--                     NULL text by CHECK; the guard refuses one on a case
--                     that did not come from the chat, and any message on
--                     a closed case. Inbound text may later only be set to
--                     NULL. The drafts, the approved text and the delivery
--                     columns are for lanes P7b and P7c.
--
-- Platform-wide, like ops_alerts and ops_approvals, not tenant tables: the
-- console lists cases across clinics and an unmatched email has no clinic,
-- so the clinic is subject_clinic_id and there is no RLS
-- (tests/rls-drift.test.ts holds every table with a clinic_id to FORCE RLS).
-- What a tenant table would give is kept another way: the guard below
-- refuses a case naming a clinic unless the write runs in that clinic's
-- tenant (it must read the clinic's row, FOR SHARE), so a write cannot name
-- a clinic it was not inside, nor one that has been destroyed or closed.
--
-- Destruction (owner's rule of 25 October 2026 for rights records, applied
-- here): a clinic's cases go WITH the clinic. app_destroy_support_cases()
-- deletes them and their messages, open or closed, called by
-- destroyClinicData beside the other deletes, on the same floor
-- (app_destruction_due) and only in the clinic's own tenant. It locks the
-- clinic's row FOR UPDATE before it deletes, so a case racing the
-- destruction either commits first and is deleted, or waits for the stamp
-- and is refused. app_mark_clinic_destroyed() is not redefined: it checks
-- tenant tables, and this one has none; the delete above runs in the same
-- transaction before the stamp. Cases with no clinic are kept 12 months
-- after they close; none can exist until the inbound slice, which brings
-- that sweep with it (follow-up S7, with the 30- and 7-day text sweep).
--
-- Grants: the runtime role reads, inserts and updates only the columns that
-- move; it can never delete or truncate either table.
--
-- Safe to apply in place: two new, empty tables and functions.
-- =============================================================================

REVOKE ALL ON support_cases FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON support_cases TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (state, category, symptom, urgency, assignee_label, reply_by_on, snoozed_until,
  subject_clinic_id, phi_suspected, hidden_numbers, hidden_emails, hidden_treatments, clinical_matches,
  last_inbound_at, last_outbound_at, closed_at, closed_reason, inbound_text_delete_after, updated_at)
  ON support_cases TO healdesk_app;--> statement-breakpoint
REVOKE ALL ON support_messages FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON support_messages TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (message_id, subject_screened, text, draft_text, draft_version, facts_json, checks_json,
  approved_by_label, approved_at, delivery_id, sent_at)
  ON support_messages TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_support_cases_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  found boolean;
  destroyed timestamptz;
  closed timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state = 'closed' THEN
      RAISE EXCEPTION 'support case % is closed; a clinic that writes again opens a new case', OLD.ref
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.ref <> OLD.ref OR NEW.source <> OLD.source OR NEW.opened_at <> OLD.opened_at THEN
      RAISE EXCEPTION 'a support case''s id, ref, source and opening time are fixed'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.subject_clinic_id IS NOT NULL AND NEW.subject_clinic_id IS DISTINCT FROM OLD.subject_clinic_id THEN
      RAISE EXCEPTION 'support case % already names its clinic', OLD.ref
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.state <> 'new' THEN
      RAISE EXCEPTION 'a support case is born new'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- A clinic named for the first time: the write must run in that clinic's
  -- tenant (its row is visible only there, FORCE RLS), and the clinic must
  -- not have left. FOR SHARE, so app_destroy_support_cases() (FOR UPDATE)
  -- and this write are ordered.
  IF NEW.subject_clinic_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.subject_clinic_id IS NULL) THEN
    SELECT true, c.destroyed_at, c.account_closed_at INTO found, destroyed, closed
      FROM clinics c WHERE c.id = NEW.subject_clinic_id FOR SHARE;
    IF found IS NOT TRUE THEN
      RAISE EXCEPTION 'a support case names clinic % from outside its tenant', NEW.subject_clinic_id
        USING ERRCODE = '42501';
    END IF;
    IF destroyed IS NOT NULL OR closed IS NOT NULL THEN
      RAISE EXCEPTION 'clinic % has left; its support cases went with its data', NEW.subject_clinic_id
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_cases_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER support_cases_guard
  BEFORE INSERT OR UPDATE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION app_support_cases_guard();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_support_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  case_state text;
  case_source text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT s.state, s.source INTO case_state, case_source
      FROM support_cases s WHERE s.id = NEW.case_id FOR SHARE;
    IF case_state = 'closed' THEN
      RAISE EXCEPTION 'support case % is closed; it takes no new message', NEW.case_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.kind = 'chat_escalation' AND case_source IS DISTINCT FROM 'chat' THEN
      RAISE EXCEPTION 'a chat escalation belongs on a case that came from the chat'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.direction <> OLD.direction
     OR NEW.kind <> OLD.kind OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.fields_json IS DISTINCT FROM OLD.fields_json
     OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to
     OR NEW.attachments_json IS DISTINCT FROM OLD.attachments_json
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a support message''s identity and what it carried in are fixed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'a support message''s mail id is fixed once set'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- What came in is only ever deleted, never rewritten: the retention sweep
  -- sets it to NULL, and nothing else may change it.
  IF OLD.direction = 'in' AND (
       (NEW.text IS DISTINCT FROM OLD.text AND NEW.text IS NOT NULL)
       OR (NEW.subject_screened IS DISTINCT FROM OLD.subject_screened AND NEW.subject_screened IS NOT NULL)) THEN
    RAISE EXCEPTION 'inbound support text is never rewritten, only deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_messages_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER support_messages_guard
  BEFORE INSERT OR UPDATE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION app_support_messages_guard();--> statement-breakpoint

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
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_support_cases(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_support_cases(uuid) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_support_cases(uuid) IS
  'Deletes every support case (support_cases, 0125) of the clinic passed, open or closed, with its messages, for destroyClinicData. Refuses unless that clinic is app.clinic_id and app_destruction_due() says it is due. Returns the count of cases.';--> statement-breakpoint

COMMENT ON TABLE support_cases IS
  'One row per support request (0125): ref, clinic, source, state, topic, urgency, reply-by day, closure. No text. Platform-wide, no RLS; a clinic''s cases are deleted at its destruction (app_destroy_support_cases).';--> statement-breakpoint
COMMENT ON TABLE support_messages IS
  'What passed on a support case (0125): a chat escalation''s fields (never words), and later screened inbound text, drafts and approved replies. Withheld from the read-only role.';--> statement-breakpoint

DO $$
DECLARE
  fn oid := 'app_destroy_support_cases(uuid)'::regprocedure;
  r name;
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'support_cases'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'support_cases'::regclass, 'TRUNCATE')
     OR has_table_privilege('healdesk_app'::name, 'support_messages'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'support_messages'::regclass, 'TRUNCATE') THEN
    RAISE EXCEPTION 'healdesk_app can delete support cases or messages; only app_destroy_support_cases() may.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'support_cases'::regclass, 'ref', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'support_cases'::regclass, 'source', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'fields_json', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'request_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can update a support case''s or message''s fixed columns.';
  END IF;
  IF NOT has_function_privilege('healdesk_app'::name, fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'healdesk_app cannot call app_destroy_support_cases(), which destroyClinicData needs.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can call app_destroy_support_cases().';
  END IF;
  FOREACH r IN ARRAY ARRAY['healdesk_readonly', 'healdesk_writer']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% can call app_destroy_support_cases().', r;
    END IF;
  END LOOP;
END
$$;

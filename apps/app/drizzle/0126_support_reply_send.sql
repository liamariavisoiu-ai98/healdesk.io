ALTER TABLE "ops_approvals" DROP CONSTRAINT "ops_approvals_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "reply_subject" text;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "approved_hash" text;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "next_send_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "send_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "send_stopped_reason" text;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "text_delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ops_approvals" ADD CONSTRAINT "ops_approvals_kind_check" CHECK ("ops_approvals"."kind" in ('billing_request_retry', 'overage_invoice_retry', 'billing_event_replay', 'baa_resign_chase', 'agreement_question', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'setup_reminder_now', 'incident_open_batch', 'incident_report_send', 'support_reply_send'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'closed_day_bookings', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'agreement_question', 'welcome', 'steps_sent', 'address_change_confirm', 'address_changing', 'agreement_to_sign', 'data_destroyed', 'baa_resign_chase', 'support_reply'));--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_reply_check" CHECK ("support_messages"."kind" <> 'reply' or ("support_messages"."direction" = 'out' and ("support_messages"."approved_at" is null) = ("support_messages"."approved_hash" is null) and ("support_messages"."approved_at" is null) = ("support_messages"."reply_subject" is null) and ("support_messages"."text" is null or "support_messages"."approved_at" is not null) and ("support_messages"."sent_at" is null or "support_messages"."approved_at" is not null) and ("support_messages"."next_send_at" is null or "support_messages"."approved_at" is not null)));--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_send_check" CHECK (("support_messages"."kind" = 'reply' or ("support_messages"."reply_subject" is null and "support_messages"."approved_hash" is null and "support_messages"."send_attempts" = 0 and "support_messages"."next_send_at" is null and "support_messages"."send_stopped_at" is null and "support_messages"."text_delete_after" is null)) and "support_messages"."send_attempts" between 0 and 6 and ("support_messages"."approved_hash" is null or "support_messages"."approved_hash" ~ '^[0-9a-f]{64}$') and ("support_messages"."reply_subject" is null or char_length("support_messages"."reply_subject") between 1 and 200) and ("support_messages"."send_stopped_at" is null) = ("support_messages"."send_stopped_reason" is null) and ("support_messages"."send_stopped_reason" is null or "support_messages"."send_stopped_reason" in ('dead', 'case_closed', 'clinic_left')) and not ("support_messages"."send_stopped_at" is not null and "support_messages"."sent_at" is not null) and ("support_messages"."text_delete_after" is null or "support_messages"."sent_at" is not null));-- =============================================================================
-- Approve and send a support reply (25 October 2026; ops automation Phase 7,
-- lane P7c; design E5 §2.1-§2.3 and §5.A; owner decision D12). The
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express.
--
-- The owner approves, edits and sends every composed support reply himself.
-- It is the one email in the product whose body is prose, so what makes it
-- safe is around it, not in it:
--
--   ops_approvals.kind      + support_reply_send: one item per reply draft
--                             version, its payload ids only (case, message,
--                             version, ref), the draft in `draft`; decided
--                             only with a fresh authenticator code, and the
--                             executor runs the reply checks again on the
--                             text approved before anything goes.
--   report_deliveries.kind  + support_reply (L37): a direct kind on the
--                             ledger, so the webhook relay marks delivery.
--   support_messages        a reply's frozen subject and the SHA-256 of the
--                             subject and approved text; how many sends were
--                             tried (at most six, the outbox's rule), when the
--                             next is due, and why the sending stopped
--                             without the email going; and the day its text
--                             is deleted, 12 months after it was sent.
--
-- The record is immutable by trigger, for every role: once a reply carries
-- its approval, its approved text, subject, hash, approval label and time,
-- and the draft it came from never change. The text may only be deleted
-- (set to NULL, the 12-month sweep), never rewritten. The same words also
-- stay in the approval item's draft (ops_approvals.draft, which 0119 makes
-- immutable): deleting those with the reply is the owner's open question. Its sent time,
-- delivery and stop are set once. app_support_messages_guard() is the
-- function 0125 created, redefined here with the reply rules added after
-- 0125's own, which are unchanged.
--
-- The runtime role may update only the new columns that move; no DELETE,
-- as before. Safe to apply in place: the new columns are empty or default
-- to 0 on every existing row, which the new CHECKs accept, and each kind
-- CHECK only widens.
-- =============================================================================

GRANT UPDATE (reply_subject, approved_hash, send_attempts, next_send_at, send_stopped_at, send_stopped_reason,
  text_delete_after)
  ON support_messages TO healdesk_app;--> statement-breakpoint

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
    -- 0126: a reply is born a draft. Its approval is set by an UPDATE, which
    -- the rules below then hold fixed.
    IF NEW.kind = 'reply' AND (NEW.approved_at IS NOT NULL OR NEW.sent_at IS NOT NULL OR NEW.text IS NOT NULL) THEN
      RAISE EXCEPTION 'a support reply is born a draft, unapproved and unsent'
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

  -- 0126: a reply's approval is the record of what the owner said yes to.
  IF OLD.kind = 'reply' THEN
    IF OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
       AND (NEW.text IS NULL OR NEW.approved_hash IS NULL OR NEW.reply_subject IS NULL OR NEW.approved_by_label IS NULL
            OR NEW.draft_text IS DISTINCT FROM OLD.draft_text OR NEW.draft_version IS DISTINCT FROM OLD.draft_version) THEN
      RAISE EXCEPTION 'a support reply is approved with its text, subject, hash and label together, and its draft as it stood'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.approved_at IS NOT NULL AND (
         NEW.approved_at IS DISTINCT FROM OLD.approved_at
         OR NEW.approved_by_label IS DISTINCT FROM OLD.approved_by_label
         OR NEW.approved_hash IS DISTINCT FROM OLD.approved_hash
         OR NEW.reply_subject IS DISTINCT FROM OLD.reply_subject
         OR NEW.draft_text IS DISTINCT FROM OLD.draft_text
         OR NEW.draft_version IS DISTINCT FROM OLD.draft_version
         OR (NEW.text IS NOT NULL AND NEW.text IS DISTINCT FROM OLD.text)) THEN
      RAISE EXCEPTION 'an approved support reply is fixed: its text may only be deleted, never rewritten'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (OLD.sent_at IS NOT NULL AND (NEW.sent_at IS DISTINCT FROM OLD.sent_at
             OR NEW.send_attempts IS DISTINCT FROM OLD.send_attempts
             OR NEW.next_send_at IS DISTINCT FROM OLD.next_send_at))
       OR (OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id)
       OR (OLD.text_delete_after IS NOT NULL AND NEW.text_delete_after IS DISTINCT FROM OLD.text_delete_after)
       OR (OLD.send_stopped_at IS NOT NULL AND (NEW.send_stopped_at IS DISTINCT FROM OLD.send_stopped_at
             OR NEW.send_stopped_reason IS DISTINCT FROM OLD.send_stopped_reason
             OR NEW.send_attempts IS DISTINCT FROM OLD.send_attempts
             OR NEW.next_send_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'a support reply''s send is recorded once'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.send_attempts < OLD.send_attempts THEN
      RAISE EXCEPTION 'a support reply''s tries only count up'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_messages_guard() FROM PUBLIC;--> statement-breakpoint
-- ALWAYS, so not even a session in replica mode writes past it.
ALTER TABLE support_messages ENABLE ALWAYS TRIGGER support_messages_guard;--> statement-breakpoint

COMMENT ON TABLE support_messages IS
  'What passed on a support case (0125): a chat escalation''s fields (never words), and later screened inbound text, drafts and approved replies. A reply''s approved text, subject and hash are fixed by trigger once approved (0126); its text is deleted here 12 months after it was sent (its approval item keeps the draft). Withheld from the read-only role.';--> statement-breakpoint

DO $$
DECLARE
  trig "char";
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'support_messages'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'support_messages'::regclass, 'TRUNCATE') THEN
    RAISE EXCEPTION 'healdesk_app can delete support messages.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'approved_hash', 'UPDATE')
     OR NOT has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'send_attempts', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot record a support reply''s send.';
  END IF;
  SELECT t.tgenabled INTO trig FROM pg_trigger t WHERE t.tgname = 'support_messages_guard';
  IF trig IS DISTINCT FROM 'A' THEN
    RAISE EXCEPTION 'the support messages guard trigger is missing or not ENABLE ALWAYS';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('ops_approvals_guard', 'ops_approvals_no_truncate', 'ops_approval_events_add_only', 'ops_approval_events_no_truncate')
         AND tgenabled = 'A') <> 4 THEN
    RAISE EXCEPTION 'an approval inbox guard trigger is missing or not ENABLE ALWAYS';
  END IF;
END
$$;

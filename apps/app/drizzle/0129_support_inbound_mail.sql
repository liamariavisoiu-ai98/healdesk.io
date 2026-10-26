ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "inbound_mail_id" text;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "sender_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_inbound_mail_key" ON "support_messages" USING btree ("inbound_mail_id");--> statement-breakpoint
CREATE INDEX "support_messages_sender_idx" ON "support_messages" USING btree ("sender_ref","received_at");--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'closed_day_bookings', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'agreement_question', 'support_received'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'closed_day_bookings', 'setup_extended', 'setup_waiting_on_us', 'setup_help_offer', 'agreement_question', 'support_received', 'welcome', 'steps_sent', 'address_change_confirm', 'address_changing', 'agreement_to_sign', 'data_destroyed', 'baa_resign_chase', 'support_reply'));--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_email_check" CHECK (("support_messages"."kind" = 'email') = ("support_messages"."inbound_mail_id" is not null) and ("support_messages"."kind" = 'email') = ("support_messages"."sender_ref" is not null) and ("support_messages"."kind" <> 'email' or ("support_messages"."direction" = 'in' and "support_messages"."text" is null and "support_messages"."subject_screened" is null and "support_messages"."draft_text" is null and "support_messages"."received_at" is not null and "support_messages"."fields_json" is not null and "support_messages"."inbound_mail_id" ~ '^[A-Za-z0-9._-]{1,128}$' and "support_messages"."sender_ref" ~ '^[0-9a-f]{64}$' and ("support_messages"."attachments_json" is null or (jsonb_typeof("support_messages"."attachments_json") = 'object' and char_length("support_messages"."attachments_json"::text) <= 300 and "support_messages"."attachments_json"::text ~ '^[a-z0-9_{}":, ]*$')))));--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_email_ids_check" CHECK ("support_messages"."kind" <> 'email' or (("support_messages"."message_id" is null or (char_length("support_messages"."message_id") <= 250 and "support_messages"."message_id" ~ '^<[A-Za-z0-9!#$%&*+.=?^_{|}~-]{1,200}@[A-Za-z0-9._-]{1,200}>$')) and ("support_messages"."in_reply_to" is null or (char_length("support_messages"."in_reply_to") <= 250 and "support_messages"."in_reply_to" ~ '^<[A-Za-z0-9!#$%&*+.=?^_{|}~-]{1,200}@[A-Za-z0-9._-]{1,200}>$'))));-- =============================================================================
-- Inbound support mail (26 October 2026; ops automation Phase 7, lane P7g;
-- design E5 §2.1-§2.3; owner decisions D13 and D14). The statements above
-- were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- A clinic's email to hello@healdesk.io reaches SES on in.healdesk.io (the
-- owner's mailbox forwards it; infra/aws/ses-inbound.tf), and apps/app turns
-- it into a support case. FACTS ONLY (the owner's rule for this lane, the
-- same as slice 1's "no inbound text exists"): the message is parsed in
-- memory and reduced to words from fixed lists, and the raw object is
-- deleted in the same request (lib/support/inbound). Nothing a clinic wrote
-- is stored: not the body, not the subject, not the sender's name, not an
-- attachment's name.
--
--   support_messages     + inbound_mail_id: SES's own message id, unique, so
--                          a notice SNS delivers twice, or the hourly sweep
--                          reading an object the webhook already took, is
--                          the same row and opens no second case and queues
--                          no second acknowledgement;
--                        + sender_ref: an HMAC-SHA256 of the sender's
--                          lower-cased address (lib/support/inbound/
--                          sender.ts), so the hour's mail from one address
--                          is counted (a fourth gets no acknowledgement)
--                          without the address being kept;
--                        support_messages_email_check: an inbound email has
--                          NULL text, NULL subject and NULL draft, always; its
--                          fields (topic, symptom, urgency, how it was
--                          matched, SES's verdicts, the capped counts of what
--                          the screen found) are fixed words held by 0125's
--                          fields CHECK (no '@', no run of three digits); its
--                          attachment summary is a count, type classes and a
--                          size bucket in lower-case words (so no file name,
--                          which would need a dot or a capital, can be
--                          stored); and only an email has SES's id and the
--                          sender's reference.
--   billing_notices.kind + support_received (L38), the fixed "We've got your
--   report_deliveries    email" with the case's ref (owner decision D14: a
--                          fixed acknowledgement needs no approval).
--   scheduled_jobs       + support-inbound-sweep, seeded OFF: hourly, reads
--                          what a failed handler left in the bucket.
--   app_support_closed_account_for_address(address)
--                          whether a closed account's kept notice address
--                          (clinics.notice_address, 0096) is this one: a
--                          former clinic writing. The case cannot name that
--                          clinic (0125's guard refuses a clinic that has
--                          left), so it is a fact on the message, and ops
--                          decides.
--
-- The runtime role's grants are unchanged: it inserts support_messages
-- (every column, 0125) and updates none of the new columns, which the
-- 0125/0126 guard holds fixed in any case (identity columns). Safe to apply
-- in place: two empty columns, their indexes, a CHECK every existing row
-- passes (no row is kind 'email' before this lane), two kind CHECKs that
-- only widen, a function and a job row.
-- =============================================================================

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('support-inbound-sweep', 'Hourly from the tick: reads the inbound mail bucket for any message the webhook did not take (a failed handler, a notice SNS gave up on), turns each into a support case like the webhook does, deletes it, and deletes anything older than a day. Reports counts only. Sends nothing to a clinic except the fixed acknowledgement. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_support_closed_account_for_address(address text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM clinics c
     WHERE c.account_closed_at IS NOT NULL
       AND c.notice_address IS NOT NULL
       AND c.notice_address_until > clock_timestamp()
       AND lower(btrim(c.notice_address)) = lower(btrim(address))
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_closed_account_for_address(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_support_closed_account_for_address(text) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_support_closed_account_for_address(text) IS
  'Whether the address is a closed account''s kept notice address (0096), still within its six years (0129, inbound support mail): yes or no, never which clinic. Business contact data.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_delete_unmatched_email_cases(as_of timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  -- Never later than the database's own clock, so a caller cannot bring a deletion forward.
  cutoff timestamptz := least(coalesce(as_of, now()), now()) - interval '30 days';
  gone integer;
BEGIN
  -- Messages go by the cascade from their case.
  DELETE FROM support_cases s
   WHERE s.source = 'email'
     AND s.subject_clinic_id IS NULL
     AND s.state = 'closed'
     AND s.closed_at < cutoff;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_delete_unmatched_email_cases(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_delete_unmatched_email_cases(timestamptz) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_delete_unmatched_email_cases(timestamptz) IS
  'Deletes every support case that came by email, names no clinic and closed more than 30 days before the earlier of the time passed and now(), with its messages (0129): the retention of a prospect''s, a stranger''s or a closed account''s email. Returns the count of cases.';--> statement-breakpoint

DO $$
DECLARE
  fn oid := 'app_support_closed_account_for_address(text)'::regprocedure;
  r name;
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'support_messages'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can delete support messages.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'inbound_mail_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'sender_ref', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can update an inbound email''s SES id or sender reference.';
  END IF;
  IF NOT has_function_privilege('healdesk_app'::name, fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'healdesk_app cannot call app_support_closed_account_for_address().';
  END IF;
  IF NOT has_function_privilege('healdesk_app'::name, 'app_delete_unmatched_email_cases(timestamptz)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'healdesk_app cannot call app_delete_unmatched_email_cases().';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = 'app_delete_unmatched_email_cases(timestamptz)'::regprocedure
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can call app_delete_unmatched_email_cases().';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              WHERE p.oid = fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can call app_support_closed_account_for_address().';
  END IF;
  FOREACH r IN ARRAY ARRAY['healdesk_readonly', 'healdesk_writer']::name[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% can call app_support_closed_account_for_address().', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND has_function_privilege(r, 'app_delete_unmatched_email_cases(timestamptz)'::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% can call app_delete_unmatched_email_cases().', r;
    END IF;
  END LOOP;
END
$$;

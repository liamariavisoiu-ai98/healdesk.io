ALTER TABLE "transcript_emails" DROP CONSTRAINT "transcript_emails_status_check";--> statement-breakpoint
ALTER TABLE "transcript_emails" DROP CONSTRAINT "transcript_emails_sent_check";--> statement-breakpoint
DROP INDEX "transcript_emails_destroy_idx";--> statement-breakpoint
ALTER TABLE "transcript_emails" ALTER COLUMN "sealed" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "transcript_emails_unconfirmed_idx" ON "transcript_emails" USING btree ("clinic_id","sent_at") WHERE "transcript_emails"."status" = 'sent';--> statement-breakpoint
CREATE INDEX "transcript_emails_destroy_idx" ON "transcript_emails" USING btree ("clinic_id","destroy_after") WHERE "transcript_emails"."sealed" is not null;--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_status_check" CHECK ("transcript_emails"."status" in ('open', 'pending', 'sent', 'bounced', 'delivered', 'expired', 'unconfirmed'));--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_sent_check" CHECK (("transcript_emails"."status" in ('open', 'pending', 'expired')) or ("transcript_emails"."sent_at" is not null and "transcript_emails"."ses_message_id" is not null));--> statement-breakpoint

-- =============================================================================
-- The sealed copy is deleted the moment delivery is confirmed (the owner's
-- decision of 14 October 2026). The statements above were generated from
-- schema.ts, but for one, transcript_emails_sealed_check, which is moved below
-- the rows already there; everything else below is the part drizzle cannot
-- express.
--
-- Until now each transcript's sealed copy waited in the outbox until seven
-- days after SES first accepted the email, delivered or not, so that a clinic
-- that lost the email could be sent it again (0069). The owner now wants no
-- copy kept once the clinic has it:
--
--   * delivered. SES's Delivery event for the message id the row records
--     (the clinic's mail server accepted it) sets the copy to NULL, the status
--     to delivered and delivered_at, in the webhook's one transaction
--     (recordSesTranscriptEvent, lib/conversations/transcript-outbox.ts);
--   * not delivered. A failed send is tried again with the same back-off, a
--     bounce, a rejection, a complaint or a rendering failure is sent again an
--     hour later, but never past destroy_after, which is now created_at plus
--     30 days and never moves: then the copy is deleted and the row expired,
--     so a dead address never keeps patient words for longer;
--   * accepted and never answered. Neither a Delivery nor a bounce, a
--     rejection, a complaint or a rendering failure 72 hours after the last
--     accepted send (sent_at, the database's clock): the copy is deleted and
--     the row unconfirmed. A transient bounce or a delay is SES still trying,
--     not an answer.
--
-- What stays is a receipt without the words: the conversation, the attempts,
-- sent_at, delivered_at, SES's message id, the status and SES's own reason,
-- scrubbed, so the owner and the clinic can know whether each transcript
-- reached the clinic. It goes with its conversation, as before (the foreign
-- key's cascade, the record clock, erasure, destruction: 0069's
-- app_mark_clinic_destroyed and destroyClinicData still cover the table).
--
-- What the database holds to, whatever the writer sends:
--
--   * sealed is NULL exactly when the status is delivered, expired or
--     unconfirmed (transcript_emails_sealed_check);
--   * a copy changes only while an open web chat stays open (0071), or to
--     NULL as its row becomes a receipt; never from NULL back to a value, and
--     a receipt never changes again, its status included;
--   * the clinic, the conversation and created_at never change, as before;
--   * the clocks are the database's: created_at at the insert; destroy_after
--     created_at plus 30 days, never moved; sent_at at each accepted send;
--     delivered_at when the status moves to delivered. A row expires only
--     once destroy_after has passed, and is unconfirmed only from sent, 72
--     hours after sent_at, both by clock_timestamp();
--   * the runtime role's grants are what the code needs: SELECT, INSERT and
--     DELETE (destroyClinicData), and UPDATE of the status, attempts, the
--     lease, last_error, the message id, the two send clocks and the copy
--     (to grow an open chat and to set it to NULL). The trigger, not the
--     grant, decides what each of those may become.
--
-- Safe to apply in place. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md), and migrations have only run on fresh databases, but a row
-- already there is brought to the new rules first: a delivered one loses its
-- copy, and every one gets the 30-day cap from its own created_at.
-- =============================================================================

-- The rows already there, before the CHECK that a delivered one breaks. The
-- table forces row-level security, which binds its owner too, so the owner
-- stands it aside for the length of this transaction, as it stands the clock
-- trigger aside, and restores both.
ALTER TABLE transcript_emails NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transcript_emails DISABLE TRIGGER transcript_emails_clock;--> statement-breakpoint
UPDATE transcript_emails SET sealed = NULL WHERE status = 'delivered';--> statement-breakpoint
UPDATE transcript_emails SET destroy_after = created_at + interval '30 days';--> statement-breakpoint
ALTER TABLE transcript_emails ENABLE TRIGGER transcript_emails_clock;--> statement-breakpoint
ALTER TABLE transcript_emails FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_sealed_check" CHECK (("transcript_emails"."status" in ('delivered', 'expired', 'unconfirmed')) = ("transcript_emails"."sealed" is null));--> statement-breakpoint

REVOKE ALL ON transcript_emails FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON transcript_emails TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (sealed, status, attempts, next_attempt_at, last_error, ses_message_id, sent_at, delivered_at) ON transcript_emails TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_transcript_email_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A row is born holding its copy: a call queued, or a web chat opened.
    IF NEW.status NOT IN ('open', 'pending') OR NEW.sealed IS NULL THEN
      RAISE EXCEPTION 'transcript_emails: a transcript is queued with its sealed copy, open or pending'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := clock_timestamp();
    NEW.destroy_after := NEW.created_at + interval '30 days';
    NEW.sent_at := NULL;
    NEW.delivered_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'transcript_emails: a queued transcript is never rewritten'
      USING ERRCODE = '42501';
  END IF;

  -- A receipt is final: its copy is gone, and nothing about it changes again.
  IF OLD.status IN ('delivered', 'expired', 'unconfirmed') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'transcript_emails: a delivered, expired or unconfirmed transcript is a receipt, and never changes'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- The copy: an open web chat's grows with the chat (0071); any other
  -- changes only to NULL, as its row becomes a receipt.
  IF NEW.sealed IS DISTINCT FROM OLD.sealed THEN
    IF NEW.sealed IS NULL THEN
      IF NEW.status NOT IN ('delivered', 'expired', 'unconfirmed') THEN
        RAISE EXCEPTION 'transcript_emails: a copy is deleted only as its transcript is delivered, expires or goes unconfirmed'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NOT (OLD.status = 'open' AND NEW.status = 'open') THEN
      RAISE EXCEPTION 'transcript_emails: a queued transcript is never rewritten'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Nothing goes back to open.
  IF NEW.status = 'open' AND OLD.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'transcript_emails: a transcript on its way is never reopened'
      USING ERRCODE = '42501';
  END IF;

  -- Each end on its own condition, by this database's clock.
  IF NEW.status = 'delivered' AND OLD.ses_message_id IS NULL THEN
    RAISE EXCEPTION 'transcript_emails: only a transcript SES accepted can be delivered'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'expired' AND OLD.destroy_after > clock_timestamp() THEN
    RAISE EXCEPTION 'transcript_emails: a transcript expires only 30 days after it was queued'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'unconfirmed'
     AND (OLD.status <> 'sent' OR OLD.sent_at IS NULL OR OLD.sent_at + interval '72 hours' > clock_timestamp()) THEN
    RAISE EXCEPTION 'transcript_emails: a transcript is unconfirmed only 72 hours after a send nothing answered'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The clocks. The 30-day cap never moves. Each accepted send records its
  -- own time, from which the 72 hours run; delivery records the database's.
  NEW.destroy_after := OLD.destroy_after;
  IF NEW.sent_at IS NULL THEN
    NEW.sent_at := OLD.sent_at;
  ELSIF NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    NEW.sent_at := clock_timestamp();
  END IF;
  IF NEW.status = 'delivered' THEN
    NEW.delivered_at := clock_timestamp();
  ELSE
    NEW.delivered_at := OLD.delivered_at;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_transcript_email_work: what the outbox job has to do, across clinics.
-- -----------------------------------------------------------------------------
-- 0069's tenant walk, and still ids only. What is due is one of three:
--   expire       a copy past its 30-day cap that was never delivered (open,
--                pending, bounced, or sent and not yet answered): deleted,
--                the row expired;
--   unconfirmed  sent, with no answer from SES 72 hours after the send:
--                deleted, the row unconfirmed;
--   send         open, pending or bounced, and due again.
-- The two deletions come first, so nothing past its cap is sent again. Never
-- the sealed copy, which the job reads inside withTenant() when it claims the
-- row; never a receipt, which has nothing left to do.
CREATE OR REPLACE FUNCTION app_transcript_email_work(p_limit integer)
RETURNS TABLE (clinic_id uuid, id uuid, due text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  now_ timestamptz := clock_timestamp();
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT w.clinic_id, w.id, w.due
        FROM (
          SELECT t.clinic_id, t.id, t.next_attempt_at,
                 CASE
                   WHEN t.destroy_after <= now_ THEN 'expire'
                   WHEN t.status = 'sent' AND t.sent_at + interval '72 hours' <= now_ THEN 'unconfirmed'
                   WHEN t.status IN ('open', 'pending', 'bounced') AND t.next_attempt_at <= now_ THEN 'send'
                 END AS due
            FROM transcript_emails t
           WHERE t.clinic_id = c.id
             AND t.status IN ('open', 'pending', 'sent', 'bounced')
        ) w
       WHERE w.due IS NOT NULL
       ORDER BY CASE w.due WHEN 'expire' THEN 0 WHEN 'unconfirmed' THEN 1 ELSE 2 END, w.next_attempt_at
       LIMIT greatest(least(p_limit, 500), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_transcript_email_work(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_transcript_email_work(integer) TO healdesk_app;--> statement-breakpoint

-- The job's switch stays as 0069 seeded it, on, and still governs sending
-- only: the two deletions run whatever it says (runTranscriptEmailsJob). Its
-- description says what it now does.
UPDATE scheduled_jobs
   SET cadence = 'Every minute, from the billing-minute queue: sends each queued transcript to its clinic through SES and retries a failed or bounced one with back-off; deletes each sealed copy SES has not reported delivered 30 days after it was queued, or 72 hours after a send nothing answered (a delivered one is deleted by SES''s event)'
 WHERE name = 'transcript-emails';

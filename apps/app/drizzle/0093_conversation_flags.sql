CREATE TABLE "conversation_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"source" text NOT NULL,
	"conversation_id" uuid,
	"thread_conversation_id" uuid,
	"thread_party_ref" text,
	"channel" text NOT NULL,
	"outcome" text,
	"conversation_started_at" timestamp with time zone NOT NULL,
	"flagged_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "conversation_flags_source_check" CHECK ("conversation_flags"."source" in ('call_or_chat', 'meta_thread')),
	CONSTRAINT "conversation_flags_target_check" CHECK (("conversation_flags"."source" = 'call_or_chat' and "conversation_flags"."conversation_id" is not null and "conversation_flags"."thread_conversation_id" is null and "conversation_flags"."thread_party_ref" is null)
        or ("conversation_flags"."source" = 'meta_thread' and "conversation_flags"."conversation_id" is null and "conversation_flags"."thread_conversation_id" is not null and "conversation_flags"."thread_party_ref" is not null
            and "conversation_flags"."channel" in ('instagram', 'messenger', 'whatsapp'))),
	CONSTRAINT "conversation_flags_channel_check" CHECK ("conversation_flags"."channel" in ('voice', 'web_chat', 'instagram', 'messenger', 'whatsapp', 'sms', 'web_form')),
	CONSTRAINT "conversation_flags_outcome_check" CHECK ("conversation_flags"."outcome" is null or "conversation_flags"."outcome" in ('answered', 'booked', 'request', 'handover', 'urgent')),
	CONSTRAINT "conversation_flags_party_ref_check" CHECK ("conversation_flags"."thread_party_ref" is null or char_length("conversation_flags"."thread_party_ref") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "conversation_flags" ADD CONSTRAINT "conversation_flags_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_flags" ADD CONSTRAINT "conversation_flags_conversation_fk" FOREIGN KEY ("clinic_id","conversation_id") REFERENCES "public"."conversations"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_flags" ADD CONSTRAINT "conversation_flags_thread_fk" FOREIGN KEY ("clinic_id","channel","thread_party_ref") REFERENCES "public"."chat_threads"("clinic_id","channel","party_ref") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_flags_conversation_idx" ON "conversation_flags" USING btree ("clinic_id","conversation_id") WHERE "conversation_flags"."conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_flags_thread_conversation_idx" ON "conversation_flags" USING btree ("clinic_id","thread_conversation_id") WHERE "conversation_flags"."thread_conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "conversation_flags_flagged_idx" ON "conversation_flags" USING btree ("clinic_id","flagged_at");--> statement-breakpoint

-- =============================================================================
-- Flag this answer (spec, "When the agent gets something wrong"; plan Part F4
-- and Annex X5's I4). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- The failure, in one paragraph. The spec gives every conversation in the
-- portal a "Flag this answer" control: one click opens an internal ticket,
-- an optional correction goes into the clinic's quick answers at once, two
-- flags from one clinic in a week is an alert, and flagged conversations get
-- their own view so the clinic sees its corrections landed. Nothing held a
-- flag: the I4 email waited in the template registry for this table, the
-- weekly recap said the portal had no flag, and a clinic whose assistant got
-- an answer wrong had no way to say so but an email to an inbox kept free of
-- patient details.
--
-- What changes:
--
--   * conversation_flags holds one flag per conversation: the conversation it
--     marks (a call's or web chat's row, or a Meta thread's conversation with
--     the thread's key), its channel, outcome and start, when it was flagged
--     and when a correction went into the quick answers. Never the
--     correction's words (they are in agent_configs.quick_answers, tagged
--     with the flag's id), and never a word of the conversation (none is
--     kept).
--   * It marks a patient's conversation, so it is tenant-scoped, FORCEd, and
--     behind the BAA gate on INSERT and UPDATE.
--   * Each foreign key carries clinic_id with the record's key, so a flag
--     can point only at its own clinic's records, and cascades: a flag goes
--     with its conversation or its thread, whoever deletes it (an erasure,
--     the record clock, a quiet thread's purge, the billing housekeeping,
--     destruction), with no change to any of them.
--   * flagged_at is the database's clock at the insert, and corrected_at the
--     database's clock when it is first set, whatever the writer sends, and
--     never changes after: the seven-day count that turns a flag into an
--     alert cannot be moved by backdating a row. The runtime role may SELECT,
--     INSERT and DELETE, and UPDATE only corrected_at.
--   * Destruction: app_mark_clinic_destroyed() requires the table empty, and
--     destroyClinicData deletes it first, so the count is in the record.
--
-- Safe to apply in place: a new table, one trigger function and one
-- redefinition that adds a table to the list it checks. apps/app has only
-- ever held synthetic and seed data (CLAUDE.md, "Until BAA coverage is in
-- place").
-- =============================================================================

ALTER TABLE conversation_flags ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversation_flags FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY conversation_flags_tenant_isolation ON conversation_flags
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- 0003's default privileges handed the runtime role all four verbs. It keeps
-- what a flag needs: to be written, read, deleted with its records, and given
-- its correction once.
REVOKE ALL ON conversation_flags FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON conversation_flags TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (corrected_at) ON conversation_flags TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER conversation_flags_baa_gate
  BEFORE INSERT OR UPDATE ON conversation_flags
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- The two clocks are the database's. A correction is recorded once: the
-- quick answer it wrote may be edited or removed in Knowledge, and the flag
-- keeps saying when it went in.
CREATE OR REPLACE FUNCTION app_conversation_flag_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.flagged_at := clock_timestamp();
    IF NEW.corrected_at IS NOT NULL THEN
      NEW.corrected_at := NEW.flagged_at;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.flagged_at IS DISTINCT FROM OLD.flagged_at THEN
    RAISE EXCEPTION 'conversation_flags: when a conversation was flagged never changes'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.corrected_at IS NOT NULL THEN
    IF NEW.corrected_at IS DISTINCT FROM OLD.corrected_at THEN
      RAISE EXCEPTION 'conversation_flags: a correction is recorded once'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.corrected_at IS NOT NULL THEN
    NEW.corrected_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER conversation_flags_clock
  BEFORE INSERT OR UPDATE ON conversation_flags
  FOR EACH ROW EXECUTE FUNCTION app_conversation_flag_clock();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: 0092's app_mark_clinic_destroyed (0069's with handovers), with
-- conversation_flags added to the tables it requires empty. Every table it checked before, it still
-- checks, and the clinic's row is still locked first. destroyClinicData
-- (lib/offboarding/offboarding.ts) deletes the clinic's flags before its
-- conversations and threads; the foreign keys' cascades would take them
-- anyway, and this makes it a checked fact. tests/booking-request-destruction.test.ts
-- reads the list from the function and holds it to every table with a
-- clinic_id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_mark_clinic_destroyed(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  done timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_mark_clinic_destroyed: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  -- The clinic's row first, FOR UPDATE, so a deletion request recorded
  -- concurrently (erasure_requests_guard reads the row FOR SHARE) either
  -- commits before the checks below, which then see it and refuse, or waits
  -- for the stamp and is refused itself. Review of 12 October 2026.
  PERFORM 1 FROM clinics c WHERE c.id = target_clinic FOR UPDATE;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to mark it destroyed.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  IF EXISTS (SELECT 1 FROM booking_requests r WHERE r.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM appointments a WHERE a.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversations v WHERE v.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contacts p WHERE p.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM transactions t WHERE t.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM reconciliation_exceptions x WHERE x.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM meta_booking_drafts d WHERE d.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM webhook_events w WHERE w.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM provider_connections k WHERE k.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_closures z WHERE z.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM chat_threads h WHERE h.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM meta_inbound_messages m WHERE m.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_setup_screens s WHERE s.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM slot_holds sh WHERE sh.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_provider_services ps WHERE ps.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_providers pr WHERE pr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM suppressions u WHERE u.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM consent_records g WHERE g.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contact_attempts n WHERE n.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM erasure_requests er WHERE er.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM record_amendments ra WHERE ra.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM deposit_payments dp WHERE dp.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM transcript_emails te WHERE te.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM handovers ho WHERE ho.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversation_flags cf WHERE cf.clinic_id = target_clinic) THEN
    RAISE EXCEPTION 'Clinic % still holds rows that destruction deletes; refusing to mark it destroyed.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'destroyClinicData deletes them first, in the same transaction, and then stamps it.';
  END IF;

  UPDATE clinics c
     SET destroyed_at = coalesce(c.destroyed_at, now()),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.destroyed_at INTO done;
  RETURN done;
END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092) and the flags on conversations (0093), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';

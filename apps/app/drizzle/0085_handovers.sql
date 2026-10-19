CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"platform" text,
	"external_call_id" text,
	"conversation_id" uuid,
	"party_ref" text,
	"meta_conversation_id" uuid,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by_label" text,
	"handled_by_user_id" text,
	CONSTRAINT "handovers_shape_check" CHECK (("handovers"."channel" = 'voice' and "handovers"."external_call_id" is not null and "handovers"."platform" is null and "handovers"."party_ref" is null and "handovers"."meta_conversation_id" is null and "handovers"."contact_id" is null)
        or ("handovers"."channel" = 'web_chat' and "handovers"."conversation_id" is not null and "handovers"."external_call_id" is null and "handovers"."platform" is null and "handovers"."party_ref" is null and "handovers"."meta_conversation_id" is null)
        or ("handovers"."channel" = 'meta' and "handovers"."platform" in ('instagram', 'messenger', 'whatsapp') and "handovers"."party_ref" is not null and "handovers"."meta_conversation_id" is not null and "handovers"."conversation_id" is null and "handovers"."external_call_id" is null and "handovers"."contact_id" is null)),
	CONSTRAINT "handovers_call_id_check" CHECK ("handovers"."external_call_id" is null or char_length("handovers"."external_call_id") between 1 and 200),
	CONSTRAINT "handovers_handled_check" CHECK (("handovers"."handled_at" is null) = ("handovers"."handled_by_label" is null) and ("handovers"."handled_at" is null) = ("handovers"."handled_by_user_id" is null) and ("handovers"."handled_by_label" is null or char_length("handovers"."handled_by_label") between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_conversation_fk" FOREIGN KEY ("clinic_id","conversation_id") REFERENCES "public"."conversations"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_thread_fk" FOREIGN KEY ("clinic_id","platform","party_ref") REFERENCES "public"."chat_threads"("clinic_id","channel","party_ref") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handovers_clinic_idx" ON "handovers" USING btree ("clinic_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "handovers_call_idx" ON "handovers" USING btree ("clinic_id","external_call_id") WHERE "handovers"."external_call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "handovers_conversation_idx" ON "handovers" USING btree ("clinic_id","conversation_id") WHERE "handovers"."conversation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "handovers_meta_conversation_idx" ON "handovers" USING btree ("clinic_id","meta_conversation_id") WHERE "handovers"."meta_conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "handovers_thread_idx" ON "handovers" USING btree ("clinic_id","platform","party_ref");--> statement-breakpoint
CREATE INDEX "handovers_contact_idx" ON "handovers" USING btree ("clinic_id","contact_id");--> statement-breakpoint
-- =============================================================================
-- Handovers (19 October 2026). The statements above were generated from
-- schema.ts; everything below is the part drizzle cannot express.
--
-- Someone asking AYA for a person raised L11 and left nothing Bookings could
-- list: the alert was a pointer to a screen that had nothing to show, and the
-- desk had no way to say it had been dealt with (plan Part F5, Needs you:
-- "open handovers"). A handover is now a row, written by
-- lib/handovers/record.ts in the transaction that queues the alert, listed
-- under Needs you behind the passkey step-up, and marked handled by the desk.
--
-- It holds no words and no identity of its own. A call or web chat points at
-- its conversation and goes with it (the foreign key's cascade), and a web
-- chat's handover holds the contact for the number the visitor gave for the
-- call back, and goes with that contact too. The contact is on the handover,
-- never on the conversation: a request later in the same chat may name
-- someone else, whose appointment would then point at a conversation this
-- person's erasure must delete (review of 19 October 2026); a Meta
-- thread points at its chat_threads row, the keyed hash of who wrote, and
-- goes with that. So the person's erasure, the record clock and the thread's
-- thirty days reach it without a line of their own, and the purge deletes on
-- the record clock whatever outlives both (a call whose conversation was
-- never written).
--
-- A call's conversation is written when the call ends, after the handover,
-- so the row carries the vendor's call id until then, and the trigger below
-- links it when the conversation with that call id is inserted. From then it
-- goes with the conversation like the others.
--
-- What the database holds to, whatever the writer sends:
--
--   * tenant isolation, forced, and the BAA gate on INSERT and UPDATE, as on
--     every table that points at a caller;
--   * when it was asked is the database's clock, and it is asked open;
--   * a handover is marked handled once, at the database's clock, and never
--     reopened or rewritten; a call's conversation and a web chat's contact
--     are each set once, and the contact is the clinic's own;
--   * a restore loads rows as they were, so it disables handovers_guard for
--     the load, as it does the other guards (docs/handover.md, "Restoring"). The runtime
--     role may UPDATE only those columns, and the trigger holds the owner to
--     the same;
--   * the runtime role may DELETE: the purge's record clock.
--
-- Destruction: 0069's app_mark_clinic_destroyed, with handovers added to the
-- tables it requires empty; destroyClinicData deletes them before the
-- conversations and threads they point at.
--
-- Safe to apply in place: a new table, two triggers, three functions.
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

ALTER TABLE handovers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE handovers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY handovers_tenant_isolation ON handovers
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
REVOKE ALL ON handovers FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON handovers TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (conversation_id, contact_id, handled_at, handled_by_label, handled_by_user_id) ON handovers TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER handovers_baa_gate
  BEFORE INSERT OR UPDATE ON handovers
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_handover_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.handled_at IS NOT NULL OR NEW.handled_by_label IS NOT NULL OR NEW.handled_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'handovers: a handover is recorded open; the desk marks it handled'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_at := clock_timestamp();
  ELSE
    IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.platform IS DISTINCT FROM OLD.platform
       OR NEW.external_call_id IS DISTINCT FROM OLD.external_call_id
       OR NEW.party_ref IS DISTINCT FROM OLD.party_ref
       OR NEW.meta_conversation_id IS DISTINCT FROM OLD.meta_conversation_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'handovers: what was asked, where and when, is never rewritten'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'handovers: a handover''s conversation is set once'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
      RAISE EXCEPTION 'handovers: a handover''s contact is set once'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- The contact is one of this clinic's: read under the caller's tenant, so
  -- another clinic's contact is not there to find.
  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND NOT EXISTS (SELECT 1 FROM contacts p WHERE p.id = NEW.contact_id AND p.clinic_id = NEW.clinic_id) THEN
    RAISE EXCEPTION 'handovers: the contact is not one of this clinic''s'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF OLD.handled_at IS NOT NULL THEN
    IF NEW.handled_at IS DISTINCT FROM OLD.handled_at
       OR NEW.handled_by_label IS DISTINCT FROM OLD.handled_by_label
       OR NEW.handled_by_user_id IS DISTINCT FROM OLD.handled_by_user_id THEN
      RAISE EXCEPTION 'handovers: a handover is marked handled once, and never reopened'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.handled_at IS NOT NULL THEN
    NEW.handled_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_handover_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER handovers_guard
  BEFORE INSERT OR UPDATE ON handovers
  FOR EACH ROW EXECUTE FUNCTION app_handover_guard();--> statement-breakpoint

-- A call's conversation, written when the call ends, takes the handover
-- asked on it. Runs as whoever inserts the conversation, inside its tenant.
CREATE OR REPLACE FUNCTION app_conversation_links_handover()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.external_call_id IS NOT NULL THEN
    UPDATE handovers h
       SET conversation_id = NEW.id
     WHERE h.clinic_id = NEW.clinic_id
       AND h.channel = 'voice'
       AND h.external_call_id = NEW.external_call_id
       AND h.conversation_id IS NULL;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_conversation_links_handover() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER conversations_link_handover
  AFTER INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION app_conversation_links_handover();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: 0069's app_mark_clinic_destroyed, with handovers added to the
-- tables it requires empty. tests/booking-request-destruction.test.ts reads
-- the list from the function and holds it to every table with a clinic_id.
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
     OR EXISTS (SELECT 1 FROM handovers ho WHERE ho.clinic_id = target_clinic) THEN
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
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069) and handovers (0085), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';

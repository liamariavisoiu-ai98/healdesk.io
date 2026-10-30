CREATE TABLE "payment_link_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"call_ref_hash" text NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"opted_in_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"deposit_payment_id" uuid,
	"aws_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payment_link_texts_appointment_key" UNIQUE("appointment_id"),
	CONSTRAINT "payment_link_texts_status_check" CHECK ("payment_link_texts"."status" in ('queued', 'sent', 'failed', 'opted_out', 'declined')),
	CONSTRAINT "payment_link_texts_failure_check" CHECK (("payment_link_texts"."status" = 'failed') = ("payment_link_texts"."failure_code" is not null) and ("payment_link_texts"."failure_code" is null or "payment_link_texts"."failure_code" in ('invalid_number', 'throttled', 'not_configured', 'error', 'link_unavailable', 'refused', 'unknown'))),
	CONSTRAINT "payment_link_texts_ref_check" CHECK ("payment_link_texts"."call_ref_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_link_texts_evidence_check" CHECK (("payment_link_texts"."status" = 'declined') = ("payment_link_texts"."opted_in_at" is null) and ("payment_link_texts"."opted_in_at" is null) = ("payment_link_texts"."confirmed_at" is null) and ("payment_link_texts"."confirmed_at" is null or "payment_link_texts"."confirmed_at" >= "payment_link_texts"."opted_in_at")),
	CONSTRAINT "payment_link_texts_message_check" CHECK (("payment_link_texts"."status" = 'sent') = ("payment_link_texts"."aws_message_id" is not null) and ("payment_link_texts"."aws_message_id" is null or "payment_link_texts"."aws_message_id" ~ '^[A-Za-z0-9-]{1,100}$')),
	CONSTRAINT "payment_link_texts_settled_check" CHECK (("payment_link_texts"."status" = 'queued') = ("payment_link_texts"."settled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "deposit_payments" DROP CONSTRAINT "deposit_payments_channel_check";--> statement-breakpoint
ALTER TABLE "payment_link_texts" ADD CONSTRAINT "payment_link_texts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_texts" ADD CONSTRAINT "payment_link_texts_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_link_texts_clinic_idx" ON "payment_link_texts" USING btree ("clinic_id","created_at");--> statement-breakpoint
ALTER TABLE "deposit_payments" ADD CONSTRAINT "deposit_payments_channel_check" CHECK ("deposit_payments"."channel" in ('web', 'meta', 'voice'));
--> statement-breakpoint
-- =============================================================================
-- The payment-link text after a call (owner, 28 and 30 October 2026; spec,
-- "Payment by text after a call, and full payment"). The statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- payment_link_texts is the ledger of the one optional text a caller who just
-- booked may agree to (lib/sms/payment-text.ts): one row per appointment, the
-- unique key that makes the send idempotent, written `queued` BEFORE AWS is
-- asked, so a crash mid-send leaves the row and nothing ever texts the booking
-- twice. It holds the opt-in evidence (when the caller said yes, when they
-- confirmed the number read back), the call as SHA-256 of Retell's call id,
-- the deposit link's row (an opaque id, with no foreign key: the deposit purge,
-- app_purge_deposit_payments, may delete a deposit before its appointment, and
-- a key's SET NULL would be an UPDATE that the closed-account freeze below
-- refuses, so purging a closed clinic's deposits would fail) and AWS's message
-- id: never the phone number and never the message body. The trigger holds the row's identity and evidence,
-- and lets the status move only from `queued` to where the send ended.
--
-- deposit_payments gains the `voice` channel: the link texted after a call is
-- the clinic's own Stripe Checkout link, made by createDepositLink as the
-- chat's is, with the same refusals.
--
-- The runtime role may insert it, settle it and delete it (destruction); the
-- BAA gate refuses it for a clinic that may not hold patient data, as on every
-- patient table, and it is frozen once the account is closed. It goes with its
-- appointment by the foreign key's cascade (erasure, the retention clock,
-- destruction), and destroyClinicData deletes it first so the stamp's check
-- names it.
--
-- Safe to apply in place: one new, empty table, a widened check, a trigger,
-- policies and grants, and app_mark_clinic_destroyed redefined (below).
-- =============================================================================

CREATE OR REPLACE FUNCTION payment_link_texts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The appointment must be the clinic's own (RLS shows the tenant's rows only).
    IF NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = NEW.appointment_id AND a.clinic_id = NEW.clinic_id) THEN
      RAISE EXCEPTION 'payment_link_texts: the appointment is not this clinic''s'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('queued', 'declined') THEN
      RAISE EXCEPTION 'payment_link_texts: a row starts queued or declined, never %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.call_ref_hash IS DISTINCT FROM OLD.call_ref_hash
     OR NEW.opted_in_at IS DISTINCT FROM OLD.opted_in_at
     OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_link_texts: a text''s identity and opt-in evidence never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'queued' THEN
    -- Settled: nothing changes.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.aws_message_id IS DISTINCT FROM OLD.aws_message_id
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
       OR NEW.deposit_payment_id IS DISTINCT FROM OLD.deposit_payment_id THEN
      RAISE EXCEPTION 'payment_link_texts: a settled text (%) never changes, and is never sent again', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status NOT IN ('queued', 'sent', 'failed', 'opted_out') THEN
    RAISE EXCEPTION 'payment_link_texts: a queued text ends sent, failed or opted out, never %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_link_texts_guard
  BEFORE INSERT OR UPDATE ON payment_link_texts
  FOR EACH ROW EXECUTE FUNCTION payment_link_texts_guard();--> statement-breakpoint

REVOKE ALL ON payment_link_texts FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON payment_link_texts TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, failure_code, aws_message_id, settled_at, deposit_payment_id) ON payment_link_texts TO healdesk_app;--> statement-breakpoint
ALTER TABLE payment_link_texts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_link_texts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_link_texts_tenant_isolation ON payment_link_texts
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
CREATE TRIGGER payment_link_texts_baa_gate
  BEFORE INSERT OR UPDATE ON payment_link_texts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- Emptied by the destruction, so frozen once the account is closed, as every
-- such table is (0121's rights_intakes_closed_account).
CREATE TRIGGER payment_link_texts_closed_account
  BEFORE INSERT OR UPDATE ON payment_link_texts
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

-- 0139's app_mark_clinic_destroyed, copied whole, with payment_link_texts
-- added to what it checks destroyClinicData deleted first.
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

  -- The clinic's row first, FOR UPDATE, so a deletion request or a
  -- patient-rights intake recorded concurrently (erasure_requests_guard and
  -- rights_intakes_guard read the row FOR SHARE) either commits before the
  -- checks below, which then see it and refuse, or waits for the stamp and
  -- is refused itself. Review of 12 October 2026.
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
     OR EXISTS (SELECT 1 FROM conversation_flags cf WHERE cf.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM patient_requests pq WHERE pq.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM retell_recording_alerts rr WHERE rr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM voice_redial_contexts vr WHERE vr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM rights_intakes ri WHERE ri.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM missed_contacts mc WHERE mc.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM payment_link_texts pl WHERE pl.clinic_id = target_clinic) THEN
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
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094), the list of who an incident affected (0098), the Retell call alerts (0106), the redial records of calls that ended early (0108), the patient-rights intakes (0121) the missed-contact record (0139) and the payment-link text ledger (0140), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';

CREATE TABLE "outbound_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"booking_request_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"phone" text NOT NULL,
	"attempt_no" smallint NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"refusal_code" text,
	"gate_basis" text,
	"vendor_call_id" text,
	"placed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_write_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_written_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "calendar_write_error" text;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "alternative_windows" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "collected_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "proposed_slots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "reschedule_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "booked_via" text DEFAULT 'desk' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "vendor_call_id" text;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "whatsapp_optin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "whatsapp_optin_quote" text;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "booking_mode" text DEFAULT 'desk_confirms' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "direct_booking_elected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "direct_booking_elected_by_label" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "direct_booking_clause_version" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "direct_booking_clause_hash" "bytea";--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "direct_booking_withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "outbound_callbacks_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "timezone_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "booking_requirements" jsonb;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "booking_requirements_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "booking_requirements_source" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "synthflow_callback_agent_id" text;--> statement-breakpoint
ALTER TABLE "connection_links" ADD COLUMN "purpose" text DEFAULT 'connect' NOT NULL;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "wording_version" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "booking_request_id" uuid;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "alternative_windows" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "consent_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "callback_consent" boolean;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "callback_consent_quote" text;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "whatsapp_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "whatsapp_optin" boolean;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "whatsapp_optin_quote" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "phi_basis" text;--> statement-breakpoint
ALTER TABLE "outbound_calls" ADD CONSTRAINT "outbound_calls_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_calls" ADD CONSTRAINT "outbound_calls_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_calls" ADD CONSTRAINT "outbound_calls_booking_request_id_booking_requests_id_fk" FOREIGN KEY ("booking_request_id") REFERENCES "public"."booking_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_calls" ADD CONSTRAINT "outbound_calls_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_calls" ADD CONSTRAINT "outbound_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_calls_vendor_idx" ON "outbound_calls" USING btree ("clinic_id","vendor_call_id") WHERE "outbound_calls"."vendor_call_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_calls_attempt_idx" ON "outbound_calls" USING btree ("booking_request_id","attempt_no");--> statement-breakpoint
CREATE INDEX "outbound_calls_due_idx" ON "outbound_calls" USING btree ("status","not_before") WHERE "outbound_calls"."status" = 'due';--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_booking_request_id_booking_requests_id_fk" FOREIGN KEY ("booking_request_id") REFERENCES "public"."booking_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_requests_vendor_call_idx" ON "booking_requests" USING btree ("clinic_id","vendor_call_id") WHERE "booking_requests"."vendor_call_id" is not null;--> statement-breakpoint
CREATE INDEX "booking_requests_thread_idx" ON "booking_requests" USING btree ("clinic_id","platform","sender_id");--> statement-breakpoint

-- =============================================================================
-- Booking modes, consented callbacks and the setup link (decision of
-- 23 September 2026; docs/design/booking-and-callbacks-2026-09-23.md, Part 2
-- §A). Everything above this line was generated from schema.ts; everything
-- below is the part drizzle cannot express.
--
-- What changes, in one paragraph. The desk gets a fourth decision — "propose
-- other times" — so a request can be `rescheduling` while the person is
-- offered up to three slots on a consented callback. Every agent asks for a
-- primary window and up to two alternatives. A clinic may elect direct
-- booking (the voice agent books the calendar slot on the call) only under a
-- recorded election of the addendum, and may switch on callbacks only per
-- clinic and only against a confirmed timezone. A placed call is a row in a
-- new ledger, outbound_calls, that cannot exist without a matching consent
-- row. The clinic's booking requirement set is confirmed on a single-use
-- setup link that reuses connection_links with a purpose, and go-live
-- refuses until it is.
--
-- Two rules this file obeys throughout. First, every outbound action is gated
-- fail-closed by table shape — a CHECK, a NOT NULL foreign key, a unique
-- index, a trigger — and only then by code, because code paths multiply and
-- the database sees every one of them. Second, every column added to a table
-- whose runtime UPDATE is a column list (clinics since 0031, booking_requests
-- since 0037) is followed by its own GRANT: a column-level grant does not
-- extend to columns added later (0031:42-46), and tests/database-audit.test.ts
-- fails CI on a forgotten one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A.1–A.4 booking_requests: alternatives, collected fields, rescheduling,
-- provenance
-- ---------------------------------------------------------------------------

-- The agent asks for a primary time and two alternatives; a third is dropped
-- before it gets here, and the shape says so.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_alternatives_max_two CHECK (cardinality(alternative_windows) <= 2);--> statement-breakpoint

-- Up to three offered slots, and a row cannot be `rescheduling` with nothing
-- to choose from or no deadline. The deadline is its own column because
-- expires_at is frozen (0039) and stays so: the link's life and the offer's
-- life are different clocks.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_proposed_slots_max_three CHECK (jsonb_array_length(proposed_slots) <= 3);--> statement-breakpoint
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_status_known;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_status_known CHECK (status IN ('requested', 'accepted', 'rescheduling', 'confirmed', 'declined', 'expired'));--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_rescheduling_shape CHECK (
    status <> 'rescheduling'
    OR (jsonb_array_length(proposed_slots) >= 1 AND reschedule_expires_at IS NOT NULL)
  );--> statement-breakpoint

-- Who turned the request into an appointment. `agent_direct` rows are
-- INSERTed already confirmed (the trigger below is BEFORE UPDATE only, on
-- purpose) and carry the vendor's call id, whose partial unique index is the
-- idempotency key for a retried tool call.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_booked_via_known CHECK (booked_via IN ('desk', 'callback', 'agent_direct'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.5 clinics: booking mode, callbacks, the requirement set — and their grant
-- ---------------------------------------------------------------------------
ALTER TABLE clinics
  ADD CONSTRAINT clinics_booking_mode_known CHECK (booking_mode IN ('desk_confirms', 'direct'));--> statement-breakpoint

-- Direct booking without a recorded, unwithdrawn election of the addendum is
-- unrepresentable. A CHECK rather than a trigger or a code path: there is no
-- write order that can leave a clinic in direct mode with nothing to show
-- for it, and withdrawing the election forces the mode back before it lands.
ALTER TABLE clinics
  ADD CONSTRAINT clinics_direct_requires_election CHECK (
    booking_mode <> 'direct'
    OR (direct_booking_elected_at IS NOT NULL
        AND direct_booking_clause_hash IS NOT NULL
        AND direct_booking_withdrawn_at IS NULL)
  );--> statement-breakpoint
ALTER TABLE clinics
  ADD CONSTRAINT clinics_booking_requirements_source_known CHECK (
    booking_requirements_source IS NULL
    OR booking_requirements_source IN ('practice', 'operator', 'defaults')
  );--> statement-breakpoint

COMMENT ON COLUMN clinics.timezone_confirmed_at IS
  'Stamped by the ops op setClinicTimezone. NULL means clinics.timezone is still the provisioning default, and no callback is ever dialled against a default: quiet hours are the recipient''s local hours.';--> statement-breakpoint
COMMENT ON COLUMN clinics.booking_requirements IS
  'string[] of catalogue booking-field ids the assistant collects for this practice. NULL means the specialty defaults apply. See booking_requirements_source for who settled it.';--> statement-breakpoint

-- clinics carries column-level UPDATE grants (0031): every new column that the
-- runtime writes needs its own. tests/database-audit.test.ts asserts that
-- every column but the two gate columns is updatable, so forgetting fails CI.
GRANT UPDATE (booking_mode, direct_booking_elected_at, direct_booking_elected_by_label,
              direct_booking_clause_version, direct_booking_clause_hash, direct_booking_withdrawn_at,
              outbound_callbacks_enabled, timezone_confirmed_at,
              booking_requirements, booking_requirements_confirmed_at, booking_requirements_source,
              synthflow_callback_agent_id)
  ON clinics TO healdesk_app;--> statement-breakpoint

-- provider_connections.phi_basis: the lawful basis for PHI reaching this
-- vendor. NULL means there is none, and a connection with none is never
-- written to. Written only by the audited ops op setConnectionPhiBasis.
--
-- No column grant follows, and that is deliberate: provider_connections still
-- carries 0003's table-level UPDATE — verified against every migration from
-- 0003 to 0039, none of which narrowed it — and a table-level grant covers
-- columns added later. A column grant here would only suggest a scoping that
-- does not exist.
ALTER TABLE provider_connections
  ADD CONSTRAINT provider_connections_phi_basis_known CHECK (phi_basis IS NULL OR phi_basis IN ('vendor_baa', 'practice_account'));--> statement-breakpoint
COMMENT ON COLUMN provider_connections.phi_basis IS
  'The lawful basis on which a name, a service and a time may reach this vendor: its own BAA with us (vendor_baa) or the practice''s own account under the practice''s own agreement (practice_account). NULL = none; never written to.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.6 appointments: the calendar write result
-- ---------------------------------------------------------------------------
-- `failed` is the vendor saying no and is never retried on its own; `unknown`
-- is a timeout or a dropped connection and is retried only after a read-back
-- under the request's key finds nothing, because Cal.com has no idempotency
-- key. external_confirmed_at is untouched by any of this: it still means "a
-- sync read this back out", which is what keeps the report evidentiary.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_calendar_write_status_known CHECK (
    calendar_write_status IN ('none', 'writing', 'written', 'failed', 'unknown')
  );--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.7 consent_records: the wording version and the request
-- ---------------------------------------------------------------------------
-- Both columns are written at INSERT. The runtime role's UPDATE on
-- consent_records is table-level (0010 withheld DELETE only), so no grant.
COMMENT ON COLUMN consent_records.wording_version IS
  'The catalogue version of the consent question asked. An outbound call may only reference a versioned consent (outbound_calls_consent_match); code additionally requires it to equal the current version before dialling.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.8 outbound_calls: the placed-call ledger
-- ---------------------------------------------------------------------------
ALTER TABLE outbound_calls
  ADD CONSTRAINT outbound_calls_purpose_known CHECK (purpose IN ('collect_fields', 'offer_alternatives', 'confirm_time'));--> statement-breakpoint
-- Never a third attempt, by shape: the range here and the unique index on
-- (booking_request_id, attempt_no) above.
ALTER TABLE outbound_calls
  ADD CONSTRAINT outbound_calls_attempt_no_range CHECK (attempt_no BETWEEN 1 AND 2);--> statement-breakpoint
ALTER TABLE outbound_calls
  ADD CONSTRAINT outbound_calls_status_known CHECK (
    status IN ('due', 'placing', 'placed', 'completed', 'failed', 'unknown', 'cancelled', 'refused')
  );--> statement-breakpoint

-- The row carries a caller's number: no row for a production clinic without
-- a BAA (0037's pattern for booking_requests).
CREATE TRIGGER outbound_calls_baa_gate
  BEFORE INSERT OR UPDATE ON outbound_calls
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

ALTER TABLE outbound_calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE outbound_calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY outbound_calls_tenant_isolation ON outbound_calls
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- No consent row, no dial — the NOT NULL foreign key says that much. This
-- trigger says the rest: the consent referenced must be THIS clinic's, for
-- THIS number, unrevoked, versioned, and captured on an inbound contact (a
-- call the person made, or a thread the person opened). A consent row from
-- a web form, or one that was revoked an hour ago, is a real row the FK would
-- accept and the TCPA would not. Invoker rights, deliberately: the lookup
-- runs under the caller's tenant, so a consent row in another clinic is not
-- merely mismatched but invisible.
CREATE OR REPLACE FUNCTION app_outbound_call_requires_matching_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM consent_records c
     WHERE c.id = NEW.consent_record_id
       AND c.clinic_id = NEW.clinic_id
       AND c.phone = NEW.phone
       AND c.revoked_at IS NULL
       AND c.source IN ('inbound_call', 'meta_thread')
       AND c.wording_version IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'outbound_calls: consent row does not match this clinic and number, or is revoked'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER outbound_calls_consent_match
  BEFORE INSERT ON outbound_calls
  FOR EACH ROW EXECUTE FUNCTION app_outbound_call_requires_matching_consent();--> statement-breakpoint

-- Privileges. 0003's default privileges gave the runtime role full UPDATE on
-- the new table the moment it was created; revoke first, or the column grant
-- below is a no-op on top of it. The number, the purpose, the attempt number
-- and the consent the call was placed under are evidence: they never move,
-- and nothing is deleted. Only the outcome columns are writable.
REVOKE UPDATE, DELETE ON outbound_calls FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON outbound_calls TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, refusal_code, gate_basis, vendor_call_id, placed_at, completed_at, conversation_id)
  ON outbound_calls TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE outbound_calls IS
  'One row per attempt to call a person back about their own booking request, written before the vendor is asked to dial. Cannot exist without a matching, unrevoked, inbound-sourced consent row (FK + trigger); at most two attempts per request (unique index + CHECK); one row per vendor call. Carries the number dialled — PHI, behind the BAA gate and the tenant policy.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.9 connection_links: the setup link reuses the connect link
-- ---------------------------------------------------------------------------
-- Same table, same token discipline, same bootstrap policy (0024). The
-- purpose is checked inside the tenant transaction by resolution and by
-- consumption, so a token issued to confirm the requirement set cannot be
-- spent on the credential wizard, nor the reverse. Set at issue and never
-- updated: the runtime role's UPDATE here is (used_at, consumed_ip) only.
ALTER TABLE connection_links
  ADD CONSTRAINT connection_links_purpose_known CHECK (purpose IN ('connect', 'setup'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.11 Go-live also requires the booking requirement set to be confirmed
-- ---------------------------------------------------------------------------
-- The database, not only goLivePreconditions(), refuses while the step is
-- open: the assistant must not take its first real call collecting a set
-- nobody settled. Otherwise identical to 0033's definition.
CREATE OR REPLACE FUNCTION app_mark_clinic_production(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  covered boolean;
  signed timestamptz;
  steps jsonb;
  missing text;
  hours_present boolean;
  routing_confirmed timestamptz;
  agent_approved timestamptz;
BEGIN
  SELECT c.organization_id, c.is_covered_entity, c.onboarding,
         (c.opening_hours IS NOT NULL), c.call_routing_confirmed_at, c.agent_approved_at
    INTO org, covered, steps, hours_present, routing_confirmed, agent_approved
    FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  IF covered IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has not had its covered-entity status determined; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Confirm with the clinic whether it sends any health information electronically to a payer, record the answer on clinics.is_covered_entity, then retry.';
  END IF;

  IF NOT hours_present THEN
    RAISE EXCEPTION 'Clinic % has no opening hours on file; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;
  IF routing_confirmed IS NULL THEN
    RAISE EXCEPTION 'Clinic % has not confirmed its call routing; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;
  IF agent_approved IS NULL THEN
    RAISE EXCEPTION 'Clinic % has not approved its agent script; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(k, ', ' ORDER BY k) INTO missing
    FROM unnest(ARRAY['hours_confirmed','phone_type_confirmed','call_routing_chosen',
                      'covered_entity_confirmed','agent_script_approved',
                      'forwarding_configured','test_call_passed',
                      'booking_requirements_confirmed']) AS k
   WHERE coalesce(steps, '{}'::jsonb) -> k IS NULL
      OR jsonb_typeof(coalesce(steps, '{}'::jsonb) -> k) = 'null';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic % has open onboarding steps: %; refusing to mark it production.', target_clinic, missing
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT b.accepted_at INTO signed
    FROM baa_acceptances b
   WHERE b.organization_id = org
     AND b.terminated_at IS NULL
   ORDER BY b.accepted_at DESC
   LIMIT 1;

  IF signed IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has no bound, in-effect business associate agreement; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Bind the signed agreement to this clinic''s organisation first (provisioning does this on purchase).';
  END IF;

  UPDATE clinics
     SET data_classification = 'production',
         baa_signed_at = signed,
         went_live_at = now(),
         updated_at = now()
   WHERE id = target_clinic;

  RETURN signed;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.12 The dialer job, seeded OFF like every other (0008, 0030, 0032, 0034)
-- ---------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('callback-dialer', 'Every 15 minutes; places due callbacks inside the window, expires lapsed reschedules, cancels calls for expired requests', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.13 The transition table, and what may move when
-- ---------------------------------------------------------------------------
-- Replaces 0039's function. The permitted transitions:
--
--   requested    → accepted, rescheduling, confirmed, declined, expired
--   accepted     → rescheduling, confirmed, expired
--   rescheduling → confirmed, declined, expired
--   confirmed, declined, expired → nothing
--
-- Three classes of column:
--
--   * always frozen — id, clinic_id, contact_id, channel, token_hash,
--     preferred_window, alternative_windows, treatment, created_at,
--     expires_at, booked_via, vendor_call_id: the facts of the request.
--   * conversation_id is set-once. 0039 wrote its clause as
--     `A IS DISTINCT FROM B AND B IS NOT NULL` inside an OR chain, and AND
--     binds tighter than OR, so null → uuid raised and only the FK's
--     uuid → null passed. A callback must be able to link the call it
--     produced to the request it was about, exactly once; hence the
--     parenthesised form below.
--   * decision-side — proposed_slots, reschedule_expires_at, collected_fields,
--     last_inbound_at, whatsapp_optin_at, whatsapp_optin_quote — move only
--     while the request is still open, so a second offer of alternatives
--     while still `rescheduling` is a plain update, not a transition. Once
--     terminal, they join 0039's freeze of the decision columns.
--
-- desk_notified_at is outside every freeze: it is a delivery timestamp, and
-- the direct-booking FYI, the choose-slot confirmation and every re-notify
-- stamp it on a terminal row. confirmed_shape (0039) is unchanged: confirmed
-- still means a slot and an appointment. The trigger stays BEFORE UPDATE
-- only (0037), so a direct booking may INSERT a `confirmed` row.
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'requested'    AND NEW.status IN ('accepted', 'rescheduling', 'confirmed', 'declined', 'expired'))
      OR (OLD.status = 'accepted'     AND NEW.status IN ('rescheduling', 'confirmed', 'expired'))
      OR (OLD.status = 'rescheduling' AND NEW.status IN ('confirmed', 'declined', 'expired'))
    ) THEN
      RAISE EXCEPTION 'booking_requests: % -> % is not a permitted transition; a decided request is already decided', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('confirmed', 'declined', 'expired')
        AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
             OR NEW.decided_by_label IS DISTINCT FROM OLD.decided_by_label
             OR NEW.desk_note IS DISTINCT FROM OLD.desk_note
             OR NEW.confirmed_for IS DISTINCT FROM OLD.confirmed_for
             OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id) THEN
    RAISE EXCEPTION 'booking_requests row is already decided and cannot be re-decided'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('confirmed', 'declined', 'expired')
     AND (NEW.proposed_slots IS DISTINCT FROM OLD.proposed_slots
          OR NEW.reschedule_expires_at IS DISTINCT FROM OLD.reschedule_expires_at
          OR NEW.collected_fields IS DISTINCT FROM OLD.collected_fields
          OR NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at
          OR NEW.whatsapp_optin_at IS DISTINCT FROM OLD.whatsapp_optin_at
          OR NEW.whatsapp_optin_quote IS DISTINCT FROM OLD.whatsapp_optin_quote) THEN
    RAISE EXCEPTION 'booking_requests: the request is % and its slots, fields and thread state are frozen', NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR (OLD.conversation_id IS NOT NULL
         AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
         AND NEW.conversation_id IS NOT NULL)
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.alternative_windows IS DISTINCT FROM OLD.alternative_windows
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.vendor_call_id IS DISTINCT FROM OLD.vendor_call_id
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The grant follows the function: the decision columns, the delivery stamp,
-- the set-once call link and the decision-side set. Never the facts. The
-- token is never rotated — a re-notify is linkless.
REVOKE UPDATE ON booking_requests FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE ("status", "desk_notified_at", "decided_at", "decided_by_label", "desk_note", "confirmed_for", "appointment_id",
              "conversation_id", "proposed_slots", "reschedule_expires_at", "collected_fields", "last_inbound_at",
              "whatsapp_optin_at", "whatsapp_optin_quote")
  ON booking_requests TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE booking_requests IS
  'A booking request taken by any agent (phone or Meta) and handed to the practice through a single-use link: confirm a slot, call back, propose other times (rescheduling) or decline. Every channel semi-confirms unless the clinic elected direct booking, in which case the agent''s own booking is INSERTed already confirmed with the vendor call id. Stores SHA-256(token), never the token.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A.14 The console projection grows the new switches (configuration only)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, synthflow_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz,
  published_phone_e164 text, forwarding_test_until timestamptz, forwarding_test_observed jsonb,
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz,
  meta_front_door_enabled boolean,
  booking_mode text, direct_booking_elected_at timestamptz, direct_booking_withdrawn_at timestamptz,
  outbound_callbacks_enabled boolean, timezone_confirmed_at timestamptz,
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text,
  synthflow_callback_agent_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone, c.specialty, c.plan,
         c.attribution_mode, c.data_classification,
         c.is_covered_entity, c.baa_signed_at, c.created_at,
         c.phone_system_type, c.call_routing, c.call_routing_confirmed_at,
         c.carrier, c.synthflow_number_e164,
         (c.opening_hours IS NOT NULL) AS opening_hours_present,
         c.onboarding, c.agent_approved_at, c.went_live_at,
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at,
         c.published_phone_e164, c.forwarding_test_until, c.forwarding_test_observed,
         c.stripe_connect_account_id, c.stripe_connect_connected_at,
         c.meta_front_door_enabled,
         c.booking_mode, c.direct_booking_elected_at, c.direct_booking_withdrawn_at,
         c.outbound_callbacks_enabled, c.timezone_confirmed_at,
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source,
         c.synthflow_callback_agent_id
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding and booking-mode state only — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- The posture, re-asserted the way 0025 and 0031 assert theirs: the migration
-- that follows a widening fails here, not in production.
DO $$
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'preferred_window', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'expires_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'booked_via', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'vendor_call_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a frozen booking_requests column; the request would no longer be evidence of what the practice was told.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'outbound_calls'::regclass, 'phone', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'outbound_calls'::regclass, 'consent_record_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'outbound_calls'::regclass, 'attempt_no', 'UPDATE')
     OR has_table_privilege('healdesk_app'::name, 'outbound_calls'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or delete the evidence columns of outbound_calls.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'provider_connections'::regclass, 'phi_basis', 'UPDATE') THEN
    RAISE EXCEPTION 'provider_connections.phi_basis is not updatable by healdesk_app; the table-level grant this file relies on is gone, so grant the column.';
  END IF;
END;
$$;

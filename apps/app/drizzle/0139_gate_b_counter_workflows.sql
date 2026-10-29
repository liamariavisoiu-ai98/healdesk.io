CREATE TABLE "answer_outages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"channels" text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"reply_by_at" timestamp with time zone NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalations" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	"call_count" integer,
	"chat_count" integer,
	CONSTRAINT "answer_outages_start_key" UNIQUE("clinic_id","started_at"),
	CONSTRAINT "answer_outages_status_check" CHECK ("answer_outages"."status" in ('open', 'closed')),
	CONSTRAINT "answer_outages_channels_check" CHECK (cardinality("answer_outages"."channels") between 1 and 3 and "answer_outages"."channels" <@ array['voice', 'web', 'meta']::text[]),
	CONSTRAINT "answer_outages_closed_check" CHECK (("answer_outages"."status" = 'closed') = ("answer_outages"."ended_at" is not null) and ("answer_outages"."ended_at" is null) = ("answer_outages"."call_count" is null) and ("answer_outages"."ended_at" is null) = ("answer_outages"."chat_count" is null) and coalesce("answer_outages"."call_count", 0) >= 0 and coalesce("answer_outages"."chat_count", 0) >= 0 and "answer_outages"."escalations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "miss_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"channel" text NOT NULL,
	"missed_on" date NOT NULL,
	"first_missed_at" timestamp with time zone NOT NULL,
	"miss_count" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"reply_by_on" date NOT NULL,
	"status_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"support_case_id" uuid,
	CONSTRAINT "miss_cases_day_key" UNIQUE("clinic_id","channel","missed_on"),
	CONSTRAINT "miss_cases_ref_check" CHECK ("miss_cases"."ref" ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$'),
	CONSTRAINT "miss_cases_channel_check" CHECK ("miss_cases"."channel" in ('voice', 'web', 'meta')),
	CONSTRAINT "miss_cases_status_check" CHECK ("miss_cases"."status" in ('open', 'looking', 'explained', 'closed')),
	CONSTRAINT "miss_cases_count_check" CHECK ("miss_cases"."miss_count" >= 1),
	CONSTRAINT "miss_cases_closed_check" CHECK (("miss_cases"."status" = 'closed') = ("miss_cases"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "missed_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"ref_hash" text NOT NULL,
	"missed_at" timestamp with time zone NOT NULL,
	"caller_phone" text,
	"outcome" text NOT NULL,
	"reached_direct_line" boolean NOT NULL,
	"called_back_at" timestamp with time zone,
	"closing_note" text,
	"miss_case_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missed_contacts_ref_key" UNIQUE("clinic_id","channel","ref_hash"),
	CONSTRAINT "missed_contacts_channel_check" CHECK ("missed_contacts"."channel" in ('voice', 'web', 'meta')),
	CONSTRAINT "missed_contacts_outcome_check" CHECK ("missed_contacts"."outcome" in ('direct_line', 'contact_form', 'nowhere', 'unknown')),
	CONSTRAINT "missed_contacts_ref_check" CHECK ("missed_contacts"."ref_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "missed_contacts_phone_check" CHECK ("missed_contacts"."caller_phone" is null or "missed_contacts"."caller_phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "missed_contacts_direct_check" CHECK ("missed_contacts"."reached_direct_line" = ("missed_contacts"."outcome" = 'direct_line')),
	CONSTRAINT "missed_contacts_note_check" CHECK ("missed_contacts"."closing_note" is null or (char_length("missed_contacts"."closing_note") between 1 and 280 and "missed_contacts"."closing_note" !~ '[@<>]|https?:|www\.'))
);
--> statement-breakpoint
CREATE TABLE "routed_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"ref_hash" text NOT NULL,
	"routed_at" timestamp with time zone NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"answered_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "routed_interactions_ref_key" UNIQUE("clinic_id","channel","ref_hash"),
	CONSTRAINT "routed_interactions_channel_check" CHECK ("routed_interactions"."channel" in ('voice', 'web', 'meta')),
	CONSTRAINT "routed_interactions_outcome_check" CHECK ("routed_interactions"."outcome" in ('pending', 'excluded', 'answered', 'missed')),
	CONSTRAINT "routed_interactions_reason_check" CHECK ("routed_interactions"."reason" is null or "routed_interactions"."reason" in ('no_agreement', 'agreement_insufficient', 'unpaid', 'not_active', 'cancel_before_start', 'suspended', 'canceled', 'not_purchased', 'channel_not_live', 'channel_off', 'ai_paused', 'outside_coverage', 'allowance_cap', 'clinic_left', 'withheld', 'caller_ended', 'outside_window', 'outbound', 'host_agreement_lapsed', 'vendor_agreement_lapsed', 'start_failed', 'late', 'no_opening', 'cut_off', 'failure_line', 'error', 'no_outcome')),
	CONSTRAINT "routed_interactions_ref_check" CHECK ("routed_interactions"."ref_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "routed_interactions_reason_shape_check" CHECK (("routed_interactions"."outcome" in ('pending', 'answered')) = ("routed_interactions"."reason" is null))
);
--> statement-breakpoint
ALTER TABLE "answer_outages" ADD CONSTRAINT "answer_outages_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miss_cases" ADD CONSTRAINT "miss_cases_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "miss_cases" ADD CONSTRAINT "miss_cases_support_case_id_support_cases_id_fk" FOREIGN KEY ("support_case_id") REFERENCES "public"."support_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_contacts" ADD CONSTRAINT "missed_contacts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missed_contacts" ADD CONSTRAINT "missed_contacts_miss_case_id_miss_cases_id_fk" FOREIGN KEY ("miss_case_id") REFERENCES "public"."miss_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routed_interactions" ADD CONSTRAINT "routed_interactions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_outages_one_open_key" ON "answer_outages" USING btree ("clinic_id") WHERE "answer_outages"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "miss_cases_ref_key" ON "miss_cases" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "miss_cases_status_idx" ON "miss_cases" USING btree ("status","reply_by_on");--> statement-breakpoint
CREATE INDEX "missed_contacts_clinic_missed_idx" ON "missed_contacts" USING btree ("clinic_id","missed_at");--> statement-breakpoint
CREATE INDEX "missed_contacts_purge_idx" ON "missed_contacts" USING btree ("missed_at");--> statement-breakpoint
CREATE INDEX "routed_interactions_clinic_routed_idx" ON "routed_interactions" USING btree ("clinic_id","routed_at");--> statement-breakpoint
CREATE INDEX "routed_interactions_pending_idx" ON "routed_interactions" USING btree ("routed_at") WHERE "routed_interactions"."outcome" = 'pending';
--> statement-breakpoint
-- =============================================================================
-- Gate B: the routed/answered counter (29 October 2026). The statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- routed_interactions holds one row per call or conversation that reached
-- AYA for a clinic, and what became of it (lib/channels/routed-answered.ts):
-- the runtime's count of what was routed to her against what she answered,
-- which Gate B asks for (plan, Gates table) and which the outage notices
-- (L17, L18) and the first-month guarantee's miss notice (L21) read. Its
-- words follow Terms §5 (lib/channels/routed-words.ts).
--
-- No patient: the channel, the SHA-256 of the runtime's own id for the call
-- or conversation (never the id), closed words and times. Each row only ever
-- moves towards the worse outcome (pending, excluded, answered, missed), so
-- a retried write, a redelivered webhook or a later message can never turn
-- a miss back into an answer; the trigger holds that, and the identity of
-- the row, against any writer. The runtime role may insert and move the
-- outcome, never delete: the row is the record a guarantee claim is checked
-- against, and it is kept for good (lib/offboarding/account-closure.ts
-- KEPT_FOR_GOOD).
--
-- app_routed_answered_work(since) is the minute sweep's walk across
-- clinics, as app_clinic_change_work (0114) walks them: each clinic with a
-- row routed since `since`, its practice (the billing clinic) and the
-- practice's first channel go-live, which starts the guarantee's first month
-- (Terms §5: "the 30 days that start on the day your first channel goes
-- live"). Ids and a date only.
--
-- Safe to apply in place: three new, empty tables, a trigger, policies and
-- grants, two functions, and app_gate_b_code_built() redefined (below).
-- =============================================================================

CREATE OR REPLACE FUNCTION routed_interactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ranks text[] := ARRAY['pending', 'excluded', 'answered', 'missed'];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.ref_hash IS DISTINCT FROM OLD.ref_hash
     OR NEW.routed_at IS DISTINCT FROM OLD.routed_at THEN
    RAISE EXCEPTION 'routed_interactions: only the outcome of a routed call or conversation changes';
  END IF;
  IF array_position(ranks, NEW.outcome) < array_position(ranks, OLD.outcome) THEN
    RAISE EXCEPTION 'routed_interactions: an outcome only moves towards the worse (% to %)', OLD.outcome, NEW.outcome;
  END IF;
  IF OLD.answered_at IS NOT NULL AND NEW.answered_at IS DISTINCT FROM OLD.answered_at THEN
    RAISE EXCEPTION 'routed_interactions: the first answer is written once';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER routed_interactions_guard
  BEFORE UPDATE ON routed_interactions
  FOR EACH ROW EXECUTE FUNCTION routed_interactions_guard();--> statement-breakpoint

REVOKE ALL ON routed_interactions FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON routed_interactions TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (outcome, reason, answered_at, resolved_at) ON routed_interactions TO healdesk_app;--> statement-breakpoint

ALTER TABLE routed_interactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE routed_interactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY routed_interactions_tenant_isolation ON routed_interactions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_routed_answered_work(since timestamptz)
RETURNS TABLE (clinic_id uuid, practice_id uuid, practice_first_live_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
  m record;
  recent boolean;
  first_live timestamptz;
  member_live timestamptz;
BEGIN
  FOR c IN
    SELECT cl.id, coalesce(cl.billing_clinic_id, cl.id) AS practice, cl.organization_id AS org
      FROM clinics cl
     WHERE cl.destroyed_at IS NULL
     ORDER BY cl.created_at
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT exists (SELECT 1 FROM routed_interactions r WHERE r.clinic_id = c.id AND r.routed_at >= since)
        OR exists (SELECT 1 FROM answer_outages o WHERE o.clinic_id = c.id AND o.status = 'open')
        OR exists (SELECT 1 FROM missed_contacts mc WHERE mc.clinic_id = c.id)
      INTO recent;
    CONTINUE WHEN NOT recent;
    -- The practice's first go-live: every location of the same practice and
    -- organisation (a pointer into another organisation is no practice, as
    -- the answer gate treats it).
    first_live := NULL;
    FOR m IN
      SELECT cl2.id FROM clinics cl2
       WHERE coalesce(cl2.billing_clinic_id, cl2.id) = c.practice
         AND cl2.organization_id IS NOT DISTINCT FROM c.org
    LOOP
      PERFORM set_config('app.clinic_id', m.id::text, true);
      SELECT min(ch.live_at) INTO member_live FROM clinic_channels ch WHERE ch.clinic_id = m.id;
      first_live := least(first_live, member_live);
    END LOOP;
    clinic_id := c.id;
    practice_id := c.practice;
    practice_first_live_at := first_live;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_routed_answered_work(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_routed_answered_work(timestamptz) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_routed_answered_work(timestamptz) IS
  'The routed/answered sweep''s walk across clinics (lib/channels/answer-notices.ts): each clinic with a call or conversation routed since the argument, an outage incident open, or a missed contact to delete at its 30 days, its practice and the practice''s first channel go-live. Ids and a date, no patient data. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The workflows behind the counter's notices (owner, 29 October 2026: the
-- emails promise things, so something must happen once they are sent;
-- docs/design/launch-readiness-2026-10-27/gate-b-notice-workflows.md).
--
-- answer_outages: one row per outage incident, written in the transaction
-- that queues L17 ("We are working on it and will keep you updated"), so L18
-- can only ever pair with an incident L17 told of; closed in the one that
-- queues L18, with the counts. One open per clinic; a closed one is final.
-- The runtime role inserts and moves the status, the counts and the
-- escalation; it never deletes.
--
-- miss_cases: one row per channel and practice-local day with a first-month
-- miss, written in the transaction that queues L21 ("We're looking into
-- why"), on the practice's billing clinic. The owner moves it through open,
-- looking, explained and closed from /admin's queues. The clinic's reply to L21
-- (its subject "Looking into a call from <day>"), joins the support case the
-- first reply opened (lib/channels/miss-cases.ts).
--
-- Both: counts, channel ids, days and times. No patient. Kept for good beside
-- the counter: they are what the guarantee's finding and the notices given
-- are checked against.
-- -----------------------------------------------------------------------------

REVOKE ALL ON answer_outages FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON answer_outages TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, last_failure_at, channels, escalated_at, escalations, ended_at, call_count, chat_count) ON answer_outages TO healdesk_app;--> statement-breakpoint
ALTER TABLE answer_outages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE answer_outages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY answer_outages_tenant_isolation ON answer_outages
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

CREATE OR REPLACE FUNCTION answer_outages_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'answer_outages: incident % is closed', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER answer_outages_guard
  BEFORE UPDATE ON answer_outages
  FOR EACH ROW EXECUTE FUNCTION answer_outages_guard();--> statement-breakpoint

REVOKE ALL ON miss_cases FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON miss_cases TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, status_at, closed_at, miss_count, first_missed_at, support_case_id) ON miss_cases TO healdesk_app;--> statement-breakpoint
ALTER TABLE miss_cases ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE miss_cases FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY miss_cases_tenant_isolation ON miss_cases
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Gate B's code list is empty (lib/compliance/gate-b.ts): the practice
-- questions ask every case (0137), the answer gate is called by every
-- runtime, the counter and its notices are built here, and every live email
-- has a template. 0090's copy of "the list is empty" therefore says true, as
-- its header asks of the commit that empties the list; tests/go-live.test.ts
-- holds the two together. Go-live still asks everything else it asked.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_gate_b_code_built()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT true
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The 30-day missed-contact record (owner, 29 October 2026): one row per
-- call or conversation routed to AYA that she did not answer, so the clinic
-- can follow up from its portal (app/c/[slug]/missed). It holds the caller's
-- number when it was known, as contacts hold a number (E.164, under RLS, in
-- this database under the BAA, never logged), where the call or message
-- went, the clinic's "Called back" tick and our closing note: no words, no
-- audio, no transcript, nothing the caller said. The BAA gate refuses it for
-- a clinic that may not hold patient data, as on every patient table.
--
-- Deleted 30 days after the miss, by the routed/answered minute sweep
-- (unswitched) and the nightly retention purge; with the clinic's data at
-- destruction (destroyClinicData, and the stamp below checks it); and by a
-- person's erasure, by their number. The runtime role may insert, tick it,
-- set the note and the case link, and delete it.
-- -----------------------------------------------------------------------------

REVOKE ALL ON missed_contacts FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON missed_contacts TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (called_back_at, closing_note, miss_case_id) ON missed_contacts TO healdesk_app;--> statement-breakpoint
ALTER TABLE missed_contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE missed_contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY missed_contacts_tenant_isolation ON missed_contacts
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
CREATE TRIGGER missed_contacts_baa_gate
  BEFORE INSERT OR UPDATE ON missed_contacts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- Emptied by the destruction, so frozen once the account is closed, as every
-- such table is (0121's rights_intakes_closed_account).
CREATE TRIGGER missed_contacts_closed_account
  BEFORE INSERT OR UPDATE ON missed_contacts
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

-- 0121's app_mark_clinic_destroyed, copied whole, with missed_contacts added
-- to what it checks destroyClinicData deleted first.
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
     OR EXISTS (SELECT 1 FROM missed_contacts mc WHERE mc.clinic_id = target_clinic) THEN
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
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094), the list of who an incident affected (0098), the Retell call alerts (0106), the redial records of calls that ended early (0108), the patient-rights intakes (0121) and the missed-contact record (0139), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';

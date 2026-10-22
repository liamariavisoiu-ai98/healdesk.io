CREATE TABLE "clinic_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"add_request_id" uuid,
	"acknowledgement_id" uuid,
	"timezone" text NOT NULL,
	"address" text,
	"published_phone_e164" text,
	"opening_hours" jsonb,
	"direct_line_e164" text,
	"transfer_e164" text,
	"urgent_help_e164" text,
	"vet_referral_e164" text,
	"coverage_mode" text DEFAULT 'overflow_after_hours' NOT NULL,
	"carrier" text,
	"phone_system_type" text DEFAULT 'unknown' NOT NULL,
	"call_routing" text DEFAULT 'conditional' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_locations_clinic_id_id_key" UNIQUE("clinic_id","id"),
	CONSTRAINT "clinic_locations_position_check" CHECK ("clinic_locations"."position" >= 1),
	CONSTRAINT "clinic_locations_status_check" CHECK ("clinic_locations"."status" in ('pending', 'active', 'retired')),
	CONSTRAINT "clinic_locations_added_check" CHECK (("clinic_locations"."position" = 1) = ("clinic_locations"."add_request_id" is null) and ("clinic_locations"."position" = 1) = ("clinic_locations"."acknowledgement_id" is null)),
	CONSTRAINT "clinic_locations_lifecycle_check" CHECK (("clinic_locations"."status" <> 'pending' or ("clinic_locations"."activated_at" is null and "clinic_locations"."retired_at" is null))
        and ("clinic_locations"."status" <> 'active' or ("clinic_locations"."activated_at" is not null and "clinic_locations"."retired_at" is null))
        and ("clinic_locations"."status" <> 'retired' or "clinic_locations"."retired_at" is not null)
        and ("clinic_locations"."position" > 1 or "clinic_locations"."status" = 'active')),
	CONSTRAINT "clinic_locations_label_check" CHECK (("clinic_locations"."position" = 1 or "clinic_locations"."label" is not null) and ("clinic_locations"."label" is null or (char_length("clinic_locations"."label") between 1 and 120 and "clinic_locations"."label" = btrim("clinic_locations"."label") and "clinic_locations"."label" !~ '[[:cntrl:]]'))),
	CONSTRAINT "clinic_locations_timezone_check" CHECK (btrim("clinic_locations"."timezone") <> ''),
	CONSTRAINT "clinic_locations_address_check" CHECK ("clinic_locations"."address" is null or (char_length("clinic_locations"."address") between 1 and 300 and "clinic_locations"."address" !~ '[[:cntrl:]]')),
	CONSTRAINT "clinic_locations_published_phone_check" CHECK ("clinic_locations"."position" = 1 or "clinic_locations"."published_phone_e164" is null or "clinic_locations"."published_phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "clinic_locations_carrier_check" CHECK ("clinic_locations"."position" = 1 or "clinic_locations"."carrier" is null or (char_length("clinic_locations"."carrier") between 1 and 80 and "clinic_locations"."carrier" !~ '[[:cntrl:]]')),
	CONSTRAINT "clinic_locations_numbers_check" CHECK (("clinic_locations"."direct_line_e164" is null or "clinic_locations"."direct_line_e164" ~ '^\+[1-9][0-9]{6,14}$') and ("clinic_locations"."transfer_e164" is null or "clinic_locations"."transfer_e164" ~ '^\+[1-9][0-9]{6,14}$') and ("clinic_locations"."urgent_help_e164" is null or "clinic_locations"."urgent_help_e164" ~ '^\+[1-9][0-9]{6,14}$') and ("clinic_locations"."vet_referral_e164" is null or "clinic_locations"."vet_referral_e164" ~ '^\+[1-9][0-9]{6,14}$')),
	CONSTRAINT "clinic_locations_coverage_mode_check" CHECK ("clinic_locations"."coverage_mode" in ('all_calls', 'overflow_after_hours', 'after_hours_only')),
	CONSTRAINT "clinic_locations_phone_system_check" CHECK ("clinic_locations"."phone_system_type" in ('landline', 'voip', 'unknown')),
	CONSTRAINT "clinic_locations_call_routing_check" CHECK ("clinic_locations"."call_routing" in ('conditional', 'always'))
);
--> statement-breakpoint
CREATE TABLE "location_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"document_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"rendered_text" text NOT NULL,
	"accepted_by_label" text NOT NULL,
	"accepted_by_user_id" text NOT NULL,
	"step_up_id" uuid NOT NULL,
	"passkey_id" uuid NOT NULL,
	"device_label" text NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_acknowledgements_clinic_location_id_key" UNIQUE("clinic_id","location_id","id"),
	CONSTRAINT "location_acknowledgements_version_check" CHECK ("location_acknowledgements"."document_version" ~ '^[a-z][a-z0-9-]{0,63}/[0-9]+\.[0-9]+\.[0-9]+$'),
	CONSTRAINT "location_acknowledgements_hash_check" CHECK ("location_acknowledgements"."document_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "location_acknowledgements_text_check" CHECK (char_length(btrim("location_acknowledgements"."rendered_text")) between 1 and 20000),
	CONSTRAINT "location_acknowledgements_label_check" CHECK (char_length(btrim("location_acknowledgements"."accepted_by_label")) between 2 and 200 and "location_acknowledgements"."accepted_by_label" !~ '[[:cntrl:]]'),
	CONSTRAINT "location_acknowledgements_device_check" CHECK (char_length("location_acknowledgements"."device_label") between 1 and 60 and "location_acknowledgements"."device_label" !~ '[[:cntrl:]]'),
	CONSTRAINT "location_acknowledgements_user_agent_check" CHECK ("location_acknowledgements"."user_agent" is null or char_length("location_acknowledgements"."user_agent") <= 512)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_closures" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "handovers" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "slot_holds" ADD COLUMN "location_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_locations" ADD CONSTRAINT "clinic_locations_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_locations" ADD CONSTRAINT "clinic_locations_acknowledgement_fk" FOREIGN KEY ("clinic_id","id","acknowledgement_id") REFERENCES "public"."location_acknowledgements"("clinic_id","location_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_acknowledgements" ADD CONSTRAINT "location_acknowledgements_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_locations_position_idx" ON "clinic_locations" USING btree ("clinic_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_locations_add_request_idx" ON "clinic_locations" USING btree ("clinic_id","add_request_id");--> statement-breakpoint
CREATE INDEX "location_acknowledgements_location_idx" ON "location_acknowledgements" USING btree ("clinic_id","location_id");--> statement-breakpoint
-- =============================================================================
-- Locations, the foundation (the extra-locations plan's steps 6 and 7, and the
-- acknowledgement table from step 5; 20 October 2026). The statements above
-- were generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The owner decided on 20 October 2026 that extra locations are one central
-- AYA for the whole account, "like a call center", not an assistant per
-- location. So the clinics row stays the one tenant (one knowledge base, one
-- sign-in, one email address, one subscription whose quantity is the number of
-- locations), and what differs from site to site moves into rows inside it:
--
--   clinic_locations           one row per location of the account. Location 1
--                              (position 1), the main location, is backfilled
--                              below for every open account and made with
--                              every new clinic by a trigger on clinics; a
--                              later location is added pending, with its
--                              acceptance and its add's request id, before the
--                              charge, and only app_activate_location() makes
--                              it active, once, and only once the charge is
--                              recorded on entitlements. The runtime role
--                              cannot insert an active location, insert the
--                              main one, or move a status.
--   location_acknowledgements  the client's acceptance of one central AYA for
--                              an added location: rendered, hashed, versioned,
--                              accepted under a passkey step-up, append-only
--                              for every role and kept with the agreement.
--   location_id                on conversations, booking_requests,
--                              appointments, handovers, slot_holds,
--                              meta_booking_drafts and clinic_closures: NOT
--                              NULL, backfilled to location 1, (clinic_id,
--                              location_id) a foreign key to clinic_locations
--                              (clinic_id, id) so no row can name another
--                              account's location, and frozen once written.
--
-- NO BEHAVIOUR CHANGES. Nothing reads the new rows yet but tests
-- (lib/locations.ts), no writer names a location (a writer that names none
-- gets the main one: app_assign_main_location, because until the tool layer
-- learns locations, the plan's step 9, every row is the main location's), and
-- locationsReady() is false for every package, so nothing can add one.
--
-- ONE SOURCE OF TRUTH FOR EACH FACT. Until the portal's Locations card moves
-- their writers (step 12), the main location's facts are written where they
-- always were and every reader reads them there: clinics (address, published
-- number, hours, time zone, carrier, phone system, call routing) and
-- clinic_settings (direct line, transfer, urgent-help and vet referral
-- numbers, coverage mode). Location 1's columns are the database's copy of
-- them: triggers on both tables keep them equal, and the runtime role cannot
-- write them on location 1. A later location's columns are its only record.
-- The time zone is the account's for every location in this release (the
-- owner's first-release limits): a later location must be added in it, and
-- the trigger on clinics moves every location's with the account's.
--
-- AYA'S NUMBER STAYS ON CLINICS (assistant_number_e164) until phone per
-- location, the plan's step 15, moves it onto the row with the readers that
-- route by it (the backstop, the Retell fallback sync, the in-memory fallback
-- line). Slice 1 sells extra locations on the chat packages only, which have
-- no number, so a copy here would be a second source for nothing. Its partial
-- unique index comes with that move: on clinics it would refuse what the code
-- handles today, a number two clinics name, which the fallback sync leaves
-- with no fallback rather than either clinic's line (retell-fallback-sync.ts).
--
-- THE BILLING POINTER. clinics.billing_clinic_id is retired as the location
-- mechanism and gets no new writer: the runtime role loses UPDATE on it
-- (0043 granted it). The CHECK that it is NULL is NOT added here: whether the
-- live database holds none is unverified, and the CHECK waits for that.
--
-- Safe to apply in place: two new tables, seven columns added with a constant
-- default then backfilled clinic by clinic inside each clinic's tenant (the
-- tables are FORCEd), their user triggers off for the backfill alone (it
-- writes only the new column), foreign keys added after it, triggers that
-- copy or refuse only what is new, a grant narrowed, and the account closure
-- redefined to delete the new rows. apps/app holds synthetic and seed data
-- only (CLAUDE.md).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The runtime role's verbs. 0003's default privileges gave it all four on
-- each new table.
-- -----------------------------------------------------------------------------

-- A location is added and its facts edited (the portal's Locations card,
-- step 12), never deleted (the account's closure, a definer, does), never
-- moved to another account or place, and its status is the definers'.
REVOKE ALL ON clinic_locations FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_locations TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (label, address, published_phone_e164, opening_hours, direct_line_e164, transfer_e164,
              urgent_help_e164, vet_referral_e164, coverage_mode, carrier, phone_system_type,
              call_routing, updated_at)
  ON clinic_locations TO healdesk_app;--> statement-breakpoint

-- An acceptance is recorded and read, never changed or removed.
REVOKE ALL ON location_acknowledgements FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON location_acknowledgements TO healdesk_app;--> statement-breakpoint

-- The billing pointer: no new writer (see the header).
REVOKE UPDATE (billing_clinic_id) ON clinics FROM healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Row-level security, forced, on the clinic's own rows.
-- -----------------------------------------------------------------------------
ALTER TABLE clinic_locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_locations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_locations_tenant_isolation ON clinic_locations
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE location_acknowledgements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE location_acknowledgements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY location_acknowledgements_tenant_isolation ON location_acknowledgements
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. The backfill: location 1 for every open account, from today's columns,
-- and every row of the seven tables named to it. Clinic by clinic inside each
-- clinic's tenant, since clinic_settings, clinic_locations and the seven are
-- FORCEd even for their owner. A closed account gets none: its closure would
-- have deleted it (section 8), and destruction emptied the seven before it.
--
-- The seven tables' own triggers are off for the backfill alone: it writes
-- nothing but the column added above, and their gates (the BAA gate, the
-- closed-account freeze, the no-rewrite guards) are about the rows' contents,
-- which it does not touch. A production clinic whose agreement had lapsed
-- would otherwise refuse the UPDATE and stop the deploy. Section 9 checks they
-- are all on again.
-- -----------------------------------------------------------------------------
ALTER TABLE conversations DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE booking_requests DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE appointments DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE handovers DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE slot_holds DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE meta_booking_drafts DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE clinic_closures DISABLE TRIGGER USER;--> statement-breakpoint

DO $$
DECLARE
  c record;
  main uuid;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.account_closed_at IS NULL ORDER BY cl.created_at, cl.id LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    INSERT INTO clinic_locations
      (clinic_id, position, status, timezone, address, published_phone_e164, opening_hours,
       carrier, phone_system_type, call_routing, direct_line_e164, transfer_e164,
       urgent_help_e164, vet_referral_e164, coverage_mode, created_at, activated_at, updated_at)
    SELECT k.id, 1, 'active', k.timezone, k.address, k.published_phone_e164, k.opening_hours,
           k.carrier, k.phone_system_type::text, k.call_routing::text, s.direct_line_e164,
           s.transfer_e164, s.urgent_help_e164, s.vet_referral_e164,
           coalesce(s.coverage_mode, 'overflow_after_hours'), k.created_at, k.created_at, now()
      FROM clinics k
      LEFT JOIN clinic_settings s ON s.clinic_id = k.id
     WHERE k.id = c.id
    RETURNING id INTO main;
    UPDATE conversations x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE booking_requests x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE appointments x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE handovers x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE slot_holds x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE meta_booking_drafts x SET location_id = main WHERE x.clinic_id = c.id;
    UPDATE clinic_closures x SET location_id = main WHERE x.clinic_id = c.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', '', true);
END
$$;--> statement-breakpoint

ALTER TABLE conversations ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE booking_requests ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE appointments ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE handovers ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE slot_holds ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE meta_booking_drafts ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE clinic_closures ENABLE TRIGGER USER;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. A row names a location of its own account, or is refused. Written by
-- hand, after the backfill: drizzle-kit would add them before it, while every
-- row still held the placeholder default. NO ACTION: deleting a location never
-- deletes a patient's row; the closure deletes locations only after
-- destruction has emptied these tables.
-- -----------------------------------------------------------------------------
ALTER TABLE conversations ADD CONSTRAINT conversations_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE handovers ADD CONSTRAINT handovers_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE slot_holds ADD CONSTRAINT slot_holds_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE meta_booking_drafts ADD CONSTRAINT meta_booking_drafts_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint
ALTER TABLE clinic_closures ADD CONSTRAINT clinic_closures_location_fk
  FOREIGN KEY (clinic_id, location_id) REFERENCES clinic_locations (clinic_id, id);--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. A writer that names no location gets the main one, and a location, once
-- written, never moves, for any role.
-- -----------------------------------------------------------------------------

-- The placeholder default (schema.ts, LOCATION_UNSET) replaced with the row's
-- clinic's main location. Named `<table>_assign_location` so it fires before
-- every other BEFORE INSERT trigger on the table (Postgres fires them in name
-- order): each sees the location the row will have. Not a definer: the insert
-- is made inside the row's own tenant (the table's policy requires it), where
-- the writer can read its main location. Where none is found the placeholder
-- stays, and the foreign key refuses the row.
CREATE OR REPLACE FUNCTION app_assign_main_location()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  main uuid;
BEGIN
  IF NEW.location_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    SELECT l.id INTO main
      FROM clinic_locations l
     WHERE l.clinic_id = NEW.clinic_id AND l.position = 1;
    IF main IS NOT NULL THEN
      NEW.location_id := main;
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_assign_main_location() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER conversations_assign_location BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER booking_requests_assign_location BEFORE INSERT ON booking_requests
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER appointments_assign_location BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER handovers_assign_location BEFORE INSERT ON handovers
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER slot_holds_assign_location BEFORE INSERT ON slot_holds
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER meta_booking_drafts_assign_location BEFORE INSERT ON meta_booking_drafts
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint
CREATE TRIGGER clinic_closures_assign_location BEFORE INSERT ON clinic_closures
  FOR EACH ROW EXECUTE FUNCTION app_assign_main_location();--> statement-breakpoint

-- The freeze. Three tables already have a guard that lists the columns which
-- never change, and the location joins each list (their latest definitions,
-- 0082, 0092 and 0060, copied whole). The other four had no such guard, and
-- get this one.
CREATE OR REPLACE FUNCTION app_location_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION '%: a row''s location is set when it is written and never moves', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_location_fixed() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER conversations_location_fixed BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION app_location_fixed();--> statement-breakpoint
CREATE TRIGGER appointments_location_fixed BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_location_fixed();--> statement-breakpoint
CREATE TRIGGER meta_booking_drafts_location_fixed BEFORE UPDATE ON meta_booking_drafts
  FOR EACH ROW EXECUTE FUNCTION app_location_fixed();--> statement-breakpoint
CREATE TRIGGER clinic_closures_location_fixed BEFORE UPDATE ON clinic_closures
  FOR EACH ROW EXECUTE FUNCTION app_location_fixed();--> statement-breakpoint

-- slot_holds: 0060's guard, "a hold's calendar never changes", with its location.
CREATE OR REPLACE FUNCTION app_slot_hold_calendar_fixed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.calendar_id IS DISTINCT FROM OLD.calendar_id THEN
    RAISE EXCEPTION 'slot_holds: a hold''s calendar never changes; hold the time on the other calendar instead'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'slot_holds: a hold''s location never changes; hold the time at the other location instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- booking_requests: 0082's app_booking_request_no_rewrite, the location added
-- to what never changes.
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  token_reissued boolean;
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
          OR NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at) THEN
    RAISE EXCEPTION 'booking_requests: the request is % and its slots, fields and thread state are frozen', NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- Never NULL: current_setting(..., true) is NULL in a session that never
  -- defined the switch, and a NULL here would make the freeze below NULL,
  -- which an IF reads as false, letting any token through.
  token_reissued := coalesce(current_setting('app.booking_token_reissue', true), '') = 'on'
                    AND OLD.status = 'requested' AND NEW.status = 'requested'
                    AND OLD.desk_notified_at IS NULL AND NEW.desk_notified_at IS NULL;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR (OLD.conversation_id IS NOT NULL
         AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
         AND NEW.conversation_id IS NOT NULL)
     OR (NEW.token_hash IS DISTINCT FROM OLD.token_hash AND NOT token_reissued)
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.alternative_windows IS DISTINCT FROM OLD.alternative_windows
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.vendor_call_id IS DISTINCT FROM OLD.vendor_call_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- handovers: 0092's app_handover_guard, the location added to "what was
-- asked, where and when".
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
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'handovers: what was asked, where and when, is never rewritten'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
      RAISE EXCEPTION 'handovers: a handover''s conversation is set once'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.callback_phone IS NOT NULL
       AND (NEW.callback_phone IS DISTINCT FROM OLD.callback_phone
            OR NEW.callback_first_name IS DISTINCT FROM OLD.callback_first_name) THEN
      RAISE EXCEPTION 'handovers: a handover''s call-back number is set once'
        USING ERRCODE = '42501';
    END IF;
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

-- -----------------------------------------------------------------------------
-- 6. The two tables' own rules, for every role.
-- -----------------------------------------------------------------------------

-- clinic_locations. On insert: the main location only from inside a definer
-- (the trigger on clinics below; current_user is then the function's owner),
-- active at once; a later location pending, in an account that has its main
-- location, in the account's time zone (this release's limit). On update:
-- which account, which place, which add and which acceptance never change;
-- a status moves pending -> active or retired, active -> retired, and its
-- stamp is the database's clock at that move; and the main location's facts
-- are the copy of clinics' and clinic_settings', which the runtime role
-- cannot write. The CHECKs hold the rest (the main location is always
-- active; a later one has an add, an acceptance and a name).
CREATE OR REPLACE FUNCTION app_clinic_location_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  account_zone text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    IF NEW.position = 1 THEN
      IF current_user = 'healdesk_app' THEN
        RAISE EXCEPTION 'clinic_locations: the main location is made with its clinic (app_clinic_locations_follow_clinic); a writer adds only a later location'
          USING ERRCODE = '42501';
      END IF;
      NEW.status := 'active';
      NEW.activated_at := now();
      NEW.retired_at := NULL;
      RETURN NEW;
    END IF;
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'clinic_locations: a location is added pending; only app_activate_location() makes it active, once its charge is recorded'
        USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM clinic_locations l WHERE l.clinic_id = NEW.clinic_id AND l.position = 1) THEN
      RAISE EXCEPTION 'clinic_locations: a location is added to an account that has its main location'
        USING ERRCODE = '23514';
    END IF;
    SELECT c.timezone INTO account_zone FROM clinics c WHERE c.id = NEW.clinic_id;
    IF NEW.timezone IS DISTINCT FROM account_zone THEN
      RAISE EXCEPTION 'clinic_locations: every location of an account keeps the account''s time zone (%), in this release', account_zone
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.add_request_id IS DISTINCT FROM OLD.add_request_id
     OR NEW.acknowledgement_id IS DISTINCT FROM OLD.acknowledgement_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'clinic_locations: a location''s account, place, add and acceptance never change'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'retired'))
            OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'clinic_locations: % -> % is not a permitted transition', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
    NEW.activated_at := CASE WHEN NEW.status = 'active' THEN now() ELSE OLD.activated_at END;
    NEW.retired_at := CASE WHEN NEW.status = 'retired' THEN now() ELSE OLD.retired_at END;
  ELSIF NEW.activated_at IS DISTINCT FROM OLD.activated_at OR NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'clinic_locations: activated_at and retired_at are stamped by the status''s move, and never otherwise'
      USING ERRCODE = '42501';
  END IF;

  IF current_user = 'healdesk_app'
     AND NEW.position = 1
     AND (NEW.timezone, NEW.address, NEW.published_phone_e164, NEW.opening_hours, NEW.carrier,
          NEW.phone_system_type, NEW.call_routing, NEW.direct_line_e164, NEW.transfer_e164,
          NEW.urgent_help_e164, NEW.vet_referral_e164, NEW.coverage_mode)
         IS DISTINCT FROM
         (OLD.timezone, OLD.address, OLD.published_phone_e164, OLD.opening_hours, OLD.carrier,
          OLD.phone_system_type, OLD.call_routing, OLD.direct_line_e164, OLD.transfer_e164,
          OLD.urgent_help_e164, OLD.vet_referral_e164, OLD.coverage_mode) THEN
    RAISE EXCEPTION 'clinic_locations: the main location''s address, numbers, hours, time zone and call settings are written on clinics and clinic_settings, and copied here'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_location_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER clinic_locations_guard
  BEFORE INSERT OR UPDATE ON clinic_locations
  FOR EACH ROW EXECUTE FUNCTION app_clinic_location_guard();--> statement-breakpoint
-- After the closure, nothing rebuilds a location (0096's freeze; the closure
-- deletes them).
CREATE TRIGGER clinic_locations_closed_account
  BEFORE INSERT OR UPDATE ON clinic_locations
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

-- location_acknowledgements: append-only for every role; the hash is of the
-- text as stored; the time is the database's; and it is accepted by a person
-- with a live grant on the clinic, under a passkey step-up of theirs that is
-- not ended and within its eight hours, on the device the step-up names, for
-- a location other than the main one (which came with the signed agreement).
-- Whether the step-up is still live by its idle window is the caller's
-- (requireStepUp); this is the database's backstop on the record.
CREATE OR REPLACE FUNCTION app_location_acknowledgement_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'location_acknowledgements is append-only: an acceptance is never changed or removed'
      USING ERRCODE = '42501';
  END IF;
  NEW.accepted_at := clock_timestamp();
  IF NEW.document_hash IS DISTINCT FROM encode(sha256(convert_to(NEW.rendered_text, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'location_acknowledgements: document_hash is the SHA-256 of rendered_text'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM step_ups s
      JOIN user_factors f ON f.id = s.factor_id
     WHERE s.id = NEW.step_up_id
       AND s.user_id = NEW.accepted_by_user_id
       AND s.factor_id = NEW.passkey_id
       AND s.device_label = NEW.device_label
       AND s.revoked_at IS NULL
       AND s.created_at > clock_timestamp() - interval '8 hours'
       AND f.kind = 'passkey'
       AND f.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'location_acknowledgements: an acceptance is made under a live passkey step-up of the person it names, on the device the step-up names'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clinic_memberships m
     WHERE m.clinic_id = NEW.clinic_id AND m.user_id = NEW.accepted_by_user_id AND m.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'location_acknowledgements: an acceptance is made by a person with a live grant on the account'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM clinic_locations l
     WHERE l.clinic_id = NEW.clinic_id AND l.id = NEW.location_id AND l.position = 1
  ) THEN
    RAISE EXCEPTION 'location_acknowledgements: the main location came with the signed agreement and takes no acceptance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_location_acknowledgement_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER location_acknowledgements_guard
  BEFORE INSERT OR UPDATE OR DELETE ON location_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION app_location_acknowledgement_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 7. Location 1 follows the clinic. Definers, because the runtime role may
-- not write the main location's facts, and each reads and writes inside the
-- clinic's own tenant (clinic_locations is FORCEd for its owner too), putting
-- the caller's back. A trigger function cannot be called directly, so the
-- EXECUTE grants give the runtime role nothing it can call (0054's rule, which
-- tests/database-audit.test.ts holds every definer to).
-- -----------------------------------------------------------------------------

-- clinics: the main location made with the clinic (provisioning, the demo
-- clinic and every test's seed), and its facts, and every location's time
-- zone, kept equal to the clinic's.
CREATE OR REPLACE FUNCTION app_clinic_locations_follow_clinic()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
BEGIN
  PERFORM set_config('app.clinic_id', NEW.id::text, true);
  IF TG_OP = 'INSERT' THEN
    INSERT INTO clinic_locations
      (clinic_id, position, status, timezone, address, published_phone_e164, opening_hours,
       carrier, phone_system_type, call_routing)
    VALUES
      (NEW.id, 1, 'active', NEW.timezone, NEW.address, NEW.published_phone_e164, NEW.opening_hours,
       NEW.carrier, NEW.phone_system_type::text, NEW.call_routing::text);
  ELSE
    UPDATE clinic_locations l
       SET address = NEW.address,
           published_phone_e164 = NEW.published_phone_e164,
           opening_hours = NEW.opening_hours,
           carrier = NEW.carrier,
           phone_system_type = NEW.phone_system_type::text,
           call_routing = NEW.call_routing::text,
           updated_at = now()
     WHERE l.clinic_id = NEW.id
       AND l.position = 1
       AND (l.address, l.published_phone_e164, l.opening_hours, l.carrier, l.phone_system_type, l.call_routing)
           IS DISTINCT FROM
           (NEW.address, NEW.published_phone_e164, NEW.opening_hours, NEW.carrier,
            NEW.phone_system_type::text, NEW.call_routing::text);
    UPDATE clinic_locations l
       SET timezone = NEW.timezone,
           updated_at = now()
     WHERE l.clinic_id = NEW.id
       AND l.timezone IS DISTINCT FROM NEW.timezone;
  END IF;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_locations_follow_clinic() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_locations_follow_clinic() TO healdesk_app;--> statement-breakpoint
CREATE TRIGGER clinics_main_location
  AFTER INSERT ON clinics
  FOR EACH ROW EXECUTE FUNCTION app_clinic_locations_follow_clinic();--> statement-breakpoint
CREATE TRIGGER clinics_locations_follow
  AFTER UPDATE OF timezone, address, published_phone_e164, opening_hours, carrier, phone_system_type, call_routing
  ON clinics
  FOR EACH ROW
  WHEN ((OLD.timezone, OLD.address, OLD.published_phone_e164, OLD.opening_hours, OLD.carrier,
         OLD.phone_system_type, OLD.call_routing)
        IS DISTINCT FROM
        (NEW.timezone, NEW.address, NEW.published_phone_e164, NEW.opening_hours, NEW.carrier,
         NEW.phone_system_type, NEW.call_routing))
  EXECUTE FUNCTION app_clinic_locations_follow_clinic();--> statement-breakpoint

-- clinic_settings: the main location's lines and coverage mode kept equal to
-- the clinic's settings, and back to the defaults when the row goes (a
-- missing row means the defaults, lib/billing/settings.ts; the account's
-- closure deletes it).
CREATE OR REPLACE FUNCTION app_main_location_follows_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM set_config('app.clinic_id', OLD.clinic_id::text, true);
    UPDATE clinic_locations l
       SET direct_line_e164 = NULL,
           transfer_e164 = NULL,
           urgent_help_e164 = NULL,
           vet_referral_e164 = NULL,
           coverage_mode = 'overflow_after_hours',
           updated_at = now()
     WHERE l.clinic_id = OLD.clinic_id AND l.position = 1;
  ELSE
    PERFORM set_config('app.clinic_id', NEW.clinic_id::text, true);
    UPDATE clinic_locations l
       SET direct_line_e164 = NEW.direct_line_e164,
           transfer_e164 = NEW.transfer_e164,
           urgent_help_e164 = NEW.urgent_help_e164,
           vet_referral_e164 = NEW.vet_referral_e164,
           coverage_mode = NEW.coverage_mode,
           updated_at = now()
     WHERE l.clinic_id = NEW.clinic_id
       AND l.position = 1
       AND (l.direct_line_e164, l.transfer_e164, l.urgent_help_e164, l.vet_referral_e164, l.coverage_mode)
           IS DISTINCT FROM
           (NEW.direct_line_e164, NEW.transfer_e164, NEW.urgent_help_e164, NEW.vet_referral_e164,
            NEW.coverage_mode);
  END IF;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_main_location_follows_settings() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_main_location_follows_settings() TO healdesk_app;--> statement-breakpoint
CREATE TRIGGER clinic_settings_main_location
  AFTER INSERT OR DELETE ON clinic_settings
  FOR EACH ROW EXECUTE FUNCTION app_main_location_follows_settings();--> statement-breakpoint
CREATE TRIGGER clinic_settings_main_location_update
  AFTER UPDATE OF direct_line_e164, transfer_e164, urgent_help_e164, vet_referral_e164, coverage_mode
  ON clinic_settings
  FOR EACH ROW
  WHEN ((OLD.direct_line_e164, OLD.transfer_e164, OLD.urgent_help_e164, OLD.vet_referral_e164, OLD.coverage_mode)
        IS DISTINCT FROM
        (NEW.direct_line_e164, NEW.transfer_e164, NEW.urgent_help_e164, NEW.vet_referral_e164, NEW.coverage_mode))
  EXECUTE FUNCTION app_main_location_follows_settings();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 8. Activation, and the closure.
-- -----------------------------------------------------------------------------

-- A pending location of the tenant made active, once, by the database's
-- clock: only while the add that bought it is recorded as charged on the
-- account's entitlements (pending_location_request_id is its add_request_id
-- and pending_location_charged_at is set), so no location is active that was
-- not paid for. A location already active returns the time it became so,
-- unchanged, so a resume (the hourly reconcile, the console's retry) may ask
-- again; a retired one, another tenant's, or one never charged is refused.
-- For the add (the plan's step 8, healdesk-io-58), in place of
-- createLocationClinic.
CREATE OR REPLACE FUNCTION app_activate_location(target_location uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  loc record;
  done timestamptz;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_activate_location: no tenant is declared for this transaction'
      USING ERRCODE = '42501';
  END IF;
  SELECT l.id, l.status, l.activated_at, l.add_request_id
    INTO loc
    FROM clinic_locations l
   WHERE l.id = target_location AND l.clinic_id = tenant
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_activate_location: location % is not one of this tenant''s', target_location
      USING ERRCODE = '42501';
  END IF;
  IF loc.status = 'active' THEN
    RETURN loc.activated_at;
  END IF;
  IF loc.status <> 'pending' THEN
    RAISE EXCEPTION 'app_activate_location: location % is %, and only a pending location becomes active', target_location, loc.status
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM entitlements e
     WHERE e.clinic_id = tenant
       AND e.pending_location_request_id = loc.add_request_id::text
       AND e.pending_location_charged_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'app_activate_location: the add that bought location % is not recorded as charged', target_location
      USING ERRCODE = '23514',
            HINT = 'addLocation records the charge (markPendingLocationCharged) before it activates the location.';
  END IF;
  UPDATE clinic_locations l
     SET status = 'active'
   WHERE l.id = loc.id
  RETURNING l.activated_at INTO done;
  RETURN done;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_activate_location(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_activate_location(uuid) TO healdesk_app;--> statement-breakpoint

-- The other end of an add that was never charged: its pending location
-- retired, once the add is no longer pending on the account's entitlements
-- (a decline, a refusal, or the resume finding no charge, each of which
-- clears the pending request first). An add still pending is refused, so
-- nothing retires a location whose charge may yet go through; a location
-- already active is refused, so this never undoes a paid one. A location
-- already retired returns false; a pending one retired here returns true.
-- The pending row and its acceptance stay, as the record that the practice
-- accepted and then did not pay; a retry is a new add at the next position.
CREATE OR REPLACE FUNCTION app_retire_unpaid_location(target_request uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  loc record;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_retire_unpaid_location: no tenant is declared for this transaction'
      USING ERRCODE = '42501';
  END IF;
  SELECT l.id, l.status
    INTO loc
    FROM clinic_locations l
   WHERE l.clinic_id = tenant AND l.add_request_id = target_request
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF loc.status = 'retired' THEN
    RETURN false;
  END IF;
  IF loc.status <> 'pending' THEN
    RAISE EXCEPTION 'app_retire_unpaid_location: the location of add % is %, and only an unpaid pending one is retired here', target_request, loc.status
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM entitlements e
     WHERE e.clinic_id = tenant
       AND e.pending_location_request_id = target_request::text
  ) THEN
    RAISE EXCEPTION 'app_retire_unpaid_location: add % is still pending, and its charge may yet go through', target_request
      USING ERRCODE = '23514';
  END IF;
  UPDATE clinic_locations l SET status = 'retired' WHERE l.id = loc.id;
  RETURN true;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_retire_unpaid_location(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_retire_unpaid_location(uuid) TO healdesk_app;--> statement-breakpoint

-- 0096's app_close_clinic_account, copied whole, with the account's locations
-- added to what it deletes (after the settings, whose own trigger copies the
-- defaults onto the main location first). tests/booking-request-destruction
-- reads its deletes as the closure's list.
CREATE OR REPLACE FUNCTION app_close_clinic_account(target_clinic uuid, notice_to text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  clinic_row record;
  waiting text;
  holders text[];
  uid text;
  other record;
  kept boolean;
  n integer;
  ended integer := 0;
  done jsonb := '{}'::jsonb;
  kept_address text := nullif(lower(btrim(coalesce(notice_to, ''))), '');
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_close_clinic_account: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.account_closed_at, c.offboarding_started_at
    INTO clinic_row
    FROM clinics c
   WHERE c.id = target_clinic
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_close_clinic_account: no clinic %', target_clinic USING ERRCODE = 'no_data_found';
  END IF;
  IF clinic_row.account_closed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  waiting := app_account_closure_waiting_on(target_clinic);
  IF waiting IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic %''s account cannot close yet: %.', target_clinic, waiting
      USING ERRCODE = 'check_violation',
            HINT = 'not_destroyed and pass_through wait for the clock; voice_agent for the agent''s release recorded on the care page; incident_open, critical_notice and stripe_connect for what they name (app_account_closure_waiting_on).';
  END IF;
  IF kept_address IS NOT NULL
     AND (char_length(kept_address) NOT BETWEEN 3 AND 254
          OR kept_address !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+$') THEN
    kept_address := NULL;
  END IF;

  -- The sign-in. Who held a live grant is read first; an address change still
  -- open is ended, so nothing moves an address back onto a closed sign-in;
  -- the grants are revoked and kept; and each person whose last live grant
  -- this was loses every way in and every detail of theirs.
  holders := ARRAY(SELECT DISTINCT m.user_id FROM clinic_memberships m
                    WHERE m.clinic_id = target_clinic AND m.revoked_at IS NULL);
  UPDATE sign_in_address_changes a
     SET status = CASE a.status WHEN 'awaiting_confirmation' THEN 'expired' ELSE 'failed' END,
         resolved_at = now(),
         resolution = 'The account closed.'
   WHERE a.clinic_id = target_clinic
     AND a.status IN ('awaiting_confirmation', 'pending');
  UPDATE clinic_memberships m SET revoked_at = now()
   WHERE m.clinic_id = target_clinic AND m.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('memberships_revoked', n);
  FOREACH uid IN ARRAY holders LOOP
    kept := false;
    -- clinic_memberships is FORCEd, so even its owner sees one tenant at a
    -- time: walk the other clinics of the person's organisations, as
    -- app_user_clinic_grants does (0043), and put the tenant back.
    FOR other IN
      SELECT cl.id FROM clinics cl
       WHERE cl.id <> target_clinic
         AND cl.organization_id IN (SELECT mb.organization_id FROM member mb WHERE mb.user_id = uid)
    LOOP
      PERFORM set_config('app.clinic_id', other.id::text, true);
      IF EXISTS (SELECT 1 FROM clinic_memberships m
                  WHERE m.clinic_id = other.id AND m.user_id = uid AND m.revoked_at IS NULL) THEN
        kept := true;
        EXIT;
      END IF;
    END LOOP;
    PERFORM set_config('app.clinic_id', target_clinic::text, true);
    IF NOT kept THEN
      DELETE FROM step_ups s WHERE s.user_id = uid;
      DELETE FROM factor_lockouts f WHERE f.user_id = uid;
      DELETE FROM webauthn_challenges w WHERE w.user_id = uid;
      DELETE FROM user_backup_codes b WHERE b.user_id = uid;
      DELETE FROM user_factors f WHERE f.user_id = uid;
      DELETE FROM sign_in_links l WHERE l.user_id = uid;
      DELETE FROM device_recoveries d WHERE d.user_id = uid;
      DELETE FROM session s WHERE s.user_id = uid;
      DELETE FROM account a WHERE a.user_id = uid;
      DELETE FROM invitation i WHERE i.inviter_id = uid;
      DELETE FROM member mb WHERE mb.user_id = uid;
      -- Better Auth's own rows for the person. As lib/auth.ts configures it
      -- (passwords off, no social sign-in, no OTP or magic-link plugin), the
      -- only ones that name a user are core's reset-password:<token> and
      -- delete-account-<token>, each holding that user's id, whole, as its
      -- value (better-auth 1.6.26, api/routes/password.mjs and
      -- update-user.mjs; identifiers stored plain). So they are matched on
      -- the id, exactly, never on the address, which can sit inside another
      -- person's (a@b.com inside xa@b.com). A plugin that keys its rows by
      -- the address (email-otp's <type>-otp-<email>) would need its exact
      -- form added here before it is turned on.
      DELETE FROM verification v WHERE v.value = uid;
      -- Kept as the tombstone the audit log's actor id points at: a
      -- non-routable address (RFC 2606's .invalid), no name, no picture.
      UPDATE "user" u
         SET email = 'closed+' || replace(gen_random_uuid()::text, '-', '') || '@invalid',
             name = 'Closed account',
             image = NULL,
             email_verified = false,
             updated_at = now()
       WHERE u.id = uid;
      ended := ended + 1;
    END IF;
  END LOOP;
  done := done || jsonb_build_object('sign_ins_ended', ended);

  -- The setup.
  DELETE FROM agent_configs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('agent_configs', n);
  DELETE FROM clinic_settings_history x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_settings_history', n);
  DELETE FROM clinic_settings x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_settings', n);
  DELETE FROM report_recipients x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('report_recipients', n);
  DELETE FROM audit_review_queue x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('audit_review_queue', n);
  DELETE FROM practice_question_results x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('practice_question_results', n);
  DELETE FROM practice_question_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('practice_question_runs', n);
  DELETE FROM website_changes x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('website_changes', n);
  DELETE FROM site_rereads x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('site_rereads', n);
  -- The account's locations (0109): their addresses, lines and hours,
  -- business data, no patient. The acceptance each later one was added
  -- under is kept with the agreement (location_acknowledgements).
  DELETE FROM clinic_locations x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_locations', n);

  -- Our own business data about the account.
  DELETE FROM clinic_touches x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('clinic_touches', n);
  DELETE FROM sync_runs x WHERE x.clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('sync_runs', n);
  -- A link a calendar election was signed through is part of that
  -- election's record (0057), and an OAuth state in flight still names its
  -- link; every other link goes.
  DELETE FROM connection_links x WHERE x.clinic_id = target_clinic
     AND NOT EXISTS (SELECT 1 FROM calendar_elections e WHERE e.clinic_id = x.clinic_id AND e.link_id = x.id)
     AND NOT EXISTS (SELECT 1 FROM google_oauth_states s WHERE s.target_clinic_id = x.clinic_id AND s.link_id = x.id);
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('connection_links', n);
  -- The checkout the clinic was provisioned from: the buyer's details and
  -- the website read at checkout (no clinic_id, so not on the catalog's
  -- lists; billing-housekeeping deletes the same rows 90 days after use).
  DELETE FROM checkout_intents ci WHERE ci.provisioned_clinic_id = target_clinic;
  GET DIAGNOSTICS n = ROW_COUNT; done := done || jsonb_build_object('checkout_intents', n);

  -- The setup columns of the clinic row, and the closure beside them: every
  -- column the practice or the wizard set up, how calls were routed and
  -- when it went live included, back to its default. What stays, and why:
  --   name, slug, specialty, time zone and address: the kept records name
  --     the practice by them;
  --   the published number: the widget a clinic has not yet taken off its
  --     website shows it as the number to call;
  --   is_covered_entity, the agreement kind and regime, the BAA stamps, the
  --     data classification and the direct-booking clause: terms of the
  --     signed agreement;
  --   the record clock (retention_*_days and its shortening): the clock the
  --     agreement's retention clause ran on, which the kept audit of each
  --     purge and the destruction refers to;
  --   billing_clinic_id, the Stripe Connect disconnect and client_number:
  --     billing records, and the label the destroyed credentials were sealed
  --     under;
  --   the offboarding dates, the destruction notice address and the
  --     organisation: what destruction and its notice ran on.
  UPDATE clinics c
     SET site_profile = NULL,
         onboarding = '{}'::jsonb,
         opening_hours = NULL,
         booking_requirements = NULL,
         booking_requirements_source = NULL,
         booking_requirements_confirmed_at = NULL,
         forwarding_test_observed = NULL,
         forwarding_test_until = NULL,
         website = NULL,
         booking_provider = NULL,
         pos_provider = NULL,
         carrier = NULL,
         phone_system_type = 'unknown',
         average_treatment_value_usd = NULL,
         booking_mode = 'desk_confirms',
         meta_front_door_enabled = false,
         stripe_connect_connected_at = NULL,
         call_routing = 'conditional',
         call_routing_confirmed_at = NULL,
         timezone_confirmed_at = NULL,
         agent_approved_at = NULL,
         went_live_at = NULL,
         attribution_mode = 'estimated',
         plan = NULL,
         notice_address = kept_address,
         notice_address_until = CASE WHEN kept_address IS NULL THEN NULL
                                     ELSE clinic_row.offboarding_started_at + interval '6 years' END,
         account_closed_at = now(),
         updated_at = now()
   WHERE c.id = target_clinic;

  RETURN done;
END
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_close_clinic_account(uuid, text) IS
  'Closes a clinic''s account once app_account_closure_waiting_on() says nothing is left: revokes its memberships and, for each person whose last live grant it held, deletes every way in (sessions, accounts, verifications, factors, codes, challenges, step-ups, lockouts, sign-in links, device recovery links, invitations, organisation memberships) and tombstones the user row, which the audit log keeps naming; deletes its setup, its locations (0109), touches, sync runs, unnamed connection links and checkout intents; clears the clinic row''s setup columns; keeps the notice address for six years after the service ended; stamps clinics.account_closed_at. Returns what it did by table, or NULL when already closed. No patient data.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE clinic_locations IS
  'One row per location of the account (the clinics row is the one tenant): what differs from site to site. Position 1, the main location, exists for every open account, made with its clinic by clinics_main_location and backfilled by 0109, its facts the database''s copy of clinics'' and clinic_settings'' (clinics_locations_follow, clinic_settings_main_location*), which the runtime role cannot write. A later location is added pending with its acceptance and add before the charge, and made active only by app_activate_location(). Business data, no patient. Deleted by the account''s closure.';--> statement-breakpoint
COMMENT ON TABLE location_acknowledgements IS
  'The client''s acceptance, for one added location, of one central AYA for every location: the rendered text, its version and SHA-256, who accepted it under which passkey step-up and on which device, and when by the database''s clock. Append-only for every role; kept with the agreement through destruction and the closure. Contract evidence, no patient.';--> statement-breakpoint
COMMENT ON FUNCTION app_activate_location(uuid) IS
  'Makes a pending location of the tenant active, once, by the database''s clock, while the add that bought it is recorded as charged on entitlements; returns activated_at, unchanged for a location already active. Refuses a retired location, another tenant''s, and one never charged.';--> statement-breakpoint
COMMENT ON FUNCTION app_retire_unpaid_location(uuid) IS
  'Retires the tenant''s pending location of an add that is no longer pending on entitlements (declined, refused, or found uncharged); refuses an add still pending and a location already active. The row and its acceptance stay. Returns true when it retired one.';--> statement-breakpoint
COMMENT ON FUNCTION app_assign_main_location() IS
  'BEFORE INSERT on the seven tables with a location_id: the placeholder default replaced with the row''s clinic''s main location. Fires first on each table.';--> statement-breakpoint
COMMENT ON COLUMN clinic_locations.timezone IS
  'The account''s time zone, for every location in this release: a later location is added in it, and clinics_locations_follow moves every location''s with the clinic''s.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 9. The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO offending
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('clinic_locations', 'location_acknowledgements')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Row-level security is not ENABLEd and FORCEd on: %', offending;
  END IF;

  IF has_table_privilege('healdesk_app', 'clinic_locations', 'DELETE')
     OR has_any_column_privilege('healdesk_app', 'location_acknowledgements', 'UPDATE')
     OR has_table_privilege('healdesk_app', 'location_acknowledgements', 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can delete a location, or rewrite or delete an acceptance.';
  END IF;
  SELECT string_agg(col, ', ') INTO offending
    FROM unnest(ARRAY['id', 'clinic_id', 'position', 'status', 'add_request_id', 'acknowledgement_id',
                      'timezone', 'created_at', 'activated_at', 'retired_at']) AS col
   WHERE has_column_privilege('healdesk_app', 'clinic_locations', col, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a clinic_locations column only the definers write: %', offending;
  END IF;
  IF has_column_privilege('healdesk_app', 'clinics', 'billing_clinic_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE clinics.billing_clinic_id, which gets no new writer.';
  END IF;

  -- Every rule above that binds the owner too is a trigger: each must exist
  -- on its table, enabled; and the seven tables' own came back on after the
  -- backfill.
  SELECT string_agg(format('%s on %s', v.tg, v.rel), ', ') INTO offending
    FROM (VALUES ('clinic_locations', 'clinic_locations_guard'),
                 ('clinic_locations', 'clinic_locations_closed_account'),
                 ('location_acknowledgements', 'location_acknowledgements_guard'),
                 ('clinics', 'clinics_main_location'),
                 ('clinics', 'clinics_locations_follow'),
                 ('clinic_settings', 'clinic_settings_main_location'),
                 ('clinic_settings', 'clinic_settings_main_location_update'),
                 ('conversations', 'conversations_assign_location'),
                 ('booking_requests', 'booking_requests_assign_location'),
                 ('appointments', 'appointments_assign_location'),
                 ('handovers', 'handovers_assign_location'),
                 ('slot_holds', 'slot_holds_assign_location'),
                 ('meta_booking_drafts', 'meta_booking_drafts_assign_location'),
                 ('clinic_closures', 'clinic_closures_assign_location'),
                 ('conversations', 'conversations_location_fixed'),
                 ('appointments', 'appointments_location_fixed'),
                 ('meta_booking_drafts', 'meta_booking_drafts_location_fixed'),
                 ('clinic_closures', 'clinic_closures_location_fixed'),
                 ('booking_requests', 'booking_requests_no_rewrite'),
                 ('handovers', 'handovers_guard'),
                 ('slot_holds', 'slot_holds_calendar_fixed')) AS v(rel, tg)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger g
      WHERE g.tgrelid = v.rel::regclass AND g.tgname = v.tg AND g.tgenabled = 'O'
   );
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or disabled trigger: %', offending;
  END IF;
  SELECT string_agg(format('%s on %s', g.tgname, g.tgrelid::regclass), ', ') INTO offending
    FROM pg_trigger g
   WHERE g.tgrelid IN ('conversations'::regclass, 'booking_requests'::regclass, 'appointments'::regclass,
                       'handovers'::regclass, 'slot_holds'::regclass, 'meta_booking_drafts'::regclass,
                       'clinic_closures'::regclass)
     AND NOT g.tgisinternal
     AND g.tgenabled <> 'O';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'A trigger the backfill turned off is still off: %', offending;
  END IF;
END
$$;--> statement-breakpoint

-- Every open account has exactly one main location, and every location row
-- below names one of its own account's (the foreign keys hold the second; this
-- is the count the backfill must leave). Inside each clinic's tenant.
DO $$
DECLARE
  c record;
  mains integer;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.account_closed_at IS NULL LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT count(*) INTO mains FROM clinic_locations l WHERE l.clinic_id = c.id AND l.position = 1;
    IF mains <> 1 THEN
      RAISE EXCEPTION 'Clinic % has % main locations after the backfill; it must have one.', c.id, mains;
    END IF;
  END LOOP;
  PERFORM set_config('app.clinic_id', '', true);
END
$$;

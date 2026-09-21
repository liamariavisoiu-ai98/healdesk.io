CREATE TABLE "booking_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"connection_id" uuid,
	"preferred_window" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"desk_notified_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_label" text,
	"desk_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_booking_drafts" (
	"clinic_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"sender_id" text NOT NULL,
	"external_id" text NOT NULL,
	"first_name" text,
	"phone" text,
	"preferred_window" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_booking_drafts_clinic_id_platform_sender_id_pk" PRIMARY KEY("clinic_id","platform","sender_id")
);
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" ADD CONSTRAINT "meta_booking_drafts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_requests_token_idx" ON "booking_requests" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "booking_requests_clinic_idx" ON "booking_requests" USING btree ("clinic_id","created_at");--> statement-breakpoint

-- =============================================================================
-- Meta booking hand-off (decision of 21 September 2026: "keep A everywhere,
-- but hand off a calendar booking the practice's human gets to accept or
-- deny").
--
-- The front door still books nothing. What it now does is collect a first
-- name, a phone number and a preferred window across a thread, write one
-- booking_requests row, and email the practice a single-use link. The desk
-- accepts or declines on that page; the person is told, on the channel they
-- used, that the practice has their request — never a time, never a provider.
--
-- Two tables. meta_booking_drafts is the half-collected request keyed by the
-- thread; it carries a phone number, so it is patient data and gets the BAA
-- gate like contacts. booking_requests is the request itself, with the desk's
-- credential stored as SHA-256(token), exactly like connection_links (0024).
-- =============================================================================

-- Storing the base64url token itself (43 bytes) would make every row a working
-- link. The constraint turns that refactor into a failed INSERT.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_token_hash_is_sha256 CHECK (octet_length(token_hash) = 32);--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_status_known CHECK (status IN ('requested', 'accepted', 'declined', 'expired'));--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_platform_known CHECK (platform IN ('messenger', 'instagram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE meta_booking_drafts
  ADD CONSTRAINT meta_booking_drafts_platform_known CHECK (platform IN ('messenger', 'instagram', 'whatsapp'));--> statement-breakpoint

-- Both carry a caller's number: no row for a production clinic without a BAA.
CREATE TRIGGER booking_requests_baa_gate
  BEFORE INSERT OR UPDATE ON booking_requests
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint
CREATE TRIGGER meta_booking_drafts_baa_gate
  BEFORE INSERT OR UPDATE ON meta_booking_drafts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

ALTER TABLE booking_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE booking_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY booking_requests_tenant_isolation ON booking_requests
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE meta_booking_drafts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE meta_booking_drafts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY meta_booking_drafts_tenant_isolation ON meta_booking_drafts
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- The desk opening the link has no session and no tenant. Same bootstrap as
-- 0024: the digest the caller presents, in a transaction-local setting, is
-- what the policy authorises against. SECURITY DEFINER would not help — the
-- definer owns the table and FORCE applies to the owner too.
CREATE OR REPLACE FUNCTION app_current_booking_hash()
RETURNS bytea
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN current_setting('app.booking_request_hash', true) ~ '^[0-9a-f]{64}$'
           THEN decode(current_setting('app.booking_request_hash', true), 'hex')
           ELSE NULL
         END
$$;--> statement-breakpoint

CREATE POLICY booking_requests_token_bootstrap ON booking_requests
  FOR SELECT
  USING (
    app_current_clinic_id() IS NULL
    AND token_hash = app_current_booking_hash()
  );--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_booking_request_clinic(request_token_hash bytea)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  found uuid;
BEGIN
  IF request_token_hash IS NULL OR octet_length(request_token_hash) <> 32 THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.booking_request_hash', encode(request_token_hash, 'hex'), true);
  SELECT r.clinic_id INTO found FROM booking_requests r WHERE r.token_hash = request_token_hash;
  RETURN found;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_booking_request_clinic(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_booking_request_clinic(bytea) TO healdesk_app;--> statement-breakpoint

-- A decided request stays decided, and the facts of the request do not move.
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.decided_at IS NOT NULL AND (
       NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.decided_by_label IS DISTINCT FROM OLD.decided_by_label
     ) THEN
    RAISE EXCEPTION 'booking_requests row is already decided and cannot be re-decided'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER booking_requests_no_rewrite
  BEFORE UPDATE ON booking_requests
  FOR EACH ROW EXECUTE FUNCTION app_booking_request_no_rewrite();--> statement-breakpoint

-- Privileges. 0003's default grant already gave the app role all four; a
-- request is evidence of what the practice was told, so no DELETE, and only
-- the decision columns may be written.
REVOKE DELETE ON booking_requests FROM healdesk_app;--> statement-breakpoint
REVOKE UPDATE ON booking_requests FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE ("status", "desk_notified_at", "decided_at", "decided_by_label", "desk_note") ON booking_requests TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON booking_requests TO healdesk_app;--> statement-breakpoint
-- Drafts are scratch: overwritten per message, deleted when the request is
-- made or when they go stale.
GRANT SELECT, INSERT, UPDATE, DELETE ON meta_booking_drafts TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE booking_requests IS
  'A booking request collected on a Meta channel and handed to the practice to accept or decline through a single-use link. Stores SHA-256(token), never the token. The person is only ever told the practice has their request; a time is never stated on the channel.';--> statement-breakpoint
COMMENT ON TABLE meta_booking_drafts IS
  'The half-collected booking request on one Meta thread, so the next message can ask for the missing piece. Overwritten per message; deleted when the request is created; swept after a day.';

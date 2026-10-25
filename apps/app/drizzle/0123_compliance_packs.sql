CREATE TABLE "compliance_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" date NOT NULL,
	"generated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"generated_by" text NOT NULL,
	CONSTRAINT "compliance_packs_week_check" CHECK (extract(isodow from "compliance_packs"."week_start") = 1),
	CONSTRAINT "compliance_packs_hash_check" CHECK ("compliance_packs"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "compliance_packs_generated_by_check" CHECK ("compliance_packs"."generated_by" ~ '^[a-z][a-z0-9-]{0,63}$'),
	CONSTRAINT "compliance_packs_payload_check" CHECK (jsonb_typeof("compliance_packs"."payload") = 'object' and position('@' in "compliance_packs"."payload"::text) = 0 and regexp_replace(regexp_replace("compliance_packs"."payload"::text, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){6,}')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_packs_week_key" ON "compliance_packs" USING btree ("week_start");--> statement-breakpoint
-- =============================================================================
-- The weekly compliance pack (25 October 2026; ops automation Phase 6, lane
-- P6h; design E6 item 18; owner decision D20). The statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The owner wants one page a week that answers "are we keeping our
-- promises?" without opening six screens: agreements signed and re-signed,
-- the vendor chain's attestations, incidents and their clocks, patient-rights
-- requests and their clocks, transcript copies and the purge, the access
-- log's counts and the approval inbox's decisions. The pack is for him only
-- (D20); an auditor gets the printed page from him.
--
--   compliance_packs  one row per week, keyed by the Monday (New York) the
--                     week starts on: the payload (counts, ids, dates and
--                     closed words, never a patient, never anything typed),
--                     the SHA-256 of its canonical JSON, when it was made
--                     and by which service. Written once, by the
--                     compliance-pack job on the Monday after the week, or by
--                     an operator's generateCompliancePack for a week the job
--                     missed; never changed. The runtime role holds SELECT and
--                     INSERT only, and a trigger refuses UPDATE, DELETE and
--                     TRUNCATE to any role that issues them, the migrator
--                     included. The triggers are ENABLE ALWAYS, so a session
--                     that sets session_replication_role does not skip them
--                     (the same pattern and the same limit as
--                     ops_approval_events in drizzle/0119: only a reviewed DDL
--                     change by the table owner could remove them).
--
-- Not a tenant table: one pack covers every clinic and is written outside any
-- tenant, like platform_compliance and ops_approval_events, so it has no
-- clinic column (every table with a clinic_id is a FORCE-RLS tenant table,
-- tests/rls-drift.test.ts) and no RLS. It names a clinic only by id, inside
-- the payload, beside an incident's id. Kept for good, as security_events is:
-- it is the record of what the owner was shown. On the read-only role's list
-- (scripts/readonly-tables.ts): it holds no patient.
--
-- The payload CHECK is the approval inbox's: no `@` anywhere, and no run of
-- seven or more digits once uuids and ISO dates are taken out, so an address
-- or a telephone number can never be stored here by mistake.
--
-- One job row, seeded OFF like every job: compliance-pack, hourly from the
-- tick, which stores last week's pack from 07:00 New York on Monday, once.
--
-- Safe to apply in place: one new, empty table and one job row.
-- =============================================================================

REVOKE ALL ON compliance_packs FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON compliance_packs TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_compliance_packs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'compliance_packs is written once and never changed: % is refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_compliance_packs_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER compliance_packs_immutable
  BEFORE UPDATE OR DELETE ON compliance_packs
  FOR EACH ROW EXECUTE FUNCTION app_compliance_packs_immutable();--> statement-breakpoint
CREATE TRIGGER compliance_packs_no_truncate
  BEFORE TRUNCATE ON compliance_packs
  FOR EACH STATEMENT EXECUTE FUNCTION app_compliance_packs_immutable();--> statement-breakpoint
ALTER TABLE compliance_packs ENABLE ALWAYS TRIGGER compliance_packs_immutable;--> statement-breakpoint
ALTER TABLE compliance_packs ENABLE ALWAYS TRIGGER compliance_packs_no_truncate;--> statement-breakpoint

COMMENT ON TABLE compliance_packs IS
  'Ops-only, platform-wide: one weekly compliance pack per Monday (New York) week (design E6 item 18; owner decision D20, for the owner only): counts, ids, dates and closed words, the SHA-256 of the payload''s canonical JSON, when and by which service it was made. Written once and never changed: UPDATE, DELETE and TRUNCATE are refused by ENABLE ALWAYS triggers for any role. No patient and no free text; kept for good; no RLS (drizzle/0123 says why).';--> statement-breakpoint

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('compliance-pack', 'Hourly; from 07:00 New York on Monday, stores last week''s compliance pack once (counts, ids and dates: agreements, vendor attestations, incidents, patient-rights requests, transcript copies, the access log and the approval inbox) and emails the owner a pointer to it with five headline numbers. Never changes a stored pack. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

DO $$
DECLARE
  trig record;
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'compliance_packs'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('healdesk_app'::name, 'compliance_packs'::regclass, 'UPDATE')
     OR NOT has_table_privilege('healdesk_app'::name, 'compliance_packs'::regclass, 'SELECT, INSERT') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or erase a compliance pack, or cannot read and add one.';
  END IF;
  FOR trig IN
    SELECT t.tgname, t.tgenabled FROM pg_trigger t
     WHERE t.tgname IN ('compliance_packs_immutable', 'compliance_packs_no_truncate')
  LOOP
    IF trig.tgenabled <> 'A' THEN
      RAISE EXCEPTION 'trigger % is not ENABLE ALWAYS', trig.tgname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('compliance_packs_immutable', 'compliance_packs_no_truncate')) <> 2 THEN
    RAISE EXCEPTION 'a compliance pack guard trigger is missing';
  END IF;
END;
$$;

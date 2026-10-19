CREATE TABLE "site_rereads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"website" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone,
	"failure" text,
	"changes" integer,
	CONSTRAINT "site_rereads_clinic_read_key" UNIQUE("clinic_id","id"),
	CONSTRAINT "site_rereads_reason_check" CHECK ("site_rereads"."reason" in ('missing', 'corrected', 'drift', 'ops')),
	CONSTRAINT "site_rereads_status_check" CHECK ("site_rereads"."status" in ('queued', 'running', 'read', 'failed', 'superseded')),
	CONSTRAINT "site_rereads_failure_check" CHECK ("site_rereads"."failure" is null or "site_rereads"."failure" in ('unreadable', 'rate_limited', 'unavailable', 'network', 'refused', 'invalid')),
	CONSTRAINT "site_rereads_website_check" CHECK (char_length("site_rereads"."website") between 4 and 200 and "site_rereads"."website" !~ '[[:space:][:cntrl:]]'),
	CONSTRAINT "site_rereads_attempts_check" CHECK ("site_rereads"."attempts" >= 0),
	CONSTRAINT "site_rereads_changes_check" CHECK ("site_rereads"."changes" is null or "site_rereads"."changes" >= 0),
	CONSTRAINT "site_rereads_finished_check" CHECK (("site_rereads"."status" in ('read', 'failed', 'superseded')) = ("site_rereads"."finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "website_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"reread_id" uuid NOT NULL,
	"section" text NOT NULL,
	"kind" text NOT NULL,
	"item_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"state" text DEFAULT 'new' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_label" text,
	CONSTRAINT "website_changes_section_check" CHECK ("website_changes"."section" in ('practice', 'prices', 'hours', 'providers', 'policies', 'quick_answers')),
	CONSTRAINT "website_changes_kind_check" CHECK ("website_changes"."kind" in ('added', 'removed', 'changed')),
	CONSTRAINT "website_changes_state_check" CHECK ("website_changes"."state" in ('new', 'confirmed', 'ignored', 'superseded')),
	CONSTRAINT "website_changes_fingerprint_check" CHECK ("website_changes"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "website_changes_item_key_check" CHECK (char_length("website_changes"."item_key") between 1 and 300 and "website_changes"."item_key" !~ '[[:cntrl:]]'),
	CONSTRAINT "website_changes_values_check" CHECK (("website_changes"."kind" = 'added' and "website_changes"."before" is null and "website_changes"."after" is not null) or ("website_changes"."kind" = 'removed' and "website_changes"."before" is not null and "website_changes"."after" is null) or ("website_changes"."kind" = 'changed' and "website_changes"."before" is not null and "website_changes"."after" is not null)),
	CONSTRAINT "website_changes_decided_check" CHECK (("website_changes"."state" in ('confirmed', 'ignored')) = ("website_changes"."decided_at" is not null) and ("website_changes"."decided_at" is null) = ("website_changes"."decided_by_label" is null)),
	CONSTRAINT "website_changes_decided_by_check" CHECK ("website_changes"."decided_by_label" is null or char_length("website_changes"."decided_by_label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "site_rereads" ADD CONSTRAINT "site_rereads_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_changes" ADD CONSTRAINT "website_changes_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_changes" ADD CONSTRAINT "website_changes_reread_fk" FOREIGN KEY ("clinic_id","reread_id") REFERENCES "public"."site_rereads"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_rereads_queued_idx" ON "site_rereads" USING btree ("clinic_id") WHERE "site_rereads"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "site_rereads_running_idx" ON "site_rereads" USING btree ("clinic_id") WHERE "site_rereads"."status" = 'running';--> statement-breakpoint
CREATE INDEX "site_rereads_clinic_idx" ON "site_rereads" USING btree ("clinic_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "website_changes_fingerprint_idx" ON "website_changes" USING btree ("clinic_id","fingerprint");--> statement-breakpoint
CREATE INDEX "website_changes_new_idx" ON "website_changes" USING btree ("clinic_id","detected_at") WHERE "website_changes"."state" = 'new';
-- =============================================================================
-- The signed website re-reads and the drift list (plan Part B, "Re-reads";
-- Part F3, "Changes on your website"; Annex X5, L23). The statements above
-- were generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- apps/app asks apps/web to read a clinic's website again, through the
-- signed route /api/clinic-site, which fetches and extracts off the PHI host
-- and stores nothing (lib/website). A read is asked for when a clinic has a
-- website and no profile, when it corrects its website, by the monthly drift
-- check of a live clinic, or by an operator; the site-reads job claims each
-- under a lease, one at a time per clinic. A missing or corrected read becomes
-- clinics.site_profile, the baseline; a drift read is compared with that
-- baseline, per Knowledge section, and each change Knowledge does not already
-- say waits in website_changes for the clinic to confirm into Knowledge or
-- ignore. An ignore is remembered by the change's fingerprint.
--
-- Nothing in either table is PHI: a website is what a practice publishes
-- about itself, screened like the purchase read. So no BAA gate. What the
-- database holds to:
--
--   * tenant isolation, forced, on both, and each is listed in
--     TENANT_SCOPED_TABLES;
--   * nothing is deleted by the runtime role: a read and its changes are the
--     record of what the website said and what the clinic decided about it.
--     Destruction keeps them, beside agent_configs (the keep-list in
--     tests/booking-request-destruction.test.ts names each);
--   * the runtime role moves a read on (its status, reason, website, clock
--     and outcome), and a change's state and decision, and nothing else: no
--     change's section, item, fingerprint or values are rewritten once
--     written;
--   * app_due_site_rereads, the tenant walk the minute job finds due reads
--     with: ids only.
--
-- Two job rows: `site-reads` ON, because it reads only what a clinic's own
-- setup asked for, mails nothing, and does nothing until HEALDESK_WEB_URL is
-- set; `website-drift` OFF, for the owner to switch on before the first
-- clinic's 30th live day.
--
-- Safe to apply in place: two new tables, one function and two job rows.
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

ALTER TABLE site_rereads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE site_rereads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_rereads_tenant_isolation ON site_rereads
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE website_changes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE website_changes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY website_changes_tenant_isolation ON website_changes
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- Grants. 0003's default privileges have already given healdesk_app all four
-- on each new table, so every REVOKE is required, and each GRANT restates the
-- intended set.
REVOKE ALL ON site_rereads FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON site_rereads TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (reason, status, website, run_after, lease_until, attempts, finished_at, failure, changes)
  ON site_rereads TO healdesk_app;--> statement-breakpoint

REVOKE ALL ON website_changes FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON website_changes TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (reread_id, state, detected_at, decided_at, decided_by_label)
  ON website_changes TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_due_site_rereads: the reads the minute job may claim, across clinics.
-- -----------------------------------------------------------------------------
-- 0080's tenant walk (app_due_practice_runs): the table forces row-level
-- security, which binds the definer too, so the walk sets the tenant per
-- clinic and restores the caller's setting. Clinic id and read id, and only
-- what is due: a queued read whose time has come, or a running one whose
-- lease ran out. The job claims each inside withTenant() (claimSiteReread),
-- which checks the same again under the row's own conditions. It counts no
-- days, so no time-zone pin; the clock is the database's.
CREATE OR REPLACE FUNCTION app_due_site_rereads(p_limit integer)
RETURNS TABLE (clinic_id uuid, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.offboarding_started_at IS NULL ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.clinic_id, r.id
        FROM site_rereads r
       WHERE r.clinic_id = c.id
         AND ((r.status = 'queued' AND r.run_after <= clock_timestamp())
              OR (r.status = 'running' AND r.lease_until < clock_timestamp()))
       ORDER BY r.run_after
       LIMIT greatest(least(p_limit, 50), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_due_site_rereads(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_due_site_rereads(integer) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The job rows.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('site-reads', 'Every minute, from the site-reads queue, and hourly from the tick: reads a clinic''s website again through apps/web''s signed route when it has a website and no profile, after it corrects its website, and when the drift check or an operator asks; reads nothing until HEALDESK_WEB_URL is set', true),
  ('website-drift', 'Hourly; asks for a read of each live clinic''s website 30 days after its last one, compares it with the purchase-time baseline per Knowledge section, and queues "Changes on your website" (L23) when it finds any. Off until the owner switches it on, before the first clinic''s 30th live day', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

COMMENT ON TABLE site_rereads IS
  'One read of a clinic''s website after purchase, asked of apps/web''s signed /api/clinic-site (lib/website): missing profile, corrected website, monthly drift check, or an operator. Queued, claimed under a lease, and what it came to. Business data, no PHI. Kept at destruction.';--> statement-breakpoint
COMMENT ON TABLE website_changes IS
  'The drift list: each change a re-read found on a clinic''s website against clinics.site_profile, per Knowledge section, and whether the clinic confirmed it into Knowledge or ignored it (remembered by fingerprint). The clinic''s own published business data, no PHI. Kept at destruction.';

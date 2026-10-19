ALTER TABLE "incidents" ADD COLUMN "agreement_notify_by" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "agreement_version" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "reports_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "not_reportable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "not_reportable_reason" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_decision_check" CHECK (not ("incidents"."reported_at" is not null and "incidents"."not_reportable_at" is not null)
          and ("incidents"."not_reportable_at" is null) = ("incidents"."not_reportable_reason" is null)
          and ("incidents"."reported_at" is null) = ("incidents"."reports_sent" = 0)
          and "incidents"."reports_sent" >= 0);--> statement-breakpoint

-- =============================================================================
-- Incidents: the agreement's own deadline beside healdesk's target, and ops'
-- decision (WP7; plan Part J, "incidents"; Part K, the /admin incidents page).
--
-- notify_by has always held healdesk's internal target, 24 hours from
-- discovery, which the agreements do not state (owner, 12 October 2026). The
-- deadline a practice was promised is the agreement's: "without unreasonable
-- delay and in no case later than 60 calendar days" after discovery under
-- BAA 1.2.2 on and the DPA; five calendar days for a breach and five
-- business days for the other two under 1.2.1 and before. From now on
-- openIncident stamps it from the agreement in effect when the incident is
-- opened (lib/incidents/reporting-rules.ts), as it stamps notify_by.
--
-- The rows already open get it here, from the agreement in effect for their
-- clinic's organisation today, which is the nearest record there is of the
-- one in effect at discovery; a clinic with no agreement in effect, or one
-- whose version the rule list does not name, gets the five-day rule, the
-- strictest. Five business days are counted as openIncident counts them
-- (addBusinessDays): weekdays after discovery, in UTC. A service complaint
-- has no agreement clock and keeps NULL. apps/app has only ever held
-- synthetic data, so no practice was ever shown the other number.
--
-- incidents and baa_acceptances FORCE row-level security, which binds their
-- owner too, so the backfill walks the clinics with the tenant set per
-- clinic, as 0061's did, and restores the setting afterwards.
--
-- The decision columns need no grant: healdesk_app has held UPDATE on the
-- whole table since 0034 (only DELETE was revoked: an incident is evidence
-- with a legal clock on it, resolved, never deleted), and the CHECK above
-- keeps one decision per incident.
-- =============================================================================
DO $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
  version text;
BEGIN
  FOR c IN SELECT cl.id, cl.organization_id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT a.document_version INTO version FROM app_agreement_in_effect(c.organization_id) a;
    UPDATE incidents i
       SET agreement_version = version,
           agreement_notify_by = CASE
             WHEN version IN ('1.5.0', '1.4.0', '1.3.0', '1.2.2', 'dpa/1.0.0')
               THEN i.discovered_at + interval '60 days'
             WHEN i.class = 'breach'
               THEN i.discovered_at + interval '5 days'
             ELSE (
               SELECT d
                 FROM generate_series(i.discovered_at + interval '1 day',
                                      i.discovered_at + interval '9 days',
                                      interval '1 day') AS d
                WHERE extract(isodow FROM d AT TIME ZONE 'UTC') < 6
                ORDER BY d
               OFFSET 4 LIMIT 1
             )
           END
     WHERE i.clinic_id = c.id
       AND i.class <> 'service_complaint'
       AND i.agreement_notify_by IS NULL;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END;
$$;

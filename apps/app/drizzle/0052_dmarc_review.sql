-- =============================================================================
-- The DMARC review reminder (open item 14 and Annex X2 of docs/design/funnel-
-- onboarding-portal-2026-10-06.md), which the owner asked for on 6 October
-- 2026. There is no schema change: drizzle-kit generated this file empty
-- (--custom), and everything in it is hand-written.
--
-- healdesk.io's DMARC record stays at p=none until its aggregate reports show
-- only Resend and the owner's own mail sending as healdesk.io, and then moves
-- to p=quarantine. Nothing in the product reads those reports or changes that
-- record, so the dmarc-review job (lib/scheduler/dmarc-review.ts) raises one
-- ops alert, ever, on the 14th UTC day after Resend first sent.
--
-- When Resend first sent is read from two places: the earliest day in
-- email_daily_quota with a count above zero, which the runtime role reads
-- directly, and the earliest successful send in report_deliveries, which it
-- cannot. The ledger FORCEs row-level security, so a plain SELECT without a
-- tenant returns nothing at all. app_first_email_sent_at() is the tenant walk
-- of 0034 and 0046, cut down to one timestamp: no clinic, kind, recipient or
-- row leaves it. apps/web's own sends are recorded only in its Google Sheet,
-- which apps/app cannot read; the quota count includes them only on a day
-- apps/app also sent, so the day found can be late, never early.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- app_first_email_sent_at: when the email platform first sent to a clinic.
-- -----------------------------------------------------------------------------
-- Walks every clinic, locations included, sets the tenant as withTenant()
-- does, and keeps the earliest sent_at of a row whose status is 'sent' (a row
-- that failed or was skipped is not a send). least() ignores nulls, so a
-- clinic with no send changes nothing. Restores the caller's setting, also on
-- the way out of an error. Null when nothing has been sent.
CREATE OR REPLACE FUNCTION app_first_email_sent_at()
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  earliest timestamptz;
  c record;
BEGIN
  BEGIN
    FOR c IN SELECT cl.id FROM clinics cl LOOP
      PERFORM set_config('app.clinic_id', c.id::text, true);
      earliest := least(earliest, (
        SELECT min(d.sent_at)
          FROM report_deliveries d
         WHERE d.clinic_id = c.id
           AND d.status = 'sent'));
    END LOOP;
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
    RAISE;
  END;
  RETURN earliest;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_first_email_sent_at() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_first_email_sent_at() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The job, seeded OFF like every job but the heartbeat. Its owner, and the
-- point it is switched on:
--   dmarc-review   The plan's email platform (Annex X; "plan" in the email
--                  kind registry), which also owns the ops alert it raises.
--                  On with Annex X8's launch checks, once healdesk.io is
--                  verified on Resend. Until Resend has sent something it
--                  does nothing, so on early costs nothing; switched on after
--                  the 14th day, it raises its alert at its first 08 UTC run.
--                  Ops acts on the alert: reads the reports and changes the
--                  DNS record by hand.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('dmarc-review', 'Daily at 08 UTC; on the 14th day after Resend first sent as healdesk.io, raises one ops alert, ever, to read the DMARC reports and move the record from p=none to p=quarantine', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION app_first_email_sent_at() IS
  'The earliest sent_at of a report_deliveries row whose status is sent, across every clinic, or null when there is none: when the email platform first sent to a clinic. For the dmarc-review job. A tenant walk because report_deliveries FORCEs RLS; restores app.clinic_id before returning, also on the way out of an error. One timestamp, never a clinic, kind, recipient or row.';

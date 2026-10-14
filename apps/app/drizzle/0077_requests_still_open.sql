-- =============================================================================
-- The live alerts (package F, 14 October 2026): the switch for L8, "Request
-- still open". Nothing above this line: drizzle generated no schema change.
--
-- The alerts themselves need no migration. Their kinds are already in both
-- kinds CHECKs (0076, package S0), and they are queued in billing_notices and
-- recorded in report_deliveries like every other notice.
--
-- L8 is the one alert a schedule sends rather than an event: at a clinic's
-- opening hour, only while its daily summary is off, one email counting the
-- booking requests still waiting for the desk (lib/scheduler/
-- requests-still-open.ts). Hourly from the tick, behind this row, seeded OFF
-- like every job that mails customers (lib/scheduler/jobs.ts): the owner
-- switches it on with the live alerts, once the sender's own switch
-- (billing-notices) is on. No table, grant or function.
-- =============================================================================
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('requests-still-open', 'Hourly; at each clinic''s opening hour, only while its daily summary is off, queues one email counting the booking requests taken before that opening that are still waiting for the desk', false)
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- The billing sweep job.
--
-- Two things about a clinic's paid life are driven by time rather than by a
-- Stripe event, and Stripe has no event for time passing: a past-due clinic
-- whose grace window has closed must be suspended, and an annual clinic's
-- per-month allowance must reset every month of the year it paid for. The
-- sweep (apps/app/src/lib/scheduler/billing-sweep.ts) does both.
--
-- Seeded OFF, like every job (0008): the Dashboard's "on payment failure: do
-- not cancel" setting hands the suspension decision to this job, and turning
-- it on is a deliberate act from the ops console, not a side effect of a
-- deploy. ON CONFLICT DO NOTHING so a re-run never re-enables it.
-- =============================================================================

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('billing-sweep', 'Hourly; suspends past-due clinics after grace, rolls annual allowances monthly', false)
ON CONFLICT (name) DO NOTHING;

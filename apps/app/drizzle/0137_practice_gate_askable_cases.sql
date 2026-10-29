-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- The practice questions ask every case (Gate B piece 1, 29 October 2026).
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- Until today the booking and the deposit booking were recorded on every
-- channel as `not_applicable` with `notApplicable: "runtime_has_no_tools"`:
-- the brain had no booking tools, so nothing held a slot or wrote a booking
-- to check. They now have checks (lib/engine/practice/checks.ts,
-- bookingCaseChecks, over the real tool layer and the practice engine), and
-- casesNotAskable() is empty. A pass recorded before that was a pass of
-- seven cases, not nine, and the spec says "Pass means every case".
--
-- app_practice_gate_open read the latest run's status and the channel's
-- result status, never which cases the result asked, so a pass recorded
-- while a case could not be asked would still open a channel once Gate B's
-- code list empties. It now also asks that the channel's result records no
-- case the runtime could not ask, as practiceQuestionsGate does in
-- TypeScript (lib/engine/practice/store.ts, recordsAnUnaskedCase). That
-- covers an operator's decision on such a run too: a review passes the
-- run's cases as they stand, which still record it. The next run asks every
-- case: PRACTICE_CASES_VERSION changed, so no earlier pass is reused, and
-- the hourly sweep asks one for a clinic whose latest run read another
-- version.
--
-- The latest run must also have asked this case set: its cases_version is
-- PRACTICE_CASES_VERSION ('2026-10-29.1', lib/engine/practice/cases.ts), so a
-- later bump of the version cannot let a pass of an older set stand. A bump
-- therefore needs a migration that redefines this function with the new
-- literal; tests/practice-questions-booking-db.test.ts pins it to the constant.
--
-- A channel already live is not touched: the gate opens for a live channel
-- whatever the runs say (0097), and nothing is deleted.
--
-- 0097's body otherwise, with its owner, search path and grants kept through
-- CREATE OR REPLACE; tests/practice-questions-db.test.ts holds the SQL and
-- the TypeScript together.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_practice_gate_open(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM clinic_channels cc
                         WHERE cc.clinic_id = p_clinic AND cc.channel = p_channel AND cc.live_at IS NOT NULL)
             THEN true
           WHEN EXISTS (SELECT 1 FROM practice_question_runs r
                         WHERE r.clinic_id = p_clinic AND r.status IN ('queued', 'running'))
             THEN false
           ELSE coalesce((
             SELECT r.status = 'passed'
                    AND r.cases_version IS NOT DISTINCT FROM '2026-10-29.1'
                    AND EXISTS (SELECT 1 FROM practice_question_results x
                                 WHERE x.run_id = r.id AND x.clinic_id = p_clinic
                                   AND x.channel = p_channel AND x.status = 'passed'
                                   AND NOT EXISTS (
                                     SELECT 1 FROM jsonb_array_elements(
                                                     CASE WHEN jsonb_typeof(x.cases) = 'array' THEN x.cases ELSE '[]'::jsonb END) c
                                      WHERE c->>'notApplicable' = 'runtime_has_no_tools'))
               FROM practice_question_runs r
              WHERE r.clinic_id = p_clinic
                AND r.override_label IS NULL
                AND r.status IN ('passed', 'failed', 'in_review', 'error')
                AND r.finished_at IS NOT NULL
              ORDER BY r.finished_at DESC
              LIMIT 1), false)
         END
$$;

-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- The practice questions' case set moved to '2026-11-01.1' (1 November 2026,
-- lib/engine/practice/cases.ts PRACTICE_CASES_VERSION): on a call a number the
-- caller gives is now read back before it is used (owner: "make sure that she
-- confirms a phone number whenever it's been given"), so the voice booking
-- cases say "Yes, that's right." after the details.
--
-- As 0137 says, a bump needs this function redefined with the new literal, or
-- a pass of the new set never opens the gate (and a pass of the old one, which
-- asked a call that no longer exists, would). 0137's body otherwise, word for
-- word; its owner, search path and grants are kept through CREATE OR REPLACE.
-- tests/practice-questions-booking-db.test.ts pins the literal to the constant.
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
                    AND r.cases_version IS NOT DISTINCT FROM '2026-11-01.1'
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

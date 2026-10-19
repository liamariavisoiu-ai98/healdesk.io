-- =============================================================================
-- Only a run of the practice questions passes a channel's audit (19 October
-- 2026). This migration changes no table, so drizzle generated it empty
-- (--custom); everything below is the part drizzle cannot express.
--
-- The spec's Stage 3: an automated test runs; if it passes, the agent is
-- approved automatically; if anything is flagged, it goes to a short internal
-- review; and no channel goes live before its audit passes. Principle 7: a
-- person reviews only what the audit flags. Until today two operator paths
-- passed a channel's audit with no case asked:
--
--   - ops attestChannelAudit recorded `audit_passed` with `via: ops_attested`
--     and no run behind it, and 0090's app_channel_audit_ok counted any such
--     row for good;
--   - ops approveAgentConfig recorded a run with status 'passed', reason
--     'override', an `override_label` and no results, which 0090's
--     app_practice_gate_open read as a pass for every channel, and attested
--     every bought channel the same way.
--
-- Both operations are retired (lib/ops/api.ts, RETIRED_OPERATIONS). The one
-- operator path left is the review queue: a decision on a run the audit
-- flagged, which passes that run's own cases at the audit-input version it
-- read (lib/engine/practice/review.ts). Here the database stops counting what
-- the retired paths wrote, and refuses to record more of it:
--
--   1. app_practice_gate_open no longer treats an override as a pass, and
--      does not read an override run as the latest run at all: it is not a
--      run of the questions. The latest run whose outcome stands is the
--      latest one they asked, as readPracticeState reads it
--      (lib/engine/practice/store.ts). An override is known by its
--      `override_label`, which the runtime role cannot update (0080's column
--      grants) and which 0080's check ties to reason 'override' and status
--      'passed'; never by `reason`, which the runtime role can update, so a
--      real run renamed 'override' still counts;
--   2. app_channel_audit_ok counts a channel's record, whoever wrote it, only
--      while the questions' gate holds open for the channel, as
--      channelsWithAuditPassed does (lib/channels/audit-seam.ts): the pass
--      that counts is always a run's cases. An `ops_attested` row passes
--      nothing by itself. It is not ignored outright because the unique
--      index keeps one record per channel (0079), so a channel holding one
--      could never record the questions' pass beside it and would wait
--      forever; read this way, it goes live once the questions pass it;
--   3. app_channel_record_input records `audit_passed` only by the practice
--      questions: 'ops_attested' leaves its closed list of ways.
--
-- Nothing is deleted: channel_events is append-only (0044), and the runs and
-- reviews are the record of what approved AYA's words (0080). Nothing here
-- takes a channel offline either: a channel already live stays live, because
-- the gate opens for a live channel whatever the runs say, and the channel
-- events' writer never moves a live channel (lib/channels/events.ts).
--
-- Each function keeps its owner, search path and grants through CREATE OR
-- REPLACE; tests/channel-events.test.ts and tests/go-live.test.ts hold the SQL
-- and the TypeScript together.
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
                    AND EXISTS (SELECT 1 FROM practice_question_results x
                                 WHERE x.run_id = r.id AND x.clinic_id = p_clinic
                                   AND x.channel = p_channel AND x.status = 'passed')
               FROM practice_question_runs r
              WHERE r.clinic_id = p_clinic
                AND r.override_label IS NULL
                AND r.status IN ('passed', 'failed', 'in_review', 'error')
                AND r.finished_at IS NOT NULL
              ORDER BY r.finished_at DESC
              LIMIT 1), false)
         END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_channel_audit_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM channel_events e
                  WHERE e.clinic_id = p_clinic AND e.channel = p_channel AND e.kind = 'audit_passed')
     AND app_practice_gate_open(p_clinic, p_channel)
$$;--> statement-breakpoint

-- 0080's body, with 'ops_attested' gone from the closed list of ways.
CREATE OR REPLACE FUNCTION app_channel_record_input(p_channel text, p_kind text, p_via text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  inserted integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_channel_record_input runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT ((p_kind = 'audit_passed' AND p_via = 'practice_questions')
          OR (p_kind = 'runtime_seen' AND p_channel = 'web' AND p_via = 'ops_confirmed')) THEN
    RAISE EXCEPTION 'app_channel_record_input: % by % on % is not an input this records', p_kind, p_via, p_channel
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clinic_channels WHERE clinic_id = c AND channel = p_channel) THEN
    RAISE EXCEPTION 'app_channel_record_input: the clinic did not buy %', p_channel USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM clinics WHERE id = c AND (offboarding_started_at IS NOT NULL OR destroyed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'app_channel_record_input: the clinic has left' USING ERRCODE = '55000';
  END IF;
  INSERT INTO channel_events (clinic_id, channel, kind, actor, detail)
  VALUES (c, p_channel, p_kind, CASE WHEN p_via = 'practice_questions' THEN 'system' ELSE 'ops' END,
          jsonb_build_object('via', p_via))
  ON CONFLICT (clinic_id, channel, kind) WHERE kind IN ('audit_passed', 'runtime_seen') DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END
$$;

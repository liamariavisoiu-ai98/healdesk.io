ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_kind_check";--> statement-breakpoint
ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_waiting_on_check";--> statement-breakpoint
ALTER TABLE "clinic_channels" DROP CONSTRAINT "clinic_channels_waiting_on_check";--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_input_once_idx" ON "channel_events" USING btree ("clinic_id","channel","kind") WHERE "channel_events"."kind" in ('audit_passed', 'runtime_seen');--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_kind_check" CHECK ("channel_events"."kind" in ('ready', 'waiting', 'live', 'first_answer', 'paused', 'resumed', 'turned_off', 'turned_on', 'audit_passed', 'runtime_seen'));--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_waiting_on_check" CHECK ("channel_events"."waiting_on" is null or "channel_events"."waiting_on" in ('setup', 'direct_line', 'forwarding', 'snippet', 'meta_connect', 'whatsapp_payment_method'));--> statement-breakpoint
ALTER TABLE "clinic_channels" ADD CONSTRAINT "clinic_channels_waiting_on_check" CHECK ("clinic_channels"."waiting_on" is null or "clinic_channels"."waiting_on" in ('setup', 'direct_line', 'forwarding', 'snippet', 'meta_connect', 'whatsapp_payment_method'));--> statement-breakpoint

-- =============================================================================
-- Channel events (WP1, 14 October 2026). The statements above were generated
-- from schema.ts; everything below is the part drizzle cannot express.
--
-- What this migration adds, in one paragraph. lib/channels/events.ts moves a
-- clinic's channels on: ready on our side, waiting on the clinic (now with
-- phone's own `direct_line` state), live, and the first answer, the day a
-- channel's price joins the plan. The answer gate answers only a live channel
-- and billing is charged from the first answer, so the database, not the
-- engine, decides who may record either. The runtime role can no longer write
-- ready_at, live_at or first_answer_at, nor insert the ready, live,
-- first_answer, audit_passed or runtime_seen events: four SECURITY DEFINER
-- functions record them, each re-checking in SQL what it records
-- (app_channel_record_input for `live`'s two recorded inputs,
-- app_channel_mark_ready, app_channel_mark_live re-checking all four inputs,
-- app_channel_record_first_answer re-checking the conversation it is the
-- first answer of). audit_passed and runtime_seen are recorded once per
-- channel (channel_events_input_once_idx), with ON CONFLICT, so recording one
-- takes no row lock. L1 (`channel_live`) is already in the outbox's and the
-- ledger's kinds (0076).
--
-- Who may call the definers. Every one is the runtime role's to EXECUTE,
-- because the ops envelope and the runtimes both run as it; the database
-- cannot tell an operator from a runtime. What the definers guarantee is that
-- nothing is recorded that its evidence does not support: a channel is live
-- only on the four inputs, an input only with the closed way it was recorded,
-- a first answer only for a conversation that exists on that channel.
--
-- Still writable by the runtime role, and so outside this guarantee: the
-- clinic row's onboarding stamps, assistant_number_e164, website and
-- forwarding_test_observed, which the operator's screens and the forwarding
-- test write as that role.
--
-- Safe to apply in place: CHECKs widened, an index on a table with no
-- audit_passed or runtime_seen rows, grants narrowed, two triggers and four
-- functions. apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The runtime role's writes, narrowed.
-- -----------------------------------------------------------------------------

-- clinic_channels: the Settings switch and the clinic's next step stay the
-- runtime role's; the three lifecycle stamps are the definers' alone.
REVOKE UPDATE ON clinic_channels FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (enabled, waiting_on, updated_at) ON clinic_channels TO healdesk_app;--> statement-breakpoint

-- A row written with a lifecycle stamp already set would be the same bypass
-- through INSERT, so the runtime role inserts a channel's row bare, as
-- provisioning does. Inside a definer current_user is the function's owner,
-- so the definers pass.
CREATE OR REPLACE FUNCTION app_clinic_channels_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'healdesk_app'
     AND (NEW.ready_at IS NOT NULL OR NEW.live_at IS NOT NULL OR NEW.first_answer_at IS NOT NULL) THEN
    RAISE EXCEPTION 'clinic_channels: ready_at, live_at and first_answer_at are written only through the channel definers'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER clinic_channels_insert_guard
  BEFORE INSERT ON clinic_channels
  FOR EACH ROW EXECUTE FUNCTION app_clinic_channels_insert_guard();--> statement-breakpoint

-- channel_events: still append-only for the runtime role (0044), which still
-- records waiting, the switch and the pause itself; the kinds that move a
-- channel or its price are the definers'.
CREATE OR REPLACE FUNCTION app_channel_events_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'healdesk_app'
     AND NEW.kind IN ('ready', 'live', 'first_answer', 'audit_passed', 'runtime_seen') THEN
    RAISE EXCEPTION 'channel_events: % is recorded only through its definer', NEW.kind
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER channel_events_insert_guard
  BEFORE INSERT ON channel_events
  FOR EACH ROW EXECUTE FUNCTION app_channel_events_insert_guard();--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_channels_insert_guard() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_events_insert_guard() FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The inputs, as SQL reads them. lib/channels/events.ts's decideChannel is
-- the TypeScript mirror, and tests/channel-events.test.ts holds the two
-- together. Plain functions, not definers: they run as the definer that
-- calls them, inside the caller's tenant.
-- -----------------------------------------------------------------------------

-- Ready on our side: the clinic has not left, the channel was bought, its
-- audit passed, and our half of its runtime exists (phone, AYA's number; the
-- Meta channel, the operator's front door; website chat has no half of ours).
-- The operator's go-live is not needed: phone is ready, and the clinic told
-- to forward, before it.
CREATE OR REPLACE FUNCTION app_channel_ours_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1 FROM clinics k
            WHERE k.id = p_clinic
              AND k.offboarding_started_at IS NULL
              AND k.destroyed_at IS NULL
              AND (p_channel = 'web'
                   OR (p_channel = 'voice' AND k.assistant_number_e164 IS NOT NULL)
                   OR (p_channel = 'meta' AND k.meta_front_door_enabled)))
     AND EXISTS (SELECT 1 FROM clinic_channels cc WHERE cc.clinic_id = p_clinic AND cc.channel = p_channel)
     AND EXISTS (SELECT 1 FROM channel_events e
                  WHERE e.clinic_id = p_clinic AND e.channel = p_channel AND e.kind = 'audit_passed')
$$;--> statement-breakpoint

-- Live: ready, the clinic in production (the operator's go-live), the
-- clinic's own step evidenced, and setup done as its skip lines promise.
--   - phone's step is a forwarding-test call observed with the caller's number
--     intact, never the onboarding stamp alone, which an operator can set by
--     hand; website chat's is the operator's confirmation that its line is on
--     the clinic's site (runtime_seen); the Meta channel's a connected platform;
--   - setup: every wizard screen this clinic is shown, answered or skipped
--     (lib/setup/screens.ts screensFor), and what the skip lines say cannot be
--     skipped (lib/setup/skip-costs.ts): phone's hours and direct line, a vet
--     practice's emergency referral number, prices read or filled in checked
--     on the services screen, and the covered status a hipaa-if-covered
--     practice left open.
CREATE OR REPLACE FUNCTION app_channel_live_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT app_channel_ours_ok(p_clinic, p_channel)
     AND EXISTS (
       SELECT 1
         FROM clinics k
         LEFT JOIN clinic_settings s ON s.clinic_id = k.id
         LEFT JOIN agent_configs a ON a.clinic_id = k.id
        WHERE k.id = p_clinic
          AND k.data_classification = 'production'
          AND CASE p_channel
                WHEN 'voice' THEN coalesce((k.forwarding_test_observed ->> 'callerIdPreserved')::boolean, false)
                WHEN 'web' THEN EXISTS (SELECT 1 FROM channel_events e
                                         WHERE e.clinic_id = p_clinic AND e.channel = 'web' AND e.kind = 'runtime_seen')
                WHEN 'meta' THEN EXISTS (SELECT 1 FROM provider_connections p
                                          WHERE p.clinic_id = p_clinic
                                            AND p.provider IN ('meta-messenger', 'meta-instagram', 'meta-whatsapp')
                                            AND p.status IN ('active', 'pending'))
                ELSE false
              END
          AND NOT EXISTS (
                SELECT 1
                  FROM (VALUES ('basics'), ('hours'), ('services'), ('question'), ('insurance'),
                               ('tone'), ('coverage'), ('direct_line'), ('deposits'), ('urgent'),
                               ('calendar'), ('providers'), ('channels')) AS wizard(screen)
                 WHERE (wizard.screen NOT IN ('insurance', 'coverage', 'direct_line')
                        OR (wizard.screen = 'insurance'
                            AND k.regulatory_regime IS NOT DISTINCT FROM 'hipaa-if-covered'
                            AND k.agreement_kind IS NOT DISTINCT FROM 'baa'
                            AND k.is_covered_entity IS NULL)
                        OR (wizard.screen IN ('coverage', 'direct_line')
                            AND EXISTS (SELECT 1 FROM clinic_channels v
                                         WHERE v.clinic_id = p_clinic AND v.channel = 'voice')))
                   AND NOT EXISTS (SELECT 1 FROM clinic_setup_screens ss
                                    WHERE ss.clinic_id = p_clinic AND ss.screen = wizard.screen))
          AND (p_channel <> 'voice'
               OR (k.opening_hours IS NOT NULL
                   AND k.onboarding ->> 'hours_confirmed' IS NOT NULL
                   AND s.direct_line_e164 IS NOT NULL))
          AND (k.regulatory_regime IS DISTINCT FROM 'non-hipaa' OR s.vet_referral_e164 IS NOT NULL)
          AND NOT (EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(a.services, '[]'::jsonb)) sv
                            WHERE sv ->> 'priceFromUsd' IS NOT NULL)
                   AND NOT EXISTS (SELECT 1 FROM clinic_setup_screens ss
                                    WHERE ss.clinic_id = p_clinic AND ss.screen = 'services' AND ss.outcome = 'done'))
          AND NOT (k.regulatory_regime IS NOT DISTINCT FROM 'hipaa-if-covered' AND k.is_covered_entity IS NULL))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_ours_ok(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_live_ok(uuid, text) FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The definers. Each runs in the caller's own tenant (app.clinic_id), which it
-- refuses to run without, and locks the clinic's channel rows in channel
-- order, the one order every writer of them takes, so no two can deadlock.
-- -----------------------------------------------------------------------------

-- One of live's two recorded inputs, once per channel: the channel's audit
-- passed, attested by an operator until the practice questions exist; or
-- website chat's line confirmed on the clinic's site by an operator. Returns
-- whether this call recorded it.
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
  IF NOT ((p_kind = 'audit_passed' AND p_via = 'ops_attested')
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
  VALUES (c, p_channel, p_kind, 'ops', jsonb_build_object('via', p_via))
  ON CONFLICT (clinic_id, channel, kind) WHERE kind IN ('audit_passed', 'runtime_seen') DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted > 0;
END
$$;--> statement-breakpoint

-- Ready on our side, once: ready_at and the `ready` event, only when
-- app_channel_ours_ok holds. Returns whether this call set it.
CREATE OR REPLACE FUNCTION app_channel_mark_ready(p_channel text, p_at timestamptz, p_actor text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  updated integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_channel_mark_ready runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM clinic_channels WHERE clinic_id = c ORDER BY channel FOR UPDATE;
  IF NOT app_channel_ours_ok(c, p_channel) THEN
    RETURN false;
  END IF;
  UPDATE clinic_channels SET ready_at = p_at, updated_at = p_at
   WHERE clinic_id = c AND channel = p_channel AND ready_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated > 0 THEN
    INSERT INTO channel_events (clinic_id, channel, kind, actor, occurred_at)
    VALUES (c, p_channel, 'ready', left(coalesce(p_actor, 'system'), 200), p_at);
  END IF;
  RETURN updated > 0;
END
$$;--> statement-breakpoint

-- Live, once: live_at (and ready_at, if it was never set) with the events,
-- waiting on nothing, only when app_channel_live_ok holds. Returns whether
-- this call took the channel live.
CREATE OR REPLACE FUNCTION app_channel_mark_live(p_channel text, p_at timestamptz, p_actor text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  was_ready timestamptz;
  updated integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_channel_mark_live runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM clinic_channels WHERE clinic_id = c ORDER BY channel FOR UPDATE;
  IF NOT app_channel_live_ok(c, p_channel) THEN
    RETURN false;
  END IF;
  SELECT ready_at INTO was_ready FROM clinic_channels WHERE clinic_id = c AND channel = p_channel;
  UPDATE clinic_channels
     SET live_at = p_at, ready_at = coalesce(ready_at, p_at), waiting_on = NULL, updated_at = p_at
   WHERE clinic_id = c AND channel = p_channel AND live_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated > 0 THEN
    IF was_ready IS NULL THEN
      INSERT INTO channel_events (clinic_id, channel, kind, actor, occurred_at)
      VALUES (c, p_channel, 'ready', left(coalesce(p_actor, 'system'), 200), p_at);
    END IF;
    INSERT INTO channel_events (clinic_id, channel, kind, actor, occurred_at)
    VALUES (c, p_channel, 'live', left(coalesce(p_actor, 'system'), 200), p_at);
  END IF;
  RETURN updated > 0;
END
$$;--> statement-breakpoint

-- The channel's first answer, once: the `first_answer` event and
-- first_answer_at, on a live channel, for a conversation that exists on that
-- channel: a call or a web chat in conversations, a Meta DM in chat_threads.
-- Returns 'recorded', 'already', 'not_bought', 'not_live' or 'no_evidence'.
-- The billing request is recorded beside it by app_record_billing_request
-- (drizzle/0050), in the same transaction, by lib/channels/events.ts.
CREATE OR REPLACE FUNCTION app_channel_record_first_answer(
  p_channel text, p_conversation_id uuid, p_billing text, p_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  r record;
  inserted integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_channel_record_first_answer runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  IF p_billing NOT IN ('plan_start', 'step_up') THEN
    RAISE EXCEPTION 'app_channel_record_first_answer: billing is plan_start or step_up' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM clinic_channels WHERE clinic_id = c ORDER BY channel FOR UPDATE;
  SELECT live_at, first_answer_at INTO r FROM clinic_channels WHERE clinic_id = c AND channel = p_channel;
  IF NOT FOUND THEN
    RETURN 'not_bought';
  END IF;
  IF r.first_answer_at IS NOT NULL THEN
    RETURN 'already';
  END IF;
  IF r.live_at IS NULL THEN
    RETURN 'not_live';
  END IF;
  IF p_conversation_id IS NULL OR NOT (
       CASE p_channel
         WHEN 'voice' THEN EXISTS (SELECT 1 FROM conversations v
                                    WHERE v.id = p_conversation_id AND v.clinic_id = c AND v.channel = 'voice')
         WHEN 'web' THEN EXISTS (SELECT 1 FROM conversations v
                                  WHERE v.id = p_conversation_id AND v.clinic_id = c AND v.channel = 'web_chat')
         WHEN 'meta' THEN EXISTS (SELECT 1 FROM chat_threads t
                                   WHERE t.clinic_id = c AND t.conversation_id = p_conversation_id
                                     AND t.channel IN ('messenger', 'instagram', 'whatsapp'))
         ELSE false
       END) THEN
    RETURN 'no_evidence';
  END IF;
  INSERT INTO channel_events (clinic_id, channel, kind, actor, detail, occurred_at)
  VALUES (c, p_channel, 'first_answer', 'system',
          jsonb_build_object('conversationId', p_conversation_id::text, 'billing', p_billing), p_at)
  ON CONFLICT (clinic_id, channel) WHERE kind = 'first_answer' DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN 'already';
  END IF;
  UPDATE clinic_channels SET first_answer_at = p_at, updated_at = p_at
   WHERE clinic_id = c AND channel = p_channel AND first_answer_at IS NULL;
  RETURN 'recorded';
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_channel_record_input(text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_mark_ready(text, timestamptz, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_mark_live(text, timestamptz, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_record_first_answer(text, uuid, text, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_record_input(text, text, text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_mark_ready(text, timestamptz, text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_mark_live(text, timestamptz, text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_record_first_answer(text, uuid, text, timestamptz) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE channel_events IS
  'Append-only history of a clinic''s channels: ready, waiting, live, first_answer, the header''s pause and resume, the Settings switch, and two of live''s inputs: audit_passed (an operator''s attestation until the practice questions exist) and runtime_seen (an operator''s confirmation that website chat''s line is on the clinic''s site). ready, live, first_answer, audit_passed and runtime_seen are recorded only through the channel definers (0078). Billing evidence: the plan start and each step-up are charged from first_answer, which the partial unique index lets each channel record once. No patient data.';--> statement-breakpoint
COMMENT ON COLUMN channel_events.detail IS
  'Ids, ISO dates and closed codes only (how a live input was recorded, the conversation a first answer belongs to, which billing request it recorded). Never conversation content, never a caller''s number.';--> statement-breakpoint
COMMENT ON COLUMN clinic_channels.waiting_on IS
  'The clinic''s one outstanding action while the channel is ready on our side and not yet live: finishing setup, phone''s direct line, the forwarding, the line on its website, the Meta login.';--> statement-breakpoint
COMMENT ON FUNCTION app_channel_mark_live(text, timestamptz, text) IS
  'Takes a channel live once, in the caller''s tenant, only when app_channel_live_ok holds: ready on our side, the clinic in production, the clinic''s own step evidenced, and setup done as its skip lines promise. No patient data.';--> statement-breakpoint
COMMENT ON FUNCTION app_channel_record_first_answer(text, uuid, text, timestamptz) IS
  'Records a live channel''s first answer once, for a conversation that exists on that channel. The plan start or step-up is recorded beside it, in the same transaction. No patient data.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, asserted.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'ready_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'live_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'first_answer_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a channel lifecycle stamp, which 0078 made the definers''.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'enabled', 'UPDATE')
     OR NOT has_column_privilege('healdesk_app'::name, 'clinic_channels'::regclass, 'waiting_on', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app lost UPDATE of clinic_channels.enabled or waiting_on, which the Settings switch and the channel events need.';
  END IF;
  IF has_any_column_privilege('healdesk_app'::name, 'channel_events'::regclass, 'UPDATE')
     OR has_table_privilege('healdesk_app'::name, 'channel_events'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or erase channel_events, which stays append-only.';
  END IF;
END
$$;

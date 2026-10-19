ALTER TABLE "checkout_intents" ADD COLUMN "paid_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "provision_failures" integer DEFAULT 0 NOT NULL;
-- =============================================================================
-- Health flags, the I2 digest and the notifyOps raisers (WP5, 14-19 October
-- 2026). The two statements above were generated from schema.ts; everything
-- below is the part drizzle cannot express.
--
-- checkout_intents gains two facts about a paid purchase that provisioning
-- has not finished (lib/checkout/dead-letter.ts): when its paid relay first
-- reached /api/provision (paid_seen_at, the database's clock), from which the
-- ops watch raises paid_intent_without_clinic ten minutes on; and how many
-- attempts failed in a way a redelivery could fix (provision_failures), at
-- three of which the purchase is dead-lettered: ops is told, B3 goes to the
-- buyer, and later redeliveries still provision. Business data about a
-- purchase, never a patient; the table's grants (0043) already cover both.
--
-- Three jobs, each a row in scheduled_jobs:
--   - health-flags, seeded OFF like every job that acts on clinics: the
--     spec's two internal flags, raised to ops only (lib/ops/health-flags.ts).
--     The owner switches it on with the go-live set (Gate B).
--   - ops-digest and ops-watch, seeded ON like incident-deadlines (0066),
--     because they only mail ops, ids and counts (lib/ops/digest.ts,
--     lib/ops/watch.ts). The digest replaced connection-health's own email,
--     whose description changes below; its switch is left as it is.
--
-- And one definer redefined (healdesk-io-58's review of WP1, optional, taken
-- here): app_channel_record_first_answer stamps first_answer_at and the
-- `first_answer` event from the database's clock, as the destruction clock
-- (0058) and the record clocks do, instead of taking the caller's time.
-- first_answer_at is billing evidence, the day a channel's price joins the
-- plan, so no caller chooses it. The function loses its p_at parameter; its
-- one caller (lib/channels/events.ts recordFirstAnswer) changes with it.
-- Nothing billed is recomputed from the column, and no row is rewritten.
--
-- Safe to apply in place: two nullable or defaulted columns on a small
-- identity-plane table, three job rows, one description, and one function
-- replaced with the same body but its clock.
-- =============================================================================

COMMENT ON COLUMN checkout_intents.paid_seen_at IS
  'When a paid first invoice''s relay first reached /api/provision for this purchase (the database''s clock), written before provisioning runs. The ops watch raises paid_intent_without_clinic when there is still no account ten minutes later. Business data, no patient.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.provision_failures IS
  'Provisioning attempts for this purchase that failed in a way a Stripe redelivery could fix. At three the purchase is dead-lettered (provisioning_dead_lettered and B3), and later redeliveries still provision.';--> statement-breakpoint

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('health-flags', 'Hourly; raises to ops, once each, a clinic with no interaction on any channel 48 hours after its first channel went live, and a live phone channel with no inbound call for 14 days. Internal: never shown to the clinic', false),
  ('ops-digest', 'Daily at 07 UTC, or the first hour after it, once a UTC day: emails ops every queue with the age of its oldest item, email health per kind, connection health and Resend''s daily count. Ids and counts only', true),
  ('ops-watch', 'Every minute from the billing-minute queue, and hourly from the tick: raises to ops, once each, a paid order with no account ten minutes after its payment reached the host, an order follow-up (B3) past its day, and, hourly, a support reply (L25) past its day with none marked', true)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

UPDATE scheduled_jobs
   SET cadence = 'Hourly; flags revoked connections, stale syncs and stuck webhooks, raises a revoked one to ops at once, and leaves the rest to the 07:00 ops digest'
 WHERE name = 'connection-health';--> statement-breakpoint

-- The channel's first answer, once, from the database's clock (was 0079's,
-- with the caller's p_at). Everything else as 0079 wrote it.
DROP FUNCTION app_channel_record_first_answer(text, uuid, text, timestamptz);--> statement-breakpoint
CREATE FUNCTION app_channel_record_first_answer(
  p_channel text, p_conversation_id uuid, p_billing text
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
  stamped timestamptz := now();
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
          jsonb_build_object('conversationId', p_conversation_id::text, 'billing', p_billing), stamped)
  ON CONFLICT (clinic_id, channel) WHERE kind = 'first_answer' DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN 'already';
  END IF;
  UPDATE clinic_channels SET first_answer_at = stamped, updated_at = stamped
   WHERE clinic_id = c AND channel = p_channel AND first_answer_at IS NULL;
  RETURN 'recorded';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_record_first_answer(text, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_record_first_answer(text, uuid, text) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_channel_record_first_answer(text, uuid, text) IS
  'Records a live channel''s first answer once, in the caller''s tenant, for a conversation that exists on that channel, stamped from the database''s clock (0081). The plan start or step-up is recorded beside it, in the same transaction. No patient data.';

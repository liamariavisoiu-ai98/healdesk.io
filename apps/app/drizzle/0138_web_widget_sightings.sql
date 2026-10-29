ALTER TABLE "channel_events" DROP CONSTRAINT "channel_events_kind_check";--> statement-breakpoint
DROP INDEX "channel_events_input_once_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_input_once_idx" ON "channel_events" USING btree ("clinic_id","channel","kind") WHERE "channel_events"."kind" in ('audit_passed', 'runtime_seen', 'widget_seen');--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_kind_check" CHECK ("channel_events"."kind" in ('ready', 'waiting', 'live', 'first_answer', 'paused', 'resumed', 'turned_off', 'turned_on', 'audit_passed', 'runtime_seen', 'widget_seen'));--> statement-breakpoint

-- =============================================================================
-- Website chat confirms its own line (WEBCHAT-2, 29 October 2026). The four
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express.
--
-- Until now only an operator recorded `runtime_seen` for website chat
-- (app_channel_record_input('web', 'runtime_seen', 'ops_confirmed')), because
-- an Origin header is no proof: any client that knows the public slug and the
-- clinic's public website can send one. The owner accepted that residual
-- risk on 29 October 2026 (decision 1 of
-- docs/design/launch-readiness-2026-10-27/webchat-2-snippet-confirmation.md),
-- since live still needs the audit, setup, the platform's attestations and
-- go-live, and billing starts at the first answer, not at live. What a
-- browser cannot do is send another site's Origin, so a hostile page is only
-- ever seen on its own host, never on another clinic's.
--
-- The rule, enforced here and nowhere else:
--   - a sighting is a widget open from a host of the clinic's own website:
--     the site itself, www, or any subdomain of it (the owner's decision 2,
--     as originAllowed in lib/chat/web-chat.ts reads it), re-checked here
--     against clinics.website, so the runtime role cannot name a host of its
--     choosing;
--   - the first sighting is recorded once, as `widget_seen` with its host
--     (channel_events_input_once_idx);
--   - a sighting at least five minutes after it records `runtime_seen` by
--     'origin_seen', with the host it was seen on. Sooner, nothing is
--     written, so a replay or a flood costs a read and never a row: at most
--     two rows per clinic, ever;
--   - nothing is written once website chat is live or its line confirmed,
--     nor for a clinic that has left or did not buy it.
-- The operator's 'ops_confirmed' stays, as the fallback and the override.
--
-- Tenant plane: a host name, an id and times. No visitor's words, address,
-- user agent or token: the widget's start request carries an empty body.
--
-- Safe to apply in place: a CHECK widened, a partial index widened, the
-- insert guard restated with one more kind, and one new function.
-- =============================================================================

-- 0079's guard, with widget_seen among the kinds only a definer records.
CREATE OR REPLACE FUNCTION app_channel_events_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'healdesk_app'
     AND NEW.kind IN ('ready', 'live', 'first_answer', 'audit_passed', 'runtime_seen', 'widget_seen') THEN
    RAISE EXCEPTION 'channel_events: % is recorded only through its definer', NEW.kind
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- One open of the widget, seen from p_host, in the current tenant. Returns
-- what it did: 'first' (the first sighting, recorded), 'too_soon' (within
-- five minutes of the first, nothing written), 'confirmed' (runtime_seen
-- recorded just now), 'already' (the line was confirmed before), 'not_waiting'
-- (live, left, or not bought) or 'wrong_host' (not a host of the clinic's
-- website, or no website on file). Raises only on a malformed host or outside
-- a tenant. lib/channels/widget-sighting.ts is the only caller and
-- SIGHTING_GAP_MINUTES there mirrors the interval.
CREATE OR REPLACE FUNCTION app_web_widget_seen(p_host text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c uuid := app_current_clinic_id();
  site text;
  first_at timestamptz;
  first_host text;
  inserted integer := 0;
BEGIN
  IF c IS NULL THEN
    RAISE EXCEPTION 'app_web_widget_seen runs inside a tenant' USING ERRCODE = '42501';
  END IF;
  IF p_host IS NULL OR length(p_host) > 253
     OR p_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
    RAISE EXCEPTION 'app_web_widget_seen: not a host name' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clinic_channels WHERE clinic_id = c AND channel = 'web' AND live_at IS NULL)
     OR EXISTS (SELECT 1 FROM clinics WHERE id = c AND (offboarding_started_at IS NOT NULL OR destroyed_at IS NOT NULL)) THEN
    RETURN 'not_waiting';
  END IF;
  IF EXISTS (SELECT 1 FROM channel_events WHERE clinic_id = c AND channel = 'web' AND kind = 'runtime_seen') THEN
    RETURN 'already';
  END IF;
  -- The site as originAllowed reads clinics.website: no scheme, no path, no www.
  SELECT regexp_replace(split_part(regexp_replace(lower(k.website), '^https?://', ''), '/', 1), '^www\.', '')
    INTO site
    FROM clinics k WHERE k.id = c;
  IF site IS NULL OR site = '' OR NOT (p_host = site OR right(p_host, length(site) + 1) = '.' || site) THEN
    RETURN 'wrong_host';
  END IF;
  INSERT INTO channel_events (clinic_id, channel, kind, actor, detail)
  VALUES (c, 'web', 'widget_seen', 'system', jsonb_build_object('host', p_host))
  ON CONFLICT (clinic_id, channel, kind) WHERE kind IN ('audit_passed', 'runtime_seen', 'widget_seen') DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted > 0 THEN
    RETURN 'first';
  END IF;
  SELECT e.occurred_at, e.detail->>'host' INTO first_at, first_host
    FROM channel_events e WHERE e.clinic_id = c AND e.channel = 'web' AND e.kind = 'widget_seen';
  IF first_at > now() - interval '5 minutes' THEN
    RETURN 'too_soon';
  END IF;
  INSERT INTO channel_events (clinic_id, channel, kind, actor, detail)
  VALUES (c, 'web', 'runtime_seen', 'system',
          jsonb_build_object('via', 'origin_seen', 'host', p_host, 'first_host', first_host))
  ON CONFLICT (clinic_id, channel, kind) WHERE kind IN ('audit_passed', 'runtime_seen', 'widget_seen') DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN CASE WHEN inserted > 0 THEN 'confirmed' ELSE 'already' END;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_web_widget_seen(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_web_widget_seen(text) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_web_widget_seen(text) IS
  'Website chat''s widget opened from a host of the clinic''s own website (0138): the first sighting is recorded once as widget_seen, and one at least five minutes later records runtime_seen by origin_seen. Writes nothing sooner, once confirmed, or for a host that is not the clinic''s. No visitor data.';

ALTER TABLE "clinic_settings" ADD COLUMN "instagram_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "messenger_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "whatsapp_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- =============================================================================
-- Instagram, Messenger and WhatsApp, each switched on its own (spec, "Every
-- switch in the portal", Channels: three rows, On / Off, default On). The
-- three columns above were generated from schema.ts; everything below is
-- written by hand.
--
-- Two switches decide whether a Meta message is answered, and they stay
-- separate on purpose:
--
--   * clinics.meta_front_door_enabled (0036), the operator's, off until the
--     ops console turns it on, and only for a production clinic with a
--     published number and a released agreement in effect (BAA 1.3.0 gate
--     19). Unchanged here: a clinic whose front door is off stays off on
--     every platform, because the webhook still skips it whatever the
--     platform switches say.
--   * the three columns above, the clinic's, beneath it. On by default, so a
--     platform answers once it is connected and the front door is open.
--
-- The Meta channel's own switch, clinic_channels.enabled for 'meta', is what
-- the answer gate, the status word and the billing record read. From here on
-- it is no longer set directly: lib/channels/meta-platforms.ts, the three
-- columns' one writer, keeps it On while any connected platform's switch is
-- On and Off once none is (and leaves it alone while nothing is connected).
--
-- 1. The backfill keeps that true for the clinics that exist. A clinic that
--    had switched its Meta channel Off in Settings (the single switch these
--    three replace) has all three Off, so nothing it had stopped starts
--    answering; every other clinic keeps the defaults, all three On, which is
--    what its single switch meant. clinic_channels and clinic_settings FORCE
--    row-level security, which binds their owner too, so the backfill walks
--    the clinics with the tenant set per clinic, as 0056's coverage_mode copy
--    did, and restores the setting afterwards.
-- =============================================================================
DO $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    INSERT INTO clinic_settings (clinic_id, instagram_enabled, messenger_enabled, whatsapp_enabled)
      SELECT ch.clinic_id, false, false, false
        FROM clinic_channels ch
       WHERE ch.clinic_id = c.id AND ch.channel = 'meta' AND NOT ch.enabled
    ON CONFLICT (clinic_id) DO UPDATE
      SET instagram_enabled = false, messenger_enabled = false, whatsapp_enabled = false;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Which clinic owns a Meta page, Instagram account or WhatsApp number, now
--    with the platform's own switch beside the front door. 0036's definition
--    plus `platform_enabled`: the clinic's switch for the platform the
--    connection is on, On where the clinic has no clinic_settings row (the
--    column default), and false for a provider that names no platform this
--    knows. Ids and two flags only; the token stays sealed. A return type
--    cannot change under CREATE OR REPLACE, so drop and recreate.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_meta_channel(text);--> statement-breakpoint
CREATE FUNCTION app_meta_channel(external_id text)
RETURNS TABLE (clinic_id uuid, connection_id uuid, provider text, enabled boolean, platform_enabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT id, meta_front_door_enabled FROM clinics ORDER BY created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT p.clinic_id, p.id, p.provider, c.meta_front_door_enabled,
             CASE p.provider
               WHEN 'meta-instagram' THEN coalesce(s.instagram_enabled, true)
               WHEN 'meta-messenger' THEN coalesce(s.messenger_enabled, true)
               WHEN 'meta-whatsapp' THEN coalesce(s.whatsapp_enabled, true)
               ELSE false
             END
        FROM provider_connections p
        LEFT JOIN clinic_settings s ON s.clinic_id = p.clinic_id
       WHERE p.provider LIKE 'meta-%'
         AND p.status IN ('active', 'pending')
         AND p.metadata ->> 'externalId' = external_id
       ORDER BY p.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_meta_channel(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_meta_channel(text) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_meta_channel(text) IS
  'Which clinic owns a Meta page, Instagram account or WhatsApp number, for the webhook, which arrives with no tenant: ids, the operator''s front door (enabled) and the clinic''s own switch for that platform (platform_enabled, On without a clinic_settings row). A message is answered only when both are on. SECURITY DEFINER because it walks the tenants; the access token stays sealed.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN clinic_settings.instagram_enabled IS
  'Settings: Instagram On or Off, default On. Off, the webhook leaves Instagram messages for the clinic''s team. Beneath the operator''s front door; the Meta channel''s clinic_channels.enabled is On while any connected platform''s switch is On.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.messenger_enabled IS
  'Settings: Messenger On or Off, default On. Off, the webhook leaves Messenger messages for the clinic''s team. Beneath the operator''s front door; the Meta channel''s clinic_channels.enabled is On while any connected platform''s switch is On.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.whatsapp_enabled IS
  'Settings: WhatsApp On or Off, default On. Off, the webhook leaves WhatsApp messages for the clinic''s team. Beneath the operator''s front door; the Meta channel''s clinic_channels.enabled is On while any connected platform''s switch is On.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: the runtime writes the three switches, and the
-- webhook's role can still resolve a channel.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'instagram_enabled', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'messenger_enabled', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'whatsapp_enabled', 'UPDATE')
          AND has_function_privilege('healdesk_app'::name, 'app_meta_channel(text)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot write a Meta platform switch or resolve a Meta channel after 0061.';
  END IF;
  IF has_function_privilege('public'::name, 'app_meta_channel(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_meta_channel is executable by PUBLIC after 0061.';
  END IF;
END;
$$;

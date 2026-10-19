CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"event_id" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_events_app_check" CHECK ("email_events"."app" in ('app', 'web')),
	CONSTRAINT "email_events_kind_check" CHECK ("email_events"."kind" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "email_events_status_check" CHECK ("email_events"."status" in ('sent', 'failed', 'bounced', 'complained', 'suppressed')),
	CONSTRAINT "email_events_event_id_check" CHECK ("email_events"."event_id" is null or "email_events"."event_id" ~ '^[A-Za-z0-9_.-]{1,128}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_event_id_key" ON "email_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "email_events_at_idx" ON "email_events" USING btree ("at");--> statement-breakpoint
-- =============================================================================
-- Email health beyond the ledgers (19 October 2026). The statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The 07:00 ops digest (I2) counted email health from report_deliveries and
-- the ops log alone: every send about a clinic, and I1. The direct kinds with
-- no ledger row (sign-in links, B3, O3, O6, the calendar's two, I3, P6's
-- resend, I2 itself) were counted nowhere, their bounces were only logged by
-- the webhook relay, and apps/web's mail (nurture, the setup links, P2 to P9,
-- the stream most likely to draw a complaint) never reached apps/app at all.
-- Resend pauses the whole account at a 0.08% complaint rate, so the digest
-- could show green while the account was near a pause.
--
-- email_events holds what the ledgers do not: a kind, a status and a time.
-- No address, no clinic, no message id. sendEmail writes one per send of a
-- direct kind with no ledger row; the webhook relay writes one per bounce,
-- complaint or suppression Resend reports for one of them, and, for apps/web,
-- one per event its webhook relays. event_id, the webhook delivery's id, makes
-- a redelivered event count once; I3's daily claim uses a digest of its
-- clinic, code and day there, never the clinic's id. Ours, not a tenant's:
-- no clinic_id, no RLS.
--
-- Grants. 0003's ALTER DEFAULT PRIVILEGES gives healdesk_app SELECT, INSERT,
-- UPDATE and DELETE on every table the migrator creates. A row is written once
-- and never changed, so UPDATE is revoked; DELETE stays, for the digest's
-- 30-day prune, the only reader.
-- =============================================================================
REVOKE UPDATE ON email_events FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON email_events TO healdesk_app;--> statement-breakpoint
COMMENT ON TABLE email_events IS
  'Email the ledgers do not hold, for the ops digest (I2): one row per send of a direct kind with no ledger row (sendEmail), per bounce, complaint or suppression Resend reports for one (the webhook relay), and per event apps/web''s webhook relays for its own mail. A kind, a status and a time; no address, no clinic. event_id dedupes a redelivered webhook, or holds I3''s daily claim as a digest of its clinic, code and day. Pruned after 30 days by the digest. Ours, not a tenant''s: no clinic_id, no RLS.';

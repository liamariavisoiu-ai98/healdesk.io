ALTER TABLE "email_daily_quota" ADD COLUMN "exhausted_at" timestamp with time zone;--> statement-breakpoint

-- =============================================================================
-- Resend's daily quota, refused (19 October 2026). The statement above was
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- The urgent reply says "I've told the team" only while the urgent alert
-- (L12) will reach the clinic (lib/notices/urgent-alert-live.ts). Once Resend
-- answers daily_quota_exceeded, every email on the account waits until
-- midnight UTC (lib/email/outbox.ts parks it until 00:05), so for the rest of
-- that UTC day the line must drop it. The free plan's 100 a day is shared
-- with apps/web's mail on the same account, so the refusal can come before
-- apps/app's own count says so; and the limit is the plan's, which this side
-- does not know, so exhaustion is recorded when a send is refused, never
-- inferred from the count. lib/email/send.ts stamps the day's row the first
-- time a send is refused; the day is the key, so the next UTC day starts
-- clear.
--
-- 0046 holds the runtime role to a column list for UPDATE on
-- email_daily_quota (used, observed_at, alerted_at); the stamp is an upsert
-- whose conflict branch sets only this column, so it joins the list. INSERT
-- is table-wide already. No new table, so no policy, BAA gate, destruction or
-- purge change.
--
-- Safe to apply in place: one nullable column, which Postgres adds without
-- rewriting the table, and one column grant.
-- =============================================================================

GRANT UPDATE (exhausted_at) ON email_daily_quota TO healdesk_app;

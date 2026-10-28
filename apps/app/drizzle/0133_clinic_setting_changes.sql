-- =============================================================================
-- Settings changes in the clinic change feed (28 October 2026; lane C1; the
-- owner's decision of that day: ops hears of every change to a clinic's
-- settings, by email and in Slack, whoever made it). The statements above
-- were generated from schema.ts: they widen three closed lists and nothing
-- else, so no row is rewritten and RLS is unchanged.
--
--   kind 'setting'           a Settings switch or choice changed, written in
--                            the save's own transaction by saveSetting and
--                            setAutoConfirm (lib/clinic/setting-changes.ts);
--                            its summary carries the key and, for a switch or
--                            a choice, the closed tokens before and after.
--   source 'support_action'  a change made on a clinic's emailed request.
--   actor 'support'          the same, as who.
--
-- clinic_audits.change_kind follows CLINIC_CHANGE_KINDS in schema.ts; no
-- audit is ever queued for a setting change (auditStatus stays null).
-- =============================================================================
ALTER TABLE "clinic_audits" DROP CONSTRAINT "clinic_audits_change_kind_check";--> statement-breakpoint
ALTER TABLE "clinic_change_events" DROP CONSTRAINT "clinic_change_events_kind_check";--> statement-breakpoint
ALTER TABLE "clinic_change_events" DROP CONSTRAINT "clinic_change_events_source_check";--> statement-breakpoint
ALTER TABLE "clinic_change_events" DROP CONSTRAINT "clinic_change_events_actor_kind_check";--> statement-breakpoint
ALTER TABLE "clinic_audits" ADD CONSTRAINT "clinic_audits_change_kind_check" CHECK ("clinic_audits"."change_kind" is null or "clinic_audits"."change_kind" in ('hours', 'closures', 'location_hours', 'providers', 'provider_services', 'setting'));--> statement-breakpoint
ALTER TABLE "clinic_change_events" ADD CONSTRAINT "clinic_change_events_kind_check" CHECK ("clinic_change_events"."kind" in ('hours', 'closures', 'location_hours', 'providers', 'provider_services', 'setting'));--> statement-breakpoint
ALTER TABLE "clinic_change_events" ADD CONSTRAINT "clinic_change_events_source_check" CHECK ("clinic_change_events"."source" in ('portal', 'wizard', 'website', 'calendar_link', 'ops_console', 'direct', 'support_action'));--> statement-breakpoint
ALTER TABLE "clinic_change_events" ADD CONSTRAINT "clinic_change_events_actor_kind_check" CHECK ("clinic_change_events"."actor_kind" in ('clinic_device', 'clinic_signin', 'ops', 'change_file', 'direct', 'support'));

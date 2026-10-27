CREATE TABLE "support_slack_messages" (
	"case_id" uuid PRIMARY KEY NOT NULL,
	"channel" text,
	"ts" text,
	"approval_id" uuid,
	"draft_version" integer,
	"shown_key" text,
	"final" boolean DEFAULT false NOT NULL,
	"lease_until" timestamp with time zone,
	"next_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_slack_messages_ids_check" CHECK (("support_slack_messages"."channel" is null) = ("support_slack_messages"."ts" is null) and ("support_slack_messages"."channel" is null or "support_slack_messages"."channel" ~ '^[CDG][A-Z0-9]{2,30}$') and ("support_slack_messages"."ts" is null or "support_slack_messages"."ts" ~ '^[0-9]{1,12}[.][0-9]{1,8}$')),
	CONSTRAINT "support_slack_messages_key_check" CHECK (("support_slack_messages"."shown_key" is null or (char_length("support_slack_messages"."shown_key") <= 300 and "support_slack_messages"."shown_key" ~ '^[A-Za-z0-9_:|.-]+$')) and ("support_slack_messages"."draft_version" is null or "support_slack_messages"."draft_version" >= 1) and "support_slack_messages"."attempts" between 0 and 1000),
	CONSTRAINT "support_slack_messages_error_check" CHECK ("support_slack_messages"."last_error" is null or (char_length("support_slack_messages"."last_error") <= 120 and "support_slack_messages"."last_error" ~ '^[a-z0-9_ ]+$'))
);
--> statement-breakpoint
ALTER TABLE "support_slack_messages" ADD CONSTRAINT "support_slack_messages_case_id_support_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."support_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_slack_messages_open_idx" ON "support_slack_messages" USING btree ("final","next_at");--> statement-breakpoint
-- =============================================================================
-- Support replies in Slack (26 October 2026; ops automation Phase 7, lane
-- P7i; the owner's decision of that day: "Show the draft reply text in Slack
-- so I can read and approve it there with the passcode. I accept that Slack
-- has no BAA."). The statement above was generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
--   support_slack_messages  one row per support case whose reply was shown
--                           in the owner's Slack channel: Slack's channel id
--                           and the message's ts (so a new draft version
--                           updates the one message, and a decided, expired
--                           or closed item turns it final with no buttons),
--                           the approval item and draft version shown, a
--                           key of ids and codes saying what it shows, and
--                           the last Slack call's outcome. Never the words:
--                           the draft is on support_messages and in Slack.
--
-- The runtime role reads, adds and updates; it never deletes (a row goes
-- with its case, by the foreign key's cascade, when the clinic's cases are
-- destroyed). Not a tenant table (no clinic_id), like support_cases. Safe to
-- apply in place: one new, empty table. Nothing is posted until the owner
-- pastes SLACK_BOT_TOKEN and SLACK_SUPPORT_CHANNEL, and the buttons work
-- only once SLACK_SIGNING_SECRET and SLACK_OPERATOR_IDS are pasted too: all
-- four settings for the feature, the first two for the worker's posts.
-- =============================================================================

REVOKE ALL ON support_slack_messages FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON support_slack_messages TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE support_slack_messages IS
  'Ops-only: the Slack message each support case''s drafted reply is shown in (lane P7i): Slack''s channel id and message ts, the approval item and draft version shown, a key of ids and codes, and the last Slack call''s outcome. Never the reply''s words. Rows leave with their case.';--> statement-breakpoint

DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'support_slack_messages'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_table_privilege('healdesk_app'::name, 'support_slack_messages'::regclass, 'SELECT')
     OR NOT has_table_privilege('healdesk_app'::name, 'support_slack_messages'::regclass, 'INSERT')
     OR NOT has_table_privilege('healdesk_app'::name, 'support_slack_messages'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app has the wrong rights on support_slack_messages.';
  END IF;
END
$$;

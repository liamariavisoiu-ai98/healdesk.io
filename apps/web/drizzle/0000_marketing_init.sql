CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"phone" text,
	"clinic_name" text,
	"website" text,
	"specialty" text,
	"segment" text,
	"source_campaign" text,
	"lead_score" text,
	"is_business_email" boolean,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"consent_notice_version" text,
	"consent_text" text,
	"consent_at" timestamp with time zone,
	"claim_token" text,
	"referrer_host" text,
	"unlock_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_ms" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_events_lead_id_at_idx" ON "lead_events" USING btree ("lead_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_email_normalized_idx" ON "leads" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_claim_token_idx" ON "leads" USING btree ("claim_token") WHERE "leads"."claim_token" is not null;
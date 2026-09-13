CREATE TABLE "call_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid,
	"phone_e164" text NOT NULL,
	"consent_version" text NOT NULL,
	"consent_text" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"call_placed_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "unsubscribed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "nurture_step" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_touch_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "checkout_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "checkout_abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "abandonment_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_plan" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "converted_mrr_usd" integer;--> statement-breakpoint
ALTER TABLE "call_consents" ADD CONSTRAINT "call_consents_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "call_consents_phone_idx" ON "call_consents" USING btree ("phone_e164","at");
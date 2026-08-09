CREATE TYPE "public"."attribution_mode" AS ENUM('estimated', 'verified');--> statement-breakpoint
CREATE TABLE "baa_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"document_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"accepted_by_name" text NOT NULL,
	"accepted_by_email" text NOT NULL,
	"accepted_by_title" text,
	"ip_address" text,
	"user_agent" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "attribution_mode" "attribution_mode" DEFAULT 'estimated' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "average_treatment_value_usd" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD CONSTRAINT "baa_acceptances_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD CONSTRAINT "baa_acceptances_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baa_acceptances_org_idx" ON "baa_acceptances" USING btree ("organization_id","accepted_at");--> statement-breakpoint
CREATE INDEX "baa_acceptances_version_idx" ON "baa_acceptances" USING btree ("document_version");
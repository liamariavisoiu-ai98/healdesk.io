CREATE TYPE "public"."consent_type" AS ENUM('express', 'express_written', 'clinic_asserted');--> statement-breakpoint
CREATE TYPE "public"."contact_channel" AS ENUM('voice', 'sms');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"consent_type" "consent_type" NOT NULL,
	"source" text NOT NULL,
	"exact_wording" text NOT NULL,
	"evidence_uri" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"channel" "contact_channel" NOT NULL,
	"purpose" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"channel" "contact_channel",
	"reason" text NOT NULL,
	"note" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_attempts" ADD CONSTRAINT "contact_attempts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions" ADD CONSTRAINT "suppressions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_clinic_phone_idx" ON "consent_records" USING btree ("clinic_id","phone","channel");--> statement-breakpoint
CREATE INDEX "consent_active_idx" ON "consent_records" USING btree ("clinic_id","phone") WHERE "consent_records"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "contact_attempts_window_idx" ON "contact_attempts" USING btree ("clinic_id","phone","attempted_at");--> statement-breakpoint
CREATE INDEX "suppression_lookup_idx" ON "suppressions" USING btree ("clinic_id","phone");
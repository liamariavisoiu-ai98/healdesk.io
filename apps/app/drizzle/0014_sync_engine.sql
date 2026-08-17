CREATE TYPE "public"."exception_kind" AS ENUM('unmatched_sale', 'unmatched_appointment', 'ambiguous_match', 'missing_arrival');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'ok', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "reconciliation_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"fingerprint" text NOT NULL,
	"transaction_id" uuid,
	"appointment_id" uuid,
	"amount_at_risk_usd" numeric(12, 2),
	"summary" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"cursor_at" timestamp with time zone,
	"page_cursor" text,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_written" integer DEFAULT 0 NOT NULL,
	"notes" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"raw_payload" text NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_exceptions_fingerprint_idx" ON "reconciliation_exceptions" USING btree ("clinic_id","fingerprint");--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_open_idx" ON "reconciliation_exceptions" USING btree ("clinic_id","amount_at_risk_usd") WHERE "reconciliation_exceptions"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "sync_runs_clinic_idx" ON "sync_runs" USING btree ("clinic_id","resource","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_cursor_idx" ON "sync_runs" USING btree ("connection_id","resource","cursor_at") WHERE "sync_runs"."status" in ('ok', 'partial');--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_delivery_idx" ON "webhook_events" USING btree ("clinic_id","provider","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("clinic_id","received_at") WHERE "webhook_events"."processed_at" is null;
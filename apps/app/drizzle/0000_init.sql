CREATE TYPE "public"."actor_type" AS ENUM('user', 'service', 'connector', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('scheduled', 'confirmed', 'showed', 'no_show', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('voice', 'sms', 'web_chat', 'instagram_dm', 'whatsapp', 'web_form');--> statement-breakpoint
CREATE TYPE "public"."clinic_role" AS ENUM('owner', 'admin', 'clinician', 'front_desk', 'billing', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'degraded', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."conversation_outcome" AS ENUM('booked', 'qualified_no_booking', 'price_shopper', 'escalated_to_human', 'spam', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."data_classification" AS ENUM('synthetic', 'production');--> statement-breakpoint
CREATE TABLE "ad_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_click_id" text,
	"campaign_id" text,
	"adset_id" text,
	"cost_usd" numeric(12, 2),
	"landing_page" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"external_appointment_id" text,
	"external_source" text,
	"status" "appointment_status" DEFAULT 'scheduled' NOT NULL,
	"treatment" text,
	"provider_name" text,
	"deposit_usd" numeric(12, 2),
	"scheduled_for" timestamp with time zone NOT NULL,
	"checked_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" text,
	"actor_service_name" text,
	"actor_connection_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"resource_ids" jsonb,
	"result_count" integer,
	"request_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_shape" CHECK (
        (actor_type = 'user'      and actor_user_id       is not null) or
        (actor_type in ('service','agent') and actor_service_name is not null) or
        (actor_type = 'connector' and actor_connection_id is not null) or
        (actor_type = 'system')
      )
);
--> statement-breakpoint
CREATE TABLE "clinic_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "clinic_role" DEFAULT 'front_desk' NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"specialty" text NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"booking_provider" text,
	"pos_provider" text,
	"is_covered_entity" boolean,
	"baa_signed_at" timestamp with time zone,
	"data_classification" "data_classification" DEFAULT 'synthetic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"phone" text,
	"email" text,
	"full_name" text,
	"external_contact_id" text,
	"external_source" text,
	"is_returning" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"contact_id" uuid,
	"ad_interaction_id" uuid,
	"channel" "channel" NOT NULL,
	"is_recovered_missed_call" boolean DEFAULT false NOT NULL,
	"outcome" "conversation_outcome",
	"treatment_interest" text,
	"transcript_uri" text,
	"recording_uri" text,
	"disclosure_played_at" timestamp with time zone,
	"recording_opt_out" boolean DEFAULT false NOT NULL,
	"response_latency_seconds" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"key_version" text NOT NULL,
	"aad_version" integer DEFAULT 1 NOT NULL,
	"capabilities" jsonb,
	"metadata" jsonb,
	"expires_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"actor_label" text NOT NULL,
	"event" text NOT NULL,
	"organization_id" text,
	"ip_address" text,
	"user_agent" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"contact_id" uuid,
	"appointment_id" uuid,
	"external_transaction_id" text,
	"external_source" text,
	"amount_usd" numeric(12, 2) NOT NULL,
	"line_items" jsonb,
	"collected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_interactions" ADD CONSTRAINT "ad_interactions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_connection_id_provider_connections_id_fk" FOREIGN KEY ("actor_connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ad_interaction_id_ad_interactions_id_fk" FOREIGN KEY ("ad_interaction_id") REFERENCES "public"."ad_interactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_interactions_clinic_idx" ON "ad_interactions" USING btree ("clinic_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ad_interactions_click_idx" ON "ad_interactions" USING btree ("clinic_id","external_click_id");--> statement-breakpoint
CREATE INDEX "appointments_clinic_idx" ON "appointments" USING btree ("clinic_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "appointments_conversation_idx" ON "appointments" USING btree ("clinic_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_external_idx" ON "appointments" USING btree ("clinic_id","external_source","external_appointment_id") WHERE "appointments"."external_appointment_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_log_clinic_idx" ON "audit_log" USING btree ("clinic_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_resource_idx" ON "audit_log" USING btree ("clinic_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("clinic_id","actor_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_request_idx" ON "audit_log" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clinic_memberships_active_idx" ON "clinic_memberships" USING btree ("clinic_id","user_id") WHERE "clinic_memberships"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "clinic_memberships_user_idx" ON "clinic_memberships" USING btree ("user_id") WHERE "clinic_memberships"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "clinics_slug_idx" ON "clinics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "clinics_org_idx" ON "clinics" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_clinic_phone_idx" ON "contacts" USING btree ("clinic_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_external_idx" ON "contacts" USING btree ("clinic_id","external_source","external_contact_id") WHERE "contacts"."external_contact_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_clinic_idx" ON "conversations" USING btree ("clinic_id","started_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("clinic_id","contact_id");--> statement-breakpoint
CREATE INDEX "conversations_ad_idx" ON "conversations" USING btree ("clinic_id","ad_interaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_clinic_provider_idx" ON "provider_connections" USING btree ("clinic_id","provider");--> statement-breakpoint
CREATE INDEX "provider_connections_status_idx" ON "provider_connections" USING btree ("clinic_id","status");--> statement-breakpoint
CREATE INDEX "security_events_user_idx" ON "security_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_events_event_idx" ON "security_events" USING btree ("event","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_clinic_idx" ON "transactions" USING btree ("clinic_id","collected_at");--> statement-breakpoint
CREATE INDEX "transactions_appointment_idx" ON "transactions" USING btree ("clinic_id","appointment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_external_idx" ON "transactions" USING btree ("clinic_id","external_source","external_transaction_id") WHERE "transactions"."external_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
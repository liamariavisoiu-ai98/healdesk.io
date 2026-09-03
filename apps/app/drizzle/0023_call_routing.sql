CREATE TYPE "public"."call_routing" AS ENUM('conditional', 'always');--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "call_routing" "call_routing" DEFAULT 'conditional' NOT NULL;
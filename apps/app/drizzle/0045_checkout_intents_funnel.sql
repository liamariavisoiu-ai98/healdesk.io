ALTER TABLE "checkout_intents" ADD COLUMN "profile" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "profile_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "invite_ref" text;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "open_session_id" text;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "nonce_hash" "bytea";--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "provisioned_user_id" text;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD COLUMN "provision_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_invite_ref_unique" UNIQUE("invite_ref");--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_profile_status_check" CHECK ("checkout_intents"."profile_status" in ('read', 'failed', 'none'));--> statement-breakpoint
ALTER TABLE "checkout_intents" ADD CONSTRAINT "checkout_intents_nonce_hash_length" CHECK ("checkout_intents"."nonce_hash" is null or octet_length("checkout_intents"."nonce_hash") = 32);--> statement-breakpoint

-- =============================================================================
-- The purchase the funnel plan builds (6 October 2026, Part A4). Everything
-- above was generated from schema.ts. No grant changes: 0043 gave the runtime
-- role table-level SELECT, INSERT, UPDATE and DELETE on checkout_intents
-- (the housekeeping job purges it), which covers these columns as it covers
-- the rest. Business contact data of a buyer, plus what was read from the
-- clinic's public website: never patient information.
-- =============================================================================
COMMENT ON COLUMN checkout_intents.profile IS
  'The clinic''s public website as read at checkout (plan Part B): services, prices, hours, providers. Validated by apps/app before it is stored. Business data, never patient information.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.invite_ref IS
  'The setup request whose link opened this purchase. Unique, so one setup link makes one purchase however many times Pay is pressed.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.attempt IS
  'How many Checkout Sessions this intent has had. Each press of Pay is one, and the previous open one is expired.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.nonce_hash IS
  'SHA-256 of the nonce cookie on the paying browser. /welcome hands the one-time sign-in link only to the browser that holds the nonce.';--> statement-breakpoint
COMMENT ON COLUMN checkout_intents.provision_failed_at IS
  'Provisioning refused this intent after payment. /welcome tells the buyer their payment is safe and that we will finish by hand.';

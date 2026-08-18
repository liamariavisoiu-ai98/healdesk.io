-- =============================================================================
-- Signing the BAA before payment.
--
-- Three changes, each with a reason:
--
--   1. organization_id becomes nullable. The agreement is signed BEFORE payment
--      — a business associate may not receive patient data without one — so the
--      row exists before there is an organization to attach it to.
--   2. The rendered document, its variables, and the assent-button label are
--      stored. The document is now per-clinic, so "version 0.0.0" no longer
--      identifies what anyone signed. The text is the evidence.
--   3. A narrow, column-scoped UPDATE grant so the row can be bound to an
--      organization after payment WITHOUT reopening the rest of it.
-- =============================================================================

-- Draft-template acceptances are development artefacts, not agreements: the
-- template was never counsel-approved, and no clinic can leave 'synthetic'
-- classification while that is true. Scoped to the draft version on purpose —
-- this must never touch a real signature if it is somehow run later.
DELETE FROM baa_acceptances WHERE document_version = '0.0.0-draft';
--> statement-breakpoint

ALTER TABLE "baa_acceptances" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD COLUMN "rendered_text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD COLUMN "variables" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD COLUMN "assent_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD COLUMN "bound_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "baa_acceptances_unbound_idx" ON "baa_acceptances" USING btree ("accepted_at") WHERE "baa_acceptances"."organization_id" is null;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The binding grant.
--
-- 0006 revoked UPDATE and DELETE outright, because an acceptance the
-- application can edit afterwards is not evidence of anything. That is still
-- the rule — but binding a signed agreement to the organization it was signed
-- for is a legitimate write, and Postgres can express exactly that distinction.
--
-- Column-level UPDATE: the runtime role may set organization_id and bound_at,
-- and physically cannot alter the signature, the rendered text, the hash, the
-- timestamp, or who signed. That is a stronger guarantee than any application
-- check, because it survives a bug in ours.
-- ---------------------------------------------------------------------------
GRANT UPDATE (organization_id, bound_at) ON baa_acceptances TO healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE baa_acceptances IS
  'Append-only legal record of BAA acceptance, written BEFORE payment. Rows start unbound (organization_id null) and are bound once payment provisions an organization. The runtime role may only ever UPDATE organization_id and bound_at — everything else is immutable by grant, not by convention.';
--> statement-breakpoint

COMMENT ON COLUMN baa_acceptances.rendered_text IS
  'The exact document shown to the signer. Evidence, not a cache — do not reconstruct it from the template.';

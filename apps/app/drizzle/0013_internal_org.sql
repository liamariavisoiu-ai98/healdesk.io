-- =============================================================================
-- An organization for healdesk's own staff.
--
-- Better Auth's invitation table requires an organization, and ops staff do not
-- belong to a clinic. Rather than loosen the schema or invent a parallel
-- invitation mechanism, ops staff get an internal org of their own — the same
-- machinery, one more row.
--
-- It has no `clinics` rows and never will, so it grants no tenant access by
-- existing. What it grants is the ability to *hold* an account, which is then
-- scoped per clinic through clinic_memberships like anyone else's.
--
-- The id is fixed so code can reference it without a lookup. ON CONFLICT DO
-- NOTHING so re-running is safe.
-- =============================================================================

INSERT INTO organization (id, name, slug, created_at)
VALUES ('org_healdesk_internal', 'healdesk (internal)', 'healdesk-internal', now())
ON CONFLICT (id) DO NOTHING;

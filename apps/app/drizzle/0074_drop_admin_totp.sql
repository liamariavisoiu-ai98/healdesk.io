DROP TABLE "admin_totp" CASCADE;--> statement-breakpoint

-- =============================================================================
-- The operator's second factor leaves this database (owner, 14 October 2026).
-- The line above was generated from schema.ts; everything below is the part
-- drizzle cannot express.
--
-- 0026 put the /admin console's TOTP secret, its last-used step and its
-- recovery-code digests here, and apps/web asked for a verdict over the signed
-- ops API before it issued a session. That made /admin impossible to sign
-- into while this host was off. The owner moved the factor onto Vercel: the
-- secret is HEALDESK_ADMIN_TOTP_SECRET on apps/web, checked there
-- (apps/web/src/lib/admin/totp.ts), and nothing on this host takes part in
-- signing in. The five ops that served sign-in (getAdminTotpState,
-- enrolAdminTotp, verifyAdminTotpStep, burnRecoveryCode, sendSignInAlert) are
-- gone from lib/ops/api.ts in the same change, and the recovery codes with
-- them. No migration before this one is edited; 0026 stays as history.
--
-- Safe to drop: the table held one row at most, about the operator and never
-- about a patient or a clinic, and nothing reads it any more. The audit rows
-- its operations wrote (admin_totp_*, admin_sign_in in security_events) are
-- history and stay where they are.
-- =============================================================================

-- The no-rewrite trigger went with the table (CASCADE); its function did not.
DROP FUNCTION IF EXISTS app_admin_totp_no_rewrite();

/**
 * The organization healdesk's own staff belong to.
 *
 * Seeded by drizzle/0013_internal_org.sql. Better Auth's invitation table
 * requires an organization and ops staff do not belong to a clinic, so they get
 * one of their own — the same machinery, one more row.
 *
 * It has no `clinics` rows and never will, so membership grants no tenant
 * access by itself. What it grants is the ability to hold an account, which is
 * then scoped per clinic through clinic_memberships like anyone else's.
 *
 * Lives here rather than beside the server actions that use it because a
 * "use server" module may only export async functions — a constant exported
 * from one fails the build, and TypeScript doesn't know that rule.
 */
export const INTERNAL_ORG_ID = "org_healdesk_internal";

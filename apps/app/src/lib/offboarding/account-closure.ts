import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { releaseNumberAfterPassThrough } from "./offboarding";

/**
 * Closing the account: what a clinic keeps once it has left, and when the
 * rest goes.
 *
 * The spec closes a clinic "keeping only the signed agreement and the billing
 * records the law requires" (Stage 1), Terms §3 and §7 say the same to the
 * practice, and the contracts doc says "the account and its setup data are
 * removed". Destruction (destroyClinicData) takes every patient row on the
 * day the agreement's Term clause gives, and nothing else, so until 19
 * October 2026 the sign-in, the setup and the clinic's business data stayed
 * for good and nothing ever deleted the account.
 *
 * ## When
 *
 * Once the data is destroyed and the pass-through has ended: the end of the
 * service plus FORWARDING_PASS_THROUGH_DAYS, the moment AYA's number is
 * released (releaseNumberAfterPassThrough). Not at destruction itself, which
 * is due from day 29: the BAA's Term clause lets healdesk "pass forwarded
 * calls straight through to Practice's direct line for as long as the Terms
 * provide", which is day 30, and that call reads the direct line from
 * clinic_settings; E3's last notice goes the day before, to the clinic's
 * address. On BAA 1.3.0's export rule the data can go as late as day 89, so
 * the account closes in the same hour as the destruction then. The hourly
 * offboarding job runs it, whatever its switch says (destroyDueClinics), and
 * app_close_clinic_account() refuses earlier, by the database's clock.
 *
 * ## What goes
 *
 * The sign-in (every membership, and each user whose last membership that
 * was, with its sessions, factors, passkey challenges, step-ups and sign-in
 * links), the setup (agent configuration, settings and their history, report
 * recipients, the practice questions, the website re-reads, the clinic row's
 * setup columns), and our own notes and phase-two runs: the function's own
 * list, which tests/booking-request-destruction.test.ts holds to the
 * catalog beside destruction's and KEPT_FOR_GOOD.
 *
 * ## What stays, and why
 *
 * KEPT_FOR_GOOD below. Each row is either the agreement, a billing record, or
 * a record the agreements or the law require; none names a patient.
 */

/** Every table with a clinic_id that neither destruction nor the closure deletes, and why. */
export const KEPT_FOR_GOOD: Readonly<Record<string, string>> = {
  // The anchor.
  // (clinics itself has no clinic_id: its row stays, with the practice's
  // name, slug, specialty, time zone, address and published number, because
  // every row below points at it, and the widget a practice has not yet
  // taken off its website shows that number to call.)
  audit_log:
    "append-only: the record of how the practice's PHI was handled, the destruction included, kept as the Security Rule's documentation (45 CFR 164.316(b)(2): six years)",

  // The agreement.
  calendar_elections:
    "part of the signed agreement: each election is a term the practice recorded for a location's calendar (0057); append-only for every role, no patient",
  connection_links:
    "only the links a calendar election was signed through (the closure deletes every other): part of that election's record (0057)",
  agreement_resigns:
    "which agreement covered the practice, and from when: the record of each re-sign from the DPA to the BAA (0088), contract metadata, no patient",
  sign_in_address_changes:
    "the written record of each notice address the practice gave (the agreements' Notices clause): a notice the BAA still owes after termination, a breach report while backups hold the practice's data, goes to the last one; business contact data, its user_id nulled when the sign-in goes (0091)",
  incidents:
    "the record of each security incident and of the notice given for it: a breach notice the business associate must be able to prove (45 CFR 164.414(b)), kept six years (164.316(b)(2))",

  // The billing records.
  entitlements:
    "a billing record: the plan, its Stripe customer and subscription, its allowances and paid-through dates",
  billing_transitions: "a billing record: the history of the billing status",
  billing_requests:
    "a billing record: each change asked of Stripe and its outcome; the runtime role cannot delete it (0050)",
  channel_events: "a billing record: the plan start and every step-up were charged from it",
  clinic_channels:
    "a billing record: the channels bought, from which the price was set; no DELETE for the runtime role",
  overage_invoices: "a billing record: each overage invoice",
  usage_events: "a billing record: the usage ledger the clinic was charged from",

  // The notices given.
  billing_notices:
    "the notices given to the practice, as each said them: the billing notices (receipts, failed payments, the cancellation) are billing records, and the rest are the notices the Terms and the agreements require (the closure, the export, the destruction, terms and subprocessor changes, incident reports); none names a patient (Annex X)",
  report_deliveries:
    "the ledger of those notices: when each went, to which address, and whether it arrived, the proof that a notice the agreements require was given; business contact data, no patient",
};

/**
 * The tables on KEPT_FOR_GOOD whose rows the closure deletes in part: every
 * connection link goes except one a calendar election was signed through.
 */
export const KEPT_IN_PART: ReadonlySet<string> = new Set(["connection_links"]);

const ACTOR = { type: "service", serviceName: "account-closure" } as const;

export type AccountClosure = { clinicId: string; deleted: Record<string, number> };

/**
 * Close the tenant's account, once its data is destroyed and its
 * pass-through has ended: AYA's number released first if it is still held,
 * then everything app_close_clinic_account() deletes, in this transaction.
 * Null when the account was closed already. Throws when the database refuses
 * (not destroyed, or still in the pass-through).
 */
export async function closeClinicAccount(tx: TenantTx): Promise<Record<string, number> | null> {
  await releaseNumberAfterPassThrough(tx);
  const [row] = await tx.db
    .select({
      deleted: sql<Record<string, number> | null>`app_close_clinic_account(${tx.clinicId}::uuid)`,
    })
    .from(sql`(select 1) as once`);
  const deleted = row?.deleted ?? null;
  if (!deleted) return null;
  tx.audit.record({
    action: "delete",
    resourceType: "clinic_account_closure",
    resourceId: tx.clinicId,
    resultCount: Object.values(deleted).reduce((a, b) => a + b, 0),
    metadata: deleted,
  });
  return deleted;
}

/**
 * Every account due to close, each in its own transaction: the destroyed
 * clinics past their pass-through whose account is still open
 * (app_accounts_to_close). Never throws: a clinic whose closure fails is
 * logged and tried again next hour.
 */
export async function closeAccountsDue(): Promise<AccountClosure[]> {
  const due = await unsafeDb.execute<{ clinic_id: string }>(
    sql`select clinic_id from app_accounts_to_close()`,
  );
  const closed: AccountClosure[] = [];
  for (const { clinic_id: clinicId } of due.rows) {
    try {
      const deleted = await withTenant({ clinicId, actor: ACTOR }, (tx) => closeClinicAccount(tx));
      if (!deleted) continue;
      closed.push({ clinicId, deleted });
      log.info("clinic account closed", {
        clinicId,
        count: Object.values(deleted).reduce((a, b) => a + b, 0),
      });
      try {
        await recordSecurityEvent(unsafeDb, {
          event: "clinic_account_closed",
          actorLabel: ACTOR.serviceName,
          metadata: {
            clinicId,
            users: deleted.users ?? 0,
            memberships: deleted.clinic_memberships ?? 0,
          },
        });
      } catch (error) {
        // The audit log's row went in with the deletes; this is the identity
        // plane's record of the sign-in going, and its loss does not undo them.
        log.error("account closed but its security event was not recorded", {
          clinicId,
          error: describeError(error),
        });
      }
    } catch (error) {
      log.error("account closure failed", { clinicId, error: describeError(error) });
    }
  }
  return closed;
}

import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { recordSecurityEvent } from "@/lib/audit";
import { billingRecipients } from "@/lib/billing/recipients";
import { describeError, log } from "@/lib/log";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
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
 * for good and nothing ever closed the account.
 *
 * ## When
 *
 * Once nothing is left to finish (app_account_closure_waiting_on, drizzle/
 * 0096): the data destroyed; the pass-through over, the end of the service
 * plus FORWARDING_PASS_THROUGH_DAYS, since the BAA's Term clause lets healdesk
 * "pass forwarded calls straight through to Practice's direct line for as
 * long as the Terms provide" and that call reads the direct line from
 * clinic_settings; for a clinic that bought voice, its agent released at
 * Retell and recorded on the care page, since until then the agent may still
 * carry a forwarded call there; no incident open and no critical notice
 * still waiting to go, since those are owed to the practice's address; and
 * its Stripe Connect link ended, since the disconnect needs the account id
 * the closure would clear. The hourly offboarding job runs it, whatever its
 * switch says, tells ops once for each clinic and thing it waits on, and
 * tells ops whenever a closure fails.
 *
 * ## What goes
 *
 * Every way into the account and every detail of the people who held it,
 * but not the people's ids: the audit log names a user as the actor of every
 * portal action, under a CHECK that needs the id, and the log is kept six
 * years. So the memberships are revoked (and kept, as the access history),
 * and each person whose last live grant this clinic held loses their
 * sessions, accounts, verifications, factors, backup codes, passkey
 * challenges, step-ups, lockouts, sign-in links, device recovery links,
 * invitations and organisation memberships, and their user row becomes a
 * tombstone: an address under RFC 2606's `.invalid`, no name. Then the
 * setup (agent configuration, settings and their history, report recipients,
 * the practice questions, the website re-reads, the account's locations, the
 * clinic row's setup columns), our own notes and
 * phase-two runs, and the checkout the clinic was bought through. The
 * function's own list, which tests/booking-request-destruction.test.ts holds
 * to the catalog beside destruction's and KEPT_FOR_GOOD; after it, those
 * tables refuse new rows for the clinic.
 *
 * ## What stays, and why
 *
 * KEPT_FOR_GOOD below. Each row is either the agreement, a billing record, or
 * a record the agreements or the law require; none names a patient. And one
 * address: the agreement's Notices clause sends notices to "the email address
 * on Practice's healdesk account", which the closure takes off the sign-in,
 * while the agreement goes on protecting what backups and a subcontractor
 * keep (clauses 12, 17, 20). So the clinic's address is kept on the clinic
 * row as its notice address (clinics.notice_address), which billingRecipients
 * reads for a closed account, until six years after the service ended: the
 * clauses give the retained copies no end ("for as long as the law
 * requires"), and the signed agreement is kept six years.
 */

/** Every table with a clinic_id that neither destruction nor the closure deletes, and why. */
export const KEPT_FOR_GOOD: Readonly<Record<string, string>> = {
  // The anchor.
  // (clinics itself has no clinic_id: its row stays, with the practice's
  // name, slug, specialty, time zone, address and published number, because
  // every row below points at it, and the widget a practice has not yet
  // taken off its website shows that number to call; with the notice address
  // beside the closure, for six years.)
  audit_log:
    "append-only: the record of how the practice's PHI was handled, the destruction included, kept as the Security Rule's documentation (45 CFR 164.316(b)(2): six years); its user actors stay named by the tombstoned user rows",
  clinic_memberships:
    "the access history: who could reach the practice's records and when, revoked at closure and never deleted (164.308(a)(4)(ii)(C), kept six years under 164.316(b)(2)); no new grant after closure",

  // The agreement.
  calendar_elections:
    "part of the signed agreement: each election is a term the practice recorded for a location's calendar (0057); append-only for every role, no patient",
  location_acknowledgements:
    "part of the agreement: the practice's acceptance, for each location it added, of one central assistant for all of them, as shown, hashed and under whose step-up (0105); append-only for every role, no patient",
  connection_links:
    "only the links a calendar election was signed through or an OAuth state names (the closure deletes every other): part of that election's record (0057)",
  agreement_resigns:
    "which agreement covered the practice, and from when: the record of each re-sign from the DPA to the BAA (0088), contract metadata, no patient",
  sign_in_address_changes:
    "the written record of each notice address the practice gave (the agreements' Notices clause): what proves where a notice was due; business contact data, no patient",
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
 * connection link goes except one a calendar election or an OAuth state names.
 */
export const KEPT_IN_PART: ReadonlySet<string> = new Set(["connection_links"]);

/**
 * The kept tables that refuse new and changed rows once the account is
 * closed (app_refuse_after_account_closure): the access records, frozen, so
 * an invitation or a link cannot grant a closed account again. The rest of
 * KEPT_FOR_GOOD stays writable: incident reports, their ledger and the audit
 * log still go on after a closure.
 */
export const FROZEN_AT_CLOSURE: ReadonlySet<string> = new Set([
  "clinic_memberships",
  "connection_links",
  "sign_in_address_changes",
]);

/** What the closure waits on (app_account_closure_waiting_on), once destroyed and past the pass-through. */
export type ClosureWait = "voice_agent" | "incident_open" | "critical_notice" | "stripe_connect";

const WAITS: ReadonlySet<string> = new Set<ClosureWait>([
  "voice_agent",
  "incident_open",
  "critical_notice",
  "stripe_connect",
]);

const ACTOR = { type: "service", serviceName: "account-closure" } as const;

export type AccountClosure = { clinicId: string; closed: Record<string, number> };

export type AccountClosureRun = {
  closed: AccountClosure[];
  /** Past the pass-through, and waiting on a person for what each names. */
  waiting: { clinicId: string; on: ClosureWait }[];
  /** The closure threw: tried again next hour, and ops told. */
  failed: string[];
  /** Kept notice addresses whose six years ended this run. */
  noticeAddressesExpired: number;
};

/**
 * Close the tenant's account once nothing is left to finish: AYA's number
 * released first if it is still held, the clinic's one address read while
 * the sign-in still has it, then everything app_close_clinic_account() does,
 * in this transaction, with that address kept as the notice address. Null
 * when the account was closed already. Throws when the database refuses
 * (app_account_closure_waiting_on names why).
 */
export async function closeClinicAccount(tx: TenantTx): Promise<Record<string, number> | null> {
  await releaseNumberAfterPassThrough(tx);
  const noticeTo = (await billingRecipients(tx))[0]?.email ?? null;
  const [row] = await tx.db
    .select({
      closed: sql<Record<
        string,
        number
      > | null>`app_close_clinic_account(${tx.clinicId}::uuid, ${noticeTo}::text)`,
    })
    .from(sql`(select 1) as once`);
  const closed = row?.closed ?? null;
  if (!closed) return null;
  tx.audit.record({
    action: "delete",
    resourceType: "clinic_account_closure",
    resourceId: tx.clinicId,
    resultCount: Object.values(closed).reduce((a, b) => a + b, 0),
    metadata: { ...closed, noticeAddressKept: noticeTo !== null },
  });
  return closed;
}

/**
 * Every account due to close, each in its own transaction (the destroyed
 * clinics past their pass-through whose account is still open,
 * app_accounts_to_close), and ops told once for each one waiting on a
 * person; then the kept notice addresses whose six years are up cleared.
 * Never throws: a clinic whose closure fails is logged, ops is told, and it
 * is tried again next hour; the caller reads `failed`.
 */
export async function closeAccountsDue(): Promise<AccountClosureRun> {
  const run: AccountClosureRun = { closed: [], waiting: [], failed: [], noticeAddressesExpired: 0 };
  const due = await unsafeDb.execute<{ clinic_id: string; waiting_on: string | null }>(
    sql`select clinic_id, waiting_on from app_accounts_to_close()`,
  );
  for (const { clinic_id: clinicId, waiting_on: waitingOn } of due.rows) {
    if (waitingOn !== null) {
      if (WAITS.has(waitingOn)) {
        run.waiting.push({ clinicId, on: waitingOn as ClosureWait });
        await notifyOpsOnce("account_closure_waiting", { clinicId, code: waitingOn });
      }
      continue;
    }
    try {
      const closed = await withTenant({ clinicId, actor: ACTOR }, (tx) => closeClinicAccount(tx));
      if (!closed) continue;
      run.closed.push({ clinicId, closed });
      log.info("clinic account closed", {
        clinicId,
        count: Object.values(closed).reduce((a, b) => a + b, 0),
      });
      try {
        await recordSecurityEvent(unsafeDb, {
          event: "clinic_account_closed",
          actorLabel: ACTOR.serviceName,
          metadata: {
            clinicId,
            signInsEnded: closed.sign_ins_ended ?? 0,
            membershipsRevoked: closed.memberships_revoked ?? 0,
          },
        });
      } catch (error) {
        // The audit log's row went in with the closure; this is the identity
        // plane's record of the sign-in ending, and its loss undoes nothing.
        log.error("account closed but its security event was not recorded", {
          clinicId,
          error: describeError(error),
        });
      }
    } catch (error) {
      run.failed.push(clinicId);
      log.error("account closure failed", { clinicId, error: describeError(error) });
      await notifyOps("account_closure_failed", { clinicId });
    }
  }
  try {
    const expired = await unsafeDb.execute<{ n: number }>(
      sql`select app_expire_notice_addresses() as n`,
    );
    run.noticeAddressesExpired = expired.rows[0]?.n ?? 0;
  } catch (error) {
    log.error("kept notice addresses not expired", { error: describeError(error) });
  }
  return run;
}

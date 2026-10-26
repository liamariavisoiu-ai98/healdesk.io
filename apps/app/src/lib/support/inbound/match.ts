import { and, eq, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { user } from "@/db/auth-schema";
import { clinics, supportCases, supportMessages, type SupportCase } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { clinicSignIn } from "@/lib/sign-in/address-change";
import { withTenant } from "@/lib/tenant";

import { readRef } from "../case-vocab";
import { matchingAddress, type MatchedBy } from "./facts";

/**
 * Which case and which clinic an inbound email is about (lane P7g; design E5
 * §2.1, "Matching"), in this order:
 *
 *   1. the case's ref in the subject, "(ref HD-7F3KQ)", as every reply and
 *      acknowledgement we send prints it, and as "Re:" keeps it;
 *   2. In-Reply-To or References naming a message on a case: one of ours
 *      (a sent reply's id as lib/support/send.ts records it, Resend's id,
 *      which the outgoing Message-ID carries before its "@") or one the
 *      clinic sent before (an inbound email's Message-ID);
 *   3. the From address, lower-cased and with any "+tag" taken off for
 *      matching only, against each clinic's ONE sign-in address
 *      (clinicSignIn, the address every product email goes to). Several
 *      locations of one account share it: the account's billing location is
 *      chosen, and when the clinics are not one account's, none is;
 *   4. a closed account's kept notice address: a former clinic. The case
 *      cannot name a clinic that has left (0125's guard), so this is a fact
 *      on the message, and ops matches or closes the case.
 *
 * A closed case is never joined (closed is final: a new case opens).
 *
 * A ref or a thread only NAMES a case; whether the email may join it is the
 * sender's (handle.ts): a case about a clinic is joined only by an
 * authenticated sender (auth.ts) who is that clinic's sign-in or wrote on the
 * case before (the same sender reference); a case about no clinic only by
 * someone who wrote on it before. Anyone else quoting a ref opens a new case,
 * matched by address like any email, so a stranger cannot reopen a clinic's
 * case, raise its urgency or add to its counts.
 */

export type CaseMatch = { supportCase: SupportCase; matchedBy: "ref" | "thread" };

export type ClinicMatch = { clinicId: string | null; matchedBy: Extract<MatchedBy, "address" | "closed_account" | "none"> };

const REF_IN_SUBJECT = /\bHD-?([0-9A-Za-z]{5})\b/gi;

/** Every ref the subject names, normalised. */
export function refsInSubject(subject: string): string[] {
  const out: string[] = [];
  for (const m of subject.matchAll(REF_IN_SUBJECT)) {
    const ref = readRef(m[1]);
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out.slice(0, 5);
}

/** The forms a message id may have been recorded in: as written, without brackets, and Resend's id before the "@". */
export function idForms(ids: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const id of ids) {
    forms.add(id);
    const bare = id.replace(/^<|>$/g, "");
    forms.add(bare);
    const local = bare.split("@")[0];
    if (local && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(local)) forms.add(local.toLowerCase());
  }
  return [...forms].filter((f) => f.length > 0 && f.length <= 998).slice(0, 150);
}

/** The open case the subject's ref, or the thread's ids, name. */
export async function matchCase(input: { subject: string; threadIds: readonly string[] }): Promise<CaseMatch | null> {
  const refs = refsInSubject(input.subject);
  if (refs.length > 0) {
    const found = await unsafeDb.select().from(supportCases).where(inArray(supportCases.ref, refs));
    const open = found.find((c) => c.state !== "closed");
    if (open) return { supportCase: open, matchedBy: "ref" };
  }
  const forms = idForms(input.threadIds);
  if (forms.length > 0) {
    const rows = await unsafeDb
      .select({ supportCase: supportCases })
      .from(supportMessages)
      .innerJoin(supportCases, eq(supportCases.id, supportMessages.caseId))
      .where(and(inArray(supportMessages.messageId, forms), sql`${supportCases.state} <> 'closed'`))
      .limit(1);
    if (rows[0]) return { supportCase: rows[0].supportCase, matchedBy: "thread" };
  }
  return null;
}

/** The clinic whose one sign-in address this is, or a closed account's, or none. */
export async function matchClinic(address: string, actor: ActorContext): Promise<ClinicMatch> {
  const wanted = matchingAddress(address);
  const [local = "", domain = ""] = wanted.split("@");
  if (!local || !domain) return { clinicId: null, matchedBy: "none" };

  // Users whose address is this one, a "+tag" aside.
  const users = await unsafeDb
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(
      and(
        sql`lower(split_part(${user.email}, '@', 2)) = ${domain}`,
        sql`split_part(lower(split_part(${user.email}, '@', 1)), '+', 1) = ${local}`,
      ),
    )
    .limit(20);

  const candidates = new Set<string>();
  for (const u of users) {
    const grants = await unsafeDb.execute<{ clinic_id: string; role: string }>(
      sql`select clinic_id, role from app_user_clinic_grants(${u.id})`,
    );
    for (const g of grants.rows) if (g.role === "owner") candidates.add(String(g.clinic_id));
  }

  // Each candidate, in its own tenant: still in service, and this really is its one sign-in.
  const confirmed: { clinicId: string; billingClinicId: string | null }[] = [];
  for (const clinicId of candidates) {
    try {
      const hit = await withTenant({ clinicId, actor }, async (tx) => {
        const [c] = await tx.db
          .select({ closed: clinics.accountClosedAt, destroyed: clinics.destroyedAt, billing: clinics.billingClinicId })
          .from(clinics)
          .where(eq(clinics.id, tx.clinicId))
          .limit(1);
        if (!c || c.closed || c.destroyed) return null;
        const signIn = await clinicSignIn(tx);
        return signIn && matchingAddress(signIn.email) === wanted ? { clinicId, billingClinicId: c.billing } : null;
      });
      if (hit) confirmed.push(hit);
    } catch (error) {
      log.warn("support inbound: a clinic was not read", { clinicId, error: describeError(error) });
    }
  }
  if (confirmed.length === 1) return { clinicId: confirmed[0]!.clinicId, matchedBy: "address" };
  if (confirmed.length > 1) {
    // One account's locations: its billing location (the one with no billing clinic above it).
    const roots = new Set(confirmed.map((c) => c.billingClinicId ?? c.clinicId));
    if (roots.size === 1) {
      const root = [...roots][0]!;
      if (confirmed.some((c) => c.clinicId === root)) return { clinicId: root, matchedBy: "address" };
    }
    return { clinicId: null, matchedBy: "none" };
  }

  const closed = await unsafeDb.execute<{ found: boolean }>(
    sql`select app_support_closed_account_for_address(${wanted}) as found`,
  );
  if (closed.rows[0]?.found === true) return { clinicId: null, matchedBy: "closed_account" };
  return { clinicId: null, matchedBy: "none" };
}

/** Whether an earlier email on this case came from the same sender (the same sender reference). */
export async function senderSeenOnCase(caseId: string, senderRef: string): Promise<boolean> {
  const [row] = await unsafeDb
    .select({ id: supportMessages.id })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "email"), eq(supportMessages.senderRef, senderRef)))
    .limit(1);
  return row !== undefined;
}

/** Whether the sender is the case's clinic's own sign-in. Null for a case with no clinic. */
export async function senderIsCaseClinic(supportCase: SupportCase, address: string, actor: ActorContext): Promise<boolean | null> {
  if (!supportCase.subjectClinicId) return null;
  try {
    return await withTenant({ clinicId: supportCase.subjectClinicId, actor }, async (tx) => {
      const signIn = await clinicSignIn(tx);
      return signIn !== null && matchingAddress(signIn.email) === matchingAddress(address);
    });
  } catch {
    return false;
  }
}

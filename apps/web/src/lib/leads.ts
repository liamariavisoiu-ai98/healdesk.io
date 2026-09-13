import { eq, sql } from "drizzle-orm";

import { isMarketingDbConfigured, marketingDb } from "@/lib/db";
import { leadEvents, leads, type Lead } from "@/lib/db/schema";

/**
 * The lead store.
 *
 * Every demo unlock, claim and contact-form submission becomes a row here,
 * keyed on the normalised email so a repeat visitor updates one row rather
 * than creating a second. Before this existed the gate route wrote one line to
 * the server log and the address was gone when the log rotated.
 *
 * ## Fail open
 *
 * `recordDemoUnlock()` never throws. If the database is unreachable the lead
 * is logged (address only, no content) and the caller carries on: losing a
 * lead is bad, refusing a demo to a prospect who just typed their email is
 * worse. The rate limiter in src/lib/rate-limit.ts makes the opposite choice,
 * because its job is to refuse.
 *
 * ## Consent is a separate fact from the unlock
 *
 * Unlocking the demo is the thing the visitor asked for. It is not permission
 * to email them about the product; that is a default-unticked checkbox, and
 * this module records exactly what the box said and when it was ticked. A
 * later unlock without the box ticked never un-ticks it (consent is not
 * withdrawn by silence), and never ticks it either.
 */

export type DemoUnlock = {
  email: string;
  isBusinessEmail: boolean;
  /** SpecialtyId being demoed, when the UI knows it. */
  specialty?: string;
  /** True only if the visitor ticked the marketing checkbox. */
  marketingConsent?: boolean;
  /** The version tag of the notice shown; recorded only when consent is true. */
  noticeVersion?: string;
  /** The exact wording beside the checkbox; recorded only when consent is true. */
  consentText?: string;
  /** Referer header, reduced to its host before storage. */
  referrer?: string | null;
  /** `c=` campaign parameter, when the visitor arrived from a cold email. */
  campaign?: string | null;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Host only — a full referrer can carry query strings we have no business keeping. */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host || null;
  } catch {
    return null;
  }
}

export type RecordResult =
  | { ok: true; leadId: string; created: boolean }
  | { ok: false; reason: "unconfigured" | "unavailable" };

export async function recordDemoUnlock(input: DemoUnlock): Promise<RecordResult> {
  if (!isMarketingDbConfigured()) {
    console.info("[healdesk] demo unlocked (no lead store configured)", {
      business: input.isBusinessEmail,
      at: new Date().toISOString(),
    });
    return { ok: false, reason: "unconfigured" };
  }

  const normalized = normalizeEmail(input.email);
  const consented = input.marketingConsent === true;
  const now = new Date();

  try {
    const db = marketingDb();
    const [row] = await db
      .insert(leads)
      .values({
        email: input.email.trim(),
        emailNormalized: normalized,
        specialty: input.specialty ?? null,
        sourceCampaign: input.campaign ?? null,
        leadScore: input.isBusinessEmail ? "business" : "consumer",
        isBusinessEmail: input.isBusinessEmail,
        marketingConsent: consented,
        consentNoticeVersion: consented ? (input.noticeVersion ?? null) : null,
        consentText: consented ? (input.consentText ?? null) : null,
        consentAt: consented ? now : null,
        referrerHost: referrerHost(input.referrer),
      })
      .onConflictDoUpdate({
        target: leads.emailNormalized,
        set: {
          lastSeenAt: now,
          updatedAt: now,
          unlockCount: sql`${leads.unlockCount} + 1`,
          // Fill gaps, never overwrite what a previous visit told us.
          specialty: sql`coalesce(${leads.specialty}, ${input.specialty ?? null})`,
          sourceCampaign: sql`coalesce(${leads.sourceCampaign}, ${input.campaign ?? null})`,
          // Consent only ever moves from false to true here; withdrawal is a
          // separate, explicit action with its own record.
          marketingConsent: sql`${leads.marketingConsent} or ${consented}`,
          consentNoticeVersion: sql`coalesce(${leads.consentNoticeVersion}, ${consented ? (input.noticeVersion ?? null) : null})`,
          consentText: sql`coalesce(${leads.consentText}, ${consented ? (input.consentText ?? null) : null})`,
          consentAt: sql`coalesce(${leads.consentAt}, ${consented ? now : null})`,
        },
      })
      .returning({ id: leads.id, unlockCount: leads.unlockCount });

    if (!row) return { ok: false, reason: "unavailable" };

    await db.insert(leadEvents).values({
      leadId: row.id,
      name: "demo_unlocked",
      payload: { business: input.isBusinessEmail, consent: consented },
    });

    return { ok: true, leadId: row.id, created: row.unlockCount === 1 };
  } catch (error) {
    // Address deliberately not logged: the log is the one place this data
    // would live with no retention policy.
    console.error("[healdesk] lead store unavailable; demo continues", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unavailable" };
  }
}

/** Append a funnel event. Never throws; instrumentation must not break a request. */
export async function recordLeadEvent(
  leadId: string,
  name: string,
  payload?: Record<string, string | number | boolean>,
): Promise<void> {
  if (!isMarketingDbConfigured()) return;
  try {
    await marketingDb().insert(leadEvents).values({ leadId, name, payload });
  } catch (error) {
    console.error("[healdesk] lead event dropped", {
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Delete leads that never became customers and have not been seen for
 * `months`. This is what makes the retention line in the privacy policy true:
 * the policy quotes POLICY.leadRetentionMonths and a Vercel cron calls this
 * daily (app/api/cron/purge-leads). Events cascade with the lead.
 *
 * A lead with a claim token is a prospect who was sent a personalised bot;
 * the same clock applies — the token expires long before this does.
 */
export async function purgeStaleLeads(months: number): Promise<number> {
  if (!isMarketingDbConfigured()) return 0;
  const result = await marketingDb()
    .delete(leads)
    .where(sql`${leads.lastSeenAt} < now() - make_interval(months => ${months})`)
    .returning({ id: leads.id });
  return result.length;
}

export async function findLeadByEmail(email: string): Promise<Lead | null> {
  if (!isMarketingDbConfigured()) return null;
  const [row] = await marketingDb()
    .select()
    .from(leads)
    .where(eq(leads.emailNormalized, normalizeEmail(email)))
    .limit(1);
  return row ?? null;
}

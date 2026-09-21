import { COHORT_SETUP_CREDIT } from "@healdesk/catalog";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { isMarketingDbConfigured, marketingDb } from "@/lib/db";
import { callConsents, leadEvents, leads, type Lead } from "@/lib/db/schema";

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

/**
 * Consent records past the limitation period. Separate from the lead purge
 * on purpose: the lead can go after a year of silence, the evidence that a
 * call was lawful stays for the four years a claim could be brought.
 */
export async function purgeStaleCallConsents(years: number): Promise<number> {
  if (!isMarketingDbConfigured()) return 0;
  const result = await marketingDb()
    .delete(callConsents)
    .where(sql`${callConsents.at} < now() - make_interval(years => ${years})`)
    .returning({ id: callConsents.id });
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

export async function findLeadById(id: string): Promise<Lead | null> {
  if (!isMarketingDbConfigured()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await marketingDb().select().from(leads).where(eq(leads.id, id)).limit(1);
  return row ?? null;
}

// -----------------------------------------------------------------------------
// May we email this person?
// -----------------------------------------------------------------------------

export type EmailKind = "marketing" | "relationship";

/**
 * The one question every send asks first.
 *
 * `marketing` is the nurture sequence: it needs the ticked box, and stops on
 * unsubscribe, bounce or purchase. `relationship` is a message about
 * something the person themselves started — the checkout they left with a
 * signed agreement on file — which CAN-SPAM treats as transactional and
 * which does not need the box; it still stops on unsubscribe and bounce,
 * because "you asked us to stop" is not a technicality.
 */
export function canEmail(lead: Lead, kind: EmailKind): { ok: true } | { ok: false; reason: string } {
  if (lead.unsubscribedAt) return { ok: false, reason: "unsubscribed" };
  if (lead.bouncedAt) return { ok: false, reason: "bounced" };
  if (kind === "marketing") {
    if (!lead.marketingConsent) return { ok: false, reason: "no marketing consent" };
    if (lead.convertedAt) return { ok: false, reason: "already a customer" };
  }
  return { ok: true };
}

/** The one-click unsubscribe, or a provider complaint. Never undone by code. */
export async function markUnsubscribed(leadId: string, source: "link" | "complaint"): Promise<boolean> {
  if (!isMarketingDbConfigured()) return false;
  const now = new Date();
  const rows = await marketingDb()
    .update(leads)
    .set({ unsubscribedAt: now, updatedAt: now })
    .where(and(eq(leads.id, leadId), isNull(leads.unsubscribedAt)))
    .returning({ id: leads.id });
  if (rows.length) await recordLeadEvent(leadId, "unsubscribed", { source });
  return rows.length > 0;
}

/** Provider webhook: a hard bounce or a complaint, keyed on the address. */
export async function markDeliveryFailure(
  email: string,
  kind: "bounce" | "complaint",
): Promise<boolean> {
  if (!isMarketingDbConfigured()) return false;
  const lead = await findLeadByEmail(email);
  if (!lead) return false;
  if (kind === "complaint") return markUnsubscribed(lead.id, "complaint");
  const now = new Date();
  await marketingDb()
    .update(leads)
    .set({ bouncedAt: now, updatedAt: now })
    .where(and(eq(leads.id, lead.id), isNull(leads.bouncedAt)));
  await recordLeadEvent(lead.id, "bounced");
  return true;
}

// -----------------------------------------------------------------------------
// The purchase funnel, as timestamps
// -----------------------------------------------------------------------------

/**
 * Checkout began: the buyer typed their email at step 4 and we created a
 * Stripe Session. Creates the lead if the demo never did (a buyer who came
 * straight from a cold email to /get-started). Never touches consent.
 */
export async function markCheckoutStarted(input: {
  email: string;
  clinicName?: string;
  specialty?: string;
  plan: string;
  interval: string;
  campaign?: string | null;
  leadId?: string | null;
}): Promise<string | null> {
  if (!isMarketingDbConfigured()) return null;
  const now = new Date();
  const normalized = normalizeEmail(input.email);
  try {
    const [row] = await marketingDb()
      .insert(leads)
      .values({
        email: input.email.trim(),
        emailNormalized: normalized,
        clinicName: input.clinicName ?? null,
        specialty: input.specialty ?? null,
        sourceCampaign: input.campaign ?? null,
        leadScore: "business",
        isBusinessEmail: true,
        checkoutStartedAt: now,
        checkoutAbandonedAt: null,
      })
      .onConflictDoUpdate({
        target: leads.emailNormalized,
        set: {
          lastSeenAt: now,
          updatedAt: now,
          clinicName: sql`coalesce(${leads.clinicName}, ${input.clinicName ?? null})`,
          specialty: sql`coalesce(${leads.specialty}, ${input.specialty ?? null})`,
          sourceCampaign: sql`coalesce(${leads.sourceCampaign}, ${input.campaign ?? null})`,
          checkoutStartedAt: now,
          // A new attempt reopens the abandonment question.
          checkoutAbandonedAt: null,
        },
      })
      .returning({ id: leads.id });
    if (!row) return null;
    await recordLeadEvent(row.id, "checkout_started", { plan: input.plan, interval: input.interval });
    return row.id;
  } catch (error) {
    console.error("[healdesk] could not record checkout start", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Stripe said the session expired, or the cron decided an hour was enough. */
export async function markCheckoutAbandoned(email: string): Promise<void> {
  if (!isMarketingDbConfigured()) return;
  const lead = await findLeadByEmail(email);
  if (!lead || lead.convertedAt || lead.checkoutAbandonedAt) return;
  const now = new Date();
  await marketingDb()
    .update(leads)
    .set({ checkoutAbandonedAt: now, updatedAt: now })
    .where(eq(leads.id, lead.id));
  await recordLeadEvent(lead.id, "checkout_abandoned");
}

/** The webhook saw a completed session: the lead is a customer. Ends the nurture. */
export async function markConverted(input: {
  email: string;
  plan: string;
  mrrUsd: number;
}): Promise<void> {
  if (!isMarketingDbConfigured()) return;
  const lead = await findLeadByEmail(input.email);
  if (!lead) return;
  const now = new Date();
  await marketingDb()
    .update(leads)
    .set({
      convertedAt: sql`coalesce(${leads.convertedAt}, ${now})`,
      convertedPlan: input.plan,
      convertedMrrUsd: Math.round(input.mrrUsd),
      checkoutAbandonedAt: null,
      updatedAt: now,
    })
    .where(eq(leads.id, lead.id));
  if (!lead.convertedAt) {
    await recordLeadEvent(lead.id, "payment_completed", { plan: input.plan, mrr: Math.round(input.mrrUsd) });
  }
}

// -----------------------------------------------------------------------------
// The nurture cron's two queries
// -----------------------------------------------------------------------------

/** Consented, not yet a customer, not stopped, and with touches left. */
export async function leadsForNurture(maxStep: number, limit = 200): Promise<Lead[]> {
  if (!isMarketingDbConfigured()) return [];
  return marketingDb()
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.marketingConsent, true),
        isNull(leads.unsubscribedAt),
        isNull(leads.bouncedAt),
        isNull(leads.convertedAt),
        lt(leads.nurtureStep, maxStep),
      ),
    )
    .limit(limit);
}

/** Started checkout, did not finish, not yet nudged. */
export async function leadsForAbandonment(olderThan: Date, limit = 200): Promise<Lead[]> {
  if (!isMarketingDbConfigured()) return [];
  return marketingDb()
    .select()
    .from(leads)
    .where(
      and(
        isNull(leads.convertedAt),
        isNull(leads.abandonmentSentAt),
        isNull(leads.unsubscribedAt),
        isNull(leads.bouncedAt),
        lt(leads.checkoutStartedAt, olderThan),
      ),
    )
    .limit(limit);
}

/** The nurture step whose email carries the founding-cohort setup credit (lib/email/nurture.ts, Day 7). */
export const COHORT_CREDIT_TOUCH_STEP = 3;

/**
 * Whether this lead's cohort credit is live: offered, and still inside the
 * window the email stated. Pure, so the checkout route's decision is testable.
 */
export function cohortCreditLive(lead: Pick<Lead, "cohortCreditOfferedAt">, now: Date = new Date()): boolean {
  if (!lead.cohortCreditOfferedAt) return false;
  const ageMs = now.getTime() - lead.cohortCreditOfferedAt.getTime();
  return ageMs >= 0 && ageMs <= COHORT_SETUP_CREDIT.validDays * 24 * 60 * 60 * 1000;
}

export async function recordTouch(
  leadId: string,
  touch: { kind: "nurture"; step: number } | { kind: "abandonment" },
): Promise<void> {
  if (!isMarketingDbConfigured()) return;
  const now = new Date();
  if (touch.kind === "nurture") {
    await marketingDb()
      .update(leads)
      .set({ nurtureStep: touch.step + 1, lastTouchAt: now, updatedAt: now })
      .where(eq(leads.id, leadId));
    await recordLeadEvent(leadId, "nurture_sent", { step: touch.step });
    if (touch.step === COHORT_CREDIT_TOUCH_STEP) {
      // Stamped once, when the offer was actually mailed; the checkout reads
      // this, never the step counter, so a resent or skipped touch cannot
      // grant or withhold the credit on its own.
      await marketingDb()
        .update(leads)
        .set({ cohortCreditOfferedAt: sql`coalesce(${leads.cohortCreditOfferedAt}, ${now})` })
        .where(eq(leads.id, leadId));
    }
  } else {
    await marketingDb()
      .update(leads)
      .set({ abandonmentSentAt: now, checkoutAbandonedAt: sql`coalesce(${leads.checkoutAbandonedAt}, ${now})`, lastTouchAt: now, updatedAt: now })
      .where(eq(leads.id, leadId));
    await recordLeadEvent(leadId, "abandonment_sent");
  }
}

// -----------------------------------------------------------------------------
// Demo-call consent
// -----------------------------------------------------------------------------

/**
 * The consent record for one AI-voiced demo call. Written BEFORE the call is
 * placed, so a vendor failure still leaves the evidence; `callPlacedAt` is
 * stamped afterwards. Never throws: a store outage must not block a call the
 * person just asked for, but it is logged loudly, because a call with no
 * record is the case the record exists for.
 */
export async function recordCallConsent(input: {
  phoneE164: string;
  consentVersion: string;
  consentText: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  leadEmail?: string | null;
}): Promise<string | null> {
  if (!isMarketingDbConfigured()) {
    console.error("[healdesk] call consent NOT persisted: no lead store configured", {
      version: input.consentVersion,
    });
    return null;
  }
  try {
    const lead = input.leadEmail ? await findLeadByEmail(input.leadEmail) : null;
    const [row] = await marketingDb()
      .insert(callConsents)
      .values({
        leadId: lead?.id ?? null,
        phoneE164: input.phoneE164,
        consentVersion: input.consentVersion,
        consentText: input.consentText,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      })
      .returning({ id: callConsents.id });
    if (lead) await recordLeadEvent(lead.id, "call_requested");
    return row?.id ?? null;
  } catch (error) {
    console.error("[healdesk] call consent NOT persisted", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function markCallPlaced(consentId: string | null): Promise<void> {
  if (!consentId || !isMarketingDbConfigured()) return;
  try {
    await marketingDb()
      .update(callConsents)
      .set({ callPlacedAt: new Date() })
      .where(eq(callConsents.id, consentId));
  } catch {
    // The consent row already exists; the placed stamp is a nicety.
  }
}

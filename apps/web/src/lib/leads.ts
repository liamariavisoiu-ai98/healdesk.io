import { randomUUID } from "node:crypto";

import { COHORT_SETUP_CREDIT } from "@healdesk/catalog";

import { isMarketingStoreConfigured, sheetsClient, type Cell, type SheetsClient } from "@/lib/sheets/client";
import {
  CALL_CONSENTS,
  LEADS,
  LEAD_EVENTS,
  SETUP_REQUESTS,
  cellRange,
  dataRange,
  ensureSheetSchema,
  leadFromRow,
  recordToRow,
  rowRange,
  rowToRecord,
  type CallConsent,
  type Lead,
  type LeadEvent,
  type SetupRequest,
  type Tab,
} from "@/lib/sheets/schema";

export type { Lead } from "@/lib/sheets/schema";

/**
 * The lead store.
 *
 * Every demo unlock, claim and contact-form submission becomes a row here,
 * keyed on the normalised email so a repeat visitor updates one row rather
 * than creating a second. Before this existed the gate route wrote one line to
 * the server log and the address was gone when the log rotated.
 *
 * ## It is a Google Sheet
 *
 * Since 23 September 2026 the rows live in the `leads`, `lead_events` and
 * `call_consents` tabs of the marketing Sheet (src/lib/sheets). The exported
 * API is the one the Postgres version had, signature for signature, so the
 * eight route handlers and the nurture cron that call it did not change. What
 * changed is underneath:
 *
 *   - A Sheet has no unique index. Identity is still `email_normalized`, but
 *     it is enforced by reading before writing, and two unlocks racing for the
 *     same new address can produce two rows. So every read deduplicates on
 *     the earliest row, and the purge treats a duplicate like any other row,
 *     which is how it eventually goes away.
 *   - A row is addressed by its 1-based sheet row number, read together with
 *     the data and never kept: it is only valid until the next delete.
 *   - A delete is a `deleteDimension` request, issued in descending row
 *     order so earlier deletes do not shift the rows of later ones.
 *   - `leadsForNurture` and `leadsForAbandonment` filter in memory. The tab
 *     is a few hundred rows at most; the limit of 200 is kept.
 *
 * ## Fail open
 *
 * `recordDemoUnlock()` never throws. If the Sheet is unreachable the lead is
 * logged (business/consumer only, no address) and the caller carries on:
 * losing a lead is bad, refusing a demo to a prospect who just typed their
 * email is worse. Which functions catch and which propagate is exactly as
 * before: the write-on-a-page-path functions catch; the cron and webhook
 * functions let a failure reach the caller so the provider retries.
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

// -----------------------------------------------------------------------------
// Reading and writing rows
// -----------------------------------------------------------------------------

/** A decoded row and where it sits, for the update or delete that follows. */
type Located<T> = { row: number; value: T };

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

function blank(cells: readonly Cell[]): boolean {
  return cells.every((cell) => cell === "" || cell === undefined);
}

async function readRows<T>(client: SheetsClient, tab: Tab, decode: (cells: readonly Cell[]) => T): Promise<Located<T>[]> {
  const rows = await client.getValues(dataRange(tab));
  const out: Located<T>[] = [];
  rows.forEach((cells, i) => {
    if (blank(cells)) return;
    out.push({ row: i + 2, value: decode(cells) });
  });
  return out;
}

/** Every `leads` row that has an id and an address, duplicates included. */
async function readLeadRows(client: SheetsClient): Promise<Located<Lead>[]> {
  const rows = await readRows(client, LEADS, leadFromRow);
  return rows.filter((r) => r.value.id && r.value.emailNormalized);
}

/** The rows a caller may act on: one per normalised address, the earliest row winning. */
function dedupe(rows: Located<Lead>[]): Located<Lead>[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.value.emailNormalized)) return false;
    seen.add(r.value.emailNormalized);
    return true;
  });
}

async function locateByEmail(client: SheetsClient, normalized: string): Promise<Located<Lead> | null> {
  return dedupe(await readLeadRows(client)).find((r) => r.value.emailNormalized === normalized) ?? null;
}

async function locateById(client: SheetsClient, id: string): Promise<Located<Lead> | null> {
  return dedupe(await readLeadRows(client)).find((r) => r.value.id === id) ?? null;
}

async function writeLead(client: SheetsClient, row: number, lead: Lead): Promise<void> {
  await client.updateRange(rowRange(LEADS, row), [recordToRow(LEADS, lead)]);
}

async function appendLead(client: SheetsClient, lead: Lead): Promise<void> {
  await client.appendRows(LEADS.title, [recordToRow(LEADS, lead)]);
}

async function appendEvent(
  client: SheetsClient,
  leadId: string,
  name: string,
  payload?: Record<string, string | number | boolean>,
): Promise<void> {
  const event: LeadEvent = { id: randomUUID(), leadId, name, at: new Date(), payload: payload ?? null };
  await client.appendRows(LEAD_EVENTS.title, [recordToRow(LEAD_EVENTS, event)]);
}

/** Delete rows by sheet row number, highest first so nothing shifts under a later delete. */
export async function deleteRows(client: SheetsClient, tab: Tab, rows: number[]): Promise<void> {
  if (rows.length === 0) return;
  const sheetId = await client.getSheetId(tab.title);
  if (sheetId === null) throw new Error(`The "${tab.title}" tab is missing from the marketing Sheet.`);
  const descending = [...new Set(rows)].sort((a, b) => b - a);
  await client.batchUpdate(
    descending.map((row) => ({
      deleteDimension: { range: { sheetId, dimension: "ROWS" as const, startIndex: row - 1, endIndex: row } },
    })),
  );
}

/** The columns a database would have defaulted. */
function newLead(now: Date, over: Partial<Lead> & Pick<Lead, "email" | "emailNormalized">): Lead {
  return {
    id: randomUUID(),
    phone: null,
    clinicName: null,
    website: null,
    specialty: null,
    segment: null,
    sourceCampaign: null,
    leadScore: null,
    isBusinessEmail: null,
    marketingConsent: false,
    consentNoticeVersion: null,
    consentText: null,
    consentAt: null,
    claimToken: null,
    unsubscribedAt: null,
    bouncedAt: null,
    nurtureStep: 0,
    lastTouchAt: null,
    cohortCreditOfferedAt: null,
    checkoutStartedAt: null,
    checkoutAbandonedAt: null,
    abandonmentSentAt: null,
    convertedAt: null,
    convertedPlan: null,
    convertedMrrUsd: null,
    referrerHost: null,
    unlockCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// -----------------------------------------------------------------------------
// The demo unlock
// -----------------------------------------------------------------------------

export async function recordDemoUnlock(input: DemoUnlock): Promise<RecordResult> {
  if (!isMarketingStoreConfigured()) {
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
    const client = await store();
    const existing = await locateByEmail(client, normalized);

    if (existing) {
      const lead = existing.value;
      await writeLead(client, existing.row, {
        ...lead,
        lastSeenAt: now,
        updatedAt: now,
        unlockCount: lead.unlockCount + 1,
        // Fill gaps, never overwrite what a previous visit told us.
        specialty: lead.specialty ?? input.specialty ?? null,
        sourceCampaign: lead.sourceCampaign ?? input.campaign ?? null,
        // Consent only ever moves from false to true here; withdrawal is a
        // separate, explicit action with its own record.
        marketingConsent: lead.marketingConsent || consented,
        consentNoticeVersion: lead.consentNoticeVersion ?? (consented ? (input.noticeVersion ?? null) : null),
        consentText: lead.consentText ?? (consented ? (input.consentText ?? null) : null),
        consentAt: lead.consentAt ?? (consented ? now : null),
      });
      await appendEvent(client, lead.id, "demo_unlocked", { business: input.isBusinessEmail, consent: consented });
      return { ok: true, leadId: lead.id, created: false };
    }

    const lead = newLead(now, {
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
    });
    await appendLead(client, lead);
    await appendEvent(client, lead.id, "demo_unlocked", { business: input.isBusinessEmail, consent: consented });
    return { ok: true, leadId: lead.id, created: true };
  } catch (error) {
    // Address deliberately not logged: the log is the one place this data
    // would live with no retention policy.
    console.error("[healdesk] lead store unavailable; demo continues", { error: describe(error) });
    return { ok: false, reason: "unavailable" };
  }
}

/** Append a funnel event. Never throws; instrumentation must not break a request. */
export async function recordLeadEvent(
  leadId: string,
  name: string,
  payload?: Record<string, string | number | boolean>,
): Promise<void> {
  if (!isMarketingStoreConfigured()) return;
  try {
    await appendEvent(await store(), leadId, name, payload);
  } catch (error) {
    console.error("[healdesk] lead event dropped", { name, error: describe(error) });
  }
}

// -----------------------------------------------------------------------------
// Retention
// -----------------------------------------------------------------------------

/**
 * Delete leads that have not been seen for `months`. This is what makes the
 * retention line in the privacy policy true: the policy quotes
 * POLICY.leadRetentionMonths and a Vercel cron calls this daily
 * (app/api/cron/purge-leads). Events go with the lead; a call-consent row
 * that named the lead keeps its evidence and loses only the link.
 *
 * A lead with a claim token is a prospect who was sent a personalised bot;
 * the same clock applies — the token expires long before this does.
 */
export async function purgeStaleLeads(months: number): Promise<number> {
  if (!isMarketingStoreConfigured()) return 0;
  const client = await store();
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);

  const stale = (await readLeadRows(client)).filter((r) => r.value.lastSeenAt.getTime() < cutoff.getTime());
  if (stale.length === 0) return 0;
  const ids = new Set(stale.map((r) => r.value.id));

  // ON DELETE SET NULL, by hand: blank the link, keep the row.
  const consents = await readRows(client, CALL_CONSENTS, (cells) => rowToRecord(CALL_CONSENTS, cells) as CallConsent);
  for (const consent of consents) {
    if (consent.value.leadId && ids.has(consent.value.leadId)) {
      await client.updateRange(cellRange(CALL_CONSENTS, consent.row, "lead_id"), [[""]]);
    }
  }

  // The same for a setup request that came from one of these leads: the
  // request has its own retention clock (setup-requests.ts).
  const requests = await readRows(client, SETUP_REQUESTS, (cells) => rowToRecord(SETUP_REQUESTS, cells) as SetupRequest);
  for (const request of requests) {
    if (request.value.leadId && ids.has(request.value.leadId)) {
      await client.updateRange(cellRange(SETUP_REQUESTS, request.row, "lead_id"), [[""]]);
    }
  }

  // ON DELETE CASCADE, by hand.
  const events = await readRows(client, LEAD_EVENTS, (cells) => rowToRecord(LEAD_EVENTS, cells) as LeadEvent);
  await deleteRows(
    client,
    LEAD_EVENTS,
    events.filter((e) => ids.has(e.value.leadId)).map((e) => e.row),
  );
  await deleteRows(client, LEADS, stale.map((r) => r.row));
  return stale.length;
}

/**
 * Consent records past the limitation period. Separate from the lead purge
 * on purpose: the lead can go after a year of silence, the evidence that a
 * call was lawful stays for the four years a claim could be brought.
 */
export async function purgeStaleCallConsents(years: number): Promise<number> {
  if (!isMarketingStoreConfigured()) return 0;
  const client = await store();
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const consents = await readRows(client, CALL_CONSENTS, (cells) => rowToRecord(CALL_CONSENTS, cells) as CallConsent);
  const stale = consents.filter((c) => c.value.at instanceof Date && c.value.at.getTime() < cutoff.getTime());
  await deleteRows(client, CALL_CONSENTS, stale.map((c) => c.row));
  return stale.length;
}

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

export async function findLeadByEmail(email: string): Promise<Lead | null> {
  if (!isMarketingStoreConfigured()) return null;
  return (await locateByEmail(await store(), normalizeEmail(email)))?.value ?? null;
}

export async function findLeadById(id: string): Promise<Lead | null> {
  if (!isMarketingStoreConfigured()) return null;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await locateById(await store(), id))?.value ?? null;
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
  if (!isMarketingStoreConfigured()) return false;
  const client = await store();
  const located = await locateById(client, leadId);
  if (!located || located.value.unsubscribedAt) return false;
  const now = new Date();
  await writeLead(client, located.row, { ...located.value, unsubscribedAt: now, updatedAt: now });
  await recordLeadEvent(leadId, "unsubscribed", { source });
  return true;
}

/** Provider webhook: a hard bounce or a complaint, keyed on the address. */
export async function markDeliveryFailure(
  email: string,
  kind: "bounce" | "complaint",
): Promise<boolean> {
  if (!isMarketingStoreConfigured()) return false;
  const client = await store();
  const located = await locateByEmail(client, normalizeEmail(email));
  if (!located) return false;
  if (kind === "complaint") return markUnsubscribed(located.value.id, "complaint");
  const now = new Date();
  if (!located.value.bouncedAt) {
    await writeLead(client, located.row, { ...located.value, bouncedAt: now, updatedAt: now });
  }
  await recordLeadEvent(located.value.id, "bounced");
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
  if (!isMarketingStoreConfigured()) return null;
  const now = new Date();
  const normalized = normalizeEmail(input.email);
  try {
    const client = await store();
    const existing = await locateByEmail(client, normalized);
    let id: string;
    if (existing) {
      const lead = existing.value;
      id = lead.id;
      await writeLead(client, existing.row, {
        ...lead,
        lastSeenAt: now,
        updatedAt: now,
        clinicName: lead.clinicName ?? input.clinicName ?? null,
        specialty: lead.specialty ?? input.specialty ?? null,
        sourceCampaign: lead.sourceCampaign ?? input.campaign ?? null,
        checkoutStartedAt: now,
        // A new attempt reopens the abandonment question.
        checkoutAbandonedAt: null,
      });
    } else {
      const lead = newLead(now, {
        email: input.email.trim(),
        emailNormalized: normalized,
        clinicName: input.clinicName ?? null,
        specialty: input.specialty ?? null,
        sourceCampaign: input.campaign ?? null,
        leadScore: "business",
        isBusinessEmail: true,
        checkoutStartedAt: now,
        checkoutAbandonedAt: null,
      });
      id = lead.id;
      await appendLead(client, lead);
    }
    await recordLeadEvent(id, "checkout_started", { plan: input.plan, interval: input.interval });
    return id;
  } catch (error) {
    console.error("[healdesk] could not record checkout start", { error: describe(error) });
    return null;
  }
}

/** Stripe said the session expired, or the cron decided an hour was enough. */
export async function markCheckoutAbandoned(email: string): Promise<void> {
  if (!isMarketingStoreConfigured()) return;
  const client = await store();
  const located = await locateByEmail(client, normalizeEmail(email));
  if (!located || located.value.convertedAt || located.value.checkoutAbandonedAt) return;
  const now = new Date();
  await writeLead(client, located.row, { ...located.value, checkoutAbandonedAt: now, updatedAt: now });
  await recordLeadEvent(located.value.id, "checkout_abandoned");
}

/** The webhook saw a completed session: the lead is a customer. Ends the nurture. */
export async function markConverted(input: {
  email: string;
  plan: string;
  mrrUsd: number;
}): Promise<void> {
  if (!isMarketingStoreConfigured()) return;
  const client = await store();
  const located = await locateByEmail(client, normalizeEmail(input.email));
  if (!located) return;
  const lead = located.value;
  const now = new Date();
  await writeLead(client, located.row, {
    ...lead,
    convertedAt: lead.convertedAt ?? now,
    convertedPlan: input.plan,
    convertedMrrUsd: Math.round(input.mrrUsd),
    checkoutAbandonedAt: null,
    updatedAt: now,
  });
  if (!lead.convertedAt) {
    await recordLeadEvent(lead.id, "payment_completed", { plan: input.plan, mrr: Math.round(input.mrrUsd) });
  }
}

// -----------------------------------------------------------------------------
// The nurture cron's two queries
// -----------------------------------------------------------------------------

/** Consented, not yet a customer, not stopped, and with touches left. */
export async function leadsForNurture(maxStep: number, limit = 200): Promise<Lead[]> {
  if (!isMarketingStoreConfigured()) return [];
  const rows = dedupe(await readLeadRows(await store()));
  return rows
    .map((r) => r.value)
    .filter(
      (l) =>
        l.marketingConsent === true &&
        !l.unsubscribedAt &&
        !l.bouncedAt &&
        !l.convertedAt &&
        l.nurtureStep < maxStep,
    )
    .slice(0, limit);
}

/** Started checkout, did not finish, not yet nudged. */
export async function leadsForAbandonment(olderThan: Date, limit = 200): Promise<Lead[]> {
  if (!isMarketingStoreConfigured()) return [];
  const rows = dedupe(await readLeadRows(await store()));
  return rows
    .map((r) => r.value)
    .filter(
      (l) =>
        !l.convertedAt &&
        !l.abandonmentSentAt &&
        !l.unsubscribedAt &&
        !l.bouncedAt &&
        l.checkoutStartedAt !== null &&
        l.checkoutStartedAt.getTime() < olderThan.getTime(),
    )
    .slice(0, limit);
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

/**
 * When this lead's cohort credit ends, or null when it is not live. The form
 * the setup offers are compared in (lib/billing.ts `chooseSetupOffer`): the
 * cohort credit beats the demo's and the website's whenever it holds.
 */
export function cohortCreditEndsAt(lead: Pick<Lead, "cohortCreditOfferedAt">, now: Date = new Date()): Date | null {
  if (!lead.cohortCreditOfferedAt || !cohortCreditLive(lead, now)) return null;
  return new Date(lead.cohortCreditOfferedAt.getTime() + COHORT_SETUP_CREDIT.validDays * 24 * 60 * 60 * 1000);
}

export async function recordTouch(
  leadId: string,
  touch: { kind: "nurture"; step: number } | { kind: "abandonment" },
): Promise<void> {
  if (!isMarketingStoreConfigured()) return;
  const client = await store();
  const located = await locateById(client, leadId);
  if (!located) return;
  const lead = located.value;
  const now = new Date();
  if (touch.kind === "nurture") {
    await writeLead(client, located.row, {
      ...lead,
      nurtureStep: touch.step + 1,
      lastTouchAt: now,
      updatedAt: now,
      // Stamped once, when the offer was actually mailed; the checkout reads
      // this, never the step counter, so a resent or skipped touch cannot
      // grant or withhold the credit on its own.
      cohortCreditOfferedAt:
        touch.step === COHORT_CREDIT_TOUCH_STEP ? (lead.cohortCreditOfferedAt ?? now) : lead.cohortCreditOfferedAt,
    });
    await recordLeadEvent(leadId, "nurture_sent", { step: touch.step });
  } else {
    await writeLead(client, located.row, {
      ...lead,
      abandonmentSentAt: now,
      checkoutAbandonedAt: lead.checkoutAbandonedAt ?? now,
      lastTouchAt: now,
      updatedAt: now,
    });
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
  if (!isMarketingStoreConfigured()) {
    console.error("[healdesk] call consent NOT persisted: no lead store configured", {
      version: input.consentVersion,
    });
    return null;
  }
  try {
    const client = await store();
    const lead = input.leadEmail ? await locateByEmail(client, normalizeEmail(input.leadEmail)) : null;
    const consent: CallConsent = {
      id: randomUUID(),
      leadId: lead?.value.id ?? null,
      phoneE164: input.phoneE164,
      consentVersion: input.consentVersion,
      consentText: input.consentText,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      callPlacedAt: null,
      at: new Date(),
    };
    await client.appendRows(CALL_CONSENTS.title, [recordToRow(CALL_CONSENTS, consent)]);
    if (lead) await recordLeadEvent(lead.value.id, "call_requested");
    return consent.id;
  } catch (error) {
    console.error("[healdesk] call consent NOT persisted", { error: describe(error) });
    return null;
  }
}

export async function markCallPlaced(consentId: string | null): Promise<void> {
  if (!consentId || !isMarketingStoreConfigured()) return;
  try {
    const client = await store();
    const consents = await readRows(client, CALL_CONSENTS, (cells) => rowToRecord(CALL_CONSENTS, cells) as CallConsent);
    const located = consents.find((c) => c.value.id === consentId);
    if (!located) return;
    await client.updateRange(cellRange(CALL_CONSENTS, located.row, "call_placed_at"), [[new Date().toISOString()]]);
  } catch {
    // The consent row already exists; the placed stamp is a nicety.
  }
}

import { columnLetter, sheetsClient, type Cell, type SheetsClient } from "./client";

/**
 * The marketing Sheet's tabs, and the rule that governs all of them:
 * NOTHING here may ever describe a patient. A lead is a clinic owner who
 * unlocked the demo or started a checkout — their work email, their clinic's
 * public website, which specialty they run. That is business contact data.
 * The moment a column could hold a patient's name, condition or appointment,
 * it belongs in apps/app behind row-level security, not here.
 * `leads.test.ts` asserts every header against a denylist so that rule
 * outlives this comment.
 *
 * ## The layout is the old Postgres schema, on purpose
 *
 * Each tab's header row is the former SQL column list, snake_case, in the
 * former order, so a query someone wrote against the database reads the same
 * against the Sheet and so `scripts/funnel-report.ts` needed no new
 * vocabulary. Cells are typed the only way a spreadsheet can be:
 *
 *   - timestamps are ISO 8601 UTC strings (`2026-09-23T10:15:00.000Z`),
 *     written RAW so Sheets never turns them into a date cell;
 *   - booleans are TRUE / FALSE cells;
 *   - integers are number cells;
 *   - null is an empty cell;
 *   - the one JSON column (`lead_events.payload`) is a JSON string.
 *
 * Rows are addressed by their 1-based sheet row number, read together with
 * the data, and never stored anywhere: a row number is only good until the
 * next delete on that tab.
 *
 * ## Provisioning
 *
 * `ensureSheetSchema()` adds missing tabs and header rows and runs lazily
 * once per process; `npm run sheets:init -w @healdesk/web` runs it by hand.
 * A tab whose header row is something other than ours is refused rather
 * than overwritten: the owner may have put something there.
 */

export type ColumnType = "text" | "bool" | "int" | "timestamp" | "json";

export type Column = { readonly header: string; readonly field: string; readonly type: ColumnType };

export type Tab = { readonly title: string; readonly columns: readonly Column[] };

function col(header: string, field: string, type: ColumnType): Column {
  return { header, field, type };
}

/** One clinic owner, keyed on `emailNormalized`. The shape `lib/email/nurture.ts` renders from. */
export type Lead = {
  id: string;
  /** As typed, for display and for the delivery address. */
  email: string;
  /** Lower-cased and trimmed; the identity of the lead. */
  emailNormalized: string;
  phone: string | null;
  clinicName: string | null;
  website: string | null;
  /** SpecialtyId from @healdesk/catalog, when known. */
  specialty: string | null;
  /** Segment from the prospecting pipeline, when the lead came from a campaign. */
  segment: string | null;
  /** The `c=` parameter on a cold-email link, verbatim, or null for organic. */
  sourceCampaign: string | null;
  /** "business" | "consumer" — from isBusinessEmail() at first contact. */
  leadScore: string | null;
  isBusinessEmail: boolean | null;
  /**
   * Whether the person ticked the marketing checkbox. Unlocking the demo is
   * the service they asked for and is never consent to marketing; that is a
   * separate, default-unticked box, and this column records only that box.
   */
  marketingConsent: boolean;
  /** Version tag of the notice shown at the moment of consent. */
  consentNoticeVersion: string | null;
  /** The exact wording shown beside the checkbox when it was ticked. */
  consentText: string | null;
  consentAt: Date | null;
  /** Signed token for the personalised-bot page; null until a claim is made. */
  claimToken: string | null;
  /** The one-click unsubscribe, or a complaint from the provider. Never cleared by code. */
  unsubscribedAt: Date | null;
  /** A hard bounce reported by the provider's webhook. */
  bouncedAt: Date | null;
  /** How many nurture touches have been sent; the next one is TOUCHES[nurtureStep]. */
  nurtureStep: number;
  lastTouchAt: Date | null;
  /**
   * When the Day 7 touch offered the founding-cohort setup credit. The
   * checkout honours the credit only within `validDays` of this, so the offer
   * the email made and the discount the card sees cannot disagree.
   */
  cohortCreditOfferedAt: Date | null;
  checkoutStartedAt: Date | null;
  /** Stripe told us the latest Checkout Session expired unpaid (checkout.session.expired). */
  checkoutAbandonedAt: Date | null;
  /** The single abandonment touch (P7, "still open"); sent at most once per lead. */
  abandonmentSentAt: Date | null;
  convertedAt: Date | null;
  convertedPlan: string | null;
  /** Monthly recurring revenue at conversion, in whole dollars. */
  convertedMrrUsd: number | null;
  /** Where they came from, host only — never a full URL with query params. */
  referrerHost: string | null;
  unlockCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The purchase ref of the Checkout Session that expired (its metadata's
   * `ref`), so P7 can read the purchase's own records when it is due: the
   * clinic, the agreement's kind and the setup link. An opaque id, nothing
   * about the buyer. The last column, so existing Sheets gain it in place.
   */
  abandonedRef: string | null;
};

export const LEADS: Tab = {
  title: "leads",
  columns: [
    col("id", "id", "text"),
    col("email", "email", "text"),
    col("email_normalized", "emailNormalized", "text"),
    col("phone", "phone", "text"),
    col("clinic_name", "clinicName", "text"),
    col("website", "website", "text"),
    col("specialty", "specialty", "text"),
    col("segment", "segment", "text"),
    col("source_campaign", "sourceCampaign", "text"),
    col("lead_score", "leadScore", "text"),
    col("is_business_email", "isBusinessEmail", "bool"),
    col("marketing_consent", "marketingConsent", "bool"),
    col("consent_notice_version", "consentNoticeVersion", "text"),
    col("consent_text", "consentText", "text"),
    col("consent_at", "consentAt", "timestamp"),
    col("claim_token", "claimToken", "text"),
    col("unsubscribed_at", "unsubscribedAt", "timestamp"),
    col("bounced_at", "bouncedAt", "timestamp"),
    col("nurture_step", "nurtureStep", "int"),
    col("last_touch_at", "lastTouchAt", "timestamp"),
    col("cohort_credit_offered_at", "cohortCreditOfferedAt", "timestamp"),
    col("checkout_started_at", "checkoutStartedAt", "timestamp"),
    col("checkout_abandoned_at", "checkoutAbandonedAt", "timestamp"),
    col("abandonment_sent_at", "abandonmentSentAt", "timestamp"),
    col("converted_at", "convertedAt", "timestamp"),
    col("converted_plan", "convertedPlan", "text"),
    col("converted_mrr_usd", "convertedMrrUsd", "int"),
    col("referrer_host", "referrerHost", "text"),
    col("unlock_count", "unlockCount", "int"),
    col("first_seen_at", "firstSeenAt", "timestamp"),
    col("last_seen_at", "lastSeenAt", "timestamp"),
    col("created_at", "createdAt", "timestamp"),
    col("updated_at", "updatedAt", "timestamp"),
    col("abandoned_ref", "abandonedRef", "text"),
  ],
};

/**
 * Append-only. Funnel instrumentation writes here as well as to the analytics
 * vendor, so the numbers survive a vendor change and can be joined to the
 * lead's segment. Payloads carry ids and enum values, never free text.
 */
export type LeadEvent = {
  id: string;
  leadId: string;
  name: string;
  at: Date;
  payload: Record<string, string | number | boolean> | null;
};

export const LEAD_EVENTS: Tab = {
  title: "lead_events",
  columns: [
    col("id", "id", "text"),
    col("lead_id", "leadId", "text"),
    col("name", "name", "text"),
    col("at", "at", "timestamp"),
    col("payload", "payload", "json"),
  ],
};

/**
 * Consent to one AI-voiced demo call, per request.
 *
 * This is the record the TCPA defence is made of: the number, the exact
 * wording shown, its version, and when. It is keyed to the lead when the gate
 * cookie identifies one, but `leadId` is nullable and is blanked when the
 * lead is purged — the lead-retention purge must never take the evidence
 * with it. Kept for POLICY.callConsentRetentionYears, the limitation period.
 */
export type CallConsent = {
  id: string;
  leadId: string | null;
  phoneE164: string;
  consentVersion: string;
  consentText: string;
  ipAddress: string | null;
  userAgent: string | null;
  /** Set once the vendor accepted the call; null means consent recorded but no call placed. */
  callPlacedAt: Date | null;
  at: Date;
};

export const CALL_CONSENTS: Tab = {
  title: "call_consents",
  columns: [
    col("id", "id", "text"),
    col("lead_id", "leadId", "text"),
    col("phone_e164", "phoneE164", "text"),
    col("consent_version", "consentVersion", "text"),
    col("consent_text", "consentText", "text"),
    col("ip_address", "ipAddress", "text"),
    col("user_agent", "userAgent", "text"),
    col("call_placed_at", "callPlacedAt", "timestamp"),
    col("at", "at", "timestamp"),
  ],
};

/** The two site-wide daily spend caps. See src/lib/rate-limit.ts for what "shared" means here. */
export type Counter = {
  key: string;
  count: number;
  windowStart: Date;
  windowMs: number;
};

export const COUNTERS: Tab = {
  title: "counters",
  columns: [
    col("key", "key", "text"),
    col("count", "count", "int"),
    col("window_start", "windowStart", "timestamp"),
    col("window_ms", "windowMs", "int"),
  ],
};

/**
 * One personalised demo: a private page that answers as one prospect's clinic
 * (src/lib/demo). Built from the clinic's public website on an operator's
 * request, after the prospect asked for it.
 *
 * Business data only. `profile` is the clinic's own published services,
 * prices, hours and FAQs; `lead_email` and `phone_e164` are the owner's work
 * contact details. Nothing a visitor types into the demo is ever written
 * here: the chat and the calls are not stored on our side at all.
 *
 * `slug` is the capability: knowing it is what lets a browser use the demo,
 * so it carries a random suffix and is never listed anywhere public.
 */
/**
 * `building` → `auditing` → `ready` | `held`, or `failed` at any point.
 * `auditing` and `held` exist for the handoff audit (src/lib/demo/audit.ts):
 * a demo reaches `ready`, the only status the page and the APIs serve, once
 * the audit has passed it or an operator has released it.
 */
export type DemoSessionStatus = "building" | "auditing" | "ready" | "held" | "failed";

/**
 * What the handoff audit decided. `pass` and `flagged` ship on their own
 * (`flagged` with an alert to the team); `held` waits for an operator;
 * `unavailable` means the audit could not run, which holds the demo too;
 * `released` is an operator shipping a held demo by hand.
 */
export type DemoAuditVerdict = "pass" | "flagged" | "held" | "unavailable" | "released";

export type DemoSession = {
  id: string;
  slug: string;
  status: DemoSessionStatus;
  leadEmail: string | null;
  clinicName: string;
  websiteUrl: string;
  /** The owner's number from the request, to prefill "call me". Never dialled without a fresh consent tick. */
  phoneE164: string | null;
  /** The niche as the operator or the webhook gave it, verbatim. */
  niche: string | null;
  /** SpecialtyId, from the extraction or the niche. */
  specialty: string | null;
  brandName: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  /** The ClinicProfile, as JSON. */
  profile: Record<string, unknown> | null;
  scrapeSource: string | null;
  /** Why a build failed, or what it had to skip. Operator-facing. */
  buildNote: string | null;
  createdBy: string | null;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date;
  claimed: boolean;
  claimedAt: Date | null;
  claimedPlan: string | null;
  emailSentAt: Date | null;
  /** When the current build (first or retry) started; how the console tells a stalled build from a slow one. */
  buildStartedAt: Date | null;
  /** The request asked for the link to be emailed; the audit's pass sends it, whenever that comes. */
  emailRequested: boolean;
  auditVerdict: DemoAuditVerdict | null;
  /** The weighted 0–100 score. */
  auditScore: number | null;
  /** The full audit (lib/demo/audit.ts `AuditReport`), as JSON. Operator-facing. */
  auditReport: Record<string, unknown> | null;
  auditedAt: Date | null;
  /** Fingerprint of the profile the verdict was given for; a changed profile is unaudited. */
  auditHash: string | null;
};

export const DEMO_SESSIONS: Tab = {
  title: "demo_sessions",
  columns: [
    col("id", "id", "text"),
    col("slug", "slug", "text"),
    col("status", "status", "text"),
    col("lead_email", "leadEmail", "text"),
    col("clinic_name", "clinicName", "text"),
    col("website_url", "websiteUrl", "text"),
    col("phone_e164", "phoneE164", "text"),
    col("niche", "niche", "text"),
    col("specialty", "specialty", "text"),
    col("brand_name", "brandName", "text"),
    col("logo_url", "logoUrl", "text"),
    col("brand_color", "brandColor", "text"),
    col("profile", "profile", "json"),
    col("scrape_source", "scrapeSource", "text"),
    col("build_note", "buildNote", "text"),
    col("created_by", "createdBy", "text"),
    col("created_at", "createdAt", "timestamp"),
    col("ready_at", "readyAt", "timestamp"),
    col("expires_at", "expiresAt", "timestamp"),
    col("claimed_status", "claimed", "bool"),
    col("claimed_at", "claimedAt", "timestamp"),
    col("claimed_plan", "claimedPlan", "text"),
    col("email_sent_at", "emailSentAt", "timestamp"),
    // Appended, never inserted: an existing tab's header row is extended in
    // place only while the old one is a prefix of this one (provision below).
    col("build_started_at", "buildStartedAt", "timestamp"),
    col("email_requested", "emailRequested", "bool"),
    col("audit_verdict", "auditVerdict", "text"),
    col("audit_score", "auditScore", "int"),
    col("audit_report", "auditReport", "json"),
    col("audited_at", "auditedAt", "timestamp"),
    col("audit_hash", "auditHash", "text"),
  ],
};

/**
 * One "Tell us about your clinic" request, and the setup link sent back.
 *
 * Business contact data only, like every tab here: who asked, for which
 * clinic, at which address, and where the request has got to. The link's
 * token is never stored (it is an HMAC over these fields and the expiry;
 * see src/lib/setup-link.ts), only when it was sent and when it expires.
 * `paid_at` makes the link single-use: the checkout refuses a request that
 * has one.
 */
export type SetupRequestStatus = "new" | "invited" | "paid" | "declined";

export type SetupRequest = {
  id: string;
  /** The person asking, as typed. */
  name: string;
  clinicName: string;
  /** Host or URL as typed, or null for a clinic with no website. */
  website: string | null;
  /** The address the clinic will use with healdesk; a shared inbox is fine. */
  email: string;
  emailNormalized: string;
  /** Comma-separated channel ids from the form: phone, web, instagram, messenger, whatsapp. */
  channels: string | null;
  /** The nurture lead this came from, when the Day 7 link brought them. */
  leadId: string | null;
  status: SetupRequestStatus;
  invitedAt: Date | null;
  linkExpiresAt: Date | null;
  openedAt: Date | null;
  remindedAt: Date | null;
  signedAt: Date | null;
  paidAt: Date | null;
  /** The one-click opt-out on the setup-link emails; stops the reminder. */
  unsubscribedAt: Date | null;
  ipAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const SETUP_REQUESTS: Tab = {
  title: "setup_requests",
  columns: [
    col("id", "id", "text"),
    col("name", "name", "text"),
    col("clinic_name", "clinicName", "text"),
    col("website", "website", "text"),
    col("email", "email", "text"),
    col("email_normalized", "emailNormalized", "text"),
    col("channels", "channels", "text"),
    col("lead_id", "leadId", "text"),
    col("status", "status", "text"),
    col("invited_at", "invitedAt", "timestamp"),
    col("link_expires_at", "linkExpiresAt", "timestamp"),
    col("opened_at", "openedAt", "timestamp"),
    col("reminded_at", "remindedAt", "timestamp"),
    col("signed_at", "signedAt", "timestamp"),
    col("paid_at", "paidAt", "timestamp"),
    col("unsubscribed_at", "unsubscribedAt", "timestamp"),
    col("ip_address", "ipAddress", "text"),
    col("created_at", "createdAt", "timestamp"),
    col("updated_at", "updatedAt", "timestamp"),
  ],
};

/**
 * The checkout records (owner, 14 October 2026): the signed agreement and the
 * purchase, kept here from the moment they are made until apps/app imports
 * them when the first invoice is paid, so a buyer can sign and pay while the
 * AWS host is in standby (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * Business contact data, like every tab here: a clinic owner's name, work
 * email, title, IP address and user agent, the clinic's answers and the
 * read of its public website. Nothing about a patient.
 *
 * Each row is one SEALED record (@healdesk/catalog/checkout-record): its JSON
 * across `record_1`…`record_8` (one cell holds 50,000 characters; a large
 * record is gzipped and split) and an HMAC over that JSON in `seal`, keyed
 * from HEALDESK_PROVISION_SECRET, which apps/app holds too and checks, so an
 * edit made here between signing and provisioning is found rather than
 * imported. The columns before `seal` are an index for finding a row, copied
 * out of the record and checked against it whenever it is read, except
 * `provisioned_at` and `withdrawn_at`, which the record does not hold: they
 * are state apps/web keeps for itself, and apps/app never reads them. Do not
 * edit a record cell by hand: the record stops opening, and the purchase it
 * carries stops provisioning.
 */
export const RECORD_COLUMNS = 8;

function recordColumns(): Column[] {
  const out: Column[] = [col("seal", "seal", "text")];
  for (let i = 1; i <= RECORD_COLUMNS; i += 1) out.push(col(`record_${i}`, `record${i}`, "text"));
  return out;
}

/** One signature: the agreement a clinic owner signed before paying. */
export type AgreementRow = {
  id: string;
  documentVersion: string;
  acceptedAt: Date;
  /** Set once the purchase that names it is provisioned: it belongs to an account now. */
  provisionedAt: Date | null;
};

/** How many leading columns of `agreements` are the index. */
export const AGREEMENT_INDEX_COLUMNS = 4;

export const AGREEMENTS: Tab = {
  title: "agreements",
  columns: [
    col("id", "id", "text"),
    col("document_version", "documentVersion", "text"),
    col("accepted_at", "acceptedAt", "timestamp"),
    col("provisioned_at", "provisionedAt", "timestamp"),
    ...recordColumns(),
  ],
};

/** One press of Pay: a purchase and the Checkout Session it opened. */
export type CheckoutIntentRow = {
  /** This record's own id. */
  id: string;
  /** The purchase; the setup link's request id while purchases are by invitation. */
  ref: string;
  attempt: number;
  inviteRef: string | null;
  agreementId: string;
  createdAt: Date;
  /** This press opened no Session (Stripe refused, or the previous one was paid): never provisioned from. */
  withdrawnAt: Date | null;
  /** The purchase is provisioned: its setup link and agreement are spent. */
  provisionedAt: Date | null;
};

/** How many leading columns of `checkout_intents` are the index. */
export const INTENT_INDEX_COLUMNS = 8;

export const CHECKOUT_INTENTS: Tab = {
  title: "checkout_intents",
  columns: [
    col("id", "id", "text"),
    col("ref", "ref", "text"),
    col("attempt", "attempt", "int"),
    col("invite_ref", "inviteRef", "text"),
    col("agreement_id", "agreementId", "text"),
    col("created_at", "createdAt", "timestamp"),
    col("withdrawn_at", "withdrawnAt", "timestamp"),
    col("provisioned_at", "provisionedAt", "timestamp"),
    ...recordColumns(),
  ],
};

export const TABS: readonly Tab[] = [
  LEADS,
  LEAD_EVENTS,
  CALL_CONSENTS,
  COUNTERS,
  SETUP_REQUESTS,
  DEMO_SESSIONS,
  AGREEMENTS,
  CHECKOUT_INTENTS,
];

// -----------------------------------------------------------------------------
// Ranges
// -----------------------------------------------------------------------------

export function lastColumn(tab: Tab): string {
  return columnLetter(tab.columns.length);
}

/** Every data row, all columns: `leads!A2:AG`. */
export function dataRange(tab: Tab): string {
  return `${tab.title}!A2:${lastColumn(tab)}`;
}

/** One whole row: `leads!A5:AG5`. */
export function rowRange(tab: Tab, row: number): string {
  return `${tab.title}!A${row}:${lastColumn(tab)}${row}`;
}

/** One cell by header: `call_consents!H5`. */
export function cellRange(tab: Tab, row: number, header: string): string {
  const index = tab.columns.findIndex((c) => c.header === header);
  if (index === -1) throw new Error(`${tab.title} has no column ${header}`);
  return `${tab.title}!${columnLetter(index + 1)}${row}`;
}

// -----------------------------------------------------------------------------
// The cell codec
// -----------------------------------------------------------------------------

/** Sheets stores dates as days since 1899-12-30. Only reached if someone hand-edits a cell into a date. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

export function toCell(type: ColumnType, value: unknown): Cell {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "text":
      return String(value);
    case "bool":
      return Boolean(value);
    case "int":
      return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : "";
    case "timestamp":
      return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : "";
    case "json":
      return JSON.stringify(value);
  }
}

export function fromCell(type: ColumnType, raw: Cell | undefined): unknown {
  if (raw === undefined || raw === "") return null;
  switch (type) {
    case "text":
      return String(raw);
    case "bool":
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      return raw.trim().toUpperCase() === "TRUE";
    case "int": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "timestamp": {
      if (typeof raw === "number") return new Date(SERIAL_EPOCH_MS + raw * 86_400_000);
      if (typeof raw === "boolean") return null;
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case "json": {
      if (typeof raw !== "string") return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
}

/** A record in the tab's column order, ready to append or write. */
export function recordToRow(tab: Tab, record: Record<string, unknown>): Cell[] {
  return tab.columns.map((c) => toCell(c.type, record[c.field]));
}

/** The loose object a row decodes to; callers narrow it (`leadFromRow` below). */
export function rowToRecord(tab: Tab, row: readonly Cell[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  tab.columns.forEach((c, i) => {
    out[c.field] = fromCell(c.type, row[i]);
  });
  return out;
}

/**
 * A `leads` row as a `Lead`, with the NOT NULL defaults the database used to
 * supply filled in for a row somebody blanked by hand. The four "seen"
 * timestamps fall back to each other before falling back to now, so a
 * damaged row is never mistaken for a thirteen-month-old one and purged.
 */
export function leadFromRow(row: readonly Cell[]): Lead {
  const r = rowToRecord(LEADS, row) as Record<string, unknown> & Partial<Lead>;
  const stamp =
    r.lastSeenAt ?? r.firstSeenAt ?? r.createdAt ?? r.updatedAt ?? new Date();
  return {
    ...(r as Lead),
    id: r.id ?? "",
    email: r.email ?? "",
    emailNormalized: r.emailNormalized ?? "",
    marketingConsent: r.marketingConsent ?? false,
    nurtureStep: r.nurtureStep ?? 0,
    unlockCount: r.unlockCount ?? 1,
    firstSeenAt: r.firstSeenAt ?? stamp,
    lastSeenAt: r.lastSeenAt ?? stamp,
    createdAt: r.createdAt ?? stamp,
    updatedAt: r.updatedAt ?? stamp,
  };
}

// -----------------------------------------------------------------------------
// Provisioning
// -----------------------------------------------------------------------------

let ensured: Promise<void> | null = null;

async function provision(client: SheetsClient): Promise<void> {
  const titles = new Set(await client.getSheetTitles());
  const missing = TABS.filter((tab) => !titles.has(tab.title));
  if (missing.length > 0) {
    await client.batchUpdate(missing.map((tab) => ({ addSheet: { properties: { title: tab.title } } })));
  }
  for (const tab of TABS) {
    const expected = tab.columns.map((c) => c.header);
    const [existing = []] = missing.includes(tab) ? [[]] : await client.getValues(`${tab.title}!1:1`);
    const asStrings = existing.map((cell) => String(cell));
    if (asStrings.length === expected.length && asStrings.every((h, i) => h === expected[i])) continue;
    const isPrefix = asStrings.every((h, i) => h === expected[i]);
    if (asStrings.length === 0 || isPrefix) {
      await client.updateRange(`${tab.title}!A1:${lastColumn(tab)}1`, [expected]);
      continue;
    }
    throw new Error(
      `The "${tab.title}" tab of the marketing Sheet has a header row that is not ours; refusing to write over it. Expected ${expected.length} columns starting with "${expected[0]}".`,
    );
  }
}

/**
 * Create missing tabs and header rows. Once per process: concurrent callers
 * share the same promise, and a failure clears it so the next caller tries
 * again rather than inheriting a rejection forever.
 */
export function ensureSheetSchema(client: SheetsClient = sheetsClient()): Promise<void> {
  if (!ensured) {
    ensured = provision(client).catch((error: unknown) => {
      ensured = null;
      throw error;
    });
  }
  return ensured;
}

/** Tests swap the fake between cases; the memo must not outlive it. */
export function __resetSheetSchemaForTests(): void {
  ensured = null;
}

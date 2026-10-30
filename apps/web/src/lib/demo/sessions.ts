import { randomBytes, randomUUID } from "node:crypto";

import {
  type Audience,
  audienceFor,
  DEMO_SETUP_CREDIT,
  isSetupCreditLive,
  isSpecialtyId,
  SELF_SERVE_DEMO_SETUP_CREDIT,
  type SetupCredit,
  setupCreditEndsAt,
} from "@healdesk/catalog";

import { sheetsClient, type Cell, type SheetsClient } from "@/lib/sheets/client";
import {
  DEMO_SESSIONS,
  dataRange,
  ensureSheetSchema,
  recordToRow,
  rowRange,
  rowToRecord,
  type DemoAuditVerdict,
  type DemoSession,
  type DemoSessionStatus,
} from "@/lib/sheets/schema";
import { site } from "@/lib/site";

import { purgeDemoEvents } from "./events";

import { normalizeProfile, type ClinicProfile } from "./profile";

export type { DemoAuditVerdict, DemoSession, DemoSessionStatus } from "@/lib/sheets/schema";

/**
 * The personalised demo's register: one `demo_sessions` row per demo, in the
 * marketing Sheet, beside the leads (src/lib/sheets).
 *
 * ## Why the Sheet and not anywhere else
 *
 * apps/web has no database client and must keep it that way (root
 * CLAUDE.md). The demo's data is business data, the clinic's public website
 * and the owner's work email, so the store the owner already opens on a
 * phone is the right one, and /admin/crm shows the new tab with no new view.
 *
 * ## What a Sheet costs here, and the cache that pays for it
 *
 * A read is a whole-tab range at 300–800 ms against a quota of about sixty
 * requests a minute. The demo page reads its row once per render, but the
 * chat route would read it on every turn, so a decoded row is kept in this
 * instance's memory for `CACHE_MS`. A write here refreshes the cached copy at
 * once; a write made by another instance (a claim from the Stripe webhook,
 * say) is seen within the minute, which is the most that can be stale about
 * a demo: whether it still works, and it stops working on a clock both
 * instances already agree on.
 *
 * ## Fail closed for visitors, loudly for operators
 *
 * `getDemoSession()` returns null when the Sheet is unreachable, and the page
 * shows "not found" rather than a stack trace; the operator paths let the
 * error through so the console says what is wrong.
 */

/** How long a link works. The prospect is told the date, and the page counts down to it. */
export const DEMO_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** After expiry the row is kept this long for the operator, then the retention purge deletes it. */
export const DEMO_RETENTION_AFTER_EXPIRY_DAYS = 30;

const CACHE_MS = 60_000;

/**
 * A row still being built is cached for a few seconds only: the build lands
 * within a minute (lib/demo/budget.ts), often on another instance, and the
 * person watching the countdown must see "ready" when it happens, not up to
 * a minute later. At one read per five seconds per instance, a build's
 * watchers cost the Sheet at most twelve reads a minute however many poll.
 */
const BUILDING_CACHE_MS = 5_000;

function cacheFor(session: DemoSession): number {
  return session.status === "building" || session.status === "auditing" ? BUILDING_CACHE_MS : CACHE_MS;
}

/** Lower-case words, hyphens, a random tail. Shape-checked on every route before any read. */
export const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-9]{10}$/;

export function isDemoSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && SLUG_SHAPE.test(value);
}

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/**
 * `smith-dental-k7q2mz9xwa`: readable enough to recognise in a list, with
 * ten characters from a 32-letter alphabet (50 bits) so it cannot be guessed
 * from the clinic's name. The doc's `smith-dental-demo` would be guessable,
 * and the slug is the only thing between a stranger and a demo that spends
 * our model and voice minutes.
 */
export function makeDemoSlug(clinicName: string): string {
  const words =
    clinicName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "clinic";
  const bytes = randomBytes(10);
  const tail = [...bytes].map((b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
  return `${words}-${tail}`;
}

export function demoUrl(slug: string): string {
  return `${site.url.replace(/\/$/, "")}/demo/${slug}`;
}

/**
 * A build or an audit still running after this long has been cut off: a
 * build takes a minute (lib/demo/budget.ts) and stops itself at
 * BUILD_HARD_STOP_MS (lib/demo/build.ts, 150 s), so a row still running past
 * three minutes has lost the process that ran it. The console offers a retry
 * for it and the waiting screen hands over to the team. It was six minutes
 * until 30 October 2026, when a prospect watched the waiting page for ten.
 */
export const DEMO_BUILD_STALL_MS = 3 * 60 * 1000;

const STATUSES: readonly DemoSessionStatus[] = ["building", "auditing", "ready", "held", "failed"];
const VERDICTS: readonly DemoAuditVerdict[] = ["pass", "flagged", "held", "unavailable", "released"];

/** Building or auditing, and past the point where the run that started it can still finish. */
export function isDemoBuildStalled(session: DemoSession, now: number = Date.now()): boolean {
  if (session.status !== "building" && session.status !== "auditing") return false;
  const started = (session.buildStartedAt ?? session.createdAt).getTime();
  return now - started > DEMO_BUILD_STALL_MS;
}

/**
 * What someone waiting on a demo is shown: still building or auditing (the
 * stage, for the progress bar in lib/demo/build-progress.ts), ready, or with
 * the team: held, failed, or stalled past the point where the run that started
 * it can still finish. The demo's page and api/demo/[slug]/status both read it
 * here, so the page and the homepage window agree.
 */
export type DemoBuildState = "building" | "auditing" | "ready" | "finishing";

export function demoBuildState(session: DemoSession, now: number = Date.now()): DemoBuildState {
  if (session.status === "ready") return session.profile ? "ready" : "finishing";
  if ((session.status === "building" || session.status === "auditing") && !isDemoBuildStalled(session, now)) return session.status;
  return "finishing";
}

/** How long the build has been running, for the progress bar. */
export function demoBuildElapsedMs(session: DemoSession, now: number = Date.now()): number {
  return Math.max(0, now - (session.buildStartedAt ?? session.createdAt).getTime());
}

/** Usable now: built, and inside its week. */
export function isDemoActive(session: DemoSession, now: number = Date.now()): boolean {
  return session.status === "ready" && session.expiresAt.getTime() > now;
}

/**
 * When the demo's setup offer (`demoSetupCredit`: 50% from an operator's demo,
 * 30% from a homepage one) ends, or null when it has ended or the demo is not
 * usable. 48 hours from the moment the demo was ready, which is when the
 * clinic was sent it, not from the request: a build that took a few
 * minutes must not eat into the clinic's two days. Never past the demo's own
 * expiry, because a demo that no longer opens has nothing to buy from.
 */
export function demoOfferEndsAt(session: DemoSession, now: number = Date.now()): Date | null {
  if (!isDemoActive(session, now)) return null;
  const credit = demoSetupCredit(session);
  const offeredAt = session.readyAt ?? session.createdAt;
  if (!isSetupCreditLive(credit, offeredAt, now)) return null;
  const ends = setupCreditEndsAt(credit, offeredAt);
  return ends.getTime() < session.expiresAt.getTime() ? ends : session.expiresAt;
}

export function isDemoExpired(session: DemoSession, now: number = Date.now()): boolean {
  return session.expiresAt.getTime() <= now;
}

/** The stored profile, decoded, or null for a row still building or one that failed. */
export function profileOf(session: DemoSession): ClinicProfile | null {
  return session.profile ? normalizeProfile(session.profile, session.clinicName) : null;
}

/**
 * Who the demo's clinic serves, in its own word (audienceFor): a veterinary
 * practice's people are clients, since its patients are animals. The
 * specialty the demo was asked for, else the one its website read found, as
 * the purchase opened from it reads them (demoCheckout); a demo that names
 * neither is a practice whose patients are people, as that purchase assumes.
 */
export function demoAudience(session: DemoSession): Audience {
  const specialty = isSpecialtyId(session.specialty)
    ? session.specialty
    : (profileOf(session)?.specialty ?? null);
  return audienceFor(specialty);
}

/**
 * `createdBy` on a demo a visitor asked for themselves, from the homepage's
 * "See it in your own branding" (api/own-demo). Every other value is an
 * operator's doing: their console address, or "webhook" for automation they
 * run once they have read a reply. The difference matters at checkout, where
 * a demo the operator built counts as an invitation and a self-serve one
 * does not (lib/setup-gate.ts).
 */
export const SELF_SERVE_DEMO = "homepage";

export function isSelfServeDemo(session: Pick<DemoSession, "createdBy">): boolean {
  return session.createdBy === SELF_SERVE_DEMO;
}

/**
 * The setup credit a demo carries for its first 48 hours: half the fee from a
 * demo an operator built, 30% from one the visitor asked for on the homepage
 * (owner, 13 October 2026). The demo's banner, the checkout's offer and the coupon
 * api/checkout applies all read it here, so they cannot disagree.
 */
export function demoSetupCredit(session: Pick<DemoSession, "createdBy">): SetupCredit {
  return isSelfServeDemo(session) ? SELF_SERVE_DEMO_SETUP_CREDIT : DEMO_SETUP_CREDIT;
}

/** The name to show: the site's own if it gave one, else what the operator typed. */
export function displayName(session: DemoSession): string {
  const profile = profileOf(session);
  return profile?.clinicName ?? session.brandName ?? session.clinicName;
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

type Located = { row: number; value: DemoSession };

function decode(cells: readonly Cell[]): DemoSession {
  const r = rowToRecord(DEMO_SESSIONS, cells) as Record<string, unknown> & Partial<DemoSession>;
  const createdAt = r.createdAt ?? new Date(0);
  const status = STATUSES.includes(r.status as DemoSessionStatus) ? (r.status as DemoSessionStatus) : "building";
  const auditVerdict = VERDICTS.includes(r.auditVerdict as DemoAuditVerdict) ? (r.auditVerdict as DemoAuditVerdict) : null;
  return {
    ...(r as DemoSession),
    id: r.id ?? "",
    slug: r.slug ?? "",
    status,
    clinicName: r.clinicName ?? "",
    websiteUrl: r.websiteUrl ?? "",
    createdAt,
    // A row with its expiry blanked by hand is treated as expired, never as eternal.
    expiresAt: r.expiresAt ?? createdAt,
    claimed: r.claimed ?? false,
    // Rows written before the audit columns existed decode with them empty.
    buildStartedAt: r.buildStartedAt ?? null,
    emailRequested: r.emailRequested ?? false,
    auditVerdict,
    auditScore: r.auditScore ?? null,
    auditReport: r.auditReport ?? null,
    auditedAt: r.auditedAt ?? null,
    auditHash: r.auditHash ?? null,
    retryCount: r.retryCount ?? 0,
  };
}

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

async function readAll(client: SheetsClient): Promise<Located[]> {
  const rows = await client.getValues(dataRange(DEMO_SESSIONS));
  const out: Located[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((c) => c === "" || c === undefined)) return;
    const value = decode(cells);
    if (value.slug) out.push({ row: i + 2, value });
  });
  return out;
}

const cache = new Map<string, { value: DemoSession; at: number }>();

function remember(session: DemoSession): DemoSession {
  cache.set(session.slug, { value: session, at: Date.now() });
  return session;
}

/** Tests swap the fake Sheet between cases. */
export function __resetDemoCacheForTests(): void {
  cache.clear();
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

/** A demo by slug, for the page and the visitor-facing routes. Null when unknown or unreachable. */
export async function getDemoSession(slug: string, options: { fresh?: boolean } = {}): Promise<DemoSession | null> {
  const found = await findDemoSession(slug, options);
  return found === "unavailable" ? null : found;
}

/**
 * As `getDemoSession`, but says "unavailable" when the Sheet could not be read
 * and nothing is cached, rather than null. The demo page must tell the two
 * apart: a read that failed (a Sheets quota or a timeout on a cold instance)
 * showed a prospect the site's 404, "This page, she can't find", for a demo
 * that exists (owner, 30 October 2026).
 */
export async function findDemoSession(slug: string, options: { fresh?: boolean } = {}): Promise<DemoSession | null | "unavailable"> {
  if (!isDemoSlug(slug)) return null;
  const hit = cache.get(slug);
  if (hit && !options.fresh && Date.now() - hit.at < cacheFor(hit.value)) return hit.value;
  try {
    const client = await store();
    const found = (await readAll(client)).find((r) => r.value.slug === slug);
    if (!found) {
      cache.delete(slug);
      return null;
    }
    return remember(found.value);
  } catch (error) {
    console.error("[healdesk] demo session read failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return hit?.value ?? "unavailable";
  }
}

/** Newest first, for the operator console. Throws when the Sheet is unreachable. */
export async function listDemoSessions(limit = 50): Promise<DemoSession[]> {
  const client = await store();
  return (await readAll(client))
    .map((r) => r.value)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

/**
 * Every row whose build has outlived the run that started it
 * (`isDemoBuildStalled`), longest stalled first, for the sweep and the
 * console's "Retry all stalled" (lib/demo/sweep.ts). Every row, not the
 * newest few: a rebuild of an old demo stalls the same way a new build
 * does. Reads fresh, because a retry writes the row it is about to read.
 * Throws when the Sheet is unreachable.
 */
export async function listStalledDemoSessions(now: number = Date.now()): Promise<DemoSession[]> {
  const client = await store();
  return (await readAll(client))
    .map((r) => r.value)
    .filter((s) => isDemoBuildStalled(s, now))
    .sort((a, b) => (a.buildStartedAt ?? a.createdAt).getTime() - (b.buildStartedAt ?? b.createdAt).getTime());
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export type NewDemo = {
  clinicName: string;
  websiteUrl: string;
  leadEmail?: string | null;
  phoneE164?: string | null;
  niche?: string | null;
  createdBy?: string | null;
  /** Email the link once the audit passes it. */
  emailRequested?: boolean;
};

/** Append a `building` row and return it; the build fills it in. */
export async function createDemoSession(input: NewDemo, now: Date = new Date()): Promise<DemoSession> {
  const niche = input.niche?.trim() || null;
  const session: DemoSession = {
    id: randomUUID(),
    slug: makeDemoSlug(input.clinicName),
    status: "building",
    leadEmail: input.leadEmail?.trim().toLowerCase() || null,
    clinicName: input.clinicName.trim().slice(0, 120),
    websiteUrl: input.websiteUrl,
    phoneE164: input.phoneE164 ?? null,
    niche,
    specialty: isSpecialtyId(niche) ? niche : null,
    brandName: null,
    logoUrl: null,
    brandColor: null,
    profile: null,
    scrapeSource: null,
    buildNote: null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    readyAt: null,
    expiresAt: new Date(now.getTime() + DEMO_LIFETIME_MS),
    claimed: false,
    claimedAt: null,
    claimedPlan: null,
    emailSentAt: null,
    buildStartedAt: now,
    emailRequested: input.emailRequested ?? false,
    auditVerdict: null,
    auditScore: null,
    auditReport: null,
    auditedAt: null,
    auditHash: null,
    retryCount: 0,
  };
  const client = await store();
  await client.appendRows(DEMO_SESSIONS.title, [recordToRow(DEMO_SESSIONS, session)]);
  return remember(session);
}

export type DemoPatch = Partial<Omit<DemoSession, "id" | "slug" | "createdAt">>;

/**
 * Read the row fresh, apply `patch`, write the whole row back. Returns the
 * updated session, or null when no row has that slug. A Sheet has no
 * transaction, so two writers racing on one row means the later one wins;
 * the usual concurrent writers are a build and a claim, which touch
 * different columns minutes apart.
 *
 * `patch` may be a function of the row as it was just read, returning the
 * patch or null to leave the row alone. A writer whose decision depends on
 * the row's state (the stall retry in lib/demo/sweep.ts) decides on the
 * same read it writes from, so what can change between its look and its
 * write is one Sheet round-trip rather than two. That is a narrower window,
 * not a lock: two writers that both read before either writes both write,
 * and the later one wins.
 */
export async function updateDemoSession(
  slug: string,
  patch: DemoPatch | ((current: DemoSession) => DemoPatch | null),
): Promise<DemoSession | null> {
  const client = await store();
  const found = (await readAll(client)).find((r) => r.value.slug === slug);
  if (!found) return null;
  const change = typeof patch === "function" ? patch(found.value) : patch;
  if (!change) return null;
  const next: DemoSession = { ...found.value, ...change };
  await client.updateRange(rowRange(DEMO_SESSIONS, found.row), [recordToRow(DEMO_SESSIONS, next)]);
  return remember(next);
}

/**
 * The prospect paid. Idempotent: a second delivery of the same checkout finds
 * the row already claimed, leaves `claimedAt` alone and reports
 * `newly: false`, so the caller alerts the team once, not once per retry.
 */
export async function markDemoClaimed(
  slug: string,
  plan: string,
  now: Date = new Date(),
): Promise<{ session: DemoSession; newly: boolean } | null> {
  const current = await getDemoSession(slug, { fresh: true });
  if (!current) return null;
  if (current.claimed) return { session: current, newly: false };
  const updated = await updateDemoSession(slug, { claimed: true, claimedAt: now, claimedPlan: plan });
  return updated ? { session: updated, newly: true } : null;
}

/**
 * Delete rows whose link expired more than `days` ago and that never became
 * a customer. A claimed row is kept: it is the record of which demo sold,
 * and it goes when the lead it belongs to goes. Returns the number deleted.
 */
export async function purgeExpiredDemoSessions(
  days: number = DEMO_RETENTION_AFTER_EXPIRY_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const client = await store();
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const stale = (await readAll(client)).filter((r) => !r.value.claimed && r.value.expiresAt.getTime() < cutoff);
  const doomed = stale.map((r) => r.row).sort((a, b) => b - a);
  if (doomed.length === 0) return 0;
  const sheetId = await client.getSheetId(DEMO_SESSIONS.title);
  if (sheetId === null) return 0;
  // Descending, so each delete leaves the row numbers of the next ones intact.
  await client.batchUpdate(
    doomed.map((row) => ({
      deleteDimension: { range: { sheetId, dimension: "ROWS" as const, startIndex: row - 1, endIndex: row } },
    })),
  );
  cache.clear();
  // Each demo's page events go with it (lib/demo/events.ts).
  await purgeDemoEvents(new Set(stale.map((r) => r.value.slug))).catch((error: unknown) => {
    console.error("[healdesk] demo events not purged", { error: (error as Error).message });
  });
  return doomed.length;
}

/**
 * The live demo a caller registered for, by the number they said they would
 * call from (the "Call us" tab, app/api/demo/[slug]/caller). The newest wins
 * when one owner has several. Read by the demo line's inbound webhook, which
 * has ten seconds and gets a Sheet read of under one: this reads fresh rather
 * than from a cache another instance filled before the number was saved.
 */
export async function findActiveDemoByCaller(phoneE164: string, now: number = Date.now()): Promise<DemoSession | null> {
  const client = await store();
  const matches = (await readAll(client))
    .map((r) => r.value)
    .filter((s) => s.phoneE164 === phoneE164 && isDemoActive(s, now))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return matches[0] ? remember(matches[0]) : null;
}

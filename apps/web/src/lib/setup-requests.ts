import { randomUUID } from "node:crypto";

import { deleteRows, normalizeEmail, recordLeadEvent } from "@/lib/leads";
import { replyByDay, replyByPassed } from "@/lib/reply-by";
import { CHANNEL_IDS, type ChannelId } from "@/lib/setup-channels";
import { isMarketingStoreConfigured, sheetsClient, type Cell, type SheetsClient } from "@/lib/sheets/client";
import {
  dataRange,
  ensureSheetSchema,
  recordToRow,
  rowRange,
  rowToRecord,
  SETUP_REQUESTS,
  type SetupRequest,
  type SetupRequestStatus,
} from "@/lib/sheets/schema";

/**
 * The "Tell us about your clinic" requests, in the marketing Sheet's
 * `setup_requests` tab, and the life of the setup link sent back.
 *
 * Business contact data only (see the schema's header): this module never
 * sees anything about a patient. It reads the whole tab on every call, which
 * is right for a list measured in dozens and wrong for one measured in
 * thousands; when public checkout opens, requests stop being the way in.
 */

export { CHANNEL_IDS, type ChannelId } from "@/lib/setup-channels";

/**
 * A host or URL that looks like a website, as typed minus the scheme and any
 * trailing slash, or null. Shape only: whether the site exists is the site
 * reader's business, not the form's. It lives in the catalog because the
 * purchase checks the same shape in the browser and in apps/app, and a read
 * profile's website must equal the purchase's to ride on it.
 */
export { cleanWebsite } from "@healdesk/catalog";

const STATUSES: readonly SetupRequestStatus[] = ["new", "invited", "paid", "declined"];

/** When the reminder (P5) goes: this long before the link expires. */
export const REMINDER_BEFORE_EXPIRY_MS = 4 * 24 * 60 * 60 * 1000;

type Located = { row: number; value: SetupRequest };

async function store(): Promise<SheetsClient> {
  const client = sheetsClient();
  await ensureSheetSchema(client);
  return client;
}

function decode(cells: readonly Cell[]): SetupRequest {
  const record = rowToRecord(SETUP_REQUESTS, cells) as SetupRequest;
  return { ...record, status: STATUSES.includes(record.status) ? record.status : "new" };
}

async function readAll(client: SheetsClient): Promise<Located[]> {
  const rows = await client.getValues(dataRange(SETUP_REQUESTS));
  const out: Located[] = [];
  rows.forEach((cells, i) => {
    if (cells.every((cell) => cell === "" || cell === undefined)) return;
    const value = decode(cells);
    if (value.id && value.emailNormalized) out.push({ row: i + 2, value });
  });
  return out;
}

export type NewSetupRequest = {
  name: string;
  clinicName: string;
  website: string | null;
  email: string;
  channels: readonly ChannelId[];
  leadId: string | null;
  ipAddress: string | null;
};

export type CreateResult =
  | { ok: true; request: SetupRequest; repeat: boolean }
  | { ok: false; reason: "unconfigured" | "unavailable" };

/**
 * Append a request. `repeat` is true when the same address asked within the
 * last day, which is how the caller decides not to send a second
 * acknowledgement (the abuse rule in Annex X3: once per address per day).
 */
export async function createSetupRequest(input: NewSetupRequest, now: Date = new Date()): Promise<CreateResult> {
  if (!isMarketingStoreConfigured()) return { ok: false, reason: "unconfigured" };
  try {
    const client = await store();
    const emailNormalized = normalizeEmail(input.email);
    const existing = await readAll(client);
    const repeat = existing.some(
      (r) => r.value.emailNormalized === emailNormalized && now.getTime() - r.value.createdAt.getTime() < 24 * 60 * 60 * 1000,
    );
    const request: SetupRequest = {
      id: randomUUID(),
      name: input.name,
      clinicName: input.clinicName,
      website: input.website,
      email: input.email.trim(),
      emailNormalized,
      channels: input.channels.length ? input.channels.join(",") : null,
      leadId: input.leadId,
      status: "new",
      invitedAt: null,
      linkExpiresAt: null,
      openedAt: null,
      remindedAt: null,
      signedAt: null,
      paidAt: null,
      unsubscribedAt: null,
      ipAddress: input.ipAddress,
      createdAt: now,
      updatedAt: now,
    };
    await client.appendRows(SETUP_REQUESTS.title, [recordToRow(SETUP_REQUESTS, request)]);
    if (input.leadId) await recordLeadEvent(input.leadId, "setup_requested");
    return { ok: true, request, repeat };
  } catch (error) {
    console.error("[healdesk] setup request NOT recorded", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "unavailable" };
  }
}

/** The channels a request asked for, as the form's ids; the Sheet keeps them comma-separated. */
export function requestChannels(request: Pick<SetupRequest, "channels">): ChannelId[] {
  return (request.channels ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id): id is ChannelId => (CHANNEL_IDS as readonly string[]).includes(id));
}

export async function findSetupRequest(id: string): Promise<SetupRequest | null> {
  if (!id || !isMarketingStoreConfigured()) return null;
  const client = await store();
  return (await readAll(client)).find((r) => r.value.id === id)?.value ?? null;
}

/** Newest first. */
export async function listSetupRequests(limit = 200): Promise<SetupRequest[]> {
  if (!isMarketingStoreConfigured()) return [];
  const client = await store();
  return (await readAll(client))
    .map((r) => r.value)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export type SetupRequestPatch = Partial<
  Pick<
    SetupRequest,
    | "status"
    | "invitedAt"
    | "linkExpiresAt"
    | "openedAt"
    | "remindedAt"
    | "signedAt"
    | "paidAt"
    | "unsubscribedAt"
  >
>;

/** Merge a patch into one request, by id. Returns the updated request, or null when it is not there. */
export async function updateSetupRequest(
  id: string,
  patch: SetupRequestPatch,
  now: Date = new Date(),
): Promise<SetupRequest | null> {
  if (!isMarketingStoreConfigured()) return null;
  const client = await store();
  const located = (await readAll(client)).find((r) => r.value.id === id);
  if (!located) return null;
  const next: SetupRequest = { ...located.value, ...patch, updatedAt: now };
  await client.updateRange(rowRange(SETUP_REQUESTS, located.row), [recordToRow(SETUP_REQUESTS, next)]);
  return next;
}

/**
 * Every address that has asked for setup. The nurture sequence stops for
 * these: a lead who asked us to set them up is talking to a person now.
 */
export async function setupRequestedEmails(): Promise<Set<string>> {
  if (!isMarketingStoreConfigured()) return new Set();
  const client = await store();
  return new Set((await readAll(client)).map((r) => r.value.emailNormalized));
}

/** Requests whose link is about to expire unused, and that have had no reminder yet. */
export async function setupRequestsDueReminder(now: Date = new Date()): Promise<SetupRequest[]> {
  if (!isMarketingStoreConfigured()) return [];
  const client = await store();
  return (await readAll(client))
    .map((r) => r.value)
    .filter(
      (r) =>
        r.status === "invited" &&
        r.linkExpiresAt !== null &&
        r.remindedAt === null &&
        r.unsubscribedAt === null &&
        r.paidAt === null &&
        now.getTime() >= r.linkExpiresAt.getTime() - REMINDER_BEFORE_EXPIRY_MS &&
        now.getTime() < r.linkExpiresAt.getTime(),
    );
}

/** How far back the past-due check looks. Each request is raised once, ever, on apps/app. */
export const PAST_REPLY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Requests still unanswered after the day P2 promised a reply by
 * ("We'll reply to {email} by {day}", the next business day in New York from
 * when it was made): still `new`, so no setup link was minted and nobody
 * declined it, the whole of that day passed in New York, and the requester
 * has not asked us to stop writing. For the ops alert
 * (app/api/cron/setup-replies), which sends each one's id, business name and
 * promised day (pastReplyAlert); nothing else leaves this module.
 */
export function pastReply(requests: readonly SetupRequest[], now: Date = new Date()): SetupRequest[] {
  return requests.filter(
    (r) =>
      r.status === "new" &&
      r.unsubscribedAt === null &&
      now.getTime() - r.createdAt.getTime() < PAST_REPLY_LOOKBACK_MS &&
      replyByPassed(replyByDay(r.createdAt), now),
  );
}

// <business-name-rule>
// Identical in apps/app lib/ops/alert-wording/allow-list.ts and apps/web
// lib/setup-requests.ts; apps/app's tests/alert-wording.test.ts fails when the
// two copies differ. Change both in one commit.
/** The most of a requester's business name an ops alert prints. */
export const MAX_BUSINESS_NAME = 80;

/**
 * A setup requester's business name as an ops alert may print it, or null
 * (owner, 23 October 2026; lane N1 and its review). Typed by a prospect, so
 * it is refused, and the alert goes without it, when it could reach anyone
 * or trip the email link scanner: seven or more digits in all, in any script
 * (a phone number however spaced); an address, spelled out or not; a link or
 * a bare domain; a slash, backslash, `=`, quote, bracket or angle bracket;
 * `href`, `src` or `url`; a control or invisible formatting character.
 * Otherwise it is cut to 80 characters at a word.
 */
export function cleanBusinessName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let name = value.replace(/\s+/gu, " ").trim();
  if (!name) return null;
  if ((name.match(/\p{Nd}/gu) ?? []).length >= 7) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return null;
  if (/[@/\\=()[\]{}<>"“”`]/u.test(name)) return null;
  if (/\b(?:href|src|url)\b/i.test(name)) return null;
  if (/\w\.\s*[a-z]{2,}/u.test(name)) return null;
  if (/\.\s*(?:com|net|org|io|co|us|ca|uk|ly|me|app|health|clinic|dental|spa|biz|info)\b/i.test(name)) return null;
  if (/\bat\b.*\bdot\b|\bdot\s+(?:com|net|org|io|co|us|ca|uk)\b/i.test(name)) return null;
  if (name.length > MAX_BUSINESS_NAME) {
    const cut = name.slice(0, MAX_BUSINESS_NAME + 1);
    const space = cut.lastIndexOf(" ");
    name = (space > 20 ? cut.slice(0, space) : cut.slice(0, MAX_BUSINESS_NAME)).trim();
  }
  return name || null;
}
// </business-name-rule>

/** The business name the past-due alert sends (cleanBusinessName; apps/app checks it again). */
export function alertBusinessName(value: unknown): string | null {
  return cleanBusinessName(value);
}

/** What the past-due alert carries for one request: its id, the business name when safe, and the promised day. */
export type PastReplyAlert = { id: string; business?: string; promisedOn?: string };

export function pastReplyAlert(request: Pick<SetupRequest, "id" | "clinicName" | "createdAt">): PastReplyAlert {
  const business = alertBusinessName(request.clinicName);
  const promisedOn =
    request.createdAt instanceof Date && !Number.isNaN(request.createdAt.getTime())
      ? replyByDay(request.createdAt)
      : null;
  return { id: request.id, ...(business ? { business } : {}), ...(promisedOn ? { promisedOn } : {}) };
}

/** pastReply over the Sheet's requests. */
export async function setupRequestsPastReply(now: Date = new Date()): Promise<SetupRequest[]> {
  if (!isMarketingStoreConfigured()) return [];
  const client = await store();
  return pastReply((await readAll(client)).map((r) => r.value), now);
}

/**
 * The retention clock the privacy policy states: a request is deleted once it
 * has gone `months` without an update. Paid ones too: the clinic's record is
 * its account in the product, not this row. Returns how many went.
 */
export async function purgeStaleSetupRequests(months: number, now: Date = new Date()): Promise<number> {
  if (!isMarketingStoreConfigured()) return 0;
  const client = await store();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const stale = (await readAll(client)).filter((r) => r.value.updatedAt.getTime() < cutoff.getTime());
  await deleteRows(client, SETUP_REQUESTS, stale.map((r) => r.row));
  return stale.length;
}

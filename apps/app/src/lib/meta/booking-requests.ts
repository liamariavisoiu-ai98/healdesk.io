import { createHash, randomBytes } from "node:crypto";

import { BOOKING_FIELDS, CALLBACK_CONSENT, findClinicalContent, resolveBookingRequirements, type BookingField, type BookingFieldId } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agentConfigs,
  appointments,
  bookingRequests,
  clinics,
  consentRecords,
  contacts,
  metaBookingDrafts,
  outboundCalls,
  reportRecipients,
  type BookedVia,
  type CalendarWriteStatus,
  type OutboundCallPurpose,
  type ProposedSlot,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { slotLabel, slotsFor, writableConnection, writeToCalendar, type CalendarSlot, type CalendarWriteOutcome } from "@/lib/booking/calendar";
import { planRescheduleOutreach, type RescheduleOutreach } from "@/lib/booking/reschedule";
import { callbacksAvailable, scheduleCallback, type ScheduleOutcome } from "@/lib/callbacks/schedule";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { META_WINDOW_MS, sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import type { MetaPlatform } from "./front-door";

/**
 * The booking hand-off, for every channel.
 *
 * Decision of 21 September 2026: no agent — phone, web or Meta — confirms a
 * booking. Each one takes a REQUEST (a name, a number, a preferred day or
 * time and up to two other times that could work, and on the phone the
 * service asked for), hands it to the practice through a single-use link,
 * and tells the person the practice will confirm. The desk has the final say
 * from that page: confirm a slot, which is the moment the appointment row
 * comes into existence; accept with "we'll call back"; propose up to three
 * other times (decision of 23 September 2026, §C); or decline. The only
 * confirmation a patient ever hears comes from a human at the practice, by
 * phone, from the assistant on a callback the person consented to, or as a
 * fixed line on the Meta thread that names no time.
 *
 * Why the exposure is lower this way: an agent that states a time on a
 * channel is making a promise the clinic's calendar may not keep, and on a
 * Meta thread it is also writing an appointment into a platform with no BAA.
 * A request is neither. The appointment row, which the revenue report counts,
 * is created by the desk's click — or, from a `rescheduling` request, by the
 * person choosing one of the times the desk already approved — and nothing
 * else. Where the clinic connected a writable calendar, confirming also
 * writes the appointment into it (lib/booking/calendar.ts), after this
 * module's transaction has committed.
 *
 * ## What is stored, and where
 *
 * `meta_booking_drafts` is the half-collected Meta request keyed by the
 * thread, so the next message can ask for the missing piece without this code
 * remembering any of the conversation. Since 23 September it also holds the
 * two fixed consent questions' state and the person's raw replies to them —
 * the only thread text the product keeps, and it keeps it as consent
 * evidence (§F.2). Overwritten per message, deleted when the request is
 * created, swept after a day. A phone call has no draft: the agent collects
 * everything on the call and the webhook delivers it at once.
 *
 * `booking_requests` is the request. Its contact row is the caller's (voice)
 * or upserted by phone (Meta), so the person the desk rings is one contact
 * either way. The desk's credential is SHA-256(token), never the token — the
 * same discipline, and the same bootstrap RLS policy, as connection_links
 * (drizzle/0024, 0037, 0039). The token is never rotated: every later notice
 * to the desk is linkless and says "open the link from the original email".
 *
 * `consent_records` gains one row per request where the person said yes to
 * the fixed callback question and their own words are on file. A bare "yes"
 * classified by the model with no stored text is not consent (§F.2).
 *
 * ## What never leaves the tenant
 *
 * The email to the desk names the clinic and the channel and carries a link.
 * No name, no number, no window, no service: it may travel over a transport
 * with no BAA behind it (`phiClass: "none"`), and the details are on the page
 * the link opens. The audit rows say a request was made and decided, never
 * for whom, and for a `rescheduling` decision how many slots — never when.
 */

/** How long the desk's link stays good. A weekend plus a slow Monday. */
export const BOOKING_REQUEST_TTL_DAYS = 7;
/** A draft nobody finished in a day is abandoned, and its phone number goes with it. */
export const DRAFT_TTL_HOURS = 24;
/** Proposed alternatives lapse after this, or at the earliest proposed slot, whichever comes first (§A.3). */
export const RESCHEDULE_TTL_HOURS = 72;
export const MAX_ALTERNATIVE_WINDOWS = 2;
export const MAX_PROPOSED_SLOTS = 3;
/** The longest reply kept as consent evidence. */
export const CONSENT_QUOTE_MAX_CHARS = 300;
/** Stored in place of a consent reply that carried clinical content. Never consent. */
export const REDACTED_QUOTE = "redacted";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "booking-link" };
const EXPIRY_ACTOR: ActorContext = { type: "service", serviceName: "booking-expiry" };

export type BookingChannel = "voice" | "meta";
export type BookingThread = { platform: MetaPlatform; externalId: string; senderId: string };

export type BookingFields = {
  firstName: string | null;
  phone: string | null;
  preferredWindow: string | null;
  /** Up to two, cleaned exactly as the primary. Asked for, never required. */
  alternativeWindows: string[];
};

export type CompleteBookingFields = { firstName: string; phone: string; preferredWindow: string; alternativeWindows: string[] };

export const EMPTY_BOOKING_FIELDS: BookingFields = { firstName: null, phone: null, preferredWindow: null, alternativeWindows: [] };

/**
 * What the model extracted, made safe to keep.
 *
 * A first name is letters only and short; a phone must normalise to E.164
 * or it is not a phone; a preferred window is free text but must contain no
 * clinical content, because "Tuesday, for my rosacea" is a diagnosis on a
 * row that exists to be emailed about. An alternative is cleaned the same
 * way; a dirty one, or one that repeats the primary, is dropped silently and
 * never asked for again. A field that fails is simply missing, and the
 * assistant asks again.
 */
export function cleanBookingFields(
  raw: { first_name?: unknown; phone?: unknown; window?: unknown; alternatives?: unknown; alt_windows?: unknown } | null | undefined,
): BookingFields {
  const name = cleanText(raw?.first_name, 40);
  const firstName = name && /^[\p{L}][\p{L}' -]*$/u.test(name) ? name : null;
  const phoneRaw = cleanText(raw?.phone, 32);
  const phone = phoneRaw ? (toE164(phoneRaw) ?? null) : null;
  const window = cleanText(raw?.window, 120);
  const preferredWindow = window && windowIsClean(window) ? window : null;
  const alternativeWindows = cleanAlternatives(raw?.alternatives ?? raw?.alt_windows, preferredWindow ? [preferredWindow] : []);
  return { firstName, phone, preferredWindow, alternativeWindows };
}

function cleanText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

/** Cleaned, deduplicated against `taken` and each other, capped at two. */
export function cleanAlternatives(raw: unknown, taken: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(taken.map(normaliseWindow));
  const out: string[] = [];
  for (const item of raw) {
    const text = cleanText(item, 120);
    if (!text || !windowIsClean(text)) continue;
    const key = normaliseWindow(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_ALTERNATIVE_WINDOWS) break;
  }
  return out;
}

function normaliseWindow(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A preferred window is a day or a time, not a reason. True when nothing clinical slipped in. */
export function windowIsClean(window: string): boolean {
  return findClinicalContent({ window }).length === 0 && !WINDOW_REFUSED.test(window) && !/\d{7,}/.test(window);
}

/**
 * The catalog matcher catches clinical CLAIMS; this catches a condition, a
 * treatment or a "for my …" slipping into the one free-text field a Meta
 * request has. A voice request carries the service in its own column.
 */
const WINDOW_REFUSED =
  /\b(for my|because|due to|acne|rosacea|melasma|eczema|psoriasis|wrinkles?|scars?|pain|anxiety|depress\w*|botox|fillers?|laser|ivf|fertility|surgery|lipo\w*|implants?|hair loss|treatment|consult\w*|procedure|injection|skin|teeth|tooth|dental)\b/i;

/** Complete means the three locked things. Alternatives are asked for, not required. */
export function isComplete(fields: BookingFields): fields is CompleteBookingFields {
  return Boolean(fields.firstName && fields.phone && fields.preferredWindow);
}

/** In the words the catalogue gives the assistant for asking (§H.6). */
export function missingPieces(fields: BookingFields): string[] {
  const ask = (id: BookingFieldId) => BOOKING_FIELDS.find((f) => f.id === id)!.ask;
  const out: string[] = [];
  if (!fields.firstName) out.push(ask("first_name"));
  if (!fields.phone) out.push(ask("phone"));
  if (!fields.preferredWindow) out.push(ask("preferred_window"));
  return out;
}

// -----------------------------------------------------------------------------
// The Meta draft
// -----------------------------------------------------------------------------

export type MetaDraft = BookingFields & {
  consentAskedAt: Date | null;
  callbackConsent: boolean | null;
  callbackConsentQuote: string | null;
  whatsappAskedAt: Date | null;
  whatsappOptin: boolean | null;
  whatsappOptinQuote: string | null;
};

const draftColumns = {
  firstName: metaBookingDrafts.firstName,
  phone: metaBookingDrafts.phone,
  preferredWindow: metaBookingDrafts.preferredWindow,
  alternativeWindows: metaBookingDrafts.alternativeWindows,
  consentAskedAt: metaBookingDrafts.consentAskedAt,
  callbackConsent: metaBookingDrafts.callbackConsent,
  callbackConsentQuote: metaBookingDrafts.callbackConsentQuote,
  whatsappAskedAt: metaBookingDrafts.whatsappAskedAt,
  whatsappOptin: metaBookingDrafts.whatsappOptin,
  whatsappOptinQuote: metaBookingDrafts.whatsappOptinQuote,
};

function threadWhere(clinicId: string, thread: BookingThread) {
  return and(eq(metaBookingDrafts.clinicId, clinicId), eq(metaBookingDrafts.platform, thread.platform), eq(metaBookingDrafts.senderId, thread.senderId));
}

/** The thread's draft as it stands, or null. Stale drafts are swept on the way. */
export async function readMetaDraft(tx: TenantTx, thread: BookingThread): Promise<MetaDraft | null> {
  await tx.db
    .delete(metaBookingDrafts)
    .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), lt(metaBookingDrafts.updatedAt, sql`now() - make_interval(hours => ${DRAFT_TTL_HOURS})`)));
  const [row] = await tx.db.select(draftColumns).from(metaBookingDrafts).where(threadWhere(tx.clinicId, thread)).limit(1);
  return row ?? null;
}

/** Merge what this message added into the thread's draft and return the whole. The consent columns are left as they are. */
export async function mergeDraft(tx: TenantTx, thread: BookingThread, fields: BookingFields): Promise<BookingFields> {
  const existing = await readMetaDraft(tx, thread);
  const preferredWindow = fields.preferredWindow ?? existing?.preferredWindow ?? null;
  const merged: BookingFields = {
    firstName: fields.firstName ?? existing?.firstName ?? null,
    phone: fields.phone ?? existing?.phone ?? null,
    preferredWindow,
    // Existing first, then this message's, deduplicated against the primary and capped.
    alternativeWindows: cleanAlternatives([...(existing?.alternativeWindows ?? []), ...fields.alternativeWindows], preferredWindow ? [preferredWindow] : []),
  };
  await tx.db
    .insert(metaBookingDrafts)
    .values({ clinicId: tx.clinicId, platform: thread.platform, senderId: thread.senderId, externalId: thread.externalId, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [metaBookingDrafts.clinicId, metaBookingDrafts.platform, metaBookingDrafts.senderId],
      set: { ...merged, externalId: thread.externalId, updatedAt: new Date() },
    });
  return merged;
}

/** Record consent-question state on the draft: asked, answered, the raw reply. */
export async function patchMetaDraft(
  tx: TenantTx,
  thread: BookingThread,
  patch: Partial<Pick<MetaDraft, "consentAskedAt" | "callbackConsent" | "callbackConsentQuote" | "whatsappAskedAt" | "whatsappOptin" | "whatsappOptinQuote">>,
): Promise<void> {
  await tx.db.update(metaBookingDrafts).set({ ...patch, updatedAt: new Date() }).where(threadWhere(tx.clinicId, thread));
}

/** The number this thread's newest request holds, when the draft is gone. */
export async function metaThreadPhone(tx: TenantTx, thread: BookingThread): Promise<string | null> {
  const [row] = await tx.db
    .select({ phone: contacts.phone })
    .from(bookingRequests)
    .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), eq(bookingRequests.platform, thread.platform), eq(bookingRequests.senderId, thread.senderId)))
    .orderBy(desc(bookingRequests.createdAt))
    .limit(1);
  return row?.phone ?? null;
}

/**
 * A reply to one of the fixed questions, as evidence: the person's own words,
 * capped, or the literal `redacted` when they carried clinical content. The
 * redaction marker is never consent.
 */
export function consentQuoteOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return findClinicalContent({ text: trimmed }).length ? REDACTED_QUOTE : trimmed.slice(0, CONSENT_QUOTE_MAX_CHARS);
}

/** True when a stored answer counts: yes, in their own words, with nothing redacted. */
export function isUsableConsent<T extends { granted: boolean; quote: string | null }>(answer: T | null | undefined): answer is T & { granted: true; quote: string } {
  return Boolean(answer && answer.granted && answer.quote && answer.quote.trim() && answer.quote !== REDACTED_QUOTE);
}

// -----------------------------------------------------------------------------
// The collected requirement fields (§A.2, §F.9)
// -----------------------------------------------------------------------------

const LOCKED_COLUMN_FIELDS: ReadonlySet<string> = new Set(["first_name", "phone", "preferred_window", "alternative_windows"]);

/**
 * Validate what an agent collected against the practice's requirement set:
 * a catalogue id the practice asked for, at most 120 characters, and nothing
 * clinical. Anything else is dropped and named, never stored. The four locked
 * fields live in their own columns and are refused here so a callback cannot
 * quietly rewrite a frozen number or window.
 */
export function cleanCollectedFields(
  requirements: readonly BookingField[],
  fields: Record<string, unknown> | null | undefined,
): { accepted: Record<string, string>; refused: { field: string; reason: string }[] } {
  const accepted: Record<string, string> = {};
  const refused: { field: string; reason: string }[] = [];
  const allowed = new Set(requirements.map((f) => f.id));
  for (const [key, raw] of Object.entries(fields ?? {})) {
    const field = key.slice(0, 40);
    if (LOCKED_COLUMN_FIELDS.has(field)) {
      refused.push({ field, reason: "locked" });
      continue;
    }
    if (!allowed.has(field as BookingFieldId)) {
      refused.push({ field, reason: "not_required" });
      continue;
    }
    const value = cleanText(raw, 120);
    if (!value) {
      refused.push({ field, reason: "empty" });
      continue;
    }
    if (findClinicalContent({ [field]: value }).length) {
      refused.push({ field, reason: "clinical" });
      continue;
    }
    accepted[field] = value;
  }
  return { accepted, refused };
}

async function clinicRequirements(tx: TenantTx): Promise<BookingField[]> {
  const [clinic] = await tx.db.select({ specialty: clinics.specialty, stored: clinics.bookingRequirements }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  return resolveBookingRequirements(clinic?.specialty ?? "", clinic?.stored ?? null);
}

/**
 * Store what a callback collected (§F.9): validated against the clinic's set,
 * merged into `collected_fields`, each refusal audited as `field_refused`.
 * A `service` lands in `collected_fields.service` because `treatment` is
 * frozen. Nothing is written on a request that is already decided.
 */
export async function recordCollectedFields(tx: TenantTx, requestId: string, fields: Record<string, string>): Promise<void> {
  const [request] = await tx.db
    .select({ status: bookingRequests.status, collected: bookingRequests.collectedFields })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .limit(1);
  const { accepted, refused } = cleanCollectedFields(await clinicRequirements(tx), fields);
  for (const r of refused) {
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "field_refused", field: r.field, reason: r.reason } });
  }
  if (!request) return;
  if (request.status === "confirmed" || request.status === "declined" || request.status === "expired") {
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "rejected", reason: "terminal", fields: Object.keys(accepted) } });
    return;
  }
  if (Object.keys(accepted).length === 0) return;
  await tx.db
    .update(bookingRequests)
    .set({ collectedFields: { ...request.collected, ...accepted } })
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)));
  tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "fields_collected", fields: Object.keys(accepted) } });
}

// -----------------------------------------------------------------------------
// Creation
// -----------------------------------------------------------------------------

export type CreatedBookingRequest = { id: string; token: string; expiresAt: Date; consentRecordId: string | null };

/** An answer to one of the fixed questions: the classifier's verdict and the person's own words. */
export type ConsentAnswer = { granted: boolean; quote: string | null; evidenceUri?: string | null };

export type CreateBookingRequestInput =
  | {
      channel: "meta";
      thread: BookingThread;
      connectionId: string | null;
      fields: CompleteBookingFields;
      /** §D.2 step 4 / §F.2: a consent row is written only for a usable yes. */
      callbackConsent?: ConsentAnswer | null;
      /** §G.2: stamped only for a usable yes, on WhatsApp threads. */
      whatsappOptin?: ConsentAnswer | null;
    }
  | {
      channel: "voice";
      /** The caller, already upserted by the ingest. */
      contactId: string;
      conversationId: string;
      preferredWindow: string;
      treatment: string | null;
      alternativeWindows?: string[];
      /** Validated here against the clinic's requirement set; refusals audited. */
      collectedFields?: Record<string, string>;
      callbackConsent?: ConsentAnswer | null;
    };

/**
 * The request row and the desk's token — returned once, to be put into
 * exactly one email. A Meta request also upserts its contact by phone and
 * deletes its draft, in the same transaction. A usable yes to the callback
 * question becomes a consent row pointing at the request, with the question
 * and the person's own reply as its exact wording.
 */
export async function createBookingRequest(tx: TenantTx, input: CreateBookingRequestInput): Promise<CreatedBookingRequest> {
  const [clinic] = await tx.db
    .select({ name: clinics.name, timezone: clinics.timezone, specialty: clinics.specialty, requirements: clinics.bookingRequirements })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);

  let contactId: string;
  let phone: string | null;
  if (input.channel === "voice") {
    contactId = input.contactId;
    const [contact] = await tx.db.select({ phone: contacts.phone }).from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.clinicId, tx.clinicId))).limit(1);
    phone = contact?.phone ?? null;
  } else {
    phone = input.fields.phone;
    const [existing] = await tx.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.phone, input.fields.phone)))
      .limit(1);
    if (existing) {
      contactId = existing.id;
    } else {
      const [created] = await tx.db
        .insert(contacts)
        .values({ clinicId: tx.clinicId, phone: input.fields.phone, fullName: input.fields.firstName, timezone: clinic?.timezone ?? null, updatedAt: new Date() })
        .returning({ id: contacts.id });
      contactId = created!.id;
    }
  }

  let collectedFields: Record<string, string> = {};
  if (input.channel === "voice" && input.collectedFields) {
    const requirements = resolveBookingRequirements(clinic?.specialty ?? "", clinic?.requirements ?? null);
    const { accepted, refused } = cleanCollectedFields(requirements, input.collectedFields);
    collectedFields = accepted;
    for (const r of refused) {
      tx.audit.record({ action: "create", resourceType: "booking_request", metadata: { outcome: "field_refused", field: r.field, reason: r.reason } });
    }
  }
  const alternativeWindows =
    input.channel === "meta"
      ? cleanAlternatives(input.fields.alternativeWindows, [input.fields.preferredWindow])
      : cleanAlternatives(input.alternativeWindows ?? [], [input.preferredWindow]);
  const whatsapp = input.channel === "meta" && isUsableConsent(input.whatsappOptin) ? input.whatsappOptin : null;

  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  raw.fill(0);
  const now = new Date();
  const [row] = await tx.db
    .insert(bookingRequests)
    .values({
      clinicId: tx.clinicId,
      contactId,
      channel: input.channel,
      conversationId: input.channel === "voice" ? input.conversationId : null,
      platform: input.channel === "meta" ? input.thread.platform : null,
      externalId: input.channel === "meta" ? input.thread.externalId : null,
      senderId: input.channel === "meta" ? input.thread.senderId : null,
      connectionId: input.channel === "meta" ? input.connectionId : null,
      preferredWindow: input.channel === "meta" ? input.fields.preferredWindow : input.preferredWindow,
      alternativeWindows,
      treatment: input.channel === "voice" ? input.treatment : null,
      collectedFields,
      tokenHash: hashToken(token),
      expiresAt: sql`now() + make_interval(days => ${BOOKING_REQUEST_TTL_DAYS})`,
      lastInboundAt: input.channel === "meta" ? now : null,
      whatsappOptinAt: whatsapp ? now : null,
      whatsappOptinQuote: whatsapp ? whatsapp.quote : null,
    })
    .returning({ id: bookingRequests.id, expiresAt: bookingRequests.expiresAt });
  if (!row) throw new Error("Failed to create a booking request: no row returned.");

  if (input.channel === "meta") {
    await tx.db.delete(metaBookingDrafts).where(threadWhere(tx.clinicId, input.thread));
  }

  // The consent row: only a usable yes, and only with a number to hold it for.
  let consentRecordId: string | null = null;
  const consent = input.callbackConsent;
  if (phone && isUsableConsent(consent)) {
    const question = input.channel === "meta" ? CALLBACK_CONSENT.meta.replace("{clinic}", clinic?.name ?? "the practice") : CALLBACK_CONSENT.voice;
    const exactWording = input.channel === "meta" ? `${question} — answered: ${consent.quote}` : `${question} — answered: "${consent.quote}"`;
    const [record] = await tx.db
      .insert(consentRecords)
      .values({
        clinicId: tx.clinicId,
        phone,
        channel: "voice",
        consentType: "express",
        source: input.channel === "meta" ? "meta_thread" : "inbound_call",
        exactWording,
        evidenceUri: consent.evidenceUri ?? null,
        wordingVersion: CALLBACK_CONSENT.version,
        bookingRequestId: row.id,
      })
      .returning({ id: consentRecords.id });
    consentRecordId = record?.id ?? null;
    if (consentRecordId) {
      tx.audit.record({
        action: "create",
        resourceType: "consent_record",
        resourceId: consentRecordId,
        resourceIds: [row.id],
        metadata: { source: input.channel === "meta" ? "meta_thread" : "inbound_call", wordingVersion: CALLBACK_CONSENT.version },
      });
    }
  }

  tx.audit.record({
    action: "create",
    resourceType: "booking_request",
    resourceId: row.id,
    resourceIds: [contactId],
    metadata: {
      channel: input.channel,
      platform: input.channel === "meta" ? input.thread.platform : undefined,
      expiresInDays: BOOKING_REQUEST_TTL_DAYS,
      alternatives: alternativeWindows.length,
      consent: consentRecordId ? true : undefined,
      whatsappOptin: whatsapp ? true : undefined,
    },
  });
  return { id: row.id, token, expiresAt: row.expiresAt, consentRecordId };
}

export const PLATFORM_LABEL: Record<MetaPlatform, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" };

/** "Messenger", "WhatsApp", or "a phone call": for the desk's email and page. */
export function channelLabel(channel: BookingChannel, platform: MetaPlatform | null): string {
  return channel === "voice" ? "a phone call" : platform ? PLATFORM_LABEL[platform] : "a message";
}

export function bookingRequestUrl(token: string): string {
  return `${env.betterAuthUrl().replace(/\/$/, "")}/booking/${token}`;
}

// -----------------------------------------------------------------------------
// Telling the desk
// -----------------------------------------------------------------------------

export type DeskNoticeVariant = "new" | "fyi_direct";

/**
 * Tell the desk. One email per report recipient, carrying the link and
 * nothing about the person; "none" because there is nothing in it a BAA
 * would need to cover. A clinic with no recipient is logged, not failed —
 * the request still exists and the care view shows it waiting.
 *
 * `fyi_direct` (§E.5) is the notice for an appointment the assistant booked
 * itself where the practice elected direct booking: nothing is asked of the
 * desk, and the deposit line is added only when the policy requires one.
 */
export async function notifyDesk(
  tx: TenantTx,
  created: { id: string; token: string },
  via: { channel: BookingChannel; platform: MetaPlatform | null },
  deps: { transport?: EmailTransport; variant?: DeskNoticeVariant } = {},
): Promise<{ status: "sent" | "no-recipients" | "failed"; recipients: number }> {
  const variant = deps.variant ?? "new";
  const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const clinicName = clinic?.name ?? "your practice";
  const recipients = await deskRecipients(tx);
  if (recipients.length === 0) {
    log.warn("booking request has no desk to notify", { clinicId: tx.clinicId, requestId: created.id });
    return { status: "no-recipients", recipients: 0 };
  }
  const transport = deps.transport ?? getTransport("none");
  const url = bookingRequestUrl(created.token);
  const label = channelLabel(via.channel, via.platform);

  let subject: string;
  let paragraphs: string[];
  if (variant === "fyi_direct") {
    const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
    const deposit = agent?.depositPolicy?.required ? " The assistant said a deposit is due and that you will call to collect it." : "";
    subject = `The assistant booked an appointment — ${clinicName}`;
    paragraphs = [
      `Your assistant booked a caller directly into your calendar, as you elected. Open the link to see who and when. Nothing further is needed unless you want to change it, which you do in your calendar.${deposit}`,
      url,
      `The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose.`,
    ];
  } else {
    subject = `New booking request via ${label} — ${clinicName}`;
    paragraphs = [
      `Someone contacted ${clinicName} through ${label} asking to book.`,
      "Open the request to see who, their number and the times they'd like (a first choice and up to two backups), then confirm a time, propose other times, call them back, or decline:",
      url,
      `The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose. Nothing is booked until you confirm it, and the person has only been told that you will call to confirm.`,
    ];
  }
  const text = paragraphs.join("\n\n");
  const html = paragraphs.map((p) => (p === url ? `<p><a href="${url}">${url}</a></p>` : `<p>${escapeHtml(p)}</p>`)).join("");

  const sent = await deliverToDesk(tx, transport, recipients, { subject, text, html }, { clinicName, requestId: created.id });
  if (sent === 0) return { status: "failed", recipients: recipients.length };
  await tx.db.update(bookingRequests).set({ deskNotifiedAt: new Date() }).where(and(eq(bookingRequests.id, created.id), eq(bookingRequests.clinicId, tx.clinicId)));
  tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: created.id, metadata: { outcome: "desk_notified", recipients: sent, variant } });
  return { status: "sent", recipients: sent };
}

export type RenotifyVariant = "collected" | "chose_none" | "confirm_no" | "chose_slot";

const RENOTIFY_BODY: Record<RenotifyVariant, string> = {
  collected:
    "The assistant has spoken to the person and added what you asked for. Open the link from the original email to accept, confirm a time, propose other times, or decline.",
  chose_none:
    "The assistant has spoken to the person: none of the times you proposed work for them. Open the link from the original email to propose other times or decline.",
  confirm_no:
    "The assistant has spoken to the person: they said the confirmed time no longer works — call them; to move it, cancel in your calendar and treat it as a new request.",
  chose_slot:
    "The assistant has spoken to the person and they chose one of the times you proposed. The appointment is recorded; open the link from the original email to see it and whether it reached your calendar.",
};

/**
 * Tell the desk again, after a callback changed something (§F.10). Linkless
 * on purpose: the plain token existed once, at creation, and is never
 * rotated, so the only way back to the page is the original email. Stamps
 * `desk_notified_at`, which sits outside every freeze so a terminal request
 * can still be re-notified.
 */
export async function renotifyDesk(tx: TenantTx, requestId: string, variant: RenotifyVariant, deps: { transport?: EmailTransport } = {}): Promise<void> {
  const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const clinicName = clinic?.name ?? "your practice";
  const recipients = await deskRecipients(tx);
  if (recipients.length === 0) {
    log.warn("booking request update has no desk to notify", { clinicId: tx.clinicId, requestId });
    return;
  }
  const transport = deps.transport ?? getTransport("none");
  const subject = `Booking request updated — ${clinicName}`;
  const body = RENOTIFY_BODY[variant];
  const text = `${body}\n\nThis email carries no patient details on purpose.`;
  const html = `<p>${escapeHtml(body)}</p><p>This email carries no patient details on purpose.</p>`;
  const sent = await deliverToDesk(tx, transport, recipients, { subject, text, html }, { clinicName, requestId });
  if (sent === 0) return;
  await tx.db.update(bookingRequests).set({ deskNotifiedAt: new Date() }).where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)));
  tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "desk_renotified", variant, recipients: sent } });
}

async function deskRecipients(tx: TenantTx): Promise<{ email: string }[]> {
  return tx.db
    .select({ email: reportRecipients.email })
    .from(reportRecipients)
    .where(and(eq(reportRecipients.clinicId, tx.clinicId), sql`${reportRecipients.unsubscribedAt} is null`));
}

async function deliverToDesk(
  tx: TenantTx,
  transport: EmailTransport,
  recipients: { email: string }[],
  message: { subject: string; text: string; html: string },
  about: { clinicName: string; requestId: string },
): Promise<number> {
  let sent = 0;
  for (const r of recipients) {
    try {
      const result = await transport.send({ to: r.email, clinicId: tx.clinicId, clinicName: about.clinicName }, { ...message, phiClass: "none" });
      if (result.status !== "failed") sent += 1;
      else log.error("booking request notice failed", { clinicId: tx.clinicId, requestId: about.requestId, reason: result.reason });
    } catch (error) {
      log.error("booking request notice threw", { clinicId: tx.clinicId, requestId: about.requestId, error: describeError(error) });
    }
  }
  return sent;
}

/** What the person is told once the request exists. Fixed text; a name, never a number or a time. */
export function requestReceivedLine(clinicName: string, firstName: string): string {
  return `Thanks, ${firstName}! I've passed that along to ${clinicName}, and they'll give you a call on the number you gave to settle on a time. If you'd rather not wait, you're always welcome to call the practice directly.`;
}

export type BookingDecision = "accepted" | "declined" | "confirmed" | "rescheduling";

/** What the person is told on a Meta thread after the desk decides. Never a time, never a provider. */
export function followUpLine(clinicName: string, decision: BookingDecision): string {
  switch (decision) {
    case "confirmed":
      return `Good news — ${clinicName} has confirmed your request. They'll call or message you with the details, so keep an eye on your phone.`;
    case "accepted":
      return `Good news — ${clinicName} has accepted your request and will call you to confirm the details. Nothing further is needed from you here.`;
    case "declined":
      return `${clinicName} has looked at your request and can't offer that window, but they'll call you to find a time that works.`;
    case "rescheduling":
      return `${clinicName} can't offer that window but has a couple of alternatives. They'll go through them with you by phone — keep an eye out for a call.`;
  }
}

// -----------------------------------------------------------------------------
// The desk's view
// -----------------------------------------------------------------------------

export type BookingRequestStatus = "requested" | "accepted" | "rescheduling" | "confirmed" | "declined" | "expired";

export type ResolvedBookingRequest = {
  id: string;
  clinicId: string;
  clinicName: string;
  channel: BookingChannel;
  platform: MetaPlatform | null;
  firstName: string | null;
  phone: string | null;
  preferredWindow: string;
  alternativeWindows: string[];
  treatment: string | null;
  collectedFields: Record<string, string>;
  status: BookingRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByLabel: string | null;
  deskNote: string | null;
  confirmedFor: Date | null;
  proposedSlots: ProposedSlot[];
  rescheduleExpiresAt: Date | null;
  bookedVia: BookedVia;
  whatsappOptinAt: Date | null;
  lastInboundAt: Date | null;
  /** Free slots from the writable calendar while the request is open (§B.3); null when there is no writable connection. */
  calendar: { writable: boolean; slots: CalendarSlot[] } | null;
  /** The confirmed appointment's calendar write, for the read-only views. */
  calendarWrite: { status: CalendarWriteStatus; error: string | null } | null;
  /** §B.3/§F.3: the assistant may ring them — both switches on and a usable consent row. Chooses the page's copy. */
  callbackAvailable: boolean;
  /** A callback queued or in flight for this request, if any. */
  pendingCallback: { purpose: OutboundCallPurpose; status: string } | null;
  /** §G.1: whether a Meta line could still reach them; null for a phone request. */
  metaWindowOpen: boolean | null;
};

/**
 * What the holder of the link may see, or null. Expired, unknown and
 * malformed are one null, and the open is recorded either way — a decided
 * request still renders (read-only, with its outcome) so a second click on
 * the same email shows the outcome rather than a dead end.
 */
export async function resolveBookingRequest(token: string, request?: RequestContext): Promise<ResolvedBookingRequest | null> {
  const hash = hashIfWellFormed(token);
  if (!hash) return null;
  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return null;

  return withTenant({ clinicId, actor: LINK_ACTOR, request }, async (tx) => {
    const [row] = await tx.db
      .select({
        id: bookingRequests.id,
        channel: bookingRequests.channel,
        platform: bookingRequests.platform,
        preferredWindow: bookingRequests.preferredWindow,
        alternativeWindows: bookingRequests.alternativeWindows,
        treatment: bookingRequests.treatment,
        collectedFields: bookingRequests.collectedFields,
        status: bookingRequests.status,
        createdAt: bookingRequests.createdAt,
        decidedAt: bookingRequests.decidedAt,
        decidedByLabel: bookingRequests.decidedByLabel,
        deskNote: bookingRequests.deskNote,
        confirmedFor: bookingRequests.confirmedFor,
        proposedSlots: bookingRequests.proposedSlots,
        rescheduleExpiresAt: bookingRequests.rescheduleExpiresAt,
        bookedVia: bookingRequests.bookedVia,
        whatsappOptinAt: bookingRequests.whatsappOptinAt,
        lastInboundAt: bookingRequests.lastInboundAt,
        expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
        clinicName: clinics.name,
        firstName: contacts.fullName,
        phone: contacts.phone,
        calendarWriteStatus: appointments.calendarWriteStatus,
        calendarWriteError: appointments.calendarWriteError,
      })
      .from(bookingRequests)
      .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
      .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
      .leftJoin(appointments, eq(appointments.id, bookingRequests.appointmentId))
      .where(eq(bookingRequests.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expired) {
      tx.audit.record({ action: "read", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "rejected", reason: "expired" } });
      return null;
    }
    tx.audit.record({ action: "read", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "opened", status: row.status } });

    const open = row.status === "requested" || row.status === "accepted" || row.status === "rescheduling";
    let calendar: ResolvedBookingRequest["calendar"] = null;
    if (open && (await writableConnection(tx))) {
      calendar = { writable: true, slots: await slotsFor(tx, 14, { preferred: [row.preferredWindow, ...row.alternativeWindows] }) };
    }
    const [pending] = await tx.db
      .select({ purpose: outboundCalls.purpose, status: outboundCalls.status })
      .from(outboundCalls)
      .where(and(eq(outboundCalls.bookingRequestId, row.id), inArray(outboundCalls.status, ["due", "placing", "placed"])))
      .orderBy(desc(outboundCalls.createdAt))
      .limit(1);

    return {
      id: row.id,
      clinicId,
      clinicName: row.clinicName,
      channel: row.channel,
      platform: row.platform,
      firstName: row.firstName,
      phone: row.phone,
      preferredWindow: row.preferredWindow,
      alternativeWindows: row.alternativeWindows,
      treatment: row.treatment,
      collectedFields: row.collectedFields,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedByLabel: row.decidedByLabel,
      deskNote: row.deskNote,
      confirmedFor: row.confirmedFor,
      proposedSlots: row.proposedSlots,
      rescheduleExpiresAt: row.rescheduleExpiresAt,
      bookedVia: row.bookedVia,
      whatsappOptinAt: row.whatsappOptinAt,
      lastInboundAt: row.lastInboundAt,
      calendar,
      calendarWrite: row.calendarWriteStatus ? { status: row.calendarWriteStatus, error: row.calendarWriteError ?? null } : null,
      callbackAvailable: await callbacksAvailable(tx, row.phone),
      pendingCallback: pending ? { purpose: pending.purpose, status: pending.status } : null,
      metaWindowOpen: row.channel === "meta" ? row.lastInboundAt !== null && row.lastInboundAt.getTime() + META_WINDOW_MS > Date.now() : null,
    };
  });
}

// -----------------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------------

export type DecisionOutcome = {
  outcome: "decided" | "already-decided" | "invalid";
  /** null when the channel has nothing to say on (a phone request: the desk calls). */
  followUp: "sent" | "failed" | "no-channel" | "outside_window" | null;
  appointmentId: string | null;
  /** §B.4: the calendar write's outcome once an appointment was created; null when nothing was confirmed. */
  calendarWrite: CalendarWriteOutcome | null;
  /** §F.3/§F.4: a consented callback queued for this decision, or why not; null when none was attempted. */
  callback: ScheduleOutcome | null;
};

export type DecisionInput = {
  decidedByLabel: string | null;
  deskNote: string | null;
  confirmedFor?: Date | null;
  treatment?: string | null;
  /** §C.1: one to three future times, each from the calendar or typed by the desk. */
  proposedSlots?: { at: Date; source?: "calendar" | "desk" }[];
  request?: RequestContext;
  /** Injectable so tests can pin the clock. */
  now?: Date;
};

type OpenStatus = "requested" | "accepted" | "rescheduling";

/** Which states each decision may be made from (§A.13). A second "rescheduling" is a plain update, not a transition. */
const DECIDABLE_FROM: Record<BookingDecision, OpenStatus[]> = {
  accepted: ["requested"],
  declined: ["requested", "rescheduling"],
  confirmed: ["requested", "accepted", "rescheduling"],
  rescheduling: ["requested", "accepted", "rescheduling"],
};

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** LEAST(expires_at, now + 72h, MIN(slot.at)) — the alternatives lapse before any of them is in the past. */
export function rescheduleDeadline(expiresAt: Date, slots: readonly { at: Date }[], now: Date): Date {
  const candidates = [expiresAt.getTime(), now.getTime() + RESCHEDULE_TTL_HOURS * 3_600_000, ...slots.map((s) => s.at.getTime())];
  return new Date(Math.min(...candidates));
}

/**
 * The desk's answer. One conditional UPDATE decides who wins a double
 * click; the trigger in 0040 makes the decision final, with the permitted
 * second steps (accepted → confirmed, → rescheduling; rescheduling →
 * confirmed, declined). Confirming a slot is the one place in the product
 * an appointment row is created from an agent's conversation: the desk's
 * click, not the agent's word, is the booking. Then, on a Meta thread, the
 * person is told through the clinic's sealed token — the fixed line above,
 * never the desk's note and never the time — and only inside Meta's window.
 *
 * The transaction commits exactly as before; the calendar write (§B.4)
 * happens after it, so a vendor timeout can never roll back the desk's
 * decision, and a re-notify or retry finds the row in the state it was left.
 */
export async function decideBookingRequest(
  token: string,
  decision: BookingDecision,
  input: DecisionInput,
  send?: MetaSender,
): Promise<DecisionOutcome> {
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null, calendarWrite: null, callback: null };
  const now = input.now ?? new Date();
  const hash = hashIfWellFormed(token);
  if (!hash) return none;
  if (decision === "confirmed" && !isValidDate(input.confirmedFor)) return none;
  let proposed: { at: Date; source: "calendar" | "desk" }[] = [];
  if (decision === "rescheduling") {
    const slots = input.proposedSlots ?? [];
    if (slots.length < 1 || slots.length > MAX_PROPOSED_SLOTS) return none;
    if (!slots.every((s) => isValidDate(s.at) && s.at.getTime() > now.getTime())) return none;
    const seen = new Set<number>();
    proposed = slots
      .filter((s) => (seen.has(s.at.getTime()) ? false : (seen.add(s.at.getTime()), true)))
      .map((s) => ({ at: s.at, source: s.source ?? "desk" }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }
  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return none;

  const decided = await withTenant({ clinicId, actor: LINK_ACTOR, request: input.request }, async (tx): Promise<DecisionOutcome> => {
    const from = DECIDABLE_FROM[decision];
    const [candidate] = await tx.db
      .select({
        id: bookingRequests.id,
        status: bookingRequests.status,
        contactId: bookingRequests.contactId,
        conversationId: bookingRequests.conversationId,
        treatment: bookingRequests.treatment,
        collectedFields: bookingRequests.collectedFields,
        expiresAt: bookingRequests.expiresAt,
        expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
        phone: contacts.phone,
        timezone: clinics.timezone,
        clinicName: clinics.name,
      })
      .from(bookingRequests)
      .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
      .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
      .where(eq(bookingRequests.tokenHash, hash))
      .limit(1);
    const decidable = candidate && !candidate.expired && (from as string[]).includes(candidate.status);
    if (!decidable) {
      const outcome = candidate && !candidate.expired ? "already-decided" : "invalid";
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate?.id, metadata: { outcome: "rejected", reason: outcome, decision } });
      return { ...none, outcome };
    }

    // Confirming creates the appointment FIRST, so the status and the
    // appointment id land in one statement: the table's shape check says a
    // confirmed row always has both, and a check is judged per statement.
    let appointmentId: string | null = null;
    if (decision === "confirmed") {
      appointmentId = await insertAppointment(tx, {
        contactId: candidate.contactId,
        conversationId: candidate.conversationId,
        scheduledFor: input.confirmedFor!,
        treatment: input.treatment?.trim().slice(0, 120) || candidate.treatment || candidate.collectedFields.service || null,
      });
    }

    const slots: ProposedSlot[] = proposed.map((s) => ({ at: s.at.toISOString(), label: slotLabel(s.at, candidate.timezone), source: s.source }));

    // One conditional UPDATE decides who wins a double click.
    const [row] = await tx.db
      .update(bookingRequests)
      .set({
        status: decision,
        decidedAt: now,
        decidedByLabel: input.decidedByLabel?.trim().slice(0, 80) || null,
        deskNote: input.deskNote?.trim().slice(0, 500) || null,
        ...(decision === "confirmed" ? { confirmedFor: input.confirmedFor!, appointmentId } : {}),
        ...(decision === "rescheduling" ? { proposedSlots: slots, rescheduleExpiresAt: rescheduleDeadline(candidate.expiresAt, proposed, now) } : {}),
      })
      .where(and(eq(bookingRequests.id, candidate.id), inArray(bookingRequests.status, from), gt(bookingRequests.expiresAt, sql`now()`)))
      .returning({
        id: bookingRequests.id,
        channel: bookingRequests.channel,
        platform: bookingRequests.platform,
        externalId: bookingRequests.externalId,
        senderId: bookingRequests.senderId,
        connectionId: bookingRequests.connectionId,
      });
    if (!row) {
      // Lost the race to a colleague's click between the read and the write.
      if (appointmentId) await tx.db.delete(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)));
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate.id, metadata: { outcome: "rejected", reason: "already-decided", decision } });
      return { ...none, outcome: "already-decided" };
    }
    if (appointmentId) {
      tx.audit.record({
        action: "create",
        resourceType: "appointment",
        resourceId: appointmentId,
        metadata: { conversationId: candidate.conversationId ?? undefined, bookingRequestId: row.id, confirmedByDesk: true, confirmedByClinicSystem: false },
      });
    }
    tx.audit.record({
      action: "update",
      resourceType: "booking_request",
      resourceId: row.id,
      metadata: { outcome: "decided", decision, channel: row.channel, slots: decision === "rescheduling" ? slots.length : undefined },
    });

    // §C.2: the alternatives are carried by a consented callback, or the desk calls.
    if (decision === "rescheduling") {
      const outreach: RescheduleOutreach = await planRescheduleOutreach(tx, row, { send, now });
      return { outcome: "decided", followUp: outreach.meta, appointmentId: null, calendarWrite: null, callback: outreach.callback };
    }

    // §F.3: a confirmed time is read back to the person by the assistant, with their permission.
    let callback: ScheduleOutcome | null = null;
    if (decision === "confirmed" && (await callbacksAvailable(tx, candidate.phone))) {
      callback = await scheduleCallback(tx, row.id, "confirm_time", { now });
    }

    if (row.channel !== "meta") return { outcome: "decided", followUp: null, appointmentId, calendarWrite: null, callback };
    if (!row.connectionId || !row.platform || !row.externalId || !row.senderId) return { outcome: "decided", followUp: "no-channel", appointmentId, calendarWrite: null, callback };
    const owner: MetaChannelOwner = { clinicId: tx.clinicId, connectionId: row.connectionId, platform: row.platform, enabled: true };
    try {
      const sent = await sendMetaReply(tx, owner, row.externalId, row.senderId, followUpLine(candidate.clinicName, decision), send, { now });
      if (sent.status !== "sent") return { outcome: "decided", followUp: "outside_window", appointmentId, calendarWrite: null, callback };
      tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: row.platform, source: "booking_follow_up" } });
      return { outcome: "decided", followUp: "sent", appointmentId, calendarWrite: null, callback };
    } catch (error) {
      log.error("booking follow-up not sent", { clinicId: tx.clinicId, requestId: row.id, error: describeError(error) });
      return { outcome: "decided", followUp: "failed", appointmentId, calendarWrite: null, callback };
    }
  });

  // §B.4: after the commit, and never inside it.
  if (decided.outcome === "decided" && decided.appointmentId) {
    return { ...decided, calendarWrite: await writeToCalendar(clinicId, decided.appointmentId, { now }) };
  }
  return decided;
}

/**
 * The person chose one of the desk's proposed times (§C.3), on a callback or
 * on the desk's own phone call. Because the desk pre-approved these slots,
 * choosing one confirms: `rescheduling → confirmed`, an appointment row, the
 * calendar write, and the desk told — linkless — that it is done. An `at`
 * that is not one of `proposed_slots` is refused outright: the assistant
 * cannot invent a time.
 *
 * `booked_via` is frozen at insert by the 0040 trigger and absent from the
 * runtime grant, so the provenance of the choice is recorded in the decision
 * label and the audit row rather than on the column.
 */
export async function confirmProposedSlot(
  clinicId: string,
  requestId: string,
  at: Date,
  opts: { bookedVia: "callback" | "desk"; decidedByLabel: string; actor?: ActorContext; request?: RequestContext; transport?: EmailTransport; now?: Date },
): Promise<DecisionOutcome> {
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null, calendarWrite: null, callback: null };
  if (!isValidDate(at)) return none;
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? LINK_ACTOR;

  const decided = await withTenant({ clinicId, actor, request: opts.request }, async (tx): Promise<DecisionOutcome> => {
    const [candidate] = await tx.db
      .select({
        id: bookingRequests.id,
        status: bookingRequests.status,
        contactId: bookingRequests.contactId,
        conversationId: bookingRequests.conversationId,
        treatment: bookingRequests.treatment,
        collectedFields: bookingRequests.collectedFields,
        proposedSlots: bookingRequests.proposedSlots,
        expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
      })
      .from(bookingRequests)
      .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)))
      .limit(1);
    if (!candidate || candidate.expired) {
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "rejected", reason: "invalid", decision: "choose_slot" } });
      return none;
    }
    if (candidate.status !== "rescheduling") {
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "rejected", reason: "already-decided", decision: "choose_slot" } });
      return { ...none, outcome: "already-decided" };
    }
    const chosen = candidate.proposedSlots.find((s) => Date.parse(s.at) === at.getTime());
    if (!chosen) {
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "rejected", reason: "slot_not_proposed", decision: "choose_slot" } });
      return none;
    }

    const appointmentId = await insertAppointment(tx, {
      contactId: candidate.contactId,
      conversationId: candidate.conversationId,
      scheduledFor: at,
      treatment: candidate.treatment ?? candidate.collectedFields.service ?? null,
    });
    const [row] = await tx.db
      .update(bookingRequests)
      .set({ status: "confirmed", decidedAt: now, decidedByLabel: opts.decidedByLabel.trim().slice(0, 80) || null, confirmedFor: at, appointmentId })
      .where(and(eq(bookingRequests.id, candidate.id), eq(bookingRequests.status, "rescheduling"), gt(bookingRequests.expiresAt, sql`now()`)))
      .returning({ id: bookingRequests.id });
    if (!row) {
      await tx.db.delete(appointments).where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)));
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate.id, metadata: { outcome: "rejected", reason: "already-decided", decision: "choose_slot" } });
      return { ...none, outcome: "already-decided" };
    }
    tx.audit.record({
      action: "create",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { conversationId: candidate.conversationId ?? undefined, bookingRequestId: row.id, confirmedByDesk: false, chosenByPerson: true, via: opts.bookedVia, confirmedByClinicSystem: false },
    });
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "decided", decision: "confirmed", via: opts.bookedVia, slotSource: chosen.source } });
    return { outcome: "decided", followUp: null, appointmentId, calendarWrite: null, callback: null };
  });
  if (decided.outcome !== "decided" || !decided.appointmentId) return decided;

  const calendarWrite = await writeToCalendar(clinicId, decided.appointmentId, { actor, now });
  await withTenant({ clinicId, actor, request: opts.request }, (tx) => renotifyDesk(tx, requestId, "chose_slot", { transport: opts.transport }));
  return { ...decided, calendarWrite };
}

async function insertAppointment(
  tx: TenantTx,
  input: { contactId: string; conversationId: string | null; scheduledFor: Date; treatment: string | null },
): Promise<string> {
  // The agent's script carries the clinic's deposit rule; with no payment
  // link path, a required deposit is owed to the front desk.
  const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
  const depositPolicy = agent?.depositPolicy ?? null;
  const [appointment] = await tx.db
    .insert(appointments)
    .values({
      clinicId: tx.clinicId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      scheduledFor: input.scheduledFor,
      treatment: input.treatment,
      depositUsd: depositPolicy?.required && depositPolicy.amountUsd !== null ? String(depositPolicy.amountUsd) : null,
      depositStatus: depositPolicy?.required ? "pending_front_desk" : "none",
      // The desk confirmed it; the clinic's own system has not reported it
      // back to us, and may never. See schema.ts.
      externalConfirmedAt: null,
    })
    .returning({ id: appointments.id });
  return appointment!.id;
}

// -----------------------------------------------------------------------------
// Expiry (§C.4)
// -----------------------------------------------------------------------------

/**
 * Lapse what has lapsed, every clinic: a `rescheduling` request past its
 * reschedule deadline and an open request past its link's expiry become
 * `expired`, and every callback still `due` for a request that is now
 * terminal is cancelled with `request_expired` — except the informational
 * `confirm_time` call on a confirmed request, which §F.4 permits. The
 * callback-dialer job calls this; it never dials.
 */
export async function expireLapsedRequests(now: Date): Promise<{ expired: number; cancelledCalls: number }> {
  let expired = 0;
  let cancelledCalls = 0;
  for (const clinic of await listClinics()) {
    const result = await withTenant({ clinicId: clinic.id, actor: EXPIRY_ACTOR }, async (tx) => {
      const lapsed = await tx.db
        .update(bookingRequests)
        .set({ status: "expired", decidedAt: now })
        .where(
          and(
            eq(bookingRequests.clinicId, tx.clinicId),
            sql`((${bookingRequests.status} = 'rescheduling' and ${bookingRequests.rescheduleExpiresAt} < ${now})
                 or (${bookingRequests.status} in ('requested', 'accepted') and ${bookingRequests.expiresAt} < ${now}))`,
          ),
        )
        .returning({ id: bookingRequests.id, wasRescheduling: sql<boolean>`${bookingRequests.rescheduleExpiresAt} is not null` });
      for (const r of lapsed) {
        tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: r.id, metadata: { outcome: "decided", decision: "expired", reason: r.wasRescheduling ? "alternatives_lapsed" : "link_expired" } });
      }
      const cancelled = await tx.db
        .update(outboundCalls)
        .set({ status: "cancelled", refusalCode: "request_expired" })
        .where(
          and(
            eq(outboundCalls.clinicId, tx.clinicId),
            eq(outboundCalls.status, "due"),
            sql`exists (select 1 from ${bookingRequests} r where r.id = ${outboundCalls.bookingRequestId}
                        and r.status in ('confirmed', 'declined', 'expired')
                        and not (r.status = 'confirmed' and ${outboundCalls.purpose} = 'confirm_time'))`,
          ),
        )
        .returning({ id: outboundCalls.id });
      if (cancelled.length) {
        tx.audit.record({ action: "update", resourceType: "outbound_call", resourceIds: cancelled.map((c) => c.id), metadata: { outcome: "cancelled", reason: "request_expired" } });
      }
      return { expired: lapsed.length, cancelled: cancelled.length };
    });
    expired += result.expired;
    cancelledCalls += result.cancelled;
  }
  return { expired, cancelledCalls };
}

/** Counts only, for the care view. A `rescheduling` request is one the desk has answered, so it counts with `accepted`. */
export async function bookingRequestCounts(tx: TenantTx): Promise<{ waiting: number; accepted: number; confirmed: number; declined: number }> {
  const rows = await tx.db
    .select({ status: bookingRequests.status, n: sql<number>`count(*)::int` })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), gt(bookingRequests.expiresAt, sql`now() - interval '30 days'`)))
    .groupBy(bookingRequests.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<string, number>>;
  return { waiting: by.requested ?? 0, accepted: (by.accepted ?? 0) + (by.rescheduling ?? 0), confirmed: by.confirmed ?? 0, declined: by.declined ?? 0 };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function hashIfWellFormed(token: unknown): Buffer | null {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return hashToken(token);
}

async function clinicForTokenHash(hash: Buffer): Promise<string | null> {
  const result = await unsafeDb.execute<{ clinic_id: string | null }>(sql`select app_booking_request_clinic(${hash}::bytea) as clinic_id`);
  return result.rows[0]?.clinic_id ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export type { ProposedSlot } from "@/db/schema";

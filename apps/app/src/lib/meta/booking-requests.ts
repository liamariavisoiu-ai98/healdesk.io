import { createHash, randomBytes } from "node:crypto";

import { BOOKING_FIELDS, findClinicalContent, resolveBookingRequirements, type BookingField, type BookingFieldId } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agentConfigs,
  appointments,
  bookingRequests,
  clinics,
  contacts,
  metaBookingDrafts,
  reportRecipients,
  type BookedVia,
  type CalendarWriteStatus,
  type ProposedSlot,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { slotLabel, slotsFor, writableConnection, writeToCalendar, type CalendarSlot, type CalendarWriteOutcome } from "@/lib/booking/calendar";
import { planRescheduleOutreach, type RescheduleOutreach } from "@/lib/booking/reschedule";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { META_WINDOW_MS, sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import type { MetaPlatform } from "./front-door";

/**
 * The booking hand-off: the manual booking path, for the phone and the Meta
 * front door.
 *
 * In v1 (docs/v1-product-spec.md, "Booking behaviour and deposit control")
 * the assistant books straight into the clinic's Google Calendar during the
 * conversation, with "Auto-confirm bookings" on by default. A REQUEST is what
 * it takes instead when it cannot or may not book: the clinic runs manual
 * booking mode (Mindbody, Boulevard), has Auto-confirm off, or its calendar
 * connection is broken. Until the Google Calendar adapter exists (launch plan
 * steps 1.5 and 1.7) every booking is a request.
 *
 * A request is a name, a number, a preferred day or time and up to two other
 * times that could work, and on the phone the service asked for. It reaches
 * the practice through a single-use link, and the person is told the
 * practice will confirm. The desk has the final say from that page: confirm
 * a slot, which is the moment the appointment row comes into existence;
 * accept and call them; propose up to three other times (decision of
 * 23 September 2026, §C) and go through them by phone; or decline. healdesk
 * itself contacts no one about a request: the confirmation a person hears
 * comes from a human at the practice, by phone, or as a fixed line on the
 * Meta thread that names no time, sent only inside Meta's 24-hour window.
 *
 * Why the exposure is lower this way: an agent that states a time on a
 * channel is making a promise the clinic's calendar may not keep, and on a
 * Meta thread it is also writing an appointment into a platform with no BAA.
 * A request is neither. The appointment row is created by the desk's click
 * and nothing else. Where the clinic connected a writable calendar,
 * confirming also writes the appointment into it (lib/booking/calendar.ts),
 * after this module's transaction has committed; v1 has no writable adapter
 * yet, so today the appointment is recorded here only.
 *
 * ## What is stored, and where
 *
 * `meta_booking_drafts` is the half-collected Meta request keyed by the
 * thread, so the next message can ask for the missing piece without this code
 * remembering any of the conversation. Overwritten per message, deleted when
 * the request is created, swept after a day. A phone call has no draft: the
 * agent collects everything on the call and the webhook delivers it at once.
 *
 * `booking_requests` is the request. Its contact row is the caller's (voice)
 * or upserted by phone (Meta), so the person the desk rings is one contact
 * either way. The desk's credential is SHA-256(token), never the token — the
 * same discipline, and the same bootstrap RLS policy, as connection_links
 * (drizzle/0024, 0037, 0039). The token is never rotated.
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

export type MetaDraft = BookingFields;

const draftColumns = {
  firstName: metaBookingDrafts.firstName,
  phone: metaBookingDrafts.phone,
  preferredWindow: metaBookingDrafts.preferredWindow,
  alternativeWindows: metaBookingDrafts.alternativeWindows,
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

/** Merge what this message added into the thread's draft and return the whole. */
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

// -----------------------------------------------------------------------------
// The collected requirement fields (§A.2)
// -----------------------------------------------------------------------------

const LOCKED_COLUMN_FIELDS: ReadonlySet<string> = new Set(["first_name", "phone", "preferred_window", "alternative_windows"]);

/**
 * Validate what an agent collected against the practice's requirement set:
 * a catalogue id the practice asked for, at most 120 characters, and nothing
 * clinical. Anything else is dropped and named, never stored. The four locked
 * fields live in their own columns and are refused here so nothing collected
 * later can quietly rewrite a frozen number or window.
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

// -----------------------------------------------------------------------------
// Creation
// -----------------------------------------------------------------------------

export type CreatedBookingRequest = { id: string; token: string; expiresAt: Date };

export type CreateBookingRequestInput =
  | {
      channel: "meta";
      thread: BookingThread;
      connectionId: string | null;
      fields: CompleteBookingFields;
      /** When the person's last message was sent: the start of Meta's 24-hour window. Defaults to now. */
      lastInboundAt?: Date;
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
    };

/**
 * The request row and the desk's token — returned once, to be put into
 * exactly one email. A Meta request also upserts its contact by phone and
 * deletes its draft, in the same transaction. No consent of any kind is
 * asked for or recorded: healdesk contacts no one about a request.
 */
export async function createBookingRequest(tx: TenantTx, input: CreateBookingRequestInput): Promise<CreatedBookingRequest> {
  const [clinic] = await tx.db
    .select({ name: clinics.name, timezone: clinics.timezone, specialty: clinics.specialty, requirements: clinics.bookingRequirements })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);

  let contactId: string;
  if (input.channel === "voice") {
    contactId = input.contactId;
  } else {
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
      lastInboundAt: input.channel === "meta" ? (input.lastInboundAt ?? now) : null,
    })
    .returning({ id: bookingRequests.id, expiresAt: bookingRequests.expiresAt });
  if (!row) throw new Error("Failed to create a booking request: no row returned.");

  if (input.channel === "meta") {
    await tx.db.delete(metaBookingDrafts).where(threadWhere(tx.clinicId, input.thread));
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
    },
  });
  return { id: row.id, token, expiresAt: row.expiresAt };
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
  lastInboundAt: Date | null;
  /** Free slots from the writable calendar while the request is open (§B.3); null when there is no writable connection. */
  calendar: { writable: boolean; slots: CalendarSlot[] } | null;
  /** The confirmed appointment's calendar write, for the read-only views. */
  calendarWrite: { status: CalendarWriteStatus; error: string | null } | null;
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
      lastInboundAt: row.lastInboundAt,
      calendar,
      calendarWrite: row.calendarWriteStatus ? { status: row.calendarWriteStatus, error: row.calendarWriteError ?? null } : null,
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
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null, calendarWrite: null };
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
        timezone: clinics.timezone,
        clinicName: clinics.name,
      })
      .from(bookingRequests)
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

    // §C.2: the desk goes through the alternatives by phone; on a Meta
    // thread, a fixed line says so, inside the window only.
    if (decision === "rescheduling") {
      const outreach: RescheduleOutreach = await planRescheduleOutreach(tx, row, { send, now });
      return { outcome: "decided", followUp: outreach.meta, appointmentId: null, calendarWrite: null };
    }

    if (row.channel !== "meta") return { outcome: "decided", followUp: null, appointmentId, calendarWrite: null };
    if (!row.connectionId || !row.platform || !row.externalId || !row.senderId) return { outcome: "decided", followUp: "no-channel", appointmentId, calendarWrite: null };
    const owner: MetaChannelOwner = { clinicId: tx.clinicId, connectionId: row.connectionId, platform: row.platform, enabled: true };
    try {
      // Outside Meta's 24-hour window sendMetaReply sends nothing: v1 has no
      // message tag and no template, so the desk calls instead.
      const sent = await sendMetaReply(tx, owner, row.externalId, row.senderId, followUpLine(candidate.clinicName, decision), send, { now });
      if (sent.status !== "sent") return { outcome: "decided", followUp: "outside_window", appointmentId, calendarWrite: null };
      tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: row.platform, source: "booking_follow_up" } });
      return { outcome: "decided", followUp: "sent", appointmentId, calendarWrite: null };
    } catch (error) {
      log.error("booking follow-up not sent", { clinicId: tx.clinicId, requestId: row.id, error: describeError(error) });
      return { outcome: "decided", followUp: "failed", appointmentId, calendarWrite: null };
    }
  });

  // §B.4: after the commit, and never inside it.
  if (decided.outcome === "decided" && decided.appointmentId) {
    return { ...decided, calendarWrite: await writeToCalendar(clinicId, decided.appointmentId, { now }) };
  }
  return decided;
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
 * `expired`. A pure function of the clock over rows that already exist; the
 * hourly tick runs it (lib/scheduler/tick.ts).
 */
export async function expireLapsedRequests(now: Date): Promise<{ expired: number }> {
  let expired = 0;
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
      return lapsed.length;
    });
    expired += result;
  }
  return { expired };
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

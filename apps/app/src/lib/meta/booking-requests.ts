import { createHash, randomBytes } from "node:crypto";

import { audienceFor, BOOKING_FIELDS, cleanBookingFieldValue, findClinicalContent, namesMetaTreatment, resolveBookingRequirements, type Audience, type BookingField, type BookingFieldId } from "@healdesk/catalog";
import { GOOGLE_CALENDAR_PROVIDER, googleCalendarAdapter, toE164 } from "@healdesk/connectors";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agentConfigs,
  appointments,
  bookingRequests,
  clinics,
  contacts,
  metaBookingDrafts,
  reportRecipients,
  slotHolds,
  type AgentService,
  type BookedVia,
  type BookingOrigin,
  type CalendarWriteStatus,
  type ProposedSlot,
  type SlotHoldStatus,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { recordDepositOutcome, type DepositOutcome } from "@/lib/billing/deposits";
import { availableSlotsFor, deskSpanFree, openContext, serviceDuration } from "@/lib/booking/availability";
import { arrangeSlots, namedWeekdays, slotLabel, writableConnection, writeToCalendar, type CalendarSlot, type CalendarWriteOutcome } from "@/lib/booking/calendar";
import { bookedDepositOutcome, depositGateFor } from "@/lib/booking/deposit-gate";
import { ANSWERED_AS_REQUEST, lockClinicCalendar } from "@/lib/booking/holds";
import { calendarTermsFor } from "@/lib/booking/terms";
import { calendarBreakOf, googleCalendarConnection, isTokenBreak, markCalendarBroken } from "@/lib/connections/google-calendar";
import { planRescheduleOutreach, type RescheduleOutreach } from "@/lib/booking/reschedule";
import { PublicUrlError, publicUrl } from "@/lib/public-url";
import { describeError, log } from "@/lib/log";
import { listedPrice } from "@/lib/setup/prices";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { listClinics } from "@/lib/ops/clinics";
import { amendmentsFor } from "@/lib/patient-rights/amendments";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { META_WINDOW_MS, resolveFollowUpOwner, sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import { isTimeWindow } from "./time-window";
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
 * times that could work, and on the phone the service asked for. The person
 * is told the practice will confirm, and staff decide it on the portal's
 * Bookings screen (/c/<slug>/bookings), signed in and behind a passkey
 * step-up, as the spec requires before any booking opens: confirm a slot,
 * which is the moment the appointment row comes into existence; propose up
 * to three other times (decision of 23 September 2026, §C) and go through
 * them by phone; or decline. `decideBookingRequest` is keyed by the clinic
 * and the request's id, and its actor is the sign-in and the device whose
 * passkey stepped up. healdesk itself contacts no one about a request: the
 * confirmation a person hears comes from a human at the practice, by phone,
 * or as a fixed line on the Meta thread that names no time, sent only inside
 * Meta's 24-hour window.
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
 * either way. Each request has a token, stored as SHA-256(token) and never
 * as itself (drizzle/0024, 0037, 0039), for the link the desk's email
 * carries. Since M5 that link is a pointer and nothing more: /booking/<token>
 * shows no patient field and takes no decision, and sends the browser
 * through sign-in and the step-up to the request on Bookings
 * (`resolveBookingPointer`).
 *
 * ## What never leaves the tenant
 *
 * The email to the desk names the clinic and the channel and carries a link.
 * No name, no number, no window, no service: it may travel over a transport
 * with no BAA behind it (`phiClass: "none"`), and the details are on the
 * Bookings screen behind the passkey. The audit rows say a request was made
 * and decided, and by which sign-in and passkey, never for whom, and for a
 * `rescheduling` decision how many slots — never when.
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

/** The emailed link, which only points: it reads a request's id and its clinic's slug. */
const POINTER_ACTOR: ActorContext = { type: "service", serviceName: "booking-link" };
const EXPIRY_ACTOR: ActorContext = { type: "service", serviceName: "booking-expiry" };

/**
 * Who decides a request: the clinic's sign-in, by the device whose passkey
 * step-up is live (lib/portal/patient-page.ts). Every transaction of the
 * decision runs as that user with the device's name as its label, and the
 * decision's own audit rows carry the passkey's and the step-up's ids.
 */
export type DeskActor = { userId: string; passkeyId: string; stepUpId: string; deviceLabel: string };

function deskActorContext(desk: DeskActor): ActorContext {
  return { type: "user", userId: desk.userId, label: desk.deviceLabel };
}

/** The passkey behind a decision, for its audit rows: ids only. */
function stepUpOf(desk: DeskActor): { passkeyId: string; stepUpId: string } {
  return { passkeyId: desk.passkeyId, stepUpId: desk.stepUpId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BookingChannel = "voice" | "meta" | "web_chat";
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
 * How a Meta request's name and every window are screened, wherever they are
 * cleaned: for the everyday skin and hair conditions as well (windowIsClean).
 */
const META_SCREEN = { conditions: true } as const;

/**
 * A Meta window's screen: META_SCREEN, and the closed time grammar
 * (lib/meta/time-window.ts), so a window keeps nothing but a time.
 */
const META_WINDOW = { ...META_SCREEN, timeGrammar: true } as const;

/**
 * What the model extracted, made safe to keep.
 *
 * A first name is letters only and short; a phone must normalise to E.164
 * or it is not a phone; a preferred window is free text but must contain no
 * clinical content, because "Tuesday, for my rosacea" is a diagnosis on a
 * row that exists to be emailed about. An alternative is cleaned the same
 * way; a dirty one, or one that repeats the primary, is dropped silently and
 * never asked for again. A field that fails is simply missing, and the
 * assistant asks again. Only a Meta thread is cleaned here, so the name and
 * the windows are screened as Meta's (META_SCREEN): letters and spaces are
 * enough to spell "Maria with acne".
 */
export function cleanBookingFields(
  raw: { first_name?: unknown; phone?: unknown; window?: unknown; alternatives?: unknown; alt_windows?: unknown } | null | undefined,
): BookingFields {
  const firstName = cleanFirstName(raw?.first_name);
  const phoneRaw = cleanText(raw?.phone, 32);
  const phone = phoneRaw ? (toE164(phoneRaw) ?? null) : null;
  const window = cleanText(raw?.window, 120);
  const preferredWindow = window && windowIsClean(window, META_WINDOW) ? window : null;
  const alternativeWindows = cleanAlternatives(raw?.alternatives ?? raw?.alt_windows, preferredWindow ? [preferredWindow] : [], META_WINDOW);
  return { firstName, phone, preferredWindow, alternativeWindows };
}

/** Words that join a name to something else: "Maria with diabetes", "Sue has HIV". */
const NAME_JOINERS = /\b(with|has|have|had|and|or|from|for|the|my|is|am|who|was)\b/i;

/** A word about a person's health that a name never is: "Cancer Patient", "Diabetic Jane", "Maria pregnant". */
const NAME_HEALTH =
  /\b(patients?|diabet\w*|pregnan\w*|cancer|hiv|aids|chemo\w*|biops\w*|tumou?rs?|herpes|hepatitis|covid|sick|ill|disabled|std|sti|injur\w*|allerg\w*|asthma\w*|epilep\w*|dementia|autis\w*)\b/i;

/**
 * A first name, made safe to keep and to say back (the C19 re-audit's B1):
 * one or two words of letters, apostrophes and hyphens ("Maria", "Maria
 * Lopez", "Mary-Jane", "O'Brien", "José"); never joined to anything else
 * ("Maria with diabetes"); and never a word about health or treatment,
 * whether the catalogue's clinical and condition screens, the treatment
 * vocabulary or the window's refused words catch it ("Sue HIV", "Cancer
 * Patient", "Diabetic Jane", "Maria semaglutide", "Botox"). Anything else is
 * dropped, and the name is asked for again.
 */
export function cleanFirstName(raw: unknown): string | null {
  const name = cleanText(raw, 40);
  if (!name || !/^[\p{L}][\p{L}'’-]*(?: [\p{L}][\p{L}'’-]*)?$/u.test(name)) return null;
  if (NAME_JOINERS.test(name) || NAME_HEALTH.test(name) || WINDOW_REFUSED.test(name)) return null;
  if (findClinicalContent({ name }, META_SCREEN).length > 0 || namesMetaTreatment(name)) return null;
  return name;
}

function cleanText(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

/** Cleaned, deduplicated against `taken` and each other, capped at two. `options` as windowIsClean's. */
export function cleanAlternatives(raw: unknown, taken: readonly string[], options: WindowScreen = {}): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(taken.map(normaliseWindow));
  const out: string[] = [];
  for (const item of raw) {
    const text = cleanText(item, 120);
    if (!text || !windowIsClean(text, options)) continue;
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

/** How a window is screened: Meta's conditions, and Meta's closed time grammar. */
export type WindowScreen = { conditions?: boolean; timeGrammar?: boolean };

/**
 * A preferred window is a day or a time, not a reason. True when nothing clinical slipped in.
 *
 * `conditions` is a Meta request's rule (META_SCREEN): the catalog's
 * everyday skin and hair conditions are refused as well, because Meta signs
 * no BAA and its channels are scoped to carry nothing clinical, by filters
 * that are designed to keep it out and cannot catch every wording (clause 16
 * of BAA 1.5.0). `timeGrammar` is Meta's too (META_WINDOW, clause 11 of BAA
 * 1.5.0, as of 1.3.0): the window must fit the closed time
 * grammar (isTimeWindow), every word of it a word for a time, because no list
 * of refused words is ever complete. A voice request's alternatives, which
 * come from a call the BAA covers, are screened without either.
 */
export function windowIsClean(window: string, options: WindowScreen = {}): boolean {
  if (options.timeGrammar && !isTimeWindow(window)) return false;
  return findClinicalContent({ window }, { conditions: options.conditions }).length === 0 && !WINDOW_REFUSED.test(window) && !/\d{7,}/.test(window);
}

/**
 * The catalog matcher catches clinical CLAIMS, and on Meta the everyday
 * conditions; this catches a condition, a treatment or a "for my …" slipping
 * into a window, the one free-text field a Meta request has. A voice
 * request's alternatives go through it too; the service a caller asked for
 * has a column of its own.
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
  // A draft's window is screened again, so one kept before the closed time
  // grammar (a draft lives a day) is dropped and asked for, never sent on.
  const kept = existing?.preferredWindow ?? null;
  const preferredWindow = fields.preferredWindow ?? (kept && windowIsClean(kept, META_WINDOW) ? kept : null);
  const merged: BookingFields = {
    firstName: fields.firstName ?? existing?.firstName ?? null,
    phone: fields.phone ?? existing?.phone ?? null,
    preferredWindow,
    // Existing first, then this message's, deduplicated against the primary and capped.
    alternativeWindows: cleanAlternatives([...(existing?.alternativeWindows ?? []), ...fields.alternativeWindows], preferredWindow ? [preferredWindow] : [], META_WINDOW),
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
 *
 * Only a call and a web chat collect them (the shared brain's capture, the
 * voice tools and the post-call ingest): a Meta request keeps the locked four
 * and nothing else. So the everyday skin and hair conditions are not counted
 * here, and a caller's `service` may be the clinic's own "Acne Facial".
 *
 * A field with its own validation (the catalogue's cleanBookingFieldValue: a
 * veterinary booking's animal name and species) is then held to it, and one
 * that fails is refused as `invalid`: a name with a digit in it, a species
 * not on the closed list.
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
    const kept = cleanBookingFieldValue(field as BookingFieldId, value);
    if (!kept) {
      refused.push({ field, reason: "invalid" });
      continue;
    }
    accepted[field] = kept;
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
      /** A call, or a web chat (lib/chat/web-chat.ts), which has no thread to answer on either. */
      channel: "voice" | "web_chat";
      /** The caller, already upserted by the ingest, the booking engine or the chat. */
      contactId: string;
      /** The call's conversation; null for a request the booking engine logs during the call, before the post-call record exists. */
      conversationId: string | null;
      preferredWindow: string;
      treatment: string | null;
      alternativeWindows?: string[];
      /** Validated here against the clinic's requirement set; refusals audited. */
      collectedFields?: Record<string, string>;
      /** The conversation's booking key (lib/booking/engine.ts), unique per clinic: how a retried tool call finds this request. */
      vendorCallId?: string;
      /** `agent_direct` when the assistant is attempting the booking itself. Frozen at insert. */
      bookedVia?: BookedVia;
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
  if (input.channel !== "meta") {
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
  if (input.channel !== "meta" && input.collectedFields) {
    const requirements = resolveBookingRequirements(clinic?.specialty ?? "", clinic?.requirements ?? null);
    const { accepted, refused } = cleanCollectedFields(requirements, input.collectedFields);
    collectedFields = accepted;
    for (const r of refused) {
      tx.audit.record({ action: "create", resourceType: "booking_request", metadata: { outcome: "field_refused", field: r.field, reason: r.reason } });
    }
  }
  const alternativeWindows =
    input.channel === "meta"
      ? cleanAlternatives(input.fields.alternativeWindows, [input.fields.preferredWindow], META_WINDOW)
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
      conversationId: input.channel !== "meta" ? input.conversationId : null,
      platform: input.channel === "meta" ? input.thread.platform : null,
      externalId: input.channel === "meta" ? input.thread.externalId : null,
      senderId: input.channel === "meta" ? input.thread.senderId : null,
      connectionId: input.channel === "meta" ? input.connectionId : null,
      preferredWindow: input.channel === "meta" ? input.fields.preferredWindow : input.preferredWindow,
      alternativeWindows,
      treatment: input.channel !== "meta" ? input.treatment : null,
      collectedFields,
      vendorCallId: input.channel !== "meta" ? (input.vendorCallId ?? null) : null,
      bookedVia: input.channel !== "meta" ? (input.bookedVia ?? "desk") : "desk",
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
  if (channel === "voice") return "a phone call";
  if (channel === "web_chat") return "the website chat";
  return platform ? PLATFORM_LABEL[platform] : "a message";
}

export function bookingRequestUrl(token: string): string {
  return publicUrl(`/booking/${token}`);
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
 * desk, and the deposit line is added only when the booked appointment's
 * deposit was left for the desk to collect.
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
  // notifyDesk runs inside the caller's tenant transaction, after the booking
  // request (and, on a call, the conversation) is written. A misconfigured
  // BETTER_AUTH_URL must cost the desk its email, not the patient their
  // request: a throw here would roll all of it back. So it is a failed send,
  // logged, and the request stays where the care view and the console see it.
  let url: string;
  try {
    url = bookingRequestUrl(created.token);
  } catch (error) {
    if (!(error instanceof PublicUrlError)) throw error;
    log.error("booking request notice not sent: no public origin to link to", {
      clinicId: tx.clinicId,
      requestId: created.id,
      error: describeError(error),
    });
    return { status: "failed", recipients: recipients.length };
  }
  const label = channelLabel(via.channel, via.platform);

  let subject: string;
  let paragraphs: string[];
  if (variant === "fyi_direct") {
    // The deposit sentence reads the appointment the assistant booked, never
    // the clinic's policy: whether a deposit was flagged is decided per
    // booking (lib/billing/deposits.ts depositDecision), so only an
    // appointment left `pending_front_desk` has one for the desk to collect.
    const [booked] = await tx.db
      .select({ depositStatus: appointments.depositStatus })
      .from(bookingRequests)
      .innerJoin(appointments, eq(appointments.id, bookingRequests.appointmentId))
      .where(and(eq(bookingRequests.id, created.id), eq(bookingRequests.clinicId, tx.clinicId)))
      .limit(1);
    const deposit = booked?.depositStatus === "pending_front_desk" ? " The assistant said a deposit is due and that you will call to collect it." : "";
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

/**
 * notifyDesk for a request whose transaction has committed, in a transaction
 * of its own: the Meta front door's way to email the desk (the webhook calls
 * it after the answer's transaction, whatever became of the reply), so the
 * email never goes for a request that then rolls back. Never throws: an email
 * that fails here is logged and leaves `desk_notified_at` unset, and the
 * request stays as it is, open and counted in the operator's care view, until
 * the desk acts on it or it expires. Nothing sends the notice again: no job
 * has read `desk_notified_at` since C13 removed the sweep, and the daily
 * summary that would list open requests is not built yet.
 */
export async function notifyDeskAfterCommit(
  clinicId: string,
  created: { id: string; token: string },
  via: { channel: BookingChannel; platform: MetaPlatform | null },
  deps: { transport?: EmailTransport; actor?: ActorContext } = {},
): Promise<void> {
  const actor = deps.actor ?? DESK_NOTICE_ACTOR;
  try {
    await withTenant({ clinicId, actor }, (tx) => notifyDesk(tx, created, via, { transport: deps.transport }));
  } catch (error) {
    log.error("booking request notice not sent after commit", { clinicId, requestId: created.id, error: describeError(error) });
  }
}

const DESK_NOTICE_ACTOR: ActorContext = { type: "agent", serviceName: "meta-front-door" };

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

/**
 * What the person is told once the request exists. Fixed text; a name, never
 * a number or a time. The name is said back only when the reply guard passes
 * the line with it (front-door.ts); otherwise the line goes without it
 * (`firstName` null).
 */
export function requestReceivedLine(clinicName: string, firstName: string | null): string {
  const thanks = firstName ? `Thanks, ${firstName}!` : "Thanks!";
  return `${thanks} I've passed that along to ${clinicName}, and they'll give you a call on the number you gave to settle on a time. If you'd rather not wait, you're always welcome to call the practice directly.`;
}

export type BookingDecision = "accepted" | "declined" | "confirmed" | "rescheduling";

/**
 * What the person is told on a Meta thread after the desk decides. Never a
 * time, never a provider, and never that anything is booked: a confirmed or
 * accepted request says only that the practice has reviewed it and will call
 * (META_CHANNEL_PROHIBITIONS[0], "Confirming the person is, was, or will be a
 * patient"; BAA 1.3.0 clause 16, under which the assistant is instructed not
 * to confirm appointment details there). These lines are fixed text, not the
 * model's, so no filter has to catch them. The appointment itself is settled
 * on the phone.
 */
export function followUpLine(clinicName: string, decision: BookingDecision): string {
  switch (decision) {
    case "confirmed":
      return `${clinicName} has reviewed your request; they'll call you. Keep an eye on your phone.`;
    case "accepted":
      return `${clinicName} has reviewed your request; they'll call you to go through it. Nothing further is needed from you here.`;
    case "declined":
      return `${clinicName} has looked at your request and can't offer that window, but they'll call you to find a time that works.`;
    case "rescheduling":
      return `${clinicName} can't offer that window but has a couple of alternatives. They'll go through them with you by phone — keep an eye out for a call.`;
  }
}

// -----------------------------------------------------------------------------
// The emailed link, which points; and the desk's view, on Bookings
// -----------------------------------------------------------------------------

export type BookingRequestStatus = "requested" | "accepted" | "rescheduling" | "confirmed" | "declined" | "expired";

/** The request's statuses staff can still act on (§A.13). */
export const OPEN_REQUEST_STATUSES = ["requested", "accepted", "rescheduling"] as const;

/**
 * Open in name but past its link's expiry, or its alternatives' deadline:
 * nothing can decide it, and the hourly sweep (expireLapsedRequests) marks
 * it expired. On the database's clock, like the sweep.
 */
export const REQUEST_LAPSED = sql<boolean>`(${bookingRequests.expiresAt} <= now()
    or (${bookingRequests.status} = 'rescheduling' and ${bookingRequests.rescheduleExpiresAt} is not null and ${bookingRequests.rescheduleExpiresAt} < now()))`;

/**
 * The requests Bookings lists under Needs you: open, and not lapsed. Home's
 * "Waiting for you" counts the same ones (lib/portal/bookings.ts).
 */
export function openRequestCondition() {
  return and(inArray(bookingRequests.status, [...OPEN_REQUEST_STATUSES]), sql`not ${REQUEST_LAPSED}`);
}

/** Where an emailed link points: the request's clinic and id, and nothing of the person. */
export type BookingPointer = { clinicId: string; slug: string; requestId: string };

/**
 * Where the desk's emailed link (/booking/<token>) points, or null for a
 * token that is malformed or names no request. The link shows nothing and
 * decides nothing (spec: a passkey before any booking opens): the page sends
 * the browser through sign-in and the passkey step-up to the request on
 * Bookings, and a sign-in that does not open this clinic gets "not found"
 * there. A request's age does not matter here: a lapsed one is on Bookings,
 * under Missed. The one audit row says the link was followed, by the
 * request's id.
 */
export async function resolveBookingPointer(token: string, request?: RequestContext): Promise<BookingPointer | null> {
  const hash = hashIfWellFormed(token);
  if (!hash) return null;
  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return null;
  return withTenant({ clinicId, actor: POINTER_ACTOR, request }, async (tx) => {
    const [row] = await tx.db
      .select({ id: bookingRequests.id, slug: clinics.slug })
      .from(bookingRequests)
      .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
      .where(eq(bookingRequests.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    tx.audit.record({ action: "read", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "link_followed" } });
    return { clinicId, slug: row.slug, requestId: row.id };
  });
}

/**
 * One request as staff see it on Bookings: who, their number, the times they
 * asked for, what the assistant collected, and how it stands. Patient data:
 * read only inside a patient page's transaction (lib/portal/patient-page.ts),
 * which writes the access row naming the passkey.
 */
export type BookingRequestView = {
  id: string;
  clinicId: string;
  /** "clients" at a practice that cares for animals, "patients" elsewhere (audienceFor): the words Bookings uses. */
  audience: Audience;
  /** The practice's IANA zone: every time on Bookings is said on the practice's clock, not the server's. */
  timeZone: string;
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
  expiresAt: Date;
  decidedAt: Date | null;
  decidedByLabel: string | null;
  deskNote: string | null;
  confirmedFor: Date | null;
  appointmentId: string | null;
  proposedSlots: ProposedSlot[];
  rescheduleExpiresAt: Date | null;
  bookedVia: BookedVia;
  lastInboundAt: Date | null;
  /**
   * Open in name but past its link's expiry, or its alternatives' deadline:
   * nothing can decide it, and the hourly sweep (expireLapsedRequests) marks
   * it expired. Bookings shows it under Missed.
   */
  lapsed: boolean;
  /** Free slots from the writable calendar while the request is open (§B.3); null until read, and when there is no writable connection. */
  calendar: { writable: boolean; slots: CalendarSlot[] } | null;
  /** The confirmed appointment's calendar write; `attempts` so the page knows when retries have run out. */
  calendarWrite: { status: CalendarWriteStatus; error: string | null; attempts: number } | null;
  /** When the assistant held time for this request on the call, if it did. */
  heldFor: Date | null;
  /** §G.1: whether a Meta line could still reach them; null for a phone or web chat request. */
  metaWindowOpen: boolean | null;
  /**
   * The practice's amendments to this request (record_amendments,
   * lib/patient-rights/amendments.ts), oldest first. The request stays as it
   * was made, and every screen of healdesk's that shows it carries them
   * (clause 14(b) of the agreement in force, BAA 1.5.0, unchanged since
   * 1.3.0): Bookings opens only behind the passkey, so it shows their words
   * beside the request.
   */
  amendments: { text: string; requestedAt: Date }[];
};

/** Which requests to read: the open queue, the lapsed ones of the last `days`, or these ids. */
export type BookingRequestScope = { kind: "open" } | { kind: "missed"; days: number } | { kind: "ids"; ids: readonly string[] };

/**
 * The requests in `scope`, in the caller's transaction (RLS keeps them to its
 * clinic): the open queue oldest first, so whoever has waited longest is at
 * the top; Missed newest first. The caller logs the access.
 */
export async function readBookingRequestViews(
  tx: TenantTx,
  scope: BookingRequestScope,
  opts: { limit?: number; now?: Date } = {},
): Promise<BookingRequestView[]> {
  const now = opts.now ?? new Date();
  const lapsed = REQUEST_LAPSED;
  const open = inArray(bookingRequests.status, [...OPEN_REQUEST_STATUSES]);
  let where;
  if (scope.kind === "open") {
    where = openRequestCondition();
  } else if (scope.kind === "missed") {
    where = and(
      sql`(${bookingRequests.status} = 'expired' or (${open} and ${lapsed}))`,
      sql`coalesce(${bookingRequests.decidedAt}, ${bookingRequests.expiresAt}) > now() - make_interval(days => ${scope.days})`,
    );
  } else {
    const ids = scope.ids.filter((id) => UUID.test(id));
    if (ids.length === 0) return [];
    where = inArray(bookingRequests.id, ids);
  }
  const rows = await tx.db
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
      expiresAt: bookingRequests.expiresAt,
      decidedAt: bookingRequests.decidedAt,
      decidedByLabel: bookingRequests.decidedByLabel,
      deskNote: bookingRequests.deskNote,
      confirmedFor: bookingRequests.confirmedFor,
      appointmentId: bookingRequests.appointmentId,
      proposedSlots: bookingRequests.proposedSlots,
      rescheduleExpiresAt: bookingRequests.rescheduleExpiresAt,
      bookedVia: bookingRequests.bookedVia,
      lastInboundAt: bookingRequests.lastInboundAt,
      lapsed,
      specialty: clinics.specialty,
      timeZone: clinics.timezone,
      firstName: contacts.fullName,
      phone: contacts.phone,
      calendarWriteStatus: appointments.calendarWriteStatus,
      calendarWriteError: appointments.calendarWriteError,
      calendarWriteAttempts: appointments.calendarWriteAttempts,
    })
    .from(bookingRequests)
    .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
    .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
    .leftJoin(appointments, eq(appointments.id, bookingRequests.appointmentId))
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), where))
    .orderBy(
      scope.kind === "missed" ? desc(sql`coalesce(${bookingRequests.decidedAt}, ${bookingRequests.expiresAt})`) : bookingRequests.createdAt,
      bookingRequests.id,
    )
    .limit(opts.limit ?? 100);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const amended = await amendmentsFor(tx, "booking_request", ids);
  const held = await tx.db
    .selectDistinctOn([slotHolds.bookingRequestId], { requestId: slotHolds.bookingRequestId, startsAt: slotHolds.startsAt })
    .from(slotHolds)
    .where(and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.bookingRequestId, ids)))
    .orderBy(slotHolds.bookingRequestId, desc(slotHolds.createdAt));
  const heldFor = new Map(held.map((h) => [h.requestId, h.startsAt]));

  return rows.map((row) => ({
    id: row.id,
    clinicId: tx.clinicId,
    audience: audienceFor(row.specialty),
    timeZone: row.timeZone,
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
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedByLabel: row.decidedByLabel,
    deskNote: row.deskNote,
    confirmedFor: row.confirmedFor,
    appointmentId: row.appointmentId,
    proposedSlots: row.proposedSlots,
    rescheduleExpiresAt: row.rescheduleExpiresAt,
    bookedVia: row.bookedVia,
    lastInboundAt: row.lastInboundAt,
    lapsed: row.lapsed,
    calendar: null,
    calendarWrite: row.calendarWriteStatus ? { status: row.calendarWriteStatus, error: row.calendarWriteError ?? null, attempts: row.calendarWriteAttempts ?? 0 } : null,
    heldFor: heldFor.get(row.id) ?? null,
    metaWindowOpen: row.channel === "meta" ? row.lastInboundAt !== null && row.lastInboundAt.getTime() + META_WINDOW_MS > now.getTime() : null,
    amendments: (amended.get(row.id) ?? []).map((a) => ({ text: a.amendment, requestedAt: a.requestedAt })),
  }));
}

/**
 * The free times Bookings lists for an open request: the request's service on
 * the calendar it books into, arranged for a desk with the person's own
 * windows in front of it (arrangeSlots). Called after the page's transaction
 * has committed, never inside it (plan §6.4): Google is asked with no
 * transaction open. The request's own holds do not block it: a time the
 * assistant reserved for this person is one the desk may confirm for them.
 * Null where healdesk may not write (nothing to pick from); an empty list
 * when Google did not answer just now, so the desk types a time.
 */
export async function deskFreeTimes(clinicId: string, req: BookingRequestView, actor: ActorContext): Promise<BookingRequestView["calendar"]> {
  const now = new Date();
  try {
    const found = await availableSlotsFor(clinicId, { service: req.treatment ?? req.collectedFields.service ?? null, exceptRequestId: req.id, now, actor });
    if (found.status === "ok") {
      const spans = found.slots.map((s) => ({ startsAt: s.at, endsAt: new Date(s.at.getTime() + found.serviceMinutes * 60_000) }));
      return { writable: true, slots: arrangeSlots(spans, { timeZone: found.timeZone, now, named: namedWeekdays([req.preferredWindow, ...req.alternativeWindows]) }) };
    }
    if (found.status === "broken" || (found.status === "unavailable" && found.reason === "not_writable")) return null;
    return { writable: true, slots: [] };
  } catch (error) {
    log.warn("desk free times not read", { clinicId, requestId: req.id, error: describeError(error) });
    return { writable: true, slots: [] };
  }
}

// -----------------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------------

export type DecisionOutcome = {
  outcome:
    | "decided"
    | "already-decided"
    | "invalid"
    /** healdesk already has that time on that calendar (plan §7.10 step 3). */
    | "slot_taken"
    /** Google shows the time busy; "Confirm anyway" (addAnyway) books it regardless. */
    | "calendar_busy"
    /** The assistant's own write for this request has not settled yet: try again in a minute. */
    | "checking"
    /** The assistant's booking for this request reached the calendar after all, and stands. */
    | "already_in_calendar";
  /**
   * null when the channel has nothing to say on (a phone request: the desk
   * calls). `withheld`: the practice's Meta front door is off, or the answer
   * gate would not answer there now (paused, suspended, no agreement), so
   * nothing was sent.
   */
  followUp: "sent" | "failed" | "no-channel" | "outside_window" | "withheld" | null;
  appointmentId: string | null;
  /** §B.4: the calendar write's outcome once an appointment was created; null when nothing was confirmed. */
  calendarWrite: CalendarWriteOutcome | null;
  /** For `slot_taken`: someone holding it on a call right now, or a booking made through healdesk. */
  takenBy?: "live_call" | "booking";
  /** For `already_in_calendar`: when the assistant booked them. */
  bookedFor?: Date;
};

export type DecisionInput = {
  /** Who decides: the sign-in and the device whose passkey stepped up. */
  actor: DeskActor;
  decidedByLabel: string | null;
  deskNote: string | null;
  confirmedFor?: Date | null;
  treatment?: string | null;
  /** §C.1: one to three future times, each from the calendar or typed by the desk. */
  proposedSlots?: { at: Date; source?: "calendar" | "desk" }[];
  /** "Confirm anyway": staff saw Google show the time busy and confirm it regardless. Audited. */
  addAnyway?: boolean;
  request?: RequestContext;
  /** Injectable so tests can pin the clock. */
  now?: Date;
};

type OpenStatus = "requested" | "accepted" | "rescheduling";

/** Which states each decision may be made from (§A.13). A second "rescheduling" is a plain update, not a transition. */
export const DECIDABLE_FROM: Record<BookingDecision, readonly OpenStatus[]> = {
  accepted: ["requested"],
  declined: ["requested", "rescheduling"],
  confirmed: ["requested", "accepted", "rescheduling"],
  rescheduling: ["requested", "accepted", "rescheduling"],
};

/** How long after the assistant's insert attempt its outcome may still be on its way (plan §7.10). */
export const ASSISTANT_WRITE_GRACE_MS = 2 * 60_000;
const ASSISTANT_LATE_LABEL = "assistant (calendar write confirmed after the call)";

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** LEAST(expires_at, now + 72h, MIN(slot.at)) — the alternatives lapse before any of them is in the past. */
export function rescheduleDeadline(expiresAt: Date, slots: readonly { at: Date }[], now: Date): Date {
  const candidates = [expiresAt.getTime(), now.getTime() + RESCHEDULE_TTL_HOURS * 3_600_000, ...slots.map((s) => s.at.getTime())];
  return new Date(Math.min(...candidates));
}

type RequestFacts = {
  id: string;
  status: BookingRequestStatus;
  expired: boolean;
  treatment: string | null;
  collectedFields: Record<string, string>;
  /** The request's newest hold that is not finished, if any. */
  hold: { id: string; status: SlotHoldStatus; insertAttemptedAt: Date | null } | null;
  /** The request's newest hold in any state: the calendar a confirmation goes on, and the event key it is written under. */
  keyHold: { id: string; calendarId: string } | null;
  /** The services list, for the confirmed span's length and canonical name. */
  services: AgentService[];
  /** A Meta request's channel connection, for its follow-up's owner; null for a phone request. */
  metaConnectionId: string | null;
  metaPlatform: MetaPlatform | null;
};

/** The facts the guard and the re-check need, read before the decision's own transaction. */
async function readRequestFacts(tx: TenantTx, requestId: string): Promise<RequestFacts | null> {
  const [row] = await tx.db
    .select({
      id: bookingRequests.id,
      status: bookingRequests.status,
      expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
      treatment: bookingRequests.treatment,
      collectedFields: bookingRequests.collectedFields,
      metaConnectionId: bookingRequests.connectionId,
      metaPlatform: bookingRequests.platform,
    })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .limit(1);
  if (!row) return null;
  const [hold] = await tx.db
    .select({ id: slotHolds.id, status: slotHolds.status, insertAttemptedAt: slotHolds.insertAttemptedAt })
    .from(slotHolds)
    .where(and(eq(slotHolds.bookingRequestId, row.id), inArray(slotHolds.status, ["writing", "unknown", "reserved", "held"])))
    .orderBy(desc(slotHolds.createdAt))
    .limit(1);
  const [keyHold] = await tx.db
    .select({ id: slotHolds.id, calendarId: slotHolds.calendarId })
    .from(slotHolds)
    .where(eq(slotHolds.bookingRequestId, row.id))
    .orderBy(desc(slotHolds.createdAt))
    .limit(1);
  const [agent] = await tx.db.select({ services: agentConfigs.services }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
  return { ...row, hold: hold ?? null, keyHold: keyHold ?? null, services: agent?.services ?? [] };
}

/**
 * The desk's answer (plan §7.10). One conditional UPDATE, under the request's
 * row lock, decides who wins a double click; the trigger in 0040 makes the
 * decision final, with the permitted second steps (accepted → confirmed,
 * → rescheduling; rescheduling → confirmed, declined). Confirming a slot is
 * the one place in the product an appointment row is created from a request:
 * the desk's click, not the agent's word, is the booking. Then, on a Meta
 * thread, the person is told through the clinic's sealed token — the fixed
 * line above, never the desk's note and never the time — and only inside
 * Meta's window.
 *
 * Before anything is decided:
 *
 *   1. **The assistant's own write.** Where the assistant held time for this
 *      request and its Google insert has not settled (a hold `writing`, or
 *      `unknown` within two minutes of the attempt), every decision answers
 *      `checking`: deciding now could put a second booking in the calendar
 *      beside one about to land. An `unknown` hold past the grace is read
 *      back from Google: found, the assistant's booking stands
 *      (`already_in_calendar`); gone, the decision goes on.
 *   2. **Google, for a confirmation** on a location whose terms let healdesk
 *      write: the exact span, freshly (deskSpanFree). Busy is
 *      `calendar_busy` until staff confirm anyway; a definitive failure has
 *      already flipped the location to manual booking, and the decision goes
 *      on.
 *   3. **The decision**, under the location's calendar lock and the
 *      request's row lock. Its own holds are settled first: a deposit
 *      reservation over exactly the confirmed span becomes the booking;
 *      every other is released. A confirmation on a location whose terms
 *      let healdesk write occupies its calendar (`booking_origin 'desk'`),
 *      so the database refuses one that overlaps a live hold or another
 *      healdesk booking (`slot_taken`); elsewhere (`not_used`, `none`) it
 *      occupies nothing, and staff may confirm two at once for two people.
 *
 * The transaction commits before the calendar write (plan §7.12), so a
 * Google timeout can never roll back the desk's decision, and a re-notify
 * or retry finds the row in the state it was left.
 *
 * Keyed by the clinic and the request's id, which the caller read inside
 * the clinic's own portal (requirePatientPage): every transaction here is
 * scoped to `target.clinicId`, so another clinic's request is `invalid`,
 * exactly like one that does not exist. Every transaction runs as
 * `input.actor`, the sign-in by its device, and the decision's own audit
 * rows, refusals included, carry the passkey's and the step-up's ids.
 */
export async function decideBookingRequest(
  target: { clinicId: string; requestId: string },
  decision: BookingDecision,
  input: DecisionInput,
  send?: MetaSender,
): Promise<DecisionOutcome> {
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null, calendarWrite: null };
  const now = input.now ?? new Date();
  const { clinicId, requestId } = target;
  if (!UUID.test(clinicId) || !UUID.test(requestId)) return none;
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
  const as = deskActorContext(input.actor);
  const who = stepUpOf(input.actor);
  const actor = { clinicId, actor: as, request: input.request };
  const from = DECIDABLE_FROM[decision];

  // 1. The assistant's own write, outside any transaction. A refusal is
  // audited as the decision's own transaction audits one.
  const facts = await withTenant(actor, async (tx) => {
    const read = await readRequestFacts(tx, requestId);
    if (read && (read.expired || !from.includes(read.status as OpenStatus))) {
      rejected(tx, read.id, read.expired ? "invalid" : "already-decided", decision, who);
    }
    return read;
  });
  if (!facts) return none;
  if (facts.expired) return none;
  if (!from.includes(facts.status as OpenStatus)) return { ...none, outcome: "already-decided" };
  const guard = await assistantWriteGuard(clinicId, facts, now, as);
  if (guard) {
    await withTenant(actor, async (tx) => rejected(tx, facts.id, guard.outcome, decision, who));
    return guard;
  }

  // 2. Google, for a confirmation: on the calendar of the assistant's hold
  // for this request when it held time (that is where its event, if any,
  // lives, and the desk's goes under the same key), else the service's.
  const service = serviceDuration(facts.services, input.treatment?.trim() || facts.treatment || facts.collectedFields.service || null);
  let deskCalendar: { calendarId: string; providerId: string | null } | null = null;
  if (decision === "confirmed") {
    const span = await deskSpanFree(clinicId, { startsAt: input.confirmedFor!, durationMinutes: service.minutes, service: service.canonicalName, calendarId: facts.keyHold?.calendarId ?? null, actor: as });
    if (span.status === "free" || span.status === "busy") deskCalendar = { calendarId: span.calendarId, providerId: span.providerId };
    if (span.status === "busy" && !input.addAnyway) {
      // A colleague may have confirmed it meanwhile, and its event is what
      // Google shows: that is already-decided, not a busy calendar.
      return withTenant(actor, async (tx) => {
        const again = await readRequestFacts(tx, requestId);
        const outcome = !again || again.expired || !from.includes(again.status as OpenStatus) ? "already-decided" : "calendar_busy";
        rejected(tx, facts.id, outcome, decision, who);
        return { ...none, outcome };
      });
    }
  }

  // The Meta follow-up's owner, through the practice's switches, outside any
  // transaction (the answer gate opens its own): a front door switched off,
  // a pause, a suspension or no agreement in effect withholds the line.
  const followUpOwner =
    facts.metaConnectionId && facts.metaPlatform
      ? await resolveFollowUpOwner({ clinicId, connectionId: facts.metaConnectionId, platform: facts.metaPlatform, actor: as, now })
      : null;

  // 3. The decision.
  let decided: DecisionOutcome;
  try {
    decided = await withTenant(actor, (tx) =>
      decideWithin(tx, { requestId, decision, input, proposed, from, now, service, deskCalendar, send, followUpOwner, who }),
    );
  } catch (error) {
    if (codeOf(error) !== "23P01") throw error;
    // The database refused a booking over time healdesk already has there.
    // Decided meanwhile by a colleague is already-decided; otherwise say
    // whether it is a live call holding it or a booking.
    return withTenant(actor, async (tx) => {
      const again = await readRequestFacts(tx, requestId);
      if (!again || !from.includes(again.status as OpenStatus)) {
        rejected(tx, facts.id, "already-decided", decision, who);
        return { ...none, outcome: "already-decided" as const };
      }
      const live = await liveHoldOverlaps(tx, input.confirmedFor!, service.minutes);
      rejected(tx, again.id, "slot_taken", decision, who);
      return { ...none, outcome: "slot_taken" as const, takenBy: live ? ("live_call" as const) : ("booking" as const) };
    });
  }

  // §B.4: after the commit, and never inside it.
  if (decided.outcome === "decided" && decided.appointmentId) {
    return { ...decided, calendarWrite: await writeToCalendar(clinicId, decided.appointmentId, { now }) };
  }
  return decided;
}

/** The desk's decision refused, audited as the decision's own transaction audits one, with the passkey behind it. */
function rejected(tx: TenantTx, requestId: string, reason: string, decision: BookingDecision, who: { passkeyId: string; stepUpId: string }): void {
  tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "rejected", reason, decision, ...who } });
}

/**
 * Step 1 of the desk path (plan §7.10): null to go on, or the outcome to
 * answer with. Only an `unknown` hold past its grace asks Google, and only
 * an answer that leaves the assistant's write unsettled keeps the desk
 * waiting: a transient miss is `checking`; a grant or calendar taken away
 * breaks the connection (the location books by request from now on) and
 * the desk decides, as it does when the event is gone, deleted, or not
 * ours.
 */
async function assistantWriteGuard(clinicId: string, facts: RequestFacts, now: Date, actor: ActorContext): Promise<DecisionOutcome | null> {
  const hold = facts.hold;
  const checking: DecisionOutcome = { outcome: "checking", followUp: null, appointmentId: null, calendarWrite: null };
  if (!hold) return null;
  if (hold.status === "writing") return checking;
  if (hold.status !== "unknown") return null;
  if (!hold.insertAttemptedAt || now.getTime() - hold.insertAttemptedAt.getTime() < ASSISTANT_WRITE_GRACE_MS) return checking;

  const read = await withTenant({ clinicId, actor }, async (tx) => {
    const target = await writableConnection(tx);
    if (!target) return null;
    const [row] = await tx.db
      .select({ calendarId: slotHolds.calendarId, startsAt: slotHolds.startsAt })
      .from(slotHolds)
      .where(eq(slotHolds.id, hold.id))
      .limit(1);
    if (!row) return null;
    const context = await openContext(tx, target, "calendar_read_back");
    return { target, calendarId: row.calendarId, context: { ...context, metadata: { ...context.metadata, calendarId: row.calendarId } }, startsAt: row.startsAt };
  });
  // Nowhere to read back from: the location's calendar is gone, so the
  // assistant's write cannot be confirmed, and the desk decides.
  if (!read) return null;
  const found = await googleCalendarAdapter.findAppointmentByKey(read.context, { idempotencyKey: `hold:${hold.id}`, around: read.startsAt });
  if (!found.ok) {
    const code = calendarBreakOf(found.error);
    if (code) {
      // A named provider's calendar gone is that calendar's problem, not the
      // location's (as availability reads it); the grant gone, or the
      // location's own calendar, breaks the connection.
      if (isTokenBreak(code) || read.calendarId === read.target.calendarId) {
        try {
          await markCalendarBroken(clinicId, { code, connectionId: read.target.connectionId, credentialVersion: read.target.credentialVersion, actor });
        } catch (error) {
          log.error("calendar break not recorded", { clinicId, error: describeError(error) });
        }
      }
      return null;
    }
    const reason = found.error.reason;
    return reason === "deleted_in_calendar" || reason === "not_ours" ? null : checking;
  }
  if (!found.value) return null;
  const event = found.value;

  let recorded: RecordedLateWrite;
  try {
    recorded = await withTenant({ clinicId, actor }, (tx) => recordAssistantWrite(tx, hold.id, event.externalId, now));
  } catch (error) {
    if (codeOf(error) !== "23P01") throw error;
    // §7.9: the assistant's event reached Google after its hold stopped
    // blocking, and the time has been taken since. The record rolled back
    // whole; the hold is let go and never retried (the writer never deletes
    // an event), the clinic is told in the same transaction to look for a
    // duplicate (calendar_check), and the desk decides.
    await withTenant({ clinicId, actor }, async (tx) => {
      if (await releaseAssistantHold(tx, hold.id, "record_conflict")) await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: facts.id });
    });
    return null;
  }
  return recorded.kind === "recorded"
    ? { outcome: "already_in_calendar", followUp: null, appointmentId: recorded.appointmentId, calendarWrite: "written", bookedFor: recorded.startsAt }
    : null;
}

export type RecordedLateWrite =
  | {
      kind: "recorded";
      appointmentId: string;
      startsAt: Date;
      minutes: number;
      requestId: string;
      /** The deposit decision the booking was recorded with (lib/booking/deposit-gate.ts). */
      deposit: DepositOutcome;
    }
  /** The hold is no longer in the state the caller fenced on: someone else recorded or released it. */
  | { kind: "settled" }
  /** The request was decided (or erased) meanwhile: the hold is released, nothing recorded, and the clinic told to check. */
  | { kind: "request_decided" };

/**
 * Which state the record step may convert a hold from (plan §7.9): the
 * engine's own write, `writing` under the lease it took at the claim; or a
 * write found in Google after the fact (the watch, the desk path), `unknown`.
 */
export type HoldFence = { lease: string } | "unknown";

const ASSISTANT_DIRECT_LABEL = "assistant (direct booking)";

function fenced(holdId: string, fence: HoldFence) {
  return fence === "unknown"
    ? and(eq(slotHolds.id, holdId), eq(slotHolds.status, "unknown"))
    : and(eq(slotHolds.id, holdId), eq(slotHolds.status, "writing"), eq(slotHolds.leaseToken, fence.lease));
}

/**
 * The record step for an assistant write Google confirmed (plan §7.9): the
 * hold becomes `converted`, its booking is recorded as written with the
 * hold's own time, length and calendar, and the request is confirmed by the
 * assistant. The engine's writer fences on its lease; a write found after
 * the fact (the watch, or the desk path's read-back) fences on `unknown`.
 *
 * The hold and its request are read and locked before anything is written,
 * so a hold someone else settled, or a request decided meanwhile, changes
 * nothing but the release of that hold (`request_decided`), with the
 * clinic told in the same transaction (calendar_check, L34): the event is in
 * Google, and a decision was made without it. A 23P01 from the booking (its
 * time retaken after the hold stopped blocking) rolls the whole of it back;
 * the caller releases the hold and raises the same alert.
 *
 * A booking recorded here raises no alert of its own (Annex X6); the
 * request reads as confirmed by the assistant, "after the call" when it was
 * found late or the caller had already been answered with a request
 * (ANSWERED_AS_REQUEST), so whoever calls them back sees it is booked.
 *
 * The deposit is the engine's decision as it stands now, through D's one
 * writer (insertAppointment → recordDepositOutcome): a booking already in
 * the calendar can only flag a deposit that is due for the front desk.
 */
export async function recordAssistantWrite(
  tx: TenantTx,
  holdId: string,
  externalId: string,
  now: Date,
  fence: HoldFence = "unknown",
): Promise<RecordedLateWrite> {
  await lockClinicCalendar(tx);
  const [hold] = await tx.db
    .select({ startsAt: slotHolds.startsAt, minutes: slotHolds.durationMinutes, calendarId: slotHolds.calendarId, requestId: slotHolds.bookingRequestId, channel: slotHolds.channel, outcomeReason: slotHolds.outcomeReason })
    .from(slotHolds)
    .where(and(fenced(holdId, fence), eq(slotHolds.clinicId, tx.clinicId)))
    .for("update")
    .limit(1);
  if (!hold) return { kind: "settled" };
  const [request] = hold.requestId
    ? await tx.db
        .select({ id: bookingRequests.id, contactId: bookingRequests.contactId, conversationId: bookingRequests.conversationId, treatment: bookingRequests.treatment, status: bookingRequests.status, expired: sql<boolean>`${bookingRequests.expiresAt} <= now()` })
        .from(bookingRequests)
        .where(eq(bookingRequests.id, hold.requestId))
        .for("update")
        .limit(1)
    : [];
  if (!request || request.expired || !(DECIDABLE_FROM.confirmed as readonly string[]).includes(request.status)) {
    await releaseAssistantHold(tx, holdId, "request_decided", fence);
    if (request) await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: request.id });
    return { kind: "request_decided" };
  }
  const late = fence === "unknown" || hold.outcomeReason === ANSWERED_AS_REQUEST;
  await tx.db
    .update(slotHolds)
    .set({ status: "converted", outcomeReason: late ? "written_late" : "written", releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
    .where(fenced(holdId, fence));
  const gate = await depositGateFor(tx, { channel: hold.channel === "web_chat" ? "web" : hold.channel, service: request.treatment });
  const deposit = bookedDepositOutcome(gate.outcome);
  const appointmentId = await insertAppointment(tx, {
    contactId: request.contactId,
    conversationId: request.conversationId,
    scheduledFor: hold.startsAt,
    treatment: request.treatment,
    durationMinutes: hold.minutes,
    bookingOrigin: "assistant",
    calendarEventKey: `hold:${holdId}`,
    calendarId: hold.calendarId,
    written: { externalId, at: now },
    deposit,
  });
  await tx.db.update(slotHolds).set({ appointmentId, updatedAt: sql`now()` }).where(eq(slotHolds.id, holdId));
  await tx.db
    .update(bookingRequests)
    .set({ status: "confirmed", confirmedFor: hold.startsAt, appointmentId, decidedAt: now, decidedByLabel: late ? ASSISTANT_LATE_LABEL : ASSISTANT_DIRECT_LABEL })
    .where(eq(bookingRequests.id, request.id));
  tx.audit.record({ action: "create", resourceType: "appointment", resourceId: appointmentId, metadata: { bookingRequestId: request.id, bookedByAssistant: true, writtenLate: late || undefined } });
  return {
    kind: "recorded",
    appointmentId,
    startsAt: hold.startsAt,
    minutes: hold.minutes,
    requestId: request.id,
    deposit,
  };
}

/** Let go of an assistant hold whose write will never be recorded (plan §7.9), fenced and audited. */
export async function releaseAssistantHold(tx: TenantTx, holdId: string, reason: string, fence: HoldFence = "unknown"): Promise<boolean> {
  const released = await tx.db
    .update(slotHolds)
    .set({ status: "released", outcomeReason: reason, releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
    .where(and(fenced(holdId, fence), eq(slotHolds.clinicId, tx.clinicId)))
    .returning({ id: slotHolds.id });
  if (released.length) {
    tx.audit.record({ action: "update", resourceType: "slot_hold", resourceId: holdId, metadata: { outcome: "released", reason } });
  }
  return released.length > 0;
}

/** Whether a live hold (a call holding time right now) overlaps the span, on any calendar. */
async function liveHoldOverlaps(tx: TenantTx, startsAt: Date, minutes: number): Promise<boolean> {
  const end = new Date(startsAt.getTime() + minutes * 60_000);
  const [row] = await tx.db
    .select({ id: slotHolds.id })
    .from(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        sql`${slotHolds.startsAt} < ${end} and ${startsAt} < ${slotHolds.endsAt}`,
        sql`((${slotHolds.status} = 'held' and ${slotHolds.expiresAt} > clock_timestamp())
             or (${slotHolds.status} in ('writing', 'unknown', 'reserved') and ${slotHolds.blocksUntil} > clock_timestamp()))`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

type DecideWithinInput = {
  requestId: string;
  decision: BookingDecision;
  input: DecisionInput;
  proposed: { at: Date; source: "calendar" | "desk" }[];
  from: readonly OpenStatus[];
  now: Date;
  service: { minutes: number; canonicalName: string | null };
  deskCalendar: { calendarId: string; providerId: string | null } | null;
  send?: MetaSender;
  /** The Meta follow-up's owner, resolved through the switches before this transaction; null withholds it. */
  followUpOwner: MetaChannelOwner | null;
  /** The passkey and step-up behind the decision, for its audit rows. */
  who: { passkeyId: string; stepUpId: string };
};

/**
 * The owner a follow-up on this request is sent as: the one resolved through
 * the switches for this request's own connection, or, when none was resolved
 * or it names another connection, a refused one, so nothing is sent.
 */
export function followUpOwnerFor(
  clinicId: string,
  row: { connectionId: string | null; platform: MetaPlatform | null },
  resolved: MetaChannelOwner | null | undefined,
): MetaChannelOwner {
  if (resolved && resolved.connectionId === row.connectionId && resolved.platform === row.platform) return resolved;
  return { clinicId, connectionId: row.connectionId ?? "", platform: row.platform ?? "messenger", enabled: false, platformEnabled: false, withheld: "unresolved" };
}

/** Step 3 of the desk path: the decision itself, in the caller's transaction. */
async function decideWithin(tx: TenantTx, d: DecideWithinInput): Promise<DecisionOutcome> {
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null, calendarWrite: null };
  const { decision, input, from, now, who } = d;
  // The calendar lock first, then the request's row lock: two confirmations
  // of one request queue here, and the second finds it decided.
  await lockClinicCalendar(tx);
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
    })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.id, d.requestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .for("update")
    .limit(1);
  const [clinic] = await tx.db.select({ timezone: clinics.timezone, clinicName: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const decidable = candidate && clinic && !candidate.expired && from.includes(candidate.status as OpenStatus);
  if (!decidable) {
    const outcome = candidate && !candidate.expired ? "already-decided" : "invalid";
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate?.id, metadata: { outcome: "rejected", reason: outcome, decision, ...who } });
    return { ...none, outcome };
  }

  // The request's own holds. One still being written means the assistant
  // may yet book it (the guard above saw it a moment ago, or it started
  // since): the desk waits.
  const holds = await tx.db
    .select({ id: slotHolds.id, status: slotHolds.status, channel: slotHolds.channel, startsAt: slotHolds.startsAt, minutes: slotHolds.durationMinutes, calendarId: slotHolds.calendarId, insertAttemptedAt: slotHolds.insertAttemptedAt })
    .from(slotHolds)
    .where(eq(slotHolds.bookingRequestId, candidate.id))
    .orderBy(desc(slotHolds.createdAt));
  if (holds.some((h) => h.status === "writing" || (h.status === "unknown" && (!h.insertAttemptedAt || now.getTime() - h.insertAttemptedAt.getTime() < ASSISTANT_WRITE_GRACE_MS)))) {
    rejected(tx, candidate.id, "checking", decision, who);
    return { ...none, outcome: "checking" };
  }
  const terms = await calendarTermsFor(tx);
  const writes = terms.kind === "covered" || terms.kind === "uncovered";
  const reserved =
    decision === "confirmed"
      ? holds.find((h) => h.status === "reserved" && h.startsAt.getTime() === input.confirmedFor!.getTime() && h.minutes === d.service.minutes)
      : undefined;
  if (reserved) {
    await tx.db
      .update(slotHolds)
      .set({ status: "converted", outcomeReason: "desk_confirmed", releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
      .where(and(eq(slotHolds.id, reserved.id), eq(slotHolds.status, "reserved")));
  }
  await tx.db
    .update(slotHolds)
    .set({ status: "released", outcomeReason: "desk_decided", releasedAt: sql`clock_timestamp()`, updatedAt: sql`now()` })
    .where(and(eq(slotHolds.bookingRequestId, candidate.id), inArray(slotHolds.status, ["held", "reserved", "unknown"])));

  // Confirming creates the appointment FIRST, so the status and the
  // appointment id land in one statement: the table's shape check says a
  // confirmed row always has both, and a check is judged per statement.
  let appointmentId: string | null = null;
  if (decision === "confirmed") {
    // Where the assistant held time for this request, the booking takes the
    // hold's key and the hold's calendar together: Google's event ids are
    // unique only within a calendar, so an assistant insert that landed late
    // meets this event there (a 409, read back) instead of sitting beside it
    // on another provider's calendar.
    const assistantHold = reserved ?? holds[0];
    const target = writes ? await writableConnection(tx) : null;
    const connection = writes && !target ? await googleCalendarConnection(tx) : null;
    const treatment = d.service.canonicalName ?? (input.treatment?.trim().slice(0, 120) || candidate.treatment || candidate.collectedFields.service || null);
    // A deposit reservation becoming the booking carries the engine's
    // deposit for its service (D's per-service amounts), as the booking
    // would have had the assistant made it, not the clinic-wide rule.
    const deposit = reserved
      ? bookedDepositOutcome((await depositGateFor(tx, { channel: reserved.channel === "web_chat" ? "web" : reserved.channel, service: treatment })).outcome)
      : undefined;
    appointmentId = await insertAppointment(tx, {
      contactId: candidate.contactId,
      conversationId: candidate.conversationId,
      scheduledFor: input.confirmedFor!,
      treatment,
      durationMinutes: d.service.minutes,
      // Occupies the location's calendar wherever healdesk writes to it, a
      // broken connection included, so it still blocks the assistant after
      // a reconnect; under terms that never write it occupies nothing.
      bookingOrigin: writes ? "desk" : null,
      calendarEventKey: assistantHold ? `hold:${assistantHold.id}` : candidate.id,
      calendarId: writes ? (assistantHold?.calendarId ?? d.deskCalendar?.calendarId ?? target?.calendarId ?? connection?.calendarId ?? "primary") : null,
      ...(deposit ? { deposit, depositAlerted: true } : {}),
    });
    if (reserved) {
      await tx.db.update(slotHolds).set({ appointmentId, updatedAt: sql`now()` }).where(eq(slotHolds.id, reserved.id));
    }
    if (input.addAnyway) {
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate.id, metadata: { outcome: "confirmed_over_busy", decision, ...who } });
    }
  }

  const slots: ProposedSlot[] = d.proposed.map((s) => ({ at: s.at.toISOString(), label: slotLabel(s.at, clinic.timezone), source: s.source }));

  // One conditional UPDATE decides who wins a double click.
  const [row] = await tx.db
    .update(bookingRequests)
    .set({
      status: decision,
      decidedAt: now,
      decidedByLabel: input.decidedByLabel?.trim().slice(0, 80) || null,
      deskNote: input.deskNote?.trim().slice(0, 500) || null,
      ...(decision === "confirmed" ? { confirmedFor: input.confirmedFor!, appointmentId } : {}),
      ...(decision === "rescheduling" ? { proposedSlots: slots, rescheduleExpiresAt: rescheduleDeadline(candidate.expiresAt, d.proposed, now) } : {}),
    })
    .where(and(eq(bookingRequests.id, candidate.id), inArray(bookingRequests.status, [...from]), gt(bookingRequests.expiresAt, sql`now()`)))
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
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate.id, metadata: { outcome: "rejected", reason: "already-decided", decision, ...who } });
    return { ...none, outcome: "already-decided" };
  }
  if (appointmentId) {
    tx.audit.record({
      action: "create",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { conversationId: candidate.conversationId ?? undefined, bookingRequestId: row.id, confirmedByDesk: true, confirmedByClinicSystem: false, ...who },
    });
  }
  tx.audit.record({
    action: "update",
    resourceType: "booking_request",
    resourceId: row.id,
    metadata: { outcome: "decided", decision, channel: row.channel, slots: decision === "rescheduling" ? slots.length : undefined, ...who },
  });

  // §C.2: the desk goes through the alternatives by phone; on a Meta
  // thread, a fixed line says so, inside the window only.
  if (decision === "rescheduling") {
    const outreach: RescheduleOutreach = await planRescheduleOutreach(tx, row, { send: d.send, now, owner: d.followUpOwner });
    return { outcome: "decided", followUp: outreach.meta, appointmentId: null, calendarWrite: null };
  }

  if (row.channel !== "meta") return { outcome: "decided", followUp: null, appointmentId, calendarWrite: null };
  if (!row.connectionId || !row.platform || !row.externalId || !row.senderId) return { outcome: "decided", followUp: "no-channel", appointmentId, calendarWrite: null };
  const owner = followUpOwnerFor(tx.clinicId, row, d.followUpOwner);
  try {
    // Outside Meta's 24-hour window sendMetaReply sends nothing: v1 has no
    // message tag and no template, so the desk calls instead. Nor does it
    // send for an owner the practice's switches refused.
    const sent = await sendMetaReply(tx, owner, row.externalId, row.senderId, followUpLine(clinic.clinicName, decision), d.send, { now });
    if (sent.status === "withheld") return { outcome: "decided", followUp: "withheld", appointmentId, calendarWrite: null };
    if (sent.status !== "sent") return { outcome: "decided", followUp: "outside_window", appointmentId, calendarWrite: null };
    tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: row.platform, source: "booking_follow_up" } });
    return { outcome: "decided", followUp: "sent", appointmentId, calendarWrite: null };
  } catch (error) {
    log.error("booking follow-up not sent", { clinicId: tx.clinicId, requestId: row.id, error: describeError(error) });
    return { outcome: "decided", followUp: "failed", appointmentId, calendarWrite: null };
  }
}

type AppointmentInput = {
  contactId: string;
  conversationId: string | null;
  scheduledFor: Date;
  treatment: string | null;
  /** The canonical service's length; null is read as 30 by the guard and the writer. */
  durationMinutes: number | null;
  /** 'desk' where the location's terms let healdesk write; 'assistant' for its own; null elsewhere. */
  bookingOrigin: BookingOrigin | null;
  /** What the Google event id derives from: "hold:" + the hold's id, or the request's id. */
  calendarEventKey: string;
  /** The calendar it occupies and is written to; null where nothing is written. */
  calendarId: string | null;
  /** Already in Google: the assistant's write, found by a read-back. */
  written?: { externalId: string; at: Date };
  /**
   * The booking engine's deposit decision (lib/booking/deposit-gate.ts): for
   * the assistant's own bookings, written through D's recordDepositOutcome,
   * and for a deposit reservation staff confirm. Absent for any other staff
   * confirmation, which applies the clinic-level rule.
   */
  deposit?: DepositOutcome;
  /**
   * The deposit's L10 alert went when the time was reserved for it (the
   * engine's claim): the amount is written as owed to the front desk with
   * no second alert.
   */
  depositAlerted?: boolean;
};

async function insertAppointment(tx: TenantTx, input: AppointmentInput): Promise<string> {
  // A staff confirmation: the agent's script carries the clinic's deposit
  // rule; with no payment link path, a required deposit is owed to the front
  // desk. The engine's decision: written here only when its alert already
  // went; otherwise after the insert, by D's one writer.
  const [agent] = await tx.db
    .select({ depositPolicy: agentConfigs.depositPolicy, services: agentConfigs.services })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const depositPolicy = input.deposit ? null : (agent?.depositPolicy ?? null);
  // The clinic's listed price for the service booked, as its list says it
  // now, kept on the booking (drizzle/0081): booked value multiplies by
  // this, so a later edit to Prices never rewrites what was booked. The
  // service is matched as the calendar matches it (serviceDuration).
  const services = agent?.services ?? [];
  const canonical = serviceDuration(services, input.treatment).canonicalName;
  const listed = listedPrice(canonical === null ? null : services.find((s) => s.name === canonical));
  const owedAlready =
    input.depositAlerted === true && input.deposit?.isRequired === true && (input.deposit.action === "book_and_flag" || input.deposit.action === "hold_and_alert");
  // A chat link (`collect`) is priced from the appointment's own amount.
  const engineUsd =
    (owedAlready || input.deposit?.action === "collect") && input.deposit?.amountUsd != null ? String(input.deposit.amountUsd) : null;
  const [appointment] = await tx.db
    .insert(appointments)
    .values({
      clinicId: tx.clinicId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      scheduledFor: input.scheduledFor,
      treatment: input.treatment,
      depositUsd: input.deposit ? engineUsd : depositPolicy?.required && depositPolicy.amountUsd !== null ? String(depositPolicy.amountUsd) : null,
      depositStatus: owedAlready || (!input.deposit && depositPolicy?.required) ? "pending_front_desk" : "none",
      // The desk confirmed it; the clinic's own system has not reported it
      // back to us, and may never. See schema.ts.
      externalConfirmedAt: null,
      durationMinutes: input.durationMinutes,
      bookingOrigin: input.bookingOrigin,
      calendarEventKey: input.calendarEventKey,
      calendarId: input.calendarId,
      listedPriceCents: listed?.cents ?? null,
      listedPriceKind: listed?.kind ?? null,
      ...(input.written
        ? {
            calendarWriteStatus: "written" as const,
            calendarWrittenAt: input.written.at,
            externalAppointmentId: input.written.externalId,
            externalSource: GOOGLE_CALENDAR_PROVIDER,
          }
        : {}),
    })
    .returning({ id: appointments.id });
  if (input.deposit && !owedAlready) await recordDepositOutcome(tx, input.deposit, { appointmentId: appointment!.id });
  return appointment!.id;
}

function codeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
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

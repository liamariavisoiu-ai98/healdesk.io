import { createHash, randomBytes } from "node:crypto";

import { findClinicalContent } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { agentConfigs, appointments, bookingRequests, clinics, contacts, metaBookingDrafts, reportRecipients } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import type { MetaPlatform } from "./front-door";

/**
 * The booking hand-off, for every channel.
 *
 * Decision of 21 September 2026: no agent — phone, web or Meta — confirms a
 * booking. Each one takes a REQUEST (a name, a number, a preferred day or
 * time, and on the phone the service asked for), hands it to the practice
 * through a single-use link, and tells the person the practice will confirm.
 * The desk has the final say from that page: confirm a slot, which is the
 * moment the appointment row comes into existence; accept with "we'll call
 * back"; or decline. The only confirmation a patient ever hears comes from a
 * human at the practice, by phone, or as a fixed line on the Meta thread that
 * names no time.
 *
 * Why the exposure is lower this way: an agent that states a time on a
 * channel is making a promise the clinic's calendar may not keep, and on a
 * Meta thread it is also writing an appointment into a platform with no BAA.
 * A request is neither. The appointment row, which the revenue report counts,
 * is created by the desk's click and nothing else.
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
 * (drizzle/0024, 0037, 0039).
 *
 * ## What never leaves the tenant
 *
 * The email to the desk names the clinic and the channel and carries a link.
 * No name, no number, no window, no service: it may travel over a transport
 * with no BAA behind it (`phiClass: "none"`), and the details are on the page
 * the link opens. The audit rows say a request was made and decided, never
 * for whom.
 */

/** How long the desk's link stays good. A weekend plus a slow Monday. */
export const BOOKING_REQUEST_TTL_DAYS = 7;
/** A draft nobody finished in a day is abandoned, and its phone number goes with it. */
export const DRAFT_TTL_HOURS = 24;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "booking-link" };

export type BookingChannel = "voice" | "meta";
export type BookingThread = { platform: MetaPlatform; externalId: string; senderId: string };

export type BookingFields = {
  firstName: string | null;
  phone: string | null;
  preferredWindow: string | null;
};

export type CompleteBookingFields = { [K in keyof BookingFields]: string };

/**
 * What the model extracted, made safe to keep.
 *
 * A first name is letters only and short; a phone must normalise to E.164
 * or it is not a phone; a preferred window is free text but must contain no
 * clinical content, because "Tuesday, for my rosacea" is a diagnosis on a
 * row that exists to be emailed about. A field that fails is simply missing,
 * and the assistant asks again.
 */
export function cleanBookingFields(raw: { first_name?: unknown; phone?: unknown; window?: unknown } | null | undefined): BookingFields {
  const text = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null;
  const name = text(raw?.first_name, 40);
  const firstName = name && /^[\p{L}][\p{L}' -]*$/u.test(name) ? name : null;
  const phoneRaw = text(raw?.phone, 32);
  const phone = phoneRaw ? (toE164(phoneRaw) ?? null) : null;
  const window = text(raw?.window, 120);
  const preferredWindow = window && windowIsClean(window) ? window : null;
  return { firstName, phone, preferredWindow };
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

export function isComplete(fields: BookingFields): fields is CompleteBookingFields {
  return Boolean(fields.firstName && fields.phone && fields.preferredWindow);
}

/** In the words the assistant should use when asking. */
export function missingPieces(fields: BookingFields): string[] {
  const out: string[] = [];
  if (!fields.firstName) out.push("their first name");
  if (!fields.phone) out.push("a phone number the practice can call");
  if (!fields.preferredWindow) out.push("a preferred day or time");
  return out;
}

/** Merge what this message added into the thread's draft and return the whole. */
export async function mergeDraft(tx: TenantTx, thread: BookingThread, fields: BookingFields): Promise<BookingFields> {
  await tx.db
    .delete(metaBookingDrafts)
    .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), lt(metaBookingDrafts.updatedAt, sql`now() - make_interval(hours => ${DRAFT_TTL_HOURS})`)));
  const [existing] = await tx.db
    .select({ firstName: metaBookingDrafts.firstName, phone: metaBookingDrafts.phone, preferredWindow: metaBookingDrafts.preferredWindow })
    .from(metaBookingDrafts)
    .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), eq(metaBookingDrafts.platform, thread.platform), eq(metaBookingDrafts.senderId, thread.senderId)))
    .limit(1);
  const merged: BookingFields = {
    firstName: fields.firstName ?? existing?.firstName ?? null,
    phone: fields.phone ?? existing?.phone ?? null,
    preferredWindow: fields.preferredWindow ?? existing?.preferredWindow ?? null,
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

export type CreatedBookingRequest = { id: string; token: string; expiresAt: Date };

export type CreateBookingRequestInput =
  | {
      channel: "meta";
      thread: BookingThread;
      connectionId: string | null;
      fields: CompleteBookingFields;
    }
  | {
      channel: "voice";
      /** The caller, already upserted by the ingest. */
      contactId: string;
      conversationId: string;
      preferredWindow: string;
      treatment: string | null;
    };

/**
 * The request row and the desk's token — returned once, to be put into
 * exactly one email. A Meta request also upserts its contact by phone and
 * deletes its draft, in the same transaction.
 */
export async function createBookingRequest(tx: TenantTx, input: CreateBookingRequestInput): Promise<CreatedBookingRequest> {
  let contactId: string;
  if (input.channel === "voice") {
    contactId = input.contactId;
  } else {
    const [clinic] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
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

  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  raw.fill(0);
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
      treatment: input.channel === "voice" ? input.treatment : null,
      tokenHash: hashToken(token),
      expiresAt: sql`now() + make_interval(days => ${BOOKING_REQUEST_TTL_DAYS})`,
    })
    .returning({ id: bookingRequests.id, expiresAt: bookingRequests.expiresAt });
  if (!row) throw new Error("Failed to create a booking request: no row returned.");

  if (input.channel === "meta") {
    await tx.db
      .delete(metaBookingDrafts)
      .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), eq(metaBookingDrafts.platform, input.thread.platform), eq(metaBookingDrafts.senderId, input.thread.senderId)));
  }

  tx.audit.record({
    action: "create",
    resourceType: "booking_request",
    resourceId: row.id,
    resourceIds: [contactId],
    metadata: { channel: input.channel, platform: input.channel === "meta" ? input.thread.platform : undefined, expiresInDays: BOOKING_REQUEST_TTL_DAYS },
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

/**
 * Tell the desk. One email per report recipient, carrying the link and
 * nothing about the person; "none" because there is nothing in it a BAA
 * would need to cover. A clinic with no recipient is logged, not failed —
 * the request still exists and the care view shows it waiting.
 */
export async function notifyDesk(
  tx: TenantTx,
  created: { id: string; token: string },
  via: { channel: BookingChannel; platform: MetaPlatform | null },
  deps: { transport?: EmailTransport } = {},
): Promise<{ status: "sent" | "no-recipients" | "failed"; recipients: number }> {
  const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const clinicName = clinic?.name ?? "your practice";
  const recipients = await tx.db
    .select({ email: reportRecipients.email })
    .from(reportRecipients)
    .where(and(eq(reportRecipients.clinicId, tx.clinicId), sql`${reportRecipients.unsubscribedAt} is null`));
  if (recipients.length === 0) {
    log.warn("booking request has no desk to notify", { clinicId: tx.clinicId, requestId: created.id });
    return { status: "no-recipients", recipients: 0 };
  }
  const transport = deps.transport ?? getTransport("none");
  const url = bookingRequestUrl(created.token);
  const label = channelLabel(via.channel, via.platform);
  const subject = `New booking request via ${label} — ${clinicName}`;
  const text = [
    `Someone contacted ${clinicName} through ${label} asking to book.`,
    "",
    "Open the request to see who, their number and when they'd like to come in, then confirm a time, call them back, or decline:",
    "",
    url,
    "",
    `The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose. Nothing is booked until you confirm it, and the person has only been told that you will call to confirm.`,
  ].join("\n");
  const html = `<p>Someone contacted <strong>${escapeHtml(clinicName)}</strong> through ${label} asking to book.</p><p>Open the request to see who, their number and when they'd like to come in, then confirm a time, call them back, or decline:</p><p><a href="${url}">${url}</a></p><p>The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose. Nothing is booked until you confirm it, and the person has only been told that you will call to confirm.</p>`;

  let sent = 0;
  for (const r of recipients) {
    try {
      const result = await transport.send({ to: r.email, clinicId: tx.clinicId, clinicName }, { subject, text, html, phiClass: "none" });
      if (result.status !== "failed") sent += 1;
      else log.error("booking request notice failed", { clinicId: tx.clinicId, requestId: created.id, reason: result.reason });
    } catch (error) {
      log.error("booking request notice threw", { clinicId: tx.clinicId, requestId: created.id, error: describeError(error) });
    }
  }
  if (sent === 0) return { status: "failed", recipients: recipients.length };
  await tx.db.update(bookingRequests).set({ deskNotifiedAt: new Date() }).where(and(eq(bookingRequests.id, created.id), eq(bookingRequests.clinicId, tx.clinicId)));
  tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: created.id, metadata: { outcome: "desk_notified", recipients: sent } });
  return { status: "sent", recipients: sent };
}

/** What the person is told once the request exists. Fixed text; a name, never a number or a time. */
export function requestReceivedLine(clinicName: string, firstName: string): string {
  return `Thanks, ${firstName}! ${clinicName} has your request and will call you on the number you gave to confirm. Nothing is booked until you hear from them — or call the practice directly if you'd rather not wait.`;
}

export type BookingDecision = "accepted" | "declined" | "confirmed";

/** What the person is told on a Meta thread after the desk decides. Never a time, never a provider. */
export function followUpLine(clinicName: string, decision: BookingDecision): string {
  switch (decision) {
    case "confirmed":
      return `Good news — ${clinicName} has confirmed your request. They'll call or message you with the details, so keep an eye on your phone.`;
    case "accepted":
      return `Good news — ${clinicName} has accepted your request and will call you to confirm the details. Nothing further is needed from you here.`;
    case "declined":
      return `${clinicName} has looked at your request and can't offer that window, but they'll call you to find a time that works.`;
  }
}

export type ResolvedBookingRequest = {
  id: string;
  clinicId: string;
  clinicName: string;
  channel: BookingChannel;
  platform: MetaPlatform | null;
  firstName: string | null;
  phone: string | null;
  preferredWindow: string;
  treatment: string | null;
  status: "requested" | "accepted" | "confirmed" | "declined" | "expired";
  createdAt: Date;
  decidedAt: Date | null;
  decidedByLabel: string | null;
  deskNote: string | null;
  confirmedFor: Date | null;
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
        treatment: bookingRequests.treatment,
        status: bookingRequests.status,
        createdAt: bookingRequests.createdAt,
        decidedAt: bookingRequests.decidedAt,
        decidedByLabel: bookingRequests.decidedByLabel,
        deskNote: bookingRequests.deskNote,
        confirmedFor: bookingRequests.confirmedFor,
        expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
        clinicName: clinics.name,
        firstName: contacts.fullName,
        phone: contacts.phone,
      })
      .from(bookingRequests)
      .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
      .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
      .where(eq(bookingRequests.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.expired) {
      tx.audit.record({ action: "read", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "rejected", reason: "expired" } });
      return null;
    }
    tx.audit.record({ action: "read", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "opened", status: row.status } });
    return {
      id: row.id,
      clinicId,
      clinicName: row.clinicName,
      channel: row.channel,
      platform: row.platform,
      firstName: row.firstName,
      phone: row.phone,
      preferredWindow: row.preferredWindow,
      treatment: row.treatment,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedByLabel: row.decidedByLabel,
      deskNote: row.deskNote,
      confirmedFor: row.confirmedFor,
    };
  });
}

export type DecisionOutcome = {
  outcome: "decided" | "already-decided" | "invalid";
  /** null when the channel has nothing to say on (a phone request: the desk calls). */
  followUp: "sent" | "failed" | "no-channel" | null;
  appointmentId: string | null;
};

/**
 * The desk's answer. One conditional UPDATE decides who wins a double
 * click; the trigger in 0039 makes the decision final, with one permitted
 * second step (accepted → confirmed). Confirming a slot is the one place in
 * the product an appointment row is created from an agent's conversation:
 * the desk's click, not the agent's word, is the booking. Then, on a Meta
 * thread, the person is told through the clinic's sealed token — the fixed
 * line above, never the desk's note and never the time.
 */
export async function decideBookingRequest(
  token: string,
  decision: BookingDecision,
  input: { decidedByLabel: string | null; deskNote: string | null; confirmedFor?: Date | null; treatment?: string | null; request?: RequestContext },
  send?: MetaSender,
): Promise<DecisionOutcome> {
  const none: DecisionOutcome = { outcome: "invalid", followUp: null, appointmentId: null };
  const hash = hashIfWellFormed(token);
  if (!hash) return none;
  if (decision === "confirmed" && !(input.confirmedFor instanceof Date && Number.isFinite(input.confirmedFor.getTime()))) return none;
  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return none;

  return withTenant({ clinicId, actor: LINK_ACTOR, request: input.request }, async (tx) => {
    const from: ("requested" | "accepted")[] = decision === "confirmed" ? ["requested", "accepted"] : ["requested"];
    const [candidate] = await tx.db
      .select({
        id: bookingRequests.id,
        status: bookingRequests.status,
        contactId: bookingRequests.contactId,
        conversationId: bookingRequests.conversationId,
        treatment: bookingRequests.treatment,
        expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
      })
      .from(bookingRequests)
      .where(eq(bookingRequests.tokenHash, hash))
      .limit(1);
    const decidable = candidate && !candidate.expired && from.includes(candidate.status as "requested");
    if (!decidable) {
      const outcome = candidate && !candidate.expired ? "already-decided" : "invalid";
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate?.id, metadata: { outcome: "rejected", reason: outcome } });
      return { outcome, followUp: null, appointmentId: null };
    }

    // Confirming creates the appointment FIRST, so the status and the
    // appointment id land in one statement: the table's shape check says a
    // confirmed row always has both, and a check is judged per statement.
    let appointmentId: string | null = null;
    if (decision === "confirmed") {
      // The agent's script carries the clinic's deposit rule; with no payment
      // link path, a required deposit is owed to the front desk.
      const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
      const depositPolicy = agent?.depositPolicy ?? null;
      const treatment = input.treatment?.trim().slice(0, 120) || candidate.treatment;
      const [appointment] = await tx.db
        .insert(appointments)
        .values({
          clinicId: tx.clinicId,
          contactId: candidate.contactId,
          conversationId: candidate.conversationId,
          scheduledFor: input.confirmedFor!,
          treatment,
          depositUsd: depositPolicy?.required && depositPolicy.amountUsd !== null ? String(depositPolicy.amountUsd) : null,
          depositStatus: depositPolicy?.required ? "pending_front_desk" : "none",
          // The desk confirmed it; the clinic's own system has not reported it
          // back to us, and may never. See schema.ts.
          externalConfirmedAt: null,
        })
        .returning({ id: appointments.id });
      appointmentId = appointment!.id;
    }

    // One conditional UPDATE decides who wins a double click.
    const [row] = await tx.db
      .update(bookingRequests)
      .set({
        status: decision,
        decidedAt: sql`now()`,
        decidedByLabel: input.decidedByLabel?.trim().slice(0, 80) || null,
        deskNote: input.deskNote?.trim().slice(0, 500) || null,
        ...(decision === "confirmed" ? { confirmedFor: input.confirmedFor!, appointmentId } : {}),
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
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: candidate.id, metadata: { outcome: "rejected", reason: "already-decided" } });
      return { outcome: "already-decided", followUp: null, appointmentId: null };
    }
    if (appointmentId) {
      tx.audit.record({
        action: "create",
        resourceType: "appointment",
        resourceId: appointmentId,
        metadata: { conversationId: candidate.conversationId ?? undefined, bookingRequestId: row.id, confirmedByDesk: true, confirmedByClinicSystem: false },
      });
    }
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "decided", decision, channel: row.channel } });

    if (row.channel !== "meta") return { outcome: "decided", followUp: null, appointmentId };
    if (!row.connectionId || !row.platform || !row.externalId || !row.senderId) return { outcome: "decided", followUp: "no-channel", appointmentId };
    const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
    const owner: MetaChannelOwner = { clinicId: tx.clinicId, connectionId: row.connectionId, platform: row.platform, enabled: true };
    try {
      await sendMetaReply(tx, owner, row.externalId, row.senderId, followUpLine(clinic?.name ?? "The practice", decision), send);
      tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: row.platform, source: "booking_follow_up" } });
      return { outcome: "decided", followUp: "sent", appointmentId };
    } catch (error) {
      log.error("booking follow-up not sent", { clinicId: tx.clinicId, requestId: row.id, error: describeError(error) });
      return { outcome: "decided", followUp: "failed", appointmentId };
    }
  });
}

/** Counts only, for the care view. */
export async function bookingRequestCounts(tx: TenantTx): Promise<{ waiting: number; accepted: number; confirmed: number; declined: number }> {
  const rows = await tx.db
    .select({ status: bookingRequests.status, n: sql<number>`count(*)::int` })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), gt(bookingRequests.expiresAt, sql`now() - interval '30 days'`)))
    .groupBy(bookingRequests.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<string, number>>;
  return { waiting: by.requested ?? 0, accepted: by.accepted ?? 0, confirmed: by.confirmed ?? 0, declined: by.declined ?? 0 };
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

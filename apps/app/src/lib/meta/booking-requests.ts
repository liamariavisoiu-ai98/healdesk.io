import { createHash, randomBytes } from "node:crypto";

import { findClinicalContent } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, eq, gt, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { bookingRequests, clinics, contacts, metaBookingDrafts, reportRecipients } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { sendMetaReply, type MetaChannelOwner, type MetaSender } from "./channels";
import type { MetaPlatform } from "./front-door";

/**
 * The booking hand-off from a Meta channel.
 *
 * Decision of 21 September 2026: the front door stays a front door ("keep A
 * everywhere"), but it must hand the practice a booking that a human accepts
 * or declines, so that both sides get some confirmation — even half of one.
 *
 * So the assistant books nothing and promises nothing. Across a thread it
 * collects three things — a first name, a phone number, a preferred day or
 * time — and when it has all three this module writes ONE row, emails the
 * practice a single-use link, and tells the person the practice has their
 * request. The desk opens the link, sees the three things, and accepts or
 * declines; the person is then told, on the channel they used, that the
 * practice will call them. A time is never stated on the channel, in either
 * direction, because Meta's terms and the absence of a BAA make the channel
 * the wrong place for it (docs/launch-plan.md, "a front door, not a hallway").
 *
 * ## What is stored, and where
 *
 * `meta_booking_drafts` is the half-collected request keyed by the thread, so
 * the next message can ask for the missing piece without this code
 * remembering any of the conversation. It is overwritten per message,
 * deleted when the request is created, and swept after a day.
 *
 * `booking_requests` is the request. Its contact row is upserted by phone
 * like a caller's (lib/voice/ingest.ts), so the person the desk rings is the
 * same contact the phone agent would create. The desk's credential is
 * SHA-256(token), never the token — the same discipline, and the same
 * bootstrap RLS policy, as connection_links (drizzle/0024, 0037).
 *
 * ## What never leaves the tenant
 *
 * The email to the desk names the clinic and the platform and carries a link.
 * No name, no number, no window: it may travel over a transport with no BAA
 * behind it (`phiClass: "none"`), and the details are on the page the link
 * opens. The audit rows say a request was made and decided, never for whom.
 */

/** How long the desk's link stays good. A weekend plus a slow Monday. */
export const BOOKING_REQUEST_TTL_DAYS = 7;
/** A draft nobody finished in a day is abandoned, and its phone number goes with it. */
export const DRAFT_TTL_HOURS = 24;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LINK_ACTOR: ActorContext = { type: "service", serviceName: "booking-link" };

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
  const preferredWindow =
    window && findClinicalContent({ window }).length === 0 && !WINDOW_REFUSED.test(window) && !/\d{7,}/.test(window) ? window : null;
  return { firstName, phone, preferredWindow };
}

/**
 * A preferred window is a day or a time, not a reason. The catalog matcher
 * catches clinical CLAIMS; this catches a condition, a treatment or a "for
 * my …" slipping into the one free-text field this table has.
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

/**
 * The request row, its contact, and the desk's token — returned once, to be
 * put into exactly one email. The draft is deleted in the same transaction.
 */
export async function createBookingRequest(
  tx: TenantTx,
  input: { thread: BookingThread; fields: CompleteBookingFields; connectionId: string | null },
): Promise<CreatedBookingRequest> {
  const [clinic] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const [existing] = await tx.db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.phone, input.fields.phone)))
    .limit(1);
  let contactId = existing?.id;
  if (!contactId) {
    const [created] = await tx.db
      .insert(contacts)
      .values({ clinicId: tx.clinicId, phone: input.fields.phone, fullName: input.fields.firstName, timezone: clinic?.timezone ?? null, updatedAt: new Date() })
      .returning({ id: contacts.id });
    contactId = created!.id;
  }

  const raw = randomBytes(TOKEN_BYTES);
  const token = raw.toString("base64url");
  raw.fill(0);
  const [row] = await tx.db
    .insert(bookingRequests)
    .values({
      clinicId: tx.clinicId,
      contactId,
      platform: input.thread.platform,
      externalId: input.thread.externalId,
      senderId: input.thread.senderId,
      connectionId: input.connectionId,
      preferredWindow: input.fields.preferredWindow,
      tokenHash: hashToken(token),
      expiresAt: sql`now() + make_interval(days => ${BOOKING_REQUEST_TTL_DAYS})`,
    })
    .returning({ id: bookingRequests.id, expiresAt: bookingRequests.expiresAt });
  if (!row) throw new Error("Failed to create a booking request: no row returned.");

  await tx.db
    .delete(metaBookingDrafts)
    .where(and(eq(metaBookingDrafts.clinicId, tx.clinicId), eq(metaBookingDrafts.platform, input.thread.platform), eq(metaBookingDrafts.senderId, input.thread.senderId)));

  tx.audit.record({
    action: "create",
    resourceType: "booking_request",
    resourceId: row.id,
    resourceIds: [contactId],
    metadata: { platform: input.thread.platform, expiresInDays: BOOKING_REQUEST_TTL_DAYS },
  });
  return { id: row.id, token, expiresAt: row.expiresAt };
}

export const PLATFORM_LABEL: Record<MetaPlatform, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" };

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
  platform: MetaPlatform,
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
  const via = PLATFORM_LABEL[platform];
  const subject = `New booking request via ${via} — ${clinicName}`;
  const text = [
    `Someone messaged ${clinicName} on ${via} asking to book.`,
    "",
    "Open the request to see who, their number and when they'd like to come in, then accept or decline it:",
    "",
    url,
    "",
    `The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose. Nothing is booked until you accept, and the person has only been told that you have their request.`,
  ].join("\n");
  const html = `<p>Someone messaged <strong>${escapeHtml(clinicName)}</strong> on ${via} asking to book.</p><p>Open the request to see who, their number and when they'd like to come in, then accept or decline it:</p><p><a href="${url}">${url}</a></p><p>The link works for ${BOOKING_REQUEST_TTL_DAYS} days and is for your front desk only. This email carries no patient details on purpose. Nothing is booked until you accept, and the person has only been told that you have their request.</p>`;

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

export type BookingDecision = "accepted" | "declined";

/** What the person is told after the desk decides. Never a time, never a provider. */
export function followUpLine(clinicName: string, decision: BookingDecision): string {
  return decision === "accepted"
    ? `Good news — ${clinicName} has accepted your request and will call you to confirm the details. Nothing further is needed from you here.`
    : `${clinicName} has looked at your request and can't offer that window, but they'll call you to find a time that works.`;
}

export type ResolvedBookingRequest = {
  id: string;
  clinicId: string;
  clinicName: string;
  platform: MetaPlatform;
  firstName: string | null;
  phone: string | null;
  preferredWindow: string;
  status: "requested" | "accepted" | "declined" | "expired";
  createdAt: Date;
  decidedAt: Date | null;
  decidedByLabel: string | null;
  deskNote: string | null;
};

/**
 * What the holder of the link may see, or null. Expired, unknown and
 * malformed are one null, and the open is recorded either way — a decided
 * request still renders (read-only) so a second click on the same email
 * shows the outcome rather than a dead end.
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
        platform: bookingRequests.platform,
        preferredWindow: bookingRequests.preferredWindow,
        status: bookingRequests.status,
        createdAt: bookingRequests.createdAt,
        decidedAt: bookingRequests.decidedAt,
        decidedByLabel: bookingRequests.decidedByLabel,
        deskNote: bookingRequests.deskNote,
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
      platform: row.platform,
      firstName: row.firstName,
      phone: row.phone,
      preferredWindow: row.preferredWindow,
      status: row.status,
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      decidedByLabel: row.decidedByLabel,
      deskNote: row.deskNote,
    };
  });
}

export type DecisionOutcome = {
  outcome: "decided" | "already-decided" | "invalid";
  followUp: "sent" | "failed" | "no-channel" | null;
};

/**
 * The desk's answer. One conditional UPDATE decides who wins a double
 * click; the trigger in 0037 makes a decided row immovable after that. Then
 * the person is told, through the clinic's sealed token, that the practice
 * will call — the fixed line above, never the desk's note.
 */
export async function decideBookingRequest(
  token: string,
  decision: BookingDecision,
  input: { decidedByLabel: string | null; deskNote: string | null; request?: RequestContext },
  send?: MetaSender,
): Promise<DecisionOutcome> {
  const hash = hashIfWellFormed(token);
  if (!hash) return { outcome: "invalid", followUp: null };
  const clinicId = await clinicForTokenHash(hash);
  if (!clinicId) return { outcome: "invalid", followUp: null };

  return withTenant({ clinicId, actor: LINK_ACTOR, request: input.request }, async (tx) => {
    const [row] = await tx.db
      .update(bookingRequests)
      .set({
        status: decision,
        decidedAt: sql`now()`,
        decidedByLabel: input.decidedByLabel?.trim().slice(0, 80) || null,
        deskNote: input.deskNote?.trim().slice(0, 500) || null,
      })
      .where(and(eq(bookingRequests.tokenHash, hash), eq(bookingRequests.status, "requested"), gt(bookingRequests.expiresAt, sql`now()`)))
      .returning({
        id: bookingRequests.id,
        platform: bookingRequests.platform,
        externalId: bookingRequests.externalId,
        senderId: bookingRequests.senderId,
        connectionId: bookingRequests.connectionId,
      });
    if (!row) {
      const [existing] = await tx.db
        .select({ id: bookingRequests.id, status: bookingRequests.status, expired: sql<boolean>`${bookingRequests.expiresAt} <= now()` })
        .from(bookingRequests)
        .where(eq(bookingRequests.tokenHash, hash))
        .limit(1);
      const outcome = existing && !existing.expired && existing.status !== "requested" ? "already-decided" : "invalid";
      tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: existing?.id, metadata: { outcome: "rejected", reason: outcome } });
      return { outcome, followUp: null };
    }
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: row.id, metadata: { outcome: "decided", decision } });

    if (!row.connectionId) return { outcome: "decided", followUp: "no-channel" };
    const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
    const owner: MetaChannelOwner = { clinicId: tx.clinicId, connectionId: row.connectionId, platform: row.platform, enabled: true };
    try {
      await sendMetaReply(tx, owner, row.externalId, row.senderId, followUpLine(clinic?.name ?? "The practice", decision), send);
      tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: row.platform, source: "booking_follow_up" } });
      return { outcome: "decided", followUp: "sent" };
    } catch (error) {
      log.error("booking follow-up not sent", { clinicId: tx.clinicId, requestId: row.id, error: describeError(error) });
      return { outcome: "decided", followUp: "failed" };
    }
  });
}

/** Counts only, for the care view. */
export async function bookingRequestCounts(tx: TenantTx): Promise<{ waiting: number; accepted: number; declined: number }> {
  const rows = await tx.db
    .select({ status: bookingRequests.status, n: sql<number>`count(*)::int` })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), gt(bookingRequests.expiresAt, sql`now() - interval '30 days'`)))
    .groupBy(bookingRequests.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<string, number>>;
  return { waiting: by.requested ?? 0, accepted: by.accepted ?? 0, declined: by.declined ?? 0 };
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

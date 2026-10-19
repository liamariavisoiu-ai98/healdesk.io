import { toE164 } from "@healdesk/connectors";
import { and, eq, gt, sql } from "drizzle-orm";

import { bookingRequests, clinicChannels, clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { assistantMayAnswer, servicesEnded, type AnswerDecision } from "@/lib/billing/answering";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { describeError, log } from "@/lib/log";
import { cleanFirstName, createBookingRequest } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { upsertCallerContact } from "@/lib/voice/ingest";

import type { WebChatClinic } from "./web-chat";

/**
 * The website's contact form: what the chat widget becomes while website chat
 * is not answering (spec, "Every switch in the portal": paused, the widget
 * "becomes a contact form ... Nothing is lost"; CLAUDE.md, "Failure").
 *
 * It takes three things and nothing else: a first name, a phone number and
 * one of a fixed set of times. No email and no free text: the agreement's
 * clauses allow what a receptionist writes on a callback slip, and a text box
 * is where a diagnosis gets typed. The name passes the same screen as a Meta
 * thread's (cleanFirstName), the number must be a number (toE164), and the
 * time is a choice, never typed.
 *
 * A message is a booking request (`source = 'contact_form'`, channel web
 * chat, no conversation), so it sits under Bookings' Needs you as "Left a
 * message while AYA was off", lapses to Missed like any other request, and
 * raises L20, "A message was left on your website", at once, at any hour, as
 * a pointer. healdesk contacts no one: the person is told the practice will
 * call them back, and the practice does.
 *
 * When it takes messages, read from the answer gate and website chat's
 * channel state (WP1's clinic_channels): whenever website chat has been live
 * and the agreement still covers the clinic, whatever has stopped AYA
 * answering (switched Off, the header's pause, the allowance cap, a
 * suspension), and while she is answering too, for a widget whose chat
 * failed to start. Never for a clinic that has left, whose Services have
 * ended (no agreement in effect, cancelled), that did not buy website chat,
 * or whose website chat has never been live: nothing may be kept for those.
 *
 * Rate-limited twice: per address and clinic in this process, and per clinic
 * from the requests themselves, so several web tasks cannot multiply it.
 */

/** The times a person may pick. Never typed: a choice cannot carry anything else. */
export const CONTACT_TIMES = [
  { id: "any_time", label: "Any time" },
  { id: "mornings", label: "Mornings" },
  { id: "afternoons", label: "Afternoons" },
  { id: "evenings", label: "Evenings" },
] as const;

export type ContactTimeId = (typeof CONTACT_TIMES)[number]["id"];

/** The only fields the form has. Anything else in the body refuses the message. */
export const CONTACT_FIELDS = ["firstName", "phone", "preferredTime"] as const;

/** Per address and clinic, in this process. */
export const CONTACT_LIMIT_PER_ADDRESS = 3;
/** Per clinic, from the requests themselves: across every web task. */
export const CONTACT_LIMIT_PER_CLINIC = 20;
export const CONTACT_WINDOW_MS = 60 * 60 * 1000;

const ACTOR: ActorContext = { type: "agent", serviceName: "web-contact-form" };

/** What the widget shows instead of the chat. */
export type ContactFormOffer = {
  /** False: the form shows the practice's own number and takes nothing. */
  takesMessages: boolean;
  times: readonly { id: ContactTimeId; label: string }[];
};

/** The form that takes nothing: the widget shows the practice's own number. */
export const CLOSED_FORM: ContactFormOffer = { takesMessages: false, times: CONTACT_TIMES };

/** The gate's refusals that leave nothing a message could be kept under. */
function refusesMessages(decision: AnswerDecision): boolean {
  if (decision.decision === "answer") return false;
  return (
    servicesEnded(decision.reason) ||
    decision.reason === "not_purchased" ||
    decision.reason === "channel_not_live"
  );
}

/** Website chat has been live (WP1's clinic_channels.live_at), or the clinic is synthetic and has no row. */
async function webHasBeenLive(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
    .limit(1);
  if (row) return row.liveAt !== null;
  const [clinic] = await tx.db
    .select({ classification: clinics.dataClassification })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return clinic?.classification === "synthetic";
}

/** Whether the form takes a message now, given the gate's decision for website chat. */
export async function contactFormOffer(
  clinic: Pick<WebChatClinic, "clinicId">,
  decision: AnswerDecision,
): Promise<ContactFormOffer> {
  const takesMessages =
    !refusesMessages(decision) &&
    (await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) =>
      (await clinicHasLeft(tx, { lock: false })) ? false : webHasBeenLive(tx),
    ));
  return { takesMessages, times: CONTACT_TIMES };
}

/**
 * The offer for a widget whose chat failed to start or answer (our endpoint
 * failing): asked afresh, and closed if even that fails. Never throws.
 */
export async function contactFormOfferSafely(
  clinic: Pick<WebChatClinic, "clinicId">,
  now: Date = new Date(),
): Promise<ContactFormOffer> {
  try {
    const decision = await assistantMayAnswer({
      clinicId: clinic.clinicId,
      channel: "web",
      now,
      actor: ACTOR,
    });
    return await contactFormOffer(clinic, decision);
  } catch (error) {
    log.error("contact form state not read", {
      clinicId: clinic.clinicId,
      error: describeError(error),
    });
    return CLOSED_FORM;
  }
}

export type ContactFields = { firstName: string; phone: string; time: ContactTimeId };

export type FieldProblem = "first_name" | "phone" | "preferred_time" | "unknown_field";

/** The three fields, cleaned, or what is wrong with them. Never echoes a value. */
export function readContactFields(
  body: Record<string, unknown>,
): { ok: true; fields: ContactFields } | { ok: false; problems: FieldProblem[] } {
  const problems: FieldProblem[] = [];
  if (Object.keys(body).some((key) => !(CONTACT_FIELDS as readonly string[]).includes(key))) {
    problems.push("unknown_field");
  }
  const firstName = cleanFirstName(body.firstName);
  if (!firstName) problems.push("first_name");
  const phone =
    typeof body.phone === "string" && body.phone.length <= 32 ? toE164(body.phone) : null;
  if (!phone) problems.push("phone");
  const time = CONTACT_TIMES.find((t) => t.id === body.preferredTime);
  if (!time) problems.push("preferred_time");
  if (problems.length > 0 || !firstName || !phone || !time) return { ok: false, problems };
  return { ok: true, fields: { firstName, phone, time: time.id } };
}

const hits = new Map<string, number[]>();

/** At most CONTACT_LIMIT_PER_ADDRESS messages an hour from one address to one clinic, in this process. */
export function addressLimited(key: string, now: number = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < CONTACT_WINDOW_MS);
  if (recent.length >= CONTACT_LIMIT_PER_ADDRESS) {
    hits.set(key, recent);
    return true;
  }
  if (hits.size > 10_000) hits.clear();
  hits.set(key, [...recent, now]);
  return false;
}

/** Tests only: forget every address. */
export function __resetContactLimitsForTests(): void {
  hits.clear();
}

/** What the person is told once the message is in. Fixed text, never their own words back. */
export function messageLeftLine(clinicName: string): string {
  return `Thanks. Your message is with ${clinicName}, and they'll call you back on the number you gave. If it's urgent, call the practice directly.`;
}

export type LeaveMessageResult =
  | { status: "received"; reply: string }
  | { status: "invalid"; problems: FieldProblem[] }
  | { status: "closed" }
  | { status: "rate_limited" };

/**
 * Leave a message: the gate and the channel's state, the clinic's limit, then
 * the request and its L20 alert in one transaction. The caller has checked
 * the address limit and the widget's origin (app/api/widget/v1/[slug]/contact).
 */
export async function leaveWebsiteMessage(
  clinic: WebChatClinic,
  body: Record<string, unknown>,
  opts: { now?: Date } = {},
): Promise<LeaveMessageResult> {
  const now = opts.now ?? new Date();
  const read = readContactFields(body);
  if (!read.ok) return { status: "invalid", problems: read.problems };

  const decision = await assistantMayAnswer({
    clinicId: clinic.clinicId,
    channel: "web",
    now,
    actor: ACTOR,
  });
  if (refusesMessages(decision)) return { status: "closed" };

  const { fields } = read;
  const label = CONTACT_TIMES.find((t) => t.id === fields.time)!.label;
  const outcome = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => {
    if ((await clinicHasLeft(tx)) || !(await webHasBeenLive(tx))) return "closed" as const;
    const [recent] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.clinicId, tx.clinicId),
          eq(bookingRequests.source, "contact_form"),
          gt(
            bookingRequests.createdAt,
            sql`now() - make_interval(secs => ${CONTACT_WINDOW_MS / 1000})`,
          ),
        ),
      );
    if ((recent?.n ?? 0) >= CONTACT_LIMIT_PER_CLINIC) return "rate_limited" as const;

    const [row] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    const contactId = await upsertCallerContact(tx.db, {
      clinicId: tx.clinicId,
      phone: fields.phone,
      name: fields.firstName,
      clinicTimezone: row?.timezone ?? "America/New_York",
    });
    const created = await createBookingRequest(tx, {
      channel: "web_chat",
      contactId,
      conversationId: null,
      preferredWindow: label,
      treatment: null,
      source: "contact_form",
    });
    // L20, at once, at any hour: a pointer, in the transaction that keeps the
    // message, so nothing is sent for one that rolls back.
    await notifyBookingAlert(tx, "website_message", {
      bookingRequestId: created.id,
      channel: "web",
    });
    return "received" as const;
  });
  if (outcome === "closed") return { status: "closed" };
  if (outcome === "rate_limited") {
    log.warn("website message refused: the clinic's hourly limit", { clinicId: clinic.clinicId });
    return { status: "rate_limited" };
  }
  return { status: "received", reply: messageLeftLine(clinic.name) };
}

/** For the route's catch: a failure to keep a message is logged by ids only. */
export function logMessageFailure(clinicId: string, error: unknown): void {
  log.error("website message not kept", { clinicId, error: describeError(error) });
}

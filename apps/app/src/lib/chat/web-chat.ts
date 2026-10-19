import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { toE164 } from "@healdesk/connectors";
import { and, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { conversations } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { answerTurn, EMPTY_CAPTURE, FAILURE_LINE, settleUrgentReply, type AssistantResponder, type BookingCapture } from "@/lib/assistant/turn";
import { assistantMayAnswer } from "@/lib/billing/answering";
import { recordUsage } from "@/lib/billing/usage";
import { noteWidgetLoaded, recordFirstAnswer } from "@/lib/channels/events";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { disclosureFor } from "@/lib/compliance/disclosure";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import {
  openChatTranscript,
  readOpenChat,
  sendQueuedTranscriptNow,
  updateOpenChat,
  type OpenChatState,
} from "@/lib/conversations/transcript-outbox";
import { deliverCriticalAfterCommit } from "@/lib/email/outbox";
import { env } from "@/lib/env";
import { identifierRef } from "@/lib/identifier-ref";
import { describeError, log } from "@/lib/log";
import { createBookingRequest } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { upsertCallerContact } from "@/lib/voice/ingest";

/**
 * The web chat on a clinic's own website: the server side of the widget
 * (CLAUDE.md: "every request that carries a visitor's words goes to
 * apps/app"). The API routes are app/api/widget/v1/[slug]/*.
 *
 * A conversation, start to end:
 *
 *   start    the widget names the clinic by its public slug. The answer gate
 *            (lib/billing/answering.ts) decides whether the assistant may
 *            answer at all; if not, the widget shows the clinic's contact
 *            form instead (CLAUDE.md, "Failure": website chat becomes a
 *            contact form). Otherwise it gets the opening line, the locked AI
 *            line and the clinic's chat greeting, and a signed token.
 *   message  the first message makes the conversation (a conversations row,
 *            channel web_chat), counts it once (chat_conversations), and opens
 *            its transcript row, sealed (lib/conversations/transcript-outbox.ts,
 *            status open). Each message is answered by the shared brain
 *            (lib/assistant/turn.ts: card numbers cut, urgent content
 *            answered with a fixed line before the model, the guard after it)
 *            and the sealed copy is rewritten with the new turns.
 *   request  once the visitor has given a first name, a number and a time,
 *            one booking request is written for the desk (channel web_chat)
 *            and the clinic is alerted (L7, lib/notices/booking-alerts.ts):
 *            a pointer into the portal, never the details.
 *   alerts   an urgent message queues the urgent alert (L12) in the
 *            message's own transaction, sent the moment it commits; a
 *            request for a person queues the handover alert (L11). Each is
 *            once per chat, and the chat stays escalated from then on.
 *   end      when the visitor ends the chat, or after thirty quiet minutes,
 *            the transcript goes to the clinic by email, and healdesk deletes
 *            its sealed copy the moment the clinic's mail server confirms
 *            delivery (never later than 30 days after the chat began).
 *
 * The token is the visitor's only handle on the chat: an HMAC-signed note of
 * the clinic, the conversation and the session, with nothing the visitor
 * wrote. The conversation itself is never in the browser beyond what the
 * widget shows.
 */

export type WebChatClinic = { clinicId: string; name: string; website: string | null };

export type WebChatToken = { clinicId: string; conversationId: string | null; sessionId: string; issuedAt: number };

/**
 * What the chat keeps between messages, sealed with the transcript.
 * `urgentAlerted` says an urgent message came in (the name predates the
 * alert; a chat open across a deploy still carries it), `handedOver` that
 * someone asked for a person. Either keeps the chat escalated to the end.
 */
type ChatState = { capture: BookingCapture; requestId: string | null; urgentAlerted: boolean; handedOver?: boolean; openedAt: string };

export type WebChatReply =
  | { mode: "chat"; reply: string; token: string; ended: boolean }
  | { mode: "contact_form"; reason: string };

const ACTOR: ActorContext = { type: "agent", serviceName: "web-chat" };
/** A token older than this starts a new conversation. */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** A chat longer than this many turns is ended and a new one begins. */
const MAX_TURNS = 120;

// -----------------------------------------------------------------------------
// The clinic and the browser
// -----------------------------------------------------------------------------

export async function webChatClinic(slug: string): Promise<WebChatClinic | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;
  const result = await unsafeDb.execute<{ clinic_id: string; name: string; website: string | null }>(
    sql`select clinic_id, name, website from app_web_chat_clinic(${slug})`,
  );
  const row = (result as unknown as { rows: { clinic_id: string; name: string; website: string | null }[] }).rows[0];
  return row ? { clinicId: String(row.clinic_id), name: row.name, website: row.website } : null;
}

/**
 * Whether a browser on `origin` may use this clinic's chat: its own website's
 * host, with or without www, or a subdomain of it, over https (http only for
 * localhost, for a clinic testing its own page). A clinic with no website on
 * file is answered from any origin: the chat carries no ambient credential,
 * so a stranger's page can only spend that clinic's own allowance.
 */
export function originAllowed(origin: string | null, website: string | null): boolean {
  if (!website) return true;
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return true;
  if (url.protocol !== "https:") return false;
  const site = website.toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
  return host === site || host === `www.${site}` || host.endsWith(`.${site}`);
}

/** A page served from the visitor's own machine: the clinic trying its widget locally. */
export function isLocalOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * The request says it comes from the clinic's own website: an origin
 * `originAllowed` accepts for the website on file, and not a local page. A
 * clinic with no website on file has no site to be seen on, so this is never
 * true for one. Only a reason to ask an operator to look: any client can
 * send any Origin (lib/channels/events.ts noteWidgetLoaded).
 */
export function isClinicSiteOrigin(origin: string | null, website: string | null): boolean {
  if (!website || !origin || isLocalOrigin(origin)) return false;
  return originAllowed(origin, website);
}

// -----------------------------------------------------------------------------
// The token
// -----------------------------------------------------------------------------

function tokenKey(): Buffer {
  return createHmac("sha256", env.betterAuthSecret()).update("healdesk web chat token v1").digest();
}

export function signToken(token: WebChatToken): string {
  const body = Buffer.from(
    JSON.stringify({ c: token.clinicId, v: token.conversationId, s: token.sessionId, t: token.issuedAt }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", tokenKey()).update(body).digest("base64url")}`;
}

export function readToken(value: unknown, clinicId: string, now: Date = new Date()): WebChatToken | null {
  if (typeof value !== "string" || value.length > 600) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", tokenKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { c?: unknown; v?: unknown; s?: unknown; t?: unknown };
    if (parsed.c !== clinicId || typeof parsed.s !== "string" || typeof parsed.t !== "number") return null;
    if (now.getTime() - parsed.t > TOKEN_TTL_MS) return null;
    return {
      clinicId,
      conversationId: typeof parsed.v === "string" ? parsed.v : null,
      sessionId: parsed.s,
      issuedAt: parsed.t,
    };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The conversation
// -----------------------------------------------------------------------------

function openingLine(facts: Pick<AssistantFacts, "clinicName" | "greeting">): string {
  return `${disclosureFor({ clinicName: facts.clinicName, channel: "web_chat" })} ${facts.greeting.chat}`;
}

/**
 * Start: the gate, then the opening line and a token with no conversation
 * yet. A start that says it comes from the clinic's own website asks an
 * operator, once, to confirm the line is on the site; it records nothing,
 * because an Origin header is never proof (lib/channels/events.ts).
 */
export async function startWebChat(clinic: WebChatClinic, now: Date = new Date(), origin: string | null = null): Promise<{ mode: "chat"; opening: string; token: string } | { mode: "contact_form"; reason: string }> {
  if (isClinicSiteOrigin(origin, clinic.website)) await noteWidgetLoaded(clinic.clinicId, { actor: ACTOR });
  const decision = await assistantMayAnswer({ clinicId: clinic.clinicId, channel: "web", now, actor: ACTOR });
  if (decision.decision === "pass_through") return { mode: "contact_form", reason: decision.reason };
  const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => ((await clinicHasLeft(tx)) ? null : assistantFacts(tx)));
  if (!facts) return { mode: "contact_form", reason: "clinic_left" };
  const token = signToken({ clinicId: clinic.clinicId, conversationId: null, sessionId: randomBytes(16).toString("base64url"), issuedAt: now.getTime() });
  return { mode: "chat", opening: openingLine(facts), token };
}

type Deps = {
  responder: AssistantResponder | null;
  transport?: EmailTransport;
  now?: Date;
  /**
   * The route's after() (next/server), so the urgent alert goes once the
   * response is on its way; without it the alert is sent before this returns.
   */
  after?: (task: () => Promise<void>) => void;
  /** The page's origin, as the route saw it: a local page's chat is never website chat's first answer. */
  origin?: string | null;
};

/** A complete request: a first name, a number that is a number, and a time. */
function requestReady(capture: BookingCapture): { firstName: string; phone: string; window: string } | null {
  if (!capture.wants || !capture.firstName || !capture.window || !capture.phone) return null;
  const phone = toE164(capture.phone);
  if (!phone) return null;
  return { firstName: capture.firstName, phone, window: capture.window };
}

async function takeRequest(tx: TenantTx, facts: AssistantFacts, conversationId: string, capture: BookingCapture): Promise<string | null> {
  const ready = requestReady(capture);
  if (!ready) return null;
  const contactId = await upsertCallerContact(tx.db, { clinicId: tx.clinicId, phone: ready.phone, name: ready.firstName, clinicTimezone: facts.timeZone });
  const created = await createBookingRequest(tx, {
    channel: "web_chat",
    contactId,
    conversationId,
    preferredWindow: ready.window,
    treatment: capture.service,
    alternativeWindows: capture.altWindows,
    collectedFields: capture.fields,
  });
  // In the request's own transaction: the alert goes only if the request commits.
  await notifyBookingAlert(tx, "booking_request", { bookingRequestId: created.id, conversationId, channel: "web" });
  return created.id;
}

/**
 * One visitor message. Never throws for anything the visitor did: a refused
 * token starts a new conversation, and a failure answers with the fixed line.
 */
export async function sendWebChatMessage(clinic: WebChatClinic, rawToken: unknown, rawText: unknown, deps: Deps): Promise<WebChatReply | { mode: "invalid"; reason: string }> {
  const now = deps.now ?? new Date();
  const token = readToken(rawToken, clinic.clinicId, now);
  if (!token) return { mode: "invalid", reason: "token" };
  const text = typeof rawText === "string" ? rawText.trim().slice(0, 2_000) : "";
  if (!text) return { mode: "invalid", reason: "empty" };

  // The open chat this token names, if it is still going.
  const existing = token.conversationId
    ? await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readOpenChat<ChatState>(tx, token.conversationId!, now))
    : null;
  const conversationId = existing && existing.payload.turns.length < MAX_TURNS ? token.conversationId! : randomUUID();
  const continuing = conversationId === token.conversationId && existing !== null;

  // The gate, outside any transaction; the conversation's reference is what
  // the hard cap asks about, so one already counted is never cut off.
  const usage = { source: "web_chat" as const, sourceRef: identifierRef("chat_conversation", clinic.clinicId, conversationId) };
  const decision = await assistantMayAnswer({ clinicId: clinic.clinicId, channel: "web", usage, continuing, now, actor: ACTOR });
  if (decision.decision === "pass_through") return { mode: "contact_form", reason: decision.reason };

  try {
    await recordUsage({
      locationClinicId: clinic.clinicId,
      meter: "chat_conversations",
      quantity: 1,
      source: "web_chat",
      sourceRef: usage.sourceRef,
      occurredAt: now,
      actor: ACTOR,
      now,
    });
  } catch (error) {
    log.error("web chat conversation not counted", { clinicId: clinic.clinicId, error: describeError(error) });
  }

  const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => ((await clinicHasLeft(tx)) ? null : assistantFacts(tx)));
  if (!facts) return { mode: "contact_form", reason: "clinic_left" };

  const state: ChatState = continuing
    ? existing!.payload.state
    : { capture: EMPTY_CAPTURE, requestId: null, urgentAlerted: false, openedAt: new Date(token.issuedAt).toISOString() };
  const history: TranscriptTurn[] = continuing ? existing!.payload.turns : [{ speaker: "assistant", text: openingLine(facts) }];

  const turn = await answerTurn({ facts, channel: "web_chat", history, text, capture: state.capture, responder: deps.responder, now });
  const ended = turn.end;
  // The reply as it is finally said: an urgent one keeps "I've told the
  // team" only once its alert is queued, which is decided in the transaction.
  let said = turn;
  let urgentQueued = false;

  let written: { transcriptId: string } | null = null;
  try {
    written = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => {
      if (!continuing) {
        await tx.db.insert(conversations).values({
          id: conversationId,
          clinicId: tx.clinicId,
          channel: "web_chat",
          startedAt: new Date(state.openedAt),
          // The opening line, the locked AI line, was on screen from the start.
          disclosurePlayedAt: new Date(state.openedAt),
        });
        tx.audit.record({ action: "create", resourceType: "conversation", resourceId: conversationId, metadata: { channel: "web_chat" } });
      }
      // The gate answered, the visitor wrote and AYA answered, not only with
      // the failure line: website chat's first answer, if it is one, with its
      // plan start or step-up. On any such message, so a chat whose first
      // reply failed counts from its first real one. Never undoes the
      // conversation (lib/channels/events.ts).
      await recordFirstAnswer(
        tx,
        {
          channel: "web",
          source: "runtime",
          gateAnswered: true,
          personAnswered: turn.source !== "fallback",
          localTest: isLocalOrigin(deps.origin),
          conversationId,
        },
        now,
      );
      const next: ChatState = { ...state, capture: turn.capture, handedOver: Boolean(state.handedOver) || turn.handoff };
      // The alerts, in this transaction, so they go only if the message is
      // recorded. Each is keyed on the conversation, so asking again on a
      // later message queues nothing new, and a queue that failed is tried
      // again by the next urgent message or the next request for a person.
      if (turn.urgent) {
        urgentQueued = await notifyBookingAlert(tx, "urgent", { channel: "web", conversationId });
        said = settleUrgentReply(turn, facts, "web_chat", urgentQueued, now);
        next.urgentAlerted = true;
      }
      if (turn.handoff) await notifyBookingAlert(tx, "handover", { channel: "web", conversationId });
      if (!next.requestId) {
        next.requestId = await takeRequest(tx, facts, conversationId, turn.capture);
      }
      await tx.db
        .update(conversations)
        .set({
          endedAt: now,
          // Escalated stays escalated: a later ordinary message does not undo an urgent hit or a handover.
          outcome: next.urgentAlerted || next.handedOver ? "escalated_to_human" : next.requestId ? "booked" : "qualified_no_booking",
          // What tells an urgent hit from a handover (drizzle/0078).
          urgent: next.urgentAlerted,
        })
        .where(and(eq(conversations.id, conversationId), eq(conversations.clinicId, tx.clinicId)));
      const turns: TranscriptTurn[] = [...history, { speaker: "person", text: said.personText }, { speaker: "assistant", text: said.reply }];
      const payload: OpenChatState<ChatState> = { channel: "web_chat", startedAt: state.openedAt, turns, state: next };
      if (continuing) {
        const ok = await updateOpenChat(tx, existing!.id, payload, { now, end: ended });
        if (!ok) throw new ChatTakenError();
        tx.audit.record({ action: "update", resourceType: "transcript_email", resourceId: existing!.id, metadata: { conversationId, source: turn.source } });
        return { transcriptId: existing!.id };
      }
      const id = await openChatTranscript(tx, { conversationId, startedAt: new Date(state.openedAt), turns, state: next, now });
      if (ended) await updateOpenChat(tx, id, payload, { now, end: true });
      return { transcriptId: id };
    });
  } catch (error) {
    if (error instanceof ChatTakenError) {
      // The quiet time ran out between the read and the write, and the
      // transcript has gone: this message starts a new conversation.
      return sendWebChatMessage(clinic, signToken({ ...token, conversationId: null, issuedAt: now.getTime() }), text, deps);
    }
    log.error("web chat message not recorded", { clinicId: clinic.clinicId, error: describeError(error) });
    return { mode: "chat", reply: FAILURE_LINE, token: signToken({ ...token, issuedAt: token.issuedAt }), ended: false };
  }

  // The urgent alert is critical: it goes now that its row has committed,
  // and the minute queue sends whatever this misses. It never rejects.
  if (urgentQueued) await deliverCriticalAfterCommit(clinic.clinicId, { after: deps.after, transport: deps.transport });
  if (ended && written) await sendQueuedTranscriptNow(clinic.clinicId, written.transcriptId, { transport: deps.transport, now });
  log.info("web chat message", { clinicId: clinic.clinicId, conversationId, source: turn.source, status: ended ? "ended" : "open" });
  return {
    mode: "chat",
    reply: said.reply,
    token: signToken({ clinicId: clinic.clinicId, conversationId: ended ? null : conversationId, sessionId: token.sessionId, issuedAt: ended ? now.getTime() : token.issuedAt }),
    ended,
  };
}

class ChatTakenError extends Error {}

/** The visitor ended the chat: its transcript goes now. True when there was one to send. */
export async function endWebChat(clinic: WebChatClinic, rawToken: unknown, deps: { transport?: EmailTransport; now?: Date } = {}): Promise<boolean> {
  const now = deps.now ?? new Date();
  const token = readToken(rawToken, clinic.clinicId, now);
  if (!token?.conversationId) return false;
  const id = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, async (tx) => {
    const open = await readOpenChat<ChatState>(tx, token.conversationId!, now);
    if (!open) return null;
    return (await updateOpenChat(tx, open.id, open.payload, { now, end: true })) ? open.id : null;
  });
  if (!id) return false;
  await sendQueuedTranscriptNow(clinic.clinicId, id, { transport: deps.transport, now });
  return true;
}

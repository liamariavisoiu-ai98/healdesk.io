import { after } from "next/server";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { recordUsage } from "@/lib/billing/usage";
import { recordFirstAnswer } from "@/lib/channels/events";
import { touchChatThread } from "@/lib/chat/threads";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { deliverCriticalAfterCommit } from "@/lib/email/outbox";
import { identifierRef } from "@/lib/identifier-ref";
import { describeError, log } from "@/lib/log";
import { resolveMetaChannel, sendMetaReply, type MetaSender } from "@/lib/meta/channels";
import { anthropicResponder, answerFrontDoor, type FrontDoorAnswer, type FrontDoorFallback, type FrontDoorResponder } from "@/lib/meta/front-door";
import { recordGreeting } from "@/lib/meta/greeting";
import { claimMetaMessage } from "@/lib/meta/inbound";
import { parseMetaEvents, verifyMetaSignature } from "@/lib/meta/webhook";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/webhooks/meta — one endpoint for Messenger, Instagram and WhatsApp.
 *
 * GET is Meta's one-time verification handshake. POST is every event; the
 * body is authenticated with the app secret before it is parsed, each
 * message is resolved to a clinic by the page / account / number id, and a
 * clinic whose front door is switched off, or which has switched the
 * message's platform Off in Settings (Instagram, Messenger and WhatsApp each
 * have their own switch, lib/channels/meta-platforms.ts), is silently
 * skipped: nothing is claimed, counted or answered. On Instagram and
 * Messenger the message waits for the clinic's team in the app; a WhatsApp
 * number is on the Cloud API alone, with no app or inbox, so there nobody
 * sees it (lib/meta/front-door.ts, staffCanReplyOn). The reply is
 * produced by the narrow agent in lib/meta/front-door.ts and sent with the
 * clinic's sealed token, opened inside the tenant transaction. A message
 * that completes a booking request also queues the clinic's alert (L7, a
 * pointer into the portal, lib/notices/booking-alerts.ts) in the answer's
 * transaction; the sender id travels into the request so the desk's decision
 * can be relayed back to the person — inside Meta's 24-hour window only,
 * which lib/meta/channels.ts enforces. A request for a person queues the
 * handover alert (L11) the same way; on WhatsApp, where nobody at the
 * practice can answer the thread, its reply is always the fixed line that
 * sends the person to the phone. An urgent message's alert (L12) is sent the
 * moment the answer commits, before the reply goes.
 *
 * Each message, in order (BD24, R18):
 *
 *   1. a redelivery is skipped entirely: the message id is claimed in
 *      meta_inbound_messages, in a short transaction of its own with
 *   2. the person's chat thread, which says which conversation the message
 *      belongs to (lib/chat/threads.ts);
 *   3. the answer gate, outside any transaction (lib/billing/answering.ts).
 *      A refusal means no model call and no reply, only an audit row with
 *      `source: "withheld"` and the reason: on Instagram and Messenger
 *      staff see the message in their own inbox, which is the Meta
 *      fallback; a WhatsApp number has none, so there it reaches nobody;
 *   4. an allowed message counts its conversation (recordUsage, idempotent
 *      on the conversation's reference, so every allowed message may call it
 *      and the conversation is counted once, from the first message the
 *      assistant may answer);
 *   5. the answer.
 *
 * Always 200 once the signature is good: Meta retries on anything else, and
 * a message we could not answer is not one we want delivered twice. So one
 * message's failure is logged and the loop carries on; the log line uses
 * allowlisted keys only, because a key off the list throws inside the catch
 * and turns that one failure into a 500 and a redelivered batch.
 */
const MAX_BODY_BYTES = 500_000;

let responderForTests: FrontDoorResponder | null | undefined;
let senderForTests: MetaSender | undefined;
let transportForTests: EmailTransport | undefined;
let nowForTests: Date | undefined;
/**
 * Test seam: swap the model, the Graph API, the email transport the urgent
 * alert goes through, and the clock. Undefined restores the real ones.
 */
export function __setMetaRuntimeForTests(
  responder: FrontDoorResponder | null | undefined,
  sender: MetaSender | undefined,
  transport?: EmailTransport,
  now?: Date,
): void {
  responderForTests = responder;
  senderForTests = sender;
  transportForTests = transport;
  nowForTests = now;
}

export async function GET(request: Request): Promise<Response> {
  const token = process.env.META_VERIFY_TOKEN;
  if (!token) return Response.json({ error: "Meta webhooks are not configured." }, { status: 503 });
  const url = new URL(request.url);
  if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === token) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return Response.json({ error: "Verification failed." }, { status: 403 });
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    log.error("META_APP_SECRET is not set; refusing Meta webhooks");
    return Response.json({ error: "Meta webhooks are not configured." }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Payload too large." }, { status: 413 });
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return Response.json({ error: "Bad signature." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const responder = responderForTests !== undefined ? responderForTests : anthropicResponder();
  const send = senderForTests;
  const now = nowForTests ?? new Date();
  const actor = { type: "agent", serviceName: "meta-front-door" } as const;
  let answered = 0;
  let skipped = 0;
  for (const message of parseMetaEvents(body, now)) {
    let clinicId: string | undefined;
    try {
      const owner = await resolveMetaChannel(message.externalId);
      // The operator's front door, then the clinic's own switch for this
      // platform: both must be on (app_meta_channel, 0061).
      if (!owner || !owner.enabled || !owner.platformEnabled) {
        skipped += 1;
        continue;
      }
      clinicId = owner.clinicId;
      // The window opens when the person sent the message, not when we
      // read it: a webhook Meta retries a day late must not reopen it. The
      // conversation is dated the same way.
      const sentAt = message.sentAt ?? now;

      // 1 and 2: a redelivery stops here, before anything is counted or
      // answered; otherwise the message joins its conversation. A clinic that
      // has left (offboarding started, or destroyed) keeps nothing new, not
      // even the keyed references (lib/clinic/leaving.ts).
      const thread = await withTenant({ clinicId: owner.clinicId, actor }, async (tx) => {
        if (await clinicHasLeft(tx)) return "left" as const;
        if (message.messageId && !(await claimMetaMessage(tx, message.platform, message.messageId))) {
          return null;
        }
        return touchChatThread(tx, { channel: message.platform, partyId: message.senderId, sentAt });
      });
      if (thread === "left") {
        log.warn("meta message refused: the clinic has left", { clinicId: owner.clinicId });
        skipped += 1;
        continue;
      }
      if (!thread) {
        skipped += 1;
        continue;
      }

      // 3: the gate, outside any transaction (it reads the location, then
      // its billing clinic). The conversation's reference is what the hard
      // cap asks about: a conversation already counted is never cut off.
      const usage = {
        source: "meta" as const,
        sourceRef: identifierRef("chat_conversation", owner.clinicId, thread.conversationId),
      };
      const decision = await assistantMayAnswer({ clinicId: owner.clinicId, channel: "meta", usage, now, actor });
      if (decision.decision === "pass_through") {
        await withTenant({ clinicId: owner.clinicId, actor }, async (tx) => {
          tx.audit.record({
            action: "create",
            resourceType: "meta_front_door_reply",
            resourceId: tx.clinicId,
            metadata: { platform: message.platform, source: "withheld", reason: decision.reason },
          });
        });
        skipped += 1;
        continue;
      }

      // 4: count the conversation. A failure here costs us the count, never
      // the person their answer; the next allowed message counts it.
      try {
        await recordUsage({
          locationClinicId: owner.clinicId,
          meter: "chat_conversations",
          quantity: 1,
          source: "meta",
          sourceRef: usage.sourceRef,
          occurredAt: sentAt,
          actor,
          now,
        });
      } catch (error) {
        log.error("meta conversation not counted", { clinicId, channel: message.platform, error: describeError(error) });
      }

      // 5: the answer, committed before anything is sent: a booking request
      // it created survives a send that fails, which would otherwise roll it
      // back after the message id was claimed, so a redelivery could never
      // make it again. An urgent message whose answer cannot be recorded
      // still gets its fixed line (FrontDoorFallback), without "I've told the
      // team": its alert rolled back too.
      const fallback: FrontDoorFallback = {};
      let answer: FrontDoorAnswer | null;
      try {
        answer = await withTenant({ clinicId: owner.clinicId, actor }, (tx) =>
          answerFrontDoor(tx, {
            platform: message.platform,
            text: message.text,
            responder,
            thread: { platform: message.platform, externalId: message.externalId, senderId: message.senderId, connectionId: owner.connectionId },
            now: sentAt,
            fallback,
          }),
        );
      } catch (error) {
        if (!fallback.urgentLine) throw error;
        log.error("meta urgent message not recorded: no alert went", { clinicId, channel: message.platform, error: describeError(error) });
        answer = {
          text: fallback.urgentLine,
          source: "urgent",
          guard: null,
          screened: "urgent",
          booking: "none",
          greeted: false,
          greetingToRecord: null,
          urgentQueued: false,
        };
      }
      if (!answer) {
        skipped += 1;
        continue;
      }
      const reply = answer;
      // 6: the urgent alert, now that the answer that queued it has
      // committed, started before the reply is sent so it waits on neither
      // the Graph API nor the rest of the batch. after() keeps the request
      // alive until it is done without holding up Meta's response; outside a
      // request scope it throws, and the alert is awaited here instead. It
      // never rejects, and the minute queue sends whatever it misses.
      if (reply.urgentQueued) {
        const critical = deliverCriticalAfterCommit(owner.clinicId, { transport: transportForTests });
        try {
          after(() => critical);
        } catch {
          await critical;
        }
      }
      // 7: the reply. Replying to the message just received: the thread
      // may hold no request yet, so the instant is passed in. sendMetaReply
      // still drops the reply if that instant is more than 24 hours old.
      await withTenant({ clinicId: owner.clinicId, actor }, async (tx) => {
        const outcome = await sendMetaReply(tx, owner, message.externalId, message.senderId, reply.text, send, { lastInboundAt: sentAt, now });
        // The greeting is given once the reply carrying it has gone out. A
        // reply dropped outside the window (a backlog Meta delivers a day
        // late) leaves it owed, so the first reply the person does get
        // opens with it (lib/meta/greeting.ts).
        if (outcome.status === "sent" && reply.greetingToRecord) await recordGreeting(tx, reply.greetingToRecord);
        // A reply that reached the person, past the gate: the Meta
        // channel's first answer, if it is one, with its plan start or
        // step-up (lib/channels/events.ts). It never undoes the send's record.
        if (outcome.status === "sent") {
          await recordFirstAnswer(
            tx,
            { channel: "meta", source: "runtime", gateAnswered: true, personAnswered: true, conversationId: thread.conversationId },
            now,
          );
        }
      });
      answered += 1;
    } catch (error) {
      skipped += 1;
      // `channel`, never `platform`: lib/log.ts throws on a key off its
      // allowlist, which inside this catch escaped the loop as a 500.
      log.error("meta message not answered", { clinicId, channel: message.platform, error: describeError(error) });
    }
  }
  return Response.json({ received: true, answered, skipped });
}

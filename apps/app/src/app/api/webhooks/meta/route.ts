import { assistantMayAnswer } from "@/lib/billing/answering";
import { recordUsage } from "@/lib/billing/usage";
import { touchChatThread } from "@/lib/chat/threads";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { identifierRef } from "@/lib/identifier-ref";
import { describeError, log } from "@/lib/log";
import { resolveMetaChannel, sendMetaReply, type MetaSender } from "@/lib/meta/channels";
import { anthropicResponder, answerFrontDoor, type FrontDoorResponder } from "@/lib/meta/front-door";
import { notifyDeskAfterCommit } from "@/lib/meta/booking-requests";
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
 * skipped: nothing is claimed, counted or answered, and the message waits for
 * the clinic's team in the app. The reply is
 * produced by the narrow agent in lib/meta/front-door.ts and sent with the
 * clinic's sealed token, opened inside the tenant transaction. A message
 * that completes a booking request also emails the clinic's desk a
 * single-use link (lib/meta/booking-requests.ts); the sender id travels
 * into that flow so the desk's decision can be relayed back to the person —
 * inside Meta's 24-hour window only, which lib/meta/channels.ts enforces.
 *
 * Each message, in order (BD24, R18):
 *
 *   1. a redelivery is skipped entirely: the message id is claimed in
 *      meta_inbound_messages, in a short transaction of its own with
 *   2. the person's chat thread, which says which conversation the message
 *      belongs to (lib/chat/threads.ts);
 *   3. the answer gate, outside any transaction (lib/billing/answering.ts).
 *      A refusal means no model call and no reply, only an audit row with
 *      `source: "withheld"` and the reason: staff see the message in their
 *      own inbox, which is the Meta fallback;
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
 * Test seam: swap the model, the Graph API, the desk's email transport and
 * the clock. Undefined restores the real ones.
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
      // make it again.
      const answer = await withTenant({ clinicId: owner.clinicId, actor }, (tx) =>
        answerFrontDoor(tx, {
          platform: message.platform,
          text: message.text,
          responder,
          thread: { platform: message.platform, externalId: message.externalId, senderId: message.senderId, connectionId: owner.connectionId },
          now: sentAt,
        }),
      );
      if (!answer) {
        skipped += 1;
        continue;
      }
      try {
        // 6: the reply. Replying to the message just received: the thread
        // may hold no request yet, so the instant is passed in. sendMetaReply
        // still drops the reply if that instant is more than 24 hours old.
        await withTenant({ clinicId: owner.clinicId, actor }, async (tx) => {
          const outcome = await sendMetaReply(tx, owner, message.externalId, message.senderId, answer.text, send, { lastInboundAt: sentAt, now });
          // The greeting is given once the reply carrying it has gone out. A
          // reply dropped outside the window (a backlog Meta delivers a day
          // late) leaves it owed, so the first reply the person does get
          // opens with it (lib/meta/greeting.ts).
          if (outcome.status === "sent" && answer.greetingToRecord) await recordGreeting(tx, answer.greetingToRecord);
        });
        answered += 1;
      } finally {
        // 7: the desk's email, only now that the request it links to has
        // committed, and whether or not the reply went out: the desk calls
        // either way. It never throws.
        if (answer.deskNotice) {
          await notifyDeskAfterCommit(owner.clinicId, answer.deskNotice, { channel: "meta", platform: message.platform }, { transport: transportForTests, actor });
        }
      }
    } catch (error) {
      skipped += 1;
      // `channel`, never `platform`: lib/log.ts throws on a key off its
      // allowlist, which inside this catch escaped the loop as a 500.
      log.error("meta message not answered", { clinicId, channel: message.platform, error: describeError(error) });
    }
  }
  return Response.json({ received: true, answered, skipped });
}

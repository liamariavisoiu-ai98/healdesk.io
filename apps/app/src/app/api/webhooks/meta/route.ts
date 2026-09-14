import { describeError, log } from "@/lib/log";
import { resolveMetaChannel, sendMetaReply, type MetaSender } from "@/lib/meta/channels";
import { anthropicResponder, answerFrontDoor, type FrontDoorResponder } from "@/lib/meta/front-door";
import { parseMetaEvents, verifyMetaSignature } from "@/lib/meta/webhook";
import { withTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * /api/webhooks/meta — one endpoint for Messenger, Instagram and WhatsApp.
 *
 * GET is Meta's one-time verification handshake. POST is every event; the
 * body is authenticated with the app secret before it is parsed, each
 * message is resolved to a clinic by the page / account / number id, and a
 * clinic whose front door is switched off is silently skipped. The reply is
 * produced by the narrow agent in lib/meta/front-door.ts and sent with the
 * clinic's sealed token, opened inside the tenant transaction.
 *
 * Always 200 once the signature is good: Meta retries on anything else, and
 * a message we could not answer is not one we want delivered twice.
 */
const MAX_BODY_BYTES = 500_000;

let responderForTests: FrontDoorResponder | null | undefined;
let senderForTests: MetaSender | undefined;
/** Test seam: swap the model and the Graph API. Undefined restores the real ones. */
export function __setMetaRuntimeForTests(responder: FrontDoorResponder | null | undefined, sender: MetaSender | undefined): void {
  responderForTests = responder;
  senderForTests = sender;
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
  let answered = 0;
  let skipped = 0;
  for (const message of parseMetaEvents(body)) {
    try {
      const owner = await resolveMetaChannel(message.externalId);
      if (!owner || !owner.enabled) {
        skipped += 1;
        continue;
      }
      const actor = { type: "agent", serviceName: "meta-front-door" } as const;
      const sent = await withTenant({ clinicId: owner.clinicId, actor }, async (tx) => {
        const answer = await answerFrontDoor(tx, { platform: message.platform, text: message.text, responder });
        if (!answer) return false;
        await sendMetaReply(tx, owner, message.externalId, message.senderId, answer.text, send);
        return true;
      });
      if (sent) answered += 1;
      else skipped += 1;
    } catch (error) {
      skipped += 1;
      log.error("meta message not answered", { platform: message.platform, error: describeError(error) });
    }
  }
  return Response.json({ received: true, answered, skipped });
}

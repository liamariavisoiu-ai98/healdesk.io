import { createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { webhookEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { sendLiveAlert } from "@/lib/reporting/alerts";
import { withTenant } from "@/lib/tenant";
import { ingestCall, VoiceIngestError } from "@/lib/voice/ingest";
import { readSynthflowPayload, VoicePayloadError } from "@/lib/voice/synthflow-payload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/webhooks/voice/[clinicId] — the call that makes the product real.
 *
 * Pre-Retell. This receives Synthflow's post-call webhook (read by
 * lib/voice/synthflow-payload.ts). The v1 voice agent runs on Retell through
 * a Healdesk-hosted custom-LLM WebSocket endpoint in its own long-lived
 * process, which is not built yet (launch plan step 2.1); its end-of-call
 * record should reach ingestCall() the same way, and this route then goes.
 *
 * Until this existed nothing wrote a `conversations` row: the report,
 * the reconciliation and the pitch were all fed by nothing. The voice
 * platform posts here when a call ends; the route authenticates it, stores
 * the raw body inside the clinic's tenant (PHI, on the 30-day webhook
 * retention clock), maps it to the observable facts, and lets ingestCall()
 * decide what they mean.
 *
 * Authentication is a fixed Bearer secret the platform sends as a header,
 * compared in constant time. It is per deployment, not per clinic, because
 * the clinic id in the path is not a secret and the vendor sends one header
 * for every agent; a per-clinic secret adds nothing while there is one
 * vendor account. Unset means 503 and nothing stored — a webhook that
 * silently drops calls is the failure the whole route exists to prevent.
 *
 * Stored FIRST, then ingested, in one transaction: a payload we could not
 * make sense of still leaves its raw body for the operator, flagged by the
 * processing error, and a replay of the same call id is a duplicate, not a
 * second conversation.
 */
const MAX_BODY_BYTES = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ clinicId: string }> },
): Promise<Response> {
  const secret = env.voiceWebhookSecret();
  if (!secret) {
    log.error("HEALDESK_VOICE_WEBHOOK_SECRET is not set; refusing voice webhooks");
    return Response.json({ error: "Voice webhooks are not configured." }, { status: 503 });
  }
  if (!authorised(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { clinicId } = await params;
  if (!UUID.test(clinicId)) return Response.json({ error: "Unknown endpoint." }, { status: 404 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "Payload too large." }, { status: 413 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }

  let event;
  try {
    event = readSynthflowPayload(parsed, clinicId);
  } catch (error) {
    if (error instanceof VoicePayloadError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const actor = { type: "agent", serviceName: "voice-ingest" } as const;

  try {
    const outcome = await withTenant({ clinicId, actor }, async (tx) => {
      // The raw body, keyed on the call id, so a replay collapses to one row.
      const stored = await tx.db
        .insert(webhookEvents)
        .values({
          clinicId,
          provider: "synthflow",
          deliveryId: event.externalCallId,
          signatureValid: true,
          rawPayload: raw,
        })
        .onConflictDoNothing({
          target: [webhookEvents.clinicId, webhookEvents.provider, webhookEvents.deliveryId],
        })
        .returning({ id: webhookEvents.id });
      const row = stored[0];
      if (!row) return { duplicate: true as const };

      tx.audit.record({
        action: "create",
        resourceType: "webhook_event",
        resourceId: row.id,
        metadata: { provider: "synthflow" },
      });
      return { duplicate: false as const, eventId: row.id };
    });

    if (outcome.duplicate) return Response.json({ received: true, duplicate: true });

    // Its own tenant transaction, after the store committed: a failure here
    // must not roll back the evidence, and the stored row carries the error.
    try {
      const result = await ingestCall(event, actor);
      await withTenant({ clinicId, actor }, (tx) =>
        tx.db.execute(
          sql`update webhook_events set processed_at = now(), attempts = attempts + 1
               where id = ${outcome.eventId}::uuid`,
        ),
      );
      log.info("voice call ingested", {
        clinicId,
        conversationId: result.conversationId,
        outcome: result.recoveryReason ?? "not_recovered",
        deferred: result.duplicate,
      });
      // The escalation alert, after the row exists and outside its transaction.
      // A booked call no longer alerts here: it produced a booking request,
      // and the desk was emailed its link inside the ingest.
      if (!result.duplicate && event.outcome === "escalated_to_human") {
        void sendLiveAlert(clinicId, "escalated", result.conversationId);
      }
      return Response.json({ received: true, conversationId: result.conversationId }, { status: 202 });
    } catch (error) {
      const reason = error instanceof VoiceIngestError ? error.message : describeError(error);
      await withTenant({ clinicId, actor }, (tx) =>
        tx.db.execute(
          sql`update webhook_events set attempts = attempts + 1, processing_error = ${reason.slice(0, 300)}
               where id = ${outcome.eventId}::uuid`,
        ),
      );
      log.error("voice call stored but not ingested", { clinicId, reason: reason.slice(0, 200) });
      // 200: the vendor did its job; retrying the same body will not help.
      return Response.json({ received: true, ingested: false });
    }
  } catch (error) {
    // A BAA-gate refusal (synthetic clinic) or a database outage. The vendor
    // retries on 5xx, which is right for the outage and harmless for the
    // gate — the clinic is not live, and nothing should be written.
    log.error("voice webhook failed", { clinicId, error: describeError(error) });
    return Response.json({ error: "Could not store the call." }, { status: 500 });
  }
}

/** Exported for the test: the vendor-side fingerprint of a payload. */
export function payloadFingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

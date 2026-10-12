import { isImplemented } from "@healdesk/connectors";

import {
  ingestWebhook,
  scheduleWebhookProcessing,
} from "@/lib/sync/webhooks";

/**
 * Inbound webhooks from booking platforms.
 *
 * Store fast, return 200, process off the queue. Platforms retry aggressively
 * and disable endpoints that are slow, so anything done inline here — parsing,
 * matching, reporting — eventually costs us the integration.
 *
 * ## On the URL containing a clinic id
 *
 * It does, and the id is not a secret. Authentication is the **signature**,
 * verified inside the adapter against that clinic's own credential; the path
 * only says which credential to check against. Anyone who guesses a clinic id
 * can cause a row with `signature_valid = false` and nothing else — no data is
 * written, no job is queued, and replays of the same body collapse onto one row
 * because the delivery id falls back to a hash of it.
 *
 * What that still permits is someone filling the table with junk. The mitigation
 * is a body-size cap here plus the retention sweep; a per-connection URL token
 * would be better and is worth adding when the first real webhook integration
 * lands and we know what the platform will let us put in a callback URL.
 */

export const dynamic = "force-dynamic";

/** Bigger than any legitimate booking payload, small enough to be cheap. */
const MAX_BODY_BYTES = 1_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; clinicId: string }> },
) {
  const { provider, clinicId } = await params;

  if (!UUID.test(clinicId)) {
    return Response.json({ error: "Unknown endpoint." }, { status: 404 });
  }

  if (!isImplemented(provider)) {
    return Response.json({ error: "Unknown endpoint." }, { status: 404 });
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large." }, { status: 413 });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await ingestWebhook({ clinicId, provider, raw, headers });

  switch (result.status) {
    case "stored":
      // Queue AFTER the store commits, so the worker can never chase a row
      // that isn't there yet.
      await scheduleWebhookProcessing(clinicId, result.eventId);
      return Response.json({ received: true }, { status: 202 });

    case "duplicate":
      // 200, not an error. A replay is the platform doing its job.
      return Response.json({ received: true, duplicate: true });

    case "unverified":
      // Stored for forensics, not acted on. 401 tells an honest sender their
      // secret is stale rather than letting them think we processed it.
      return Response.json({ error: "Signature did not verify." }, { status: 401 });

    case "rejected":
      return Response.json({ error: result.reason }, { status: 400 });

    case "left":
      // 200, so the platform stops retrying; nothing it carried is kept
      // (lib/clinic/leaving.ts).
      return Response.json({ received: true });
  }
}

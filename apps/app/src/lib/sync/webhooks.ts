import { createHash } from "node:crypto";

import { getAdapter, safeLog } from "@healdesk/connectors";
import { and, eq, sql } from "drizzle-orm";

import { providerConnections, webhookEvents } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withCredentials } from "@/lib/connections/store";
import {
  enqueue,
  QUEUE_PROCESS_WEBHOOK,
  QUEUE_SYNC_CONNECTION,
} from "@/lib/queue/boss";
import { withTenant } from "@/lib/tenant";

import { upsertAppointments, upsertContacts, upsertSales } from "./upsert";

/**
 * Inbound webhooks: store first, understand later.
 *
 * The endpoint's only job is to get the payload durably onto disk and return
 * 200 fast. Platforms retry aggressively and disable endpoints that are slow or
 * flaky, and "we processed it inline, the process died, the platform gave up"
 * loses data with no trace. Storing raw means a parsing bug is recoverable — we
 * still have exactly what they sent.
 *
 * Three rules:
 *
 *   1. **Unverified payloads are kept, not acted on.** A bad signature might be
 *      an attacker or might be a rotated secret nobody told us about. Deleting
 *      it destroys the evidence needed to tell those apart.
 *   2. **Deduplicate on the platform's delivery id.** At-least-once delivery is
 *      the norm; the unique index makes a replay a no-op.
 *   3. **A hint is not a payload.** Many platforms send a thin notification and
 *      expect a read-back. `complete: false` schedules a sync rather than
 *      writing a half-populated row.
 */

export type IngestResult =
  | { status: "stored"; eventId: string; deliveryId: string }
  | { status: "duplicate"; deliveryId: string }
  | { status: "rejected"; reason: string }
  | { status: "unverified"; eventId: string; deliveryId: string };

export async function ingestWebhook(input: {
  clinicId: string;
  provider: string;
  raw: string;
  headers: Record<string, string>;
}): Promise<IngestResult> {
  const adapter = getAdapter(input.provider);
  if (!adapter?.parseWebhook) {
    return {
      status: "rejected",
      reason: `No webhook handler for ${input.provider}.`,
    };
  }

  const actor: ActorContext = { type: "service", serviceName: "webhook-ingest" };

  return withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const [connection] = await tx.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.clinicId, input.clinicId),
          eq(providerConnections.provider, input.provider),
        ),
      )
      .limit(1);

    if (!connection) {
      return { status: "rejected" as const, reason: "No such connection." };
    }

    // Signature verification happens in the adapter, against the clinic's own
    // secret — so the decrypt is needed even to decide whether to trust this.
    const parsed = await withCredentials(
      tx.db,
      { clinicId: input.clinicId, connectionId: connection.id },
      async (credentials) =>
        adapter.parseWebhook!(
          {
            clinicId: input.clinicId,
            connectionId: connection.id,
            credentials,
          },
          input.raw,
          input.headers,
        ),
    );

    // Rule 1, made concrete. A rejected signature is stored with the flag off:
    // it might be an attacker, or it might be a secret someone rotated without
    // telling us, and deleting it destroys the only evidence that distinguishes
    // them. Anything else — a body we cannot parse at all — is refused, because
    // it has no delivery id to deduplicate on and a loop could fill the table.
    let deliveryId: string;
    let signatureValid: boolean;

    if (parsed.ok) {
      deliveryId = parsed.value.deliveryId;
      signatureValid = true;
    } else if (parsed.error.code === "unauthorised") {
      // Hash of the body, so a replayed bad payload still collapses to one row.
      deliveryId = `unverified:${createHash("sha256").update(input.raw).digest("hex").slice(0, 32)}`;
      signatureValid = false;
    } else {
      return {
        status: "rejected" as const,
        reason: safeLog(parsed.error.message),
      };
    }

    const inserted = await tx.db
      .insert(webhookEvents)
      .values({
        clinicId: input.clinicId,
        provider: input.provider,
        deliveryId,
        signatureValid,
        rawPayload: input.raw,
      })
      .onConflictDoNothing({
        target: [
          webhookEvents.clinicId,
          webhookEvents.provider,
          webhookEvents.deliveryId,
        ],
      })
      .returning({ id: webhookEvents.id });

    const row = inserted[0];
    if (!row) {
      return { status: "duplicate" as const, deliveryId };
    }

    tx.audit.record({
      action: "create",
      resourceType: "webhook_event",
      resourceId: row.id,
      metadata: { provider: input.provider, signatureValid },
    });

    if (!signatureValid) {
      return { status: "unverified" as const, eventId: row.id, deliveryId };
    }

    return { status: "stored" as const, eventId: row.id, deliveryId };
  });
}

/**
 * Turn one stored webhook into rows.
 *
 * Runs off the queue, not in the request. Re-parses from the stored payload
 * rather than trusting anything passed in, so a replayed job cannot smuggle a
 * different body past the signature check that already happened.
 */
export async function processWebhookEvent(input: {
  clinicId: string;
  webhookEventId: string;
}): Promise<{ written: number; deferred: boolean }> {
  const actor: ActorContext = { type: "service", serviceName: "webhook-worker" };

  const outcome = await withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const [event] = await tx.db
      .select({
        id: webhookEvents.id,
        provider: webhookEvents.provider,
        rawPayload: webhookEvents.rawPayload,
        signatureValid: webhookEvents.signatureValid,
        processedAt: webhookEvents.processedAt,
        attempts: webhookEvents.attempts,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.id, input.webhookEventId),
          eq(webhookEvents.clinicId, input.clinicId),
        ),
      )
      .limit(1);

    if (!event) throw new Error("Webhook event not found.");
    if (event.processedAt) return { written: 0, deferred: false, sync: null };

    // Rule 1: kept, not acted on.
    if (!event.signatureValid) {
      await markProcessed(tx.db, input, "Signature did not verify; not applied.");
      return { written: 0, deferred: false, sync: null };
    }

    const adapter = getAdapter(event.provider);
    if (!adapter?.parseWebhook) {
      await markProcessed(tx.db, input, `No handler for ${event.provider}.`);
      return { written: 0, deferred: false, sync: null };
    }

    const [connection] = await tx.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.clinicId, input.clinicId),
          eq(providerConnections.provider, event.provider),
        ),
      )
      .limit(1);

    if (!connection) {
      await markProcessed(tx.db, input, "Connection has gone away.");
      return { written: 0, deferred: false, sync: null };
    }

    const parsed = await withCredentials(
      tx.db,
      { clinicId: input.clinicId, connectionId: connection.id },
      async (credentials) =>
        adapter.parseWebhook!(
          {
            clinicId: input.clinicId,
            connectionId: connection.id,
            credentials,
          },
          event.rawPayload,
          {},
        ),
    );

    if (!parsed.ok) {
      await markProcessed(tx.db, input, safeLog(parsed.error.message));
      return { written: 0, deferred: false, sync: null };
    }

    // Rule 3: a hint triggers a read-back rather than a partial write.
    if (!parsed.value.complete) {
      await markProcessed(tx.db, input, null);
      return { written: 0, deferred: true, sync: connection.id };
    }

    let written = 0;
    const { contact, appointment, sale } = parsed.value;

    // Contact first — appointments carry a NOT NULL contact_id.
    if (contact) {
      written += await upsertContacts(tx.db, input.clinicId, event.provider, [contact]);
    }
    if (appointment) {
      written += await upsertAppointments(tx.db, input.clinicId, event.provider, [
        appointment,
      ]);
    }
    if (sale) {
      written += await upsertSales(tx.db, input.clinicId, event.provider, [sale]);
    }

    tx.audit.record({
      action: "update",
      resourceType: parsed.value.kind === "sale" ? "transaction" : parsed.value.kind,
      resultCount: written,
      metadata: { source: event.provider, via: "webhook", operation: "upsert" },
    });

    await markProcessed(tx.db, input, null);
    return { written, deferred: false, sync: null };
  });

  // Enqueue outside the transaction: pg-boss writes to its own schema, and a
  // job that commits while the transaction that produced it rolls back is a
  // worker chasing a row that never existed.
  if (outcome.sync) {
    await enqueue(QUEUE_SYNC_CONNECTION, {
      clinicId: input.clinicId,
      connectionId: outcome.sync,
    });
  }

  return { written: outcome.written, deferred: outcome.deferred };
}

/** Fire-and-forget enqueue after a successful ingest. */
export async function scheduleWebhookProcessing(
  clinicId: string,
  webhookEventId: string,
): Promise<void> {
  await enqueue(QUEUE_PROCESS_WEBHOOK, { clinicId, webhookEventId });
}

async function markProcessed(
  db: Parameters<Parameters<typeof withTenant>[1]>[0]["db"],
  input: { clinicId: string; webhookEventId: string },
  error: string | null,
): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      processedAt: new Date(),
      processingError: error,
      // Incremented in SQL, not read-then-written: two workers racing the same
      // event would both read 0 and both write 1, and the attempt count is the
      // only signal that something is retrying forever.
      attempts: sql`${webhookEvents.attempts} + 1`,
    })
    .where(
      and(
        eq(webhookEvents.id, input.webhookEventId),
        eq(webhookEvents.clinicId, input.clinicId),
      ),
    );
}

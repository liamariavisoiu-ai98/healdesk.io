import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { bookingRequests, clinics } from "@/db/schema";
import { saveConnection, withCredentials } from "@/lib/connections/store";
import type { TenantTx } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";

/**
 * A clinic's Meta channels: one sealed access token per platform, on the
 * same encrypted connections table as every other credential, with the
 * platform's id for the page / account / number in plain metadata so the
 * webhook can find the tenant.
 *
 * One rule about what may be sent, enforced here in the adapter and never
 * left to the prompt (v1 spec, "The 24-hour window, the rule that shapes
 * everything"): free-form text only inside Meta's 24-hour customer-service
 * window, on every platform. WhatsApp enforces it; Messenger and Instagram
 * reject `messaging_type: "RESPONSE"` outside it and we use no message tags.
 * So `sendMetaReply` drops the send rather than calling Graph when the
 * thread's last inbound message is more than a day old, whatever the model
 * or the caller asked for, and the desk is told to call.
 *
 * There is no other way out. v1 is inbound only, so there is no message tag,
 * no HUMAN_AGENT send and no WhatsApp template: the out-of-window template
 * path of 23 September 2026 (§G.3) was removed, and nothing in this file can
 * reach a person who has not written in the last 24 hours.
 */
export const META_PROVIDERS: Record<MetaPlatform, string> = {
  messenger: "meta-messenger",
  instagram: "meta-instagram",
  whatsapp: "meta-whatsapp",
};

/** Meta's customer-service window: 24 hours from the person's last message. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isMetaPlatform(value: unknown): value is MetaPlatform {
  return value === "messenger" || value === "instagram" || value === "whatsapp";
}

export async function attachMetaChannel(
  tx: TenantTx,
  input: { platform: MetaPlatform; externalId: string; accessToken: string; label?: string },
): Promise<string> {
  const id = await saveConnection(tx.db, {
    clinicId: tx.clinicId,
    provider: META_PROVIDERS[input.platform],
    credentials: { accessToken: input.accessToken },
    metadata: { externalId: input.externalId, label: input.label ?? null },
  });
  tx.audit.record({
    action: "create",
    resourceType: "provider_connection",
    resourceId: id,
    metadata: { provider: META_PROVIDERS[input.platform] },
  });
  return id;
}

export async function setMetaFrontDoor(tx: TenantTx, enabled: boolean): Promise<void> {
  await tx.db.update(clinics).set({ metaFrontDoorEnabled: enabled, updatedAt: new Date() }).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({ action: "update", resourceType: "clinic_meta_front_door", resourceId: tx.clinicId, metadata: { enabled } });
}

export type MetaChannelOwner = { clinicId: string; connectionId: string; platform: MetaPlatform; enabled: boolean };

/** Which clinic owns this page / account / number. Ids only; see 0036. */
export async function resolveMetaChannel(externalId: string): Promise<MetaChannelOwner | null> {
  const result = await unsafeDb.execute<{ clinic_id: string; connection_id: string; provider: string; enabled: boolean }>(
    sql`select clinic_id, connection_id, provider, enabled from app_meta_channel(${externalId})`,
  );
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? result) as {
    clinic_id: string;
    connection_id: string;
    provider: string;
    enabled: boolean;
  }[];
  const row = rows[0];
  if (!row) return null;
  const platform = (Object.keys(META_PROVIDERS) as MetaPlatform[]).find((p) => META_PROVIDERS[p] === row.provider);
  if (!platform) return null;
  return { clinicId: row.clinic_id, connectionId: row.connection_id, platform, enabled: Boolean(row.enabled) };
}

/**
 * Keep the thread's window current (§G.1): every inbound message restarts
 * the 24 hours on the requests it belongs to. Only open requests — the 0040
 * trigger freezes `last_inbound_at` once a request is terminal, and a
 * terminal request has no follow-up left to send.
 */
export async function touchMetaThread(tx: TenantTx, platform: MetaPlatform, senderId: string, at: Date = new Date()): Promise<void> {
  await tx.db
    .update(bookingRequests)
    .set({ lastInboundAt: at })
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        eq(bookingRequests.platform, platform),
        eq(bookingRequests.senderId, senderId),
        inArray(bookingRequests.status, ["requested", "accepted", "rescheduling"]),
      ),
    );
}

/** The thread's last inbound instant as the newest request on it records it; null when nothing is known. */
export async function metaThreadLastInbound(tx: TenantTx, platform: MetaPlatform, senderId: string): Promise<Date | null> {
  const [row] = await tx.db
    .select({ lastInboundAt: bookingRequests.lastInboundAt })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), eq(bookingRequests.platform, platform), eq(bookingRequests.senderId, senderId)))
    .orderBy(desc(bookingRequests.lastInboundAt))
    .limit(1);
  return row?.lastInboundAt ?? null;
}

/** Send one reply through the Graph API with the sealed token, opened and audited here. */
export type MetaSender = (input: { platform: MetaPlatform; externalId: string; accessToken: string; recipientId: string; text: string }) => Promise<void>;

export async function graphSend(input: Parameters<MetaSender>[0]): Promise<void> {
  const url =
    input.platform === "whatsapp"
      ? `https://graph.facebook.com/v21.0/${encodeURIComponent(input.externalId)}/messages`
      : `https://graph.facebook.com/v21.0/me/messages`;
  const body =
    input.platform === "whatsapp"
      ? { messaging_product: "whatsapp", to: input.recipientId, type: "text", text: { body: input.text } }
      : { recipient: { id: input.recipientId }, messaging_type: "RESPONSE", message: { text: input.text } };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Graph API ${response.status}`);
}

export type MetaSendOutcome = { status: "sent" } | { status: "outside_window" };

/**
 * Send free-form text on a thread, inside its window only. The only send
 * function this product has for Meta; outside the window it sends nothing.
 *
 * A caller replying to the message it just received passes `lastInboundAt`
 * (the instant is in its hand and the thread may hold no request yet);
 * everyone else — the desk's decision, the reschedule line — leaves it out
 * and the newest request on the thread answers. No request, or a request
 * from before the column existed, is treated as outside: fail closed, the
 * desk calls.
 */
export async function sendMetaReply(
  tx: TenantTx,
  owner: MetaChannelOwner,
  externalId: string,
  recipientId: string,
  text: string,
  send: MetaSender = graphSend,
  opts: { lastInboundAt?: Date | null; now?: Date } = {},
): Promise<MetaSendOutcome> {
  const now = opts.now ?? new Date();
  const lastInbound = opts.lastInboundAt !== undefined ? opts.lastInboundAt : await metaThreadLastInbound(tx, owner.platform, recipientId);
  if (!lastInbound || lastInbound.getTime() + META_WINDOW_MS < now.getTime()) {
    tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: owner.platform, outcome: "outside_window" } });
    return { status: "outside_window" };
  }
  await withCredentials(tx.db, { clinicId: tx.clinicId, connectionId: owner.connectionId }, async (credentials) => {
    const accessToken = credentials.accessToken;
    if (!accessToken) throw new Error("The channel has no access token.");
    await send({ platform: owner.platform, externalId, accessToken, recipientId, text });
  });
  return { status: "sent" };
}

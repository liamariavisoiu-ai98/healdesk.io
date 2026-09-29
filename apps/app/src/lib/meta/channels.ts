import { toE164 } from "@healdesk/connectors";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { bookingRequests, clinics, providerConnections, suppressions } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { saveConnection, withCredentials } from "@/lib/connections/store";
import { env } from "@/lib/env";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { guardReply, type MetaPlatform } from "./front-door";

/**
 * A clinic's Meta channels: one sealed access token per platform, on the
 * same encrypted connections table as every other credential, with the
 * platform's id for the page / account / number in plain metadata so the
 * webhook can find the tenant.
 *
 * Two rules about what may be sent, both from the design of 23 September
 * 2026 (§G):
 *
 *   - Free-form text only inside Meta's 24-hour customer-service window,
 *     on every platform. WhatsApp enforces it; Messenger and Instagram
 *     reject `messaging_type: "RESPONSE"` outside it and we use no message
 *     tags. So `sendMetaReply` refuses rather than calling Graph when the
 *     thread's last inbound message is more than a day old, and the desk is
 *     told to call.
 *   - Outside the window, on WhatsApp only, one approved utility template,
 *     only to a person who opted in to it as its own question, only while
 *     the environment flag is on, and only with parameters the reply guard
 *     would pass. The template carries a first name, a clinic name and a
 *     clinic phone — no time, service, provider or "appointment".
 */
export const META_PROVIDERS: Record<MetaPlatform, string> = {
  messenger: "meta-messenger",
  instagram: "meta-instagram",
  whatsapp: "meta-whatsapp",
};

/** Meta's customer-service window: 24 hours from the person's last message. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The template submitted to Meta (§G.3). The approved name is read from the connection's metadata, never assumed. */
export const WHATSAPP_TEMPLATE_NAME = "healdesk_request_update_v1";
export const WHATSAPP_TEMPLATE_LANGUAGE = "en_US";

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
 * Send free-form text on a thread, inside its window only.
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

// -----------------------------------------------------------------------------
// The WhatsApp template (§G.3)
// -----------------------------------------------------------------------------

export type MetaTemplateSender = (input: { externalId: string; accessToken: string; payload: Record<string, unknown> }) => Promise<void>;

/** The vendor's shape for a template send. Three text parameters, nothing free-form. */
export function whatsappTemplatePayload(input: { to: string; templateName: string; firstName: string; clinicName: string; clinicPhone: string }): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: input.firstName },
            { type: "text", text: input.clinicName },
            { type: "text", text: input.clinicPhone },
          ],
        },
      ],
    },
  };
}

export async function graphSendTemplate(input: Parameters<MetaTemplateSender>[0]): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(input.externalId)}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify(input.payload),
  });
  if (!response.ok) throw new Error(`Graph API ${response.status}`);
}

export type MetaTemplateOutcome = { status: "sent"; template: string } | { status: "refused"; reason: string };

const TEMPLATE_ACTOR: ActorContext = { type: "service", serviceName: "meta-template" };

/**
 * One approved WhatsApp template to one person, outside the window (§G.2–G.3).
 * Refuses, in order: the environment flag unset; no WhatsApp channel; no
 * approved template name on the connection; a parameter the reply guard
 * would refuse; no opt-in recorded for this person on this clinic's WhatsApp
 * thread; the number suppressed. Audits `meta_template_sent { template }`.
 */
export async function sendMetaTemplate(
  input: { clinicId: string; to: string; firstName: string; clinicName: string; clinicPhone: string },
  deps: { tx?: TenantTx; send?: MetaTemplateSender; actor?: ActorContext } = {},
): Promise<MetaTemplateOutcome> {
  const run = async (tx: TenantTx): Promise<MetaTemplateOutcome> => {
    const refuse = (reason: string): MetaTemplateOutcome => {
      tx.audit.record({ action: "create", resourceType: "meta_template_sent", resourceId: tx.clinicId, metadata: { outcome: "refused", reason } });
      return { status: "refused", reason };
    };
    if (!env.whatsappTemplatesEnabled()) return refuse("templates_disabled");

    const [connection] = await tx.db
      .select({ id: providerConnections.id, metadata: providerConnections.metadata })
      .from(providerConnections)
      .where(and(eq(providerConnections.clinicId, tx.clinicId), eq(providerConnections.provider, META_PROVIDERS.whatsapp), isNotNull(providerConnections.metadata)))
      .limit(1);
    const metadata = (connection?.metadata ?? null) as { externalId?: unknown; templateName?: unknown } | null;
    if (!connection || typeof metadata?.externalId !== "string") return refuse("no_channel");
    const templateName = typeof metadata.templateName === "string" && metadata.templateName.trim() ? metadata.templateName.trim() : null;
    if (!templateName) return refuse("no_template");

    for (const value of [input.firstName, input.clinicName, input.clinicPhone]) {
      if (!guardReply(value).ok) return refuse("parameter_refused");
    }

    const [optin] = await tx.db
      .select({ id: bookingRequests.id })
      .from(bookingRequests)
      .where(and(eq(bookingRequests.clinicId, tx.clinicId), eq(bookingRequests.platform, "whatsapp"), eq(bookingRequests.senderId, input.to), isNotNull(bookingRequests.whatsappOptinAt)))
      .limit(1);
    if (!optin) return refuse("no_optin");

    const phones = [input.to, toE164(input.to) ?? "", toE164(`+${input.to}`) ?? ""].filter(Boolean);
    const [suppressed] = await tx.db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(and(eq(suppressions.clinicId, tx.clinicId), inArray(suppressions.phone, phones), or(isNull(suppressions.channel), eq(suppressions.channel, "sms"))))
      .limit(1);
    if (suppressed) return refuse("suppressed");

    const payload = whatsappTemplatePayload({ to: input.to, templateName, firstName: input.firstName, clinicName: input.clinicName, clinicPhone: input.clinicPhone });
    const send = deps.send ?? graphSendTemplate;
    await withCredentials(tx.db, { clinicId: tx.clinicId, connectionId: connection.id }, async (credentials) => {
      const accessToken = credentials.accessToken;
      if (!accessToken) throw new Error("The channel has no access token.");
      await send({ externalId: metadata.externalId as string, accessToken, payload });
    });
    tx.audit.record({ action: "create", resourceType: "meta_template_sent", resourceId: connection.id, metadata: { template: templateName, platform: "whatsapp" } });
    return { status: "sent", template: templateName };
  };
  if (deps.tx) return run(deps.tx);
  return withTenant({ clinicId: input.clinicId, actor: deps.actor ?? TEMPLATE_ACTOR }, run);
}

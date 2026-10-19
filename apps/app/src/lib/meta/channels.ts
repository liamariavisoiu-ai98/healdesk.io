import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { bookingRequests, clinics, providerConnections } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { assistantMayAnswer } from "@/lib/billing/answering";
import { evaluateChannels } from "@/lib/channels/events";
import { metaPlatformOn, syncMetaChannelSwitch } from "@/lib/channels/meta-platforms";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { saveConnection, withCredentials } from "@/lib/connections/store";
import { withTenant, type TenantTx } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";
import { GRAPH_VERSION, GraphError, isTokenInvalid } from "./graph";
import { markMetaConnectionBroken } from "./reconnect";
import { META_PROVIDERS } from "./providers";

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
 *
 * The second rule is the practice's switches (BAA 1.3.0 clause 16: Practice
 * "may switch them off at any time"). A reply that answers the message just
 * received is sent only after the webhook has found the front door and the
 * platform's switch on and the answer gate open. A reply sent later, on the
 * desk's decision (the follow-up and the reschedule line), takes an owner
 * resolved by `resolveFollowUpOwner` just before it, through the same three
 * checks, and an owner they refused is never sent for: `sendMetaReply` drops
 * it and records why, as it records a send outside the window.
 */
export { META_PROVIDERS };

/** Meta's customer-service window: 24 hours from the person's last message. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isMetaPlatform(value: unknown): value is MetaPlatform {
  return value === "messenger" || value === "instagram" || value === "whatsapp";
}

/** Each platform's account, as a refusal names it. */
const ASSET_WORDS: Record<MetaPlatform, string> = {
  messenger: "Facebook Page",
  instagram: "Instagram account",
  whatsapp: "WhatsApp number",
};

/**
 * The Page, Instagram account or WhatsApp number is already connected to
 * another practice on healdesk. Its message is for the person connecting.
 */
export class MetaAssetTakenError extends Error {
  constructor(readonly platform: MetaPlatform) {
    super(
      `That ${ASSET_WORDS[platform]} is already connected to another practice on healdesk, so it can't be connected here too. Disconnect it there first, or reply to your setup email and we'll sort it out.`,
    );
    this.name = "MetaAssetTakenError";
  }
}

/** The unique index that keeps one Meta asset on one clinic (drizzle/0066). */
function isAssetTaken(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const e = current as { code?: unknown; constraint?: unknown };
    if (e.code === "23505" && e.constraint === "provider_connections_meta_asset_live_idx") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Store one Meta channel for the tenant, replacing any earlier connection on
 * the same platform (`saveConnection` keeps one per provider).
 *
 * One asset, one clinic: a Page, Instagram account or WhatsApp number another
 * clinic holds (not revoked) is refused by the database's unique index
 * (drizzle/0066), and the refusal is a MetaAssetTakenError in plain words.
 * Two clinics on one asset would have had every message routed to the older
 * one: another practice's patients in its records.
 *
 * `secrets` are sealed with the token, never written in clear: today only a
 * WhatsApp number's registration PIN, which re-registering the number needs.
 * `details` are non-secret ids kept in metadata, such as the WhatsApp Business
 * account a number belongs to. `via` says how the token arrived, so the audit
 * trail separates a clinic's own login from an operator pasting one.
 *
 * A newly connected platform answers by default (its Settings switch is On
 * unless someone turned it Off), so the Meta channel's own switch is brought
 * back in step with the connected platforms' switches in the same
 * transaction (lib/channels/meta-platforms.ts).
 */
export async function attachMetaChannel(
  tx: TenantTx,
  input: {
    platform: MetaPlatform;
    externalId: string;
    accessToken: string;
    label?: string;
    secrets?: Record<string, string>;
    details?: Record<string, string>;
    via?: "operator" | "facebook_login" | "embedded_signup";
  },
): Promise<string> {
  let id: string;
  try {
    id = await saveConnection(tx.db, {
      clinicId: tx.clinicId,
      provider: META_PROVIDERS[input.platform],
      credentials: { ...input.secrets, accessToken: input.accessToken },
      metadata: { ...input.details, externalId: input.externalId, label: input.label ?? null },
    });
  } catch (error) {
    if (isAssetTaken(error)) throw new MetaAssetTakenError(input.platform);
    throw error;
  }
  // A fresh login is the reconnect: whatever marked the old token dead is
  // cleared with it (lib/meta/reconnect.ts), so the button goes away and the
  // channel is no longer listed as needing attention.
  await tx.db
    .update(providerConnections)
    .set({ brokenAt: null, brokenAlertedAt: null, transientFailures: 0, lastError: null })
    .where(eq(providerConnections.id, id));
  tx.audit.record({
    action: "create",
    resourceType: "provider_connection",
    resourceId: id,
    metadata: { provider: META_PROVIDERS[input.platform], via: input.via ?? "operator" },
  });
  await syncMetaChannelSwitch(tx, CONNECTED_BY[input.via ?? "operator"]);
  // A connected platform is the Meta channel's own step: it may now be live
  // (lib/channels/events.ts).
  await evaluateChannels(tx, { only: "meta", actor: CONNECTED_BY[input.via ?? "operator"] });
  return id;
}

/** Who a channel switch that follows a new connection is recorded as having changed it. */
const CONNECTED_BY: Record<"operator" | "facebook_login" | "embedded_signup", string> = {
  operator: "healdesk support",
  facebook_login: "Facebook login",
  embedded_signup: "WhatsApp signup",
};

export async function setMetaFrontDoor(tx: TenantTx, enabled: boolean): Promise<void> {
  await tx.db.update(clinics).set({ metaFrontDoorEnabled: enabled, updatedAt: new Date() }).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({ action: "update", resourceType: "clinic_meta_front_door", resourceId: tx.clinicId, metadata: { enabled } });
  // The front door is our half of the Meta channel's runtime.
  if (enabled) await evaluateChannels(tx, { only: "meta", actor: "ops" });
}

/**
 * Who owns a Meta page, account or number, and whether it may be answered:
 * `enabled` is the operator's front door for the whole clinic, and
 * `platformEnabled` the clinic's own switch for this platform (Settings,
 * lib/channels/meta-platforms.ts). The webhook answers only when both are on.
 */
export type MetaChannelOwner = {
  clinicId: string;
  connectionId: string;
  platform: MetaPlatform;
  /** The operator's front door is on (and, for a follow-up, the answer gate is open). */
  enabled: boolean;
  /** The clinic's own switch for this platform is on. */
  platformEnabled: boolean;
  /** Why a follow-up owner is refused: `front_door_off`, `platform_off`, or the answer gate's reason. */
  withheld?: string;
};

/**
 * The owner for a reply that does not answer the message just received: the
 * desk's follow-up and the reschedule line. Resolved outside any transaction,
 * because the answer gate opens its own (lib/billing/answering.ts, R1), just
 * before the decision's transaction that sends it. Enabled only while the
 * operator's Meta front door is on (`clinics.meta_front_door_enabled`), the
 * clinic's own switch for the platform the request came in on is on
 * (lib/channels/meta-platforms.ts), both of which the webhook obeys, and the
 * answer gate would answer on Meta now: no pause, the channel bought, on and
 * live, billing in good standing (not suspended or cancelled), and an
 * agreement in effect. The follow-up belongs to a conversation already had,
 * so it is not a new one for the allowance cap, and asking raises no
 * allowance notice.
 */
export async function resolveFollowUpOwner(input: {
  clinicId: string;
  connectionId: string;
  platform: MetaPlatform;
  actor: ActorContext;
  now?: Date;
}): Promise<MetaChannelOwner> {
  const base = { clinicId: input.clinicId, connectionId: input.connectionId, platform: input.platform };
  const switches = await withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const [row] = await tx.db
      .select({ enabled: clinics.metaFrontDoorEnabled })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return { frontDoor: row?.enabled === true, platform: await metaPlatformOn(tx, input.platform) };
  });
  if (!switches.frontDoor) {
    return { ...base, enabled: false, platformEnabled: switches.platform, withheld: "front_door_off" };
  }
  if (!switches.platform) return { ...base, enabled: true, platformEnabled: false, withheld: "platform_off" };
  const decision = await assistantMayAnswer({
    clinicId: input.clinicId,
    channel: "meta",
    continuing: true,
    now: input.now,
    actor: input.actor,
  });
  if (decision.decision === "pass_through") {
    return { ...base, enabled: false, platformEnabled: true, withheld: decision.reason };
  }
  return { ...base, enabled: true, platformEnabled: true };
}

/** Which clinic owns this page / account / number. Ids and the two switches only; see 0036 and 0061. */
export async function resolveMetaChannel(externalId: string): Promise<MetaChannelOwner | null> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    connection_id: string;
    provider: string;
    enabled: boolean;
    platform_enabled: boolean;
  }>(sql`select clinic_id, connection_id, provider, enabled, platform_enabled from app_meta_channel(${externalId})`);
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? result) as {
    clinic_id: string;
    connection_id: string;
    provider: string;
    enabled: boolean;
    platform_enabled: boolean;
  }[];
  const row = rows[0];
  if (!row) return null;
  const platform = (Object.keys(META_PROVIDERS) as MetaPlatform[]).find((p) => META_PROVIDERS[p] === row.provider);
  if (!platform) return null;
  return {
    clinicId: row.clinic_id,
    connectionId: row.connection_id,
    platform,
    enabled: Boolean(row.enabled),
    platformEnabled: row.platform_enabled === true,
  };
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
      ? `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(input.externalId)}/messages`
      : `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`;
  const body =
    input.platform === "whatsapp"
      ? { messaging_product: "whatsapp", to: input.recipientId, type: "text", text: { body: input.text } }
      : { recipient: { id: input.recipientId }, messaging_type: "RESPONSE", message: { text: input.text } };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // Only Meta's numeric code is read off the answer, never its text, so
    // sendMetaReply can tell a dead token from every other refusal.
    const body = (await response.json().catch(() => ({}))) as { error?: { code?: unknown } };
    const code = typeof body.error?.code === "number" ? body.error.code : undefined;
    throw new GraphError(`Graph API ${response.status}`, response.status, code);
  }
}

export type MetaSendOutcome =
  | { status: "sent" }
  | { status: "outside_window" }
  /** The owner was refused: the front door or the platform's switch is off, or the answer gate would not answer. */
  | { status: "withheld"; reason: string };

/**
 * Send free-form text on a thread, inside its window only. The only send
 * function this product has for Meta; outside the window it sends nothing,
 * and for a clinic that has left (offboarding started) nothing at all.
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
  // The practice's switches first: an owner refused is never sent for,
  // whatever the caller asked (see the header).
  if (!owner.enabled || !owner.platformEnabled) {
    const reason = owner.withheld ?? (owner.enabled ? "platform_off" : "front_door_off");
    tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: owner.platform, outcome: "withheld", reason } });
    return { status: "withheld", reason };
  }
  // A clinic that has left sends nothing more on its threads: not the desk's
  // follow-up, not a reschedule line (lib/clinic/leaving.ts; the C19
  // re-audit). Read with the clinic's row held, in the caller's transaction.
  if (await clinicHasLeft(tx)) {
    tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: owner.platform, outcome: "withheld", reason: "clinic_left" } });
    return { status: "withheld", reason: "clinic_left" };
  }
  const lastInbound = opts.lastInboundAt !== undefined ? opts.lastInboundAt : await metaThreadLastInbound(tx, owner.platform, recipientId);
  if (!lastInbound || lastInbound.getTime() + META_WINDOW_MS < now.getTime()) {
    tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: owner.platform, outcome: "outside_window" } });
    return { status: "outside_window" };
  }
  try {
    await withCredentials(tx.db, { clinicId: tx.clinicId, connectionId: owner.connectionId }, async (credentials) => {
      const accessToken = credentials.accessToken;
      if (!accessToken) throw new Error("The channel has no access token.");
      await send({ platform: owner.platform, externalId, accessToken, recipientId, text });
    });
  } catch (error) {
    // Meta says the login is dead: remember it, so Home and Settings offer
    // Reconnect. Written in a transaction of its own, because the caller's is
    // about to roll back on this throw, and the mark must survive it.
    if (isTokenInvalid(error)) await markMetaConnectionBroken(tx.clinicId, owner.connectionId, "token_invalid");
    throw error;
  }
  return { status: "sent" };
}

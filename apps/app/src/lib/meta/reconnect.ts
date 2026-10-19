import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { providerConnections } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { eraseCredentials, withCredentials } from "@/lib/connections/store";
import { env } from "@/lib/env";
import { withTenant, type TenantTx } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";
import { META_PROVIDERS } from "./providers";

/**
 * When Meta drops a clinic's login, and how the portal says so.
 *
 * Meta tokens die without telling us: the clinic removes healdesk from its
 * Page, changes its Facebook password, or Meta invalidates the grant. Nothing
 * then fails loudly. Replies fail, and the portal went on showing "Connected"
 * with no button to fix it. A connection Meta has refused is marked with
 * `broken_at`, the column the Google Calendar watch already uses for the same
 * purpose, and the portal reads it: the Connect button returns as Reconnect,
 * Home lists it, Settings says so. A fresh login clears it
 * (attachMetaChannel).
 *
 * The status is left alone on purpose. `app_meta_channel` routes a webhook by
 * status, so flipping it to `error` would stop inbound messages resolving to
 * the clinic at all; `broken_at` only tells the portal.
 *
 * Nothing here holds a patient: provider names, ids and timestamps.
 */

const WATCH_ACTOR = { type: "service" as const, serviceName: "meta-token-watch" };

/** The three states one Meta connection can be in, as the portal draws them. */
export type MetaConnectionState = "none" | "connected" | "needs_reconnect";

/**
 * What the clinic sees: one Facebook login covers Messenger and Instagram, a
 * WhatsApp sign-up is its own, so the portal has two buttons, not three.
 */
export type MetaConnectView = {
  facebook: { state: MetaConnectionState; names: string[] };
  whatsapp: { state: MetaConnectionState };
  /** The keys for each button are in (Meta app, secret and the login configuration). */
  available: { facebook: boolean; whatsapp: boolean };
};

const NAMES: Record<MetaPlatform, string> = { messenger: "Messenger", instagram: "Instagram", whatsapp: "WhatsApp" };

export function metaConnectAvailability(): MetaConnectView["available"] {
  const app = Boolean(env.metaAppId() && env.metaAppSecret());
  return {
    facebook: app && Boolean(env.metaLoginConfigId()),
    whatsapp: app && Boolean(env.metaWhatsAppConfigId()),
  };
}

/** Pure, so the states are testable without a database. */
export function metaConnectViewOf(
  rows: readonly { provider: string; brokenAt: Date | null }[],
  available: MetaConnectView["available"] = metaConnectAvailability(),
): MetaConnectView {
  const stateOf = (platforms: readonly MetaPlatform[]): MetaConnectionState => {
    const mine = rows.filter((r) => platforms.some((p) => META_PROVIDERS[p] === r.provider));
    if (mine.length === 0) return "none";
    return mine.some((r) => r.brokenAt !== null) ? "needs_reconnect" : "connected";
  };
  const facebook: MetaPlatform[] = ["messenger", "instagram"];
  return {
    facebook: {
      state: stateOf(facebook),
      names: facebook.filter((p) => rows.some((r) => r.provider === META_PROVIDERS[p])).map((p) => NAMES[p]),
    },
    whatsapp: { state: stateOf(["whatsapp"]) },
    available,
  };
}

/** The clinic's Meta connections that are live (as the webhook counts them), with whether Meta dropped each. */
export async function readMetaConnectView(db: Transaction, clinicId: string): Promise<MetaConnectView> {
  const rows = await db
    .select({ provider: providerConnections.provider, brokenAt: providerConnections.brokenAt })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, clinicId),
        inArray(providerConnections.provider, Object.values(META_PROVIDERS)),
        inArray(providerConnections.status, ["active", "pending"]),
      ),
    );
  return metaConnectViewOf(rows);
}

/**
 * Mark a connection as needing a fresh login, inside a tenant transaction.
 * Idempotent: the first mark wins and writes the audit row, a repeat changes
 * nothing. `reason` is a short code, never Meta's text.
 */
export async function markBrokenWithin(
  tx: TenantTx,
  connectionId: string,
  reason: string,
  /** When the mark came from a credential read earlier: a login saved since (a reconnect) is not marked. */
  readAt?: Date,
): Promise<boolean> {
  const [marked] = await tx.db
    .update(providerConnections)
    .set({ brokenAt: sql`now()`, lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.clinicId, tx.clinicId),
        inArray(providerConnections.provider, Object.values(META_PROVIDERS)),
        inArray(providerConnections.status, ["active", "pending"]),
        isNull(providerConnections.brokenAt),
        ...(readAt ? [lte(providerConnections.updatedAt, readAt)] : []),
      ),
    )
    .returning({ provider: providerConnections.provider });
  if (!marked) return false;
  tx.audit.record({
    action: "update",
    resourceType: "provider_connection",
    resourceId: connectionId,
    metadata: { provider: marked.provider, outcome: "needs_reconnect", reason },
  });
  return true;
}

const pendingMarks = new Set<Promise<void>>();

/**
 * Mark from a send that Meta refused. Never throws: the caller is already
 * handling the send's own failure and must see that one. Not awaited by the
 * caller: it runs in a transaction of its own, so waiting for it from inside
 * the caller's transaction would hold two pooled connections at once, and a
 * burst of refused sends could exhaust the pool. The caller's throw ends its
 * transaction and frees its connection, then the mark proceeds.
 * `settleMetaMarks` waits for the ones in flight (tests, shutdown).
 * `readAt` is the row's `updated_at` as read before the token the send
 * used: a reconnect saved since is a different login, and is not marked.
 */
export function markMetaConnectionBroken(clinicId: string, connectionId: string, reason: string, readAt?: Date): void {
  const run = withTenant({ clinicId, actor: WATCH_ACTOR }, (tx) => markBrokenWithin(tx, connectionId, reason, readAt))
    .then(() => undefined)
    .catch((error) => {
      log.warn("Could not mark a Meta connection as needing reconnect", { clinicId, error: describeError(error) });
    })
    .finally(() => pendingMarks.delete(run));
  pendingMarks.add(run);
}

export async function settleMetaMarks(): Promise<void> {
  await Promise.all([...pendingMarks]);
}

/**
 * Whether signing in would REPLACE a connected Page, Instagram account or
 * WhatsApp number with a different one. A first connect, and a reconnect of
 * the very same asset, are not replacements. Swapping the asset changes where
 * the clinic's patients are answered, so it asks for a passkey step-up, as
 * Google Calendar does for a different account.
 */
export async function replacesConnectedAsset(
  db: Transaction,
  clinicId: string,
  incoming: readonly { platform: MetaPlatform; externalId: string }[],
): Promise<boolean> {
  const rows = await db
    .select({ provider: providerConnections.provider, externalId: sql<string | null>`${providerConnections.metadata} ->> 'externalId'` })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, clinicId),
        inArray(providerConnections.provider, incoming.map((i) => META_PROVIDERS[i.platform])),
        inArray(providerConnections.status, ["active", "pending"]),
      ),
    );
  return incoming.some((i) => {
    const current = rows.find((r) => r.provider === META_PROVIDERS[i.platform]);
    return current !== undefined && current.externalId !== i.externalId;
  });
}

/**
 * The registration PIN sealed with the clinic's WhatsApp connection, when
 * that connection is the number `phoneNumberId`. Registering a number again
 * needs the two-step PIN it was registered with (graph.ts,
 * registerPhoneNumber): a fresh one is refused by Meta, and every retry with
 * another fresh one is a wrong guess against the number. So a reconnect of
 * the same number reuses this one. Undefined for a first connect, a
 * different number, or a connection whose credentials were erased.
 */
export async function storedRegistrationPin(tx: TenantTx, phoneNumberId: string): Promise<string | undefined> {
  const [row] = await tx.db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, tx.clinicId),
        eq(providerConnections.provider, META_PROVIDERS.whatsapp),
        sql`${providerConnections.metadata} ->> 'externalId' = ${phoneNumberId}`,
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const pin = await withCredentials(tx.db, { clinicId: tx.clinicId, connectionId: row.id }, async (credentials) =>
    credentials.registrationPin ?? null,
  );
  return pin && /^\d{6}$/.test(pin) ? pin : undefined;
}

/**
 * After a Facebook login: a Messenger or Instagram connection the login did
 * not return, whose token Meta had already dropped (`broken_at`), is revoked.
 * Without this a Page that lost its Instagram link leaves an Instagram row
 * that no Reconnect can clear. A live one is left alone.
 */
export async function retireDroppedFacebookRows(tx: TenantTx, returned: readonly MetaPlatform[]): Promise<void> {
  const absent = (["messenger", "instagram"] as const).filter((p) => !returned.includes(p));
  if (absent.length === 0) return;
  const rows = await tx.db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, tx.clinicId),
        inArray(providerConnections.provider, absent.map((p) => META_PROVIDERS[p])),
        inArray(providerConnections.status, ["active", "pending"]),
        isNotNull(providerConnections.brokenAt),
      ),
    );
  for (const row of rows) {
    await eraseCredentials(tx.db, { clinicId: tx.clinicId, connectionId: row.id, reason: "replaced_by_login" });
    tx.audit.record({ action: "update", resourceType: "provider_connection", resourceId: row.id, metadata: { outcome: "retired", reason: "replaced_by_login" } });
  }
}

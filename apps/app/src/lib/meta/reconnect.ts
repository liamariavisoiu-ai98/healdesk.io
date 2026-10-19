import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { providerConnections } from "@/db/schema";
import { describeError, log } from "@/lib/log";
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
export async function markBrokenWithin(tx: TenantTx, connectionId: string, reason: string): Promise<boolean> {
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

/**
 * Mark from a send that Meta refused. Never throws: the caller is already
 * handling the send's own failure and must see that one.
 */
export async function markMetaConnectionBroken(clinicId: string, connectionId: string, reason: string): Promise<void> {
  try {
    await withTenant({ clinicId, actor: WATCH_ACTOR }, (tx) => markBrokenWithin(tx, connectionId, reason));
  } catch (error) {
    log.warn("Could not mark a Meta connection as needing reconnect", { clinicId, error: describeError(error) });
  }
}

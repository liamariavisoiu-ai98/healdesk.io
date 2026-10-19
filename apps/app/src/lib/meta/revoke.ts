import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { providerConnections } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { eraseCredentials, withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";
import { type FetchLike, GraphError, isMetaId, unsubscribePage, unsubscribeWaba } from "./graph";
import { META_PROVIDERS } from "./providers";

/**
 * Ending healdesk's access to a clinic's Meta accounts when its service ends
 * (Terms §7: "We revoke our access to your Google Calendar, your Meta
 * accounts and your payment gateway").
 *
 * Until 19 October 2026 only Google was swept at the end of a subscription.
 * The Page and WhatsApp tokens stayed sealed in provider_connections, the
 * app stayed subscribed to the Page's and the WhatsApp account's webhooks,
 * and the clinic's DMs kept reaching us, until destruction deleted the rows
 * on day 29 or day 89. Sends were already refused for a clinic that has left
 * (clinicHasLeft), but access was not given back.
 *
 * Now, for a clinic that has left, each Meta connection still standing is
 * revoked with the tokens we hold:
 *
 *   - Messenger and Instagram: `DELETE /{page-id}/subscribed_apps` with the
 *     Page's token, which takes the app off the Page's webhooks, Instagram's
 *     DMs included (they reach us through the Page, lib/meta/connect.ts);
 *   - WhatsApp: `DELETE /{waba-id}/subscribed_apps` with the business's
 *     token, the reverse of the subscription Embedded Signup made. The number
 *     itself is not deregistered: it is the clinic's, and deregistering it
 *     would take it off WhatsApp for whatever the clinic uses next;
 *
 * and then the token is erased (eraseCredentials: the row is marked revoked
 * and its ciphertext sealed over with nothing), so nothing of it remains to
 * use. Each erasure is audited with what happened at Meta (MetaRevokeOutcome).
 *
 * ## A Page or account another clinic still uses
 *
 * The subscription belongs to the Page or the WhatsApp Business account, not
 * to the clinic. Two locations can each have their own number on one
 * WhatsApp Business account (the one-asset rule, drizzle/0066, is on the
 * number), and a Page can come to serve another clinic too; unsubscribing it
 * for the location that left would end the other's messages, with nothing to
 * tell it. So before each call, app_meta_asset_in_service() asks whether the
 * Page or account still serves a clinic that has not left. If it does, Meta is
 * not asked, and only this clinic's token is erased (`shared_in_service`):
 * the other clinic's own connection keeps the subscription it needs.
 *
 * ## When Meta refuses
 *
 * Meta answering that the token is already dead (code 190: the clinic removed
 * the app, or Meta ended the grant) means the access is gone already, and the
 * token is erased all the same. Any other refusal keeps the token for the
 * next hourly run (lib/scheduler/tick.ts), counted on the row
 * (transient_failures), and ops is told once a connection has failed
 * META_REVOKE_ALERT_AFTER times. Destruction asks once more just before it
 * deletes the rows and tells ops if Meta still refuses
 * (lib/offboarding/offboarding.ts): the token goes with the data on the day
 * the agreement sets, and a person has the Page or account remove the app.
 * A connection with no Page or account on record (an operator's pasted
 * token) has nothing healdesk can unsubscribe: its token is erased and the
 * audit says so (`nothing_to_unsubscribe`), never that it was revoked at Meta.
 *
 * Graph is asked with no transaction open (lib/meta/graph.ts, rule 3): the
 * tokens are read in one tenant transaction, Meta is called, and the
 * erasures are a second. When that is merged with check/portal-connect-buttons,
 * its token watch and its Reconnect marks read only active and pending
 * connections, so a revoked one is never offered for Reconnect.
 *
 * Nothing here holds a patient: provider names, Meta object ids, tokens.
 */

const REVOKE_ACTOR = { type: "service", serviceName: "meta-revoke" } as const;
const META_PROVIDER_LIST = Object.values(META_PROVIDERS);
const PLATFORM_OF: Record<string, MetaPlatform> = Object.fromEntries(
  (Object.entries(META_PROVIDERS) as [MetaPlatform, string][]).map(([platform, provider]) => [
    provider,
    platform,
  ]),
);
/** Meta's "this token is no good" (OAuthException 190): the access is gone already. */
const TOKEN_INVALID = 190;
/** Hourly refusals before ops is told about a connection: six hours of tries. */
export const META_REVOKE_ALERT_AFTER = 6;

/** What happened at Meta for one connection whose token was erased, as its audit row says. */
export type MetaRevokeOutcome =
  /** Meta took the app off the Page or account. */
  | "revoked"
  /** Meta said the token was already dead: the access was gone. */
  | "already_gone"
  /** No Page or account on record: nothing to unsubscribe, the token erased alone. */
  | "nothing_to_unsubscribe"
  /** The Page or account still serves a clinic in service: left subscribed, this token erased. */
  | "shared_in_service";

export type MetaRevokeResult = {
  /** Clinics looked at. */
  clinics: number;
  /** Connections whose token was erased, whatever happened at Meta. */
  revoked: number;
  /** Connections left for the next run, Meta having refused or failed. */
  failed: number;
};

type Target = { kind: "page" | "waba"; id: string };
type Held = {
  connectionId: string;
  provider: string;
  token: string | null;
  target: Target | null;
  failures: number;
};

/** Where at Meta a connection's subscription lives: the Page for Messenger and Instagram, the account for WhatsApp. */
export function revokeTargetOf(
  provider: string,
  metadata: Record<string, unknown> | null,
): Target | null {
  const platform = PLATFORM_OF[provider];
  const pick = (value: unknown): string | null => (isMetaId(value) ? value : null);
  const m = metadata ?? {};
  const id =
    platform === "messenger"
      ? (pick(m.externalId) ?? pick(m.pageId))
      : platform === "instagram"
        ? pick(m.pageId)
        : platform === "whatsapp"
          ? pick(m.wabaId)
          : null;
  if (!id) return null;
  return { kind: platform === "whatsapp" ? "waba" : "page", id };
}

/**
 * Revoke the Meta access of each clinic named that has left, or, with no
 * list, of every clinic whose service has ended and whose data is not yet
 * destroyed (after destruction the connections are gone with it). Never
 * throws: one clinic's failure is logged and counted, and the rest go on.
 */
export async function revokeMetaAccess(
  clinicIds?: readonly string[],
  options: { actor?: ActorContext; fetchImpl?: FetchLike } = {},
): Promise<MetaRevokeResult> {
  const result: MetaRevokeResult = { clinics: 0, revoked: 0, failed: 0 };
  let targets: string[];
  try {
    targets = clinicIds
      ? [...new Set(clinicIds)]
      : (await listClinics())
          .filter((c) => c.offboardingStartedAt && !c.destroyedAt)
          .map((c) => c.id);
  } catch (error) {
    log.error("Meta revoke could not list its clinics", { error: describeError(error) });
    return { ...result, failed: 1 };
  }
  for (const clinicId of targets) {
    try {
      const one = await revokeFor(clinicId, options);
      if (one === null) continue;
      result.clinics += 1;
      result.revoked += one.revoked;
      result.failed += one.failed;
    } catch (error) {
      result.clinics += 1;
      result.failed += 1;
      log.error("Meta revoke failed for a clinic", { clinicId, error: describeError(error) });
    }
  }
  return result;
}

/** Whether the Page or account still serves a clinic, other than this one, that has not left. */
async function inServiceElsewhere(target: Target, clinicId: string): Promise<boolean> {
  const result = await unsafeDb.execute<{ used: boolean }>(
    sql`select app_meta_asset_in_service(${target.kind}, ${target.id}, ${clinicId}::uuid) as used`,
  );
  return result.rows[0]?.used === true;
}

async function revokeFor(
  clinicId: string,
  options: { actor?: ActorContext; fetchImpl?: FetchLike },
): Promise<{ revoked: number; failed: number } | null> {
  const actor = options.actor ?? REVOKE_ACTOR;
  const fetchImpl = options.fetchImpl ?? fetch;

  // 1. The connections still standing, with their tokens, for a clinic that has left.
  const held = await withTenant({ clinicId, actor }, async (tx): Promise<Held[] | null> => {
    if (!(await clinicHasLeft(tx, { lock: false }))) return null;
    const rows = await tx.db
      .select({
        id: providerConnections.id,
        provider: providerConnections.provider,
        metadata: providerConnections.metadata,
        failures: providerConnections.transientFailures,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.clinicId, tx.clinicId),
          inArray(providerConnections.provider, META_PROVIDER_LIST),
          ne(providerConnections.status, "revoked"),
        ),
      );
    const out: Held[] = [];
    for (const row of rows) {
      const token = await withCredentials(
        tx.db,
        { clinicId: tx.clinicId, connectionId: row.id },
        async (credentials) => credentials.accessToken ?? null,
      );
      out.push({
        connectionId: row.id,
        provider: row.provider,
        token,
        target: revokeTargetOf(
          row.provider,
          (row.metadata ?? null) as Record<string, unknown> | null,
        ),
        failures: row.failures,
      });
    }
    return out;
  });
  if (held === null) return null;
  if (held.length === 0) return { revoked: 0, failed: 0 };

  // 2. Meta, with no transaction open: each Page or account once, and never
  //    one another clinic in service still uses.
  const atMeta = new Map<string, "revoked" | "already_gone" | "shared_in_service" | "failed">();
  for (const h of held) {
    if (!h.target || !h.token) continue;
    const key = `${h.target.kind}:${h.target.id}`;
    if (atMeta.has(key)) continue;
    if (await inServiceElsewhere(h.target, clinicId)) {
      atMeta.set(key, "shared_in_service");
      continue;
    }
    try {
      if (h.target.kind === "page") await unsubscribePage(fetchImpl, h.target.id, h.token);
      else await unsubscribeWaba(fetchImpl, h.target.id, h.token);
      atMeta.set(key, "revoked");
    } catch (error) {
      const gone = error instanceof GraphError && error.code === TOKEN_INVALID;
      atMeta.set(key, gone ? "already_gone" : "failed");
      if (!gone) {
        log.warn("Meta did not take the app off a clinic's account", {
          clinicId,
          provider: h.provider,
          status: error instanceof GraphError ? error.status : null,
          code: error instanceof GraphError ? (error.code ?? null) : null,
        });
      }
    }
  }

  // 3. The tokens erased for every connection Meta no longer needs one for,
  //    each audited with what happened there; a refusal counted on its row.
  const outcomeOf = (h: Held): MetaRevokeOutcome | "failed" =>
    !h.target || !h.token
      ? "nothing_to_unsubscribe"
      : (atMeta.get(`${h.target.kind}:${h.target.id}`) ?? "failed");
  const refused = held.filter((h) => outcomeOf(h) === "failed");
  const alertFor: Held[] = [];
  await withTenant({ clinicId, actor }, async (tx) => {
    for (const h of held) {
      const outcome = outcomeOf(h);
      if (outcome === "failed") {
        await tx.db
          .update(providerConnections)
          .set({
            transientFailures: sql`least(${providerConnections.transientFailures} + 1, 32000)`,
          })
          .where(eq(providerConnections.id, h.connectionId));
        if (h.failures + 1 >= META_REVOKE_ALERT_AFTER) alertFor.push(h);
        continue;
      }
      const erased = await eraseCredentials(tx.db, {
        clinicId: tx.clinicId,
        connectionId: h.connectionId,
        reason: "service_ended",
      });
      if (!erased) continue;
      tx.audit.record({
        action: "update",
        resourceType: "provider_connection",
        resourceId: h.connectionId,
        metadata: { provider: h.provider, outcome, reason: "service_ended" },
      });
    }
  });
  for (const h of alertFor) {
    await notifyOpsOnce("meta_revoke_failed", {
      clinicId,
      connectionId: h.connectionId,
      provider: h.provider,
      phase: "retries",
    });
  }
  return { revoked: held.length - refused.length, failed: refused.length };
}

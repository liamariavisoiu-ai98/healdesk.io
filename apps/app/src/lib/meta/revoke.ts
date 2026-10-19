import { and, eq, inArray, ne } from "drizzle-orm";

import { providerConnections } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { eraseCredentials, withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
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
 * use. Meta answering that the token is already dead (code 190: the clinic
 * removed the app, or Meta ended the grant) means the access is gone
 * already, and the token is erased all the same. Any other failure leaves
 * the connection as it is, to be tried again by the next hourly run
 * (lib/scheduler/tick.ts), and destruction deletes the row in any case.
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

export type MetaRevokeResult = {
  /** Clinics looked at. */
  clinics: number;
  /** Connections whose token was erased. */
  revoked: number;
  /** Connections left for the next run, Meta having refused or failed. */
  failed: number;
};

type Target = { kind: "page" | "waba"; id: string };
type Held = { connectionId: string; provider: string; token: string | null; target: Target | null };

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
      });
    }
    return out;
  });
  if (held === null) return null;
  if (held.length === 0) return { revoked: 0, failed: 0 };

  // 2. Meta, with no transaction open: each Page or account once.
  const outcomes = new Map<string, "done" | "gone" | "failed">();
  for (const h of held) {
    if (!h.target || !h.token) continue;
    const key = `${h.target.kind}:${h.target.id}`;
    if (outcomes.get(key) === "done" || outcomes.get(key) === "gone") continue;
    try {
      if (h.target.kind === "page") await unsubscribePage(fetchImpl, h.target.id, h.token);
      else await unsubscribeWaba(fetchImpl, h.target.id, h.token);
      outcomes.set(key, "done");
    } catch (error) {
      const gone = error instanceof GraphError && error.code === TOKEN_INVALID;
      outcomes.set(key, gone ? "gone" : "failed");
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

  // 3. The tokens erased, for every connection whose access Meta no longer
  //    gives us: unsubscribed, already gone, or with no Page or account to
  //    unsubscribe from (an operator-pasted token, or one with nothing left
  //    to open), where the erasure is the whole of it.
  const outcomeOf = (h: Held): "done" | "gone" | "failed" | "nothing_to_call" =>
    !h.target || !h.token
      ? "nothing_to_call"
      : (outcomes.get(`${h.target.kind}:${h.target.id}`) ?? "failed");
  const erasable = held.filter((h) => outcomeOf(h) !== "failed");
  if (erasable.length > 0) {
    await withTenant({ clinicId, actor }, async (tx) => {
      for (const h of erasable) {
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
          metadata: {
            provider: h.provider,
            outcome: "revoked",
            reason: "service_ended",
            meta: outcomeOf(h),
          },
        });
      }
    });
  }
  return { revoked: erasable.length, failed: held.length - erasable.length };
}

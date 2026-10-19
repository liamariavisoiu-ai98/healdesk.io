import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { providerConnections } from "@/db/schema";
import { withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { type FetchLike, probeToken } from "./graph";
import { markBrokenWithin } from "./reconnect";
import { META_PROVIDERS } from "./providers";

/**
 * The periodic check behind "Reconnect": once every few hours, ask Meta about
 * every live Meta token with the cheapest call there is (graph.ts, probeToken).
 *
 * A send that Meta refuses marks the connection at once (sendMetaReply), but a
 * clinic that revoked healdesk on a quiet week is not sending anything, and
 * its portal would say "Connected" until the next patient wrote in and got no
 * answer. This closes that gap. Meta offers a Deauthorize Callback URL too,
 * but it names a Facebook user, not a Page or number, and we keep no user id,
 * so it could not tell us which clinic lost what.
 *
 * Only `invalid` marks. A timeout or an unexpected answer counts as nothing
 * and the next run asks again. Connections already marked are skipped (read
 * from the row, since the listing below does not carry it), and a mark is
 * dropped if the login was saved again after the token was read.
 *
 * Read across tenants the way connection-health does, through
 * `app_connection_health()` (ids, provider and status, no credential), then
 * one short transaction to read the credential, Meta asked with none open,
 * and one to mark. No patient data is read or written.
 */

const WATCH_ACTOR = { type: "service" as const, serviceName: "meta-token-watch" };
const META_PROVIDER_NAMES: ReadonlySet<string> = new Set(Object.values(META_PROVIDERS));

export type MetaTokenWatchResult = { checked: number; marked: number; failures: number };

export async function runMetaTokenWatch(options: { fetchImpl?: FetchLike } = {}): Promise<MetaTokenWatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const result = await unsafeDb.execute<{
    clinic_id: string;
    connection_id: string;
    provider: string;
    status: string;
  }>(sql`select clinic_id, connection_id, provider, status from app_connection_health()`);
  const rows = ((result as unknown as { rows?: unknown[] }).rows ?? result) as {
    clinic_id: string;
    connection_id: string;
    provider: string;
    status: string;
  }[];

  const out: MetaTokenWatchResult = { checked: 0, marked: 0, failures: 0 };
  for (const row of rows) {
    if (!META_PROVIDER_NAMES.has(row.provider) || (row.status !== "active" && row.status !== "pending")) continue;
    try {
      // The credential is read in one transaction and Meta asked with none
      // open (graph.ts, rule 3); the mark is a second one, guarded by when the
      // row was read so a reconnect in between is not marked dead.
      const read = await withTenant({ clinicId: row.clinic_id, actor: WATCH_ACTOR }, async (tx) => {
        const [current] = await tx.db
          .select({ brokenAt: providerConnections.brokenAt, updatedAt: providerConnections.updatedAt })
          .from(providerConnections)
          .where(eq(providerConnections.id, row.connection_id))
          .limit(1);
        if (!current || current.brokenAt !== null) return null;
        const accessToken = await withCredentials(
          tx.db,
          { clinicId: tx.clinicId, connectionId: row.connection_id },
          async (credentials) => credentials.accessToken ?? null,
        );
        return accessToken ? { accessToken, readAt: current.updatedAt } : null;
      });
      if (!read) continue;
      const verdict = await probeToken(fetchImpl, read.accessToken);
      out.checked += 1;
      if (verdict !== "invalid") continue;
      const marked = await withTenant({ clinicId: row.clinic_id, actor: WATCH_ACTOR }, (tx) =>
        markBrokenWithin(tx, row.connection_id, "token_invalid", read.readAt),
      );
      if (marked) out.marked += 1;
    } catch (error) {
      out.failures += 1;
      log.warn("Meta token check failed for a connection", { clinicId: row.clinic_id, error: describeError(error) });
    }
  }
  return out;
}

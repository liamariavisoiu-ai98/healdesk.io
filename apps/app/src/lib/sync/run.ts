// PHASE TWO: attribution (POS/EMR read-back, sync, reconciliation and the
// monthly revenue report). Not part of v1: kept, but fenced out of v1 flows,
// screens, emails and copy (HEALDESK_PHASE_TWO_ATTRIBUTION, lib/env.ts).
import {
  budgetFor,
  getAdapter,
  limitationsOf,
  safeLog,
  Throttle,
  type CanonicalAppointment,
  type CanonicalContact,
  type CanonicalSale,
  type ConnectorAdapter,
  type ConnectorContext,
  type Page,
  type Result,
  type TimeWindow,
} from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import { providerConnections, syncRuns } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withCredentials } from "@/lib/connections/store";
import { withTenant } from "@/lib/tenant";

import {
  advanceTo,
  lastCursor,
  SYNC_RESOURCES,
  windowFor,
  type SyncResource,
} from "./cursors";
import { upsertAppointments, upsertContacts, upsertSales } from "./upsert";

/**
 * One sync run, for one connection.
 *
 * The shape of this file is decided by three constraints that pull against
 * each other:
 *
 *   1. **Credentials must not escape their audited read.** store.ts hands them
 *      to a callback and never returns them.
 *   2. **Network I/O must not happen inside a database transaction.** An open
 *      transaction holds a snapshot; holding one across a slow HTTP call to
 *      PatientNow blocks vacuum and burns a pooled connection doing nothing.
 *   3. **Writes must be tenant-scoped**, so they need a transaction.
 *
 * The resolution: one short transaction decrypts the credential and hands back
 * a context that lives in the run's closure, then every page is fetched with no
 * transaction open and written in its own short one. Rule 1 bends exactly once,
 * here, in a named private function — see `openContext` — rather than being
 * quietly relaxed wherever it got inconvenient.
 *
 * Per-page transactions also mean a run that dies at page 40 keeps pages 1–39.
 * Since the cursor only advances at the end, the next run re-reads them and the
 * upserts make that a no-op.
 */

/** Guard against a platform whose cursor never terminates. */
const MAX_PAGES = 200;

/** Our table names, for the audit trail. Not the adapter's resource names. */
const AUDIT_RESOURCE: Record<SyncResource, string> = {
  contacts: "contact",
  appointments: "appointment",
  sales: "transaction",
};

export type ResourceOutcome = {
  resource: SyncResource;
  status: "ok" | "partial" | "failed" | "skipped";
  itemsSeen: number;
  itemsWritten: number;
  /** Verbatim limitations. Reach the clinic; never summarised away. */
  notes: string[];
  error?: string;
};

export type SyncSummary = {
  clinicId: string;
  connectionId: string;
  provider: string;
  resources: ResourceOutcome[];
};

export async function syncConnection(input: {
  clinicId: string;
  connectionId: string;
  /** Injectable so tests are deterministic. */
  now?: Date;
  resources?: readonly SyncResource[];
  actor?: ActorContext;
}): Promise<SyncSummary> {
  const now = input.now ?? new Date();
  const actor: ActorContext = input.actor ?? {
    type: "service",
    serviceName: "sync-engine",
  };

  const opened = await openContext(input.clinicId, input.connectionId, actor);

  const adapter = getAdapter(opened.provider);
  if (!adapter) {
    // A platform with no adapter is a known state, not an error. The console
    // reads this to explain an empty report instead of showing zero revenue
    // with no reason.
    return {
      clinicId: input.clinicId,
      connectionId: input.connectionId,
      provider: opened.provider,
      resources: (input.resources ?? SYNC_RESOURCES).map((resource) => ({
        resource,
        status: "skipped" as const,
        itemsSeen: 0,
        itemsWritten: 0,
        notes: [`No adapter for ${opened.provider} yet, so nothing was synced.`],
      })),
    };
  }

  const throttle = new Throttle(budgetFor(opened.provider));
  const outcomes: ResourceOutcome[] = [];

  // Sequential, not Promise.all. The resources share one rate budget, and
  // contacts must land before the appointments that reference them.
  for (const resource of input.resources ?? SYNC_RESOURCES) {
    outcomes.push(
      await syncResource({
        adapter,
        context: opened.context,
        clinicId: input.clinicId,
        connectionId: input.connectionId,
        provider: opened.provider,
        resource,
        throttle,
        now,
        actor,
      }),
    );
  }

  return {
    clinicId: input.clinicId,
    connectionId: input.connectionId,
    provider: opened.provider,
    resources: outcomes,
  };
}

async function syncResource(args: {
  adapter: ConnectorAdapter;
  context: ConnectorContext;
  clinicId: string;
  connectionId: string;
  provider: string;
  resource: SyncResource;
  throttle: Throttle;
  now: Date;
  actor: ActorContext;
}): Promise<ResourceOutcome> {
  const { adapter, resource, clinicId, connectionId, provider, now, actor } = args;

  const capability =
    resource === "sales"
      ? adapter.capabilities.listSales
      : resource === "appointments"
        ? adapter.capabilities.listAppointments
        : { support: "full" as const };

  if (capability.support === "unsupported") {
    // Not a failure. The platform cannot do this, permanently, and the reason
    // belongs in front of the clinic rather than in a log nobody reads.
    return {
      resource,
      status: "skipped",
      itemsSeen: 0,
      itemsWritten: 0,
      notes: [capability.note ?? `${adapter.displayName} cannot provide ${resource}.`],
    };
  }

  // ---- 1. Open the run and work out the window. One short transaction. -----
  const { runId, window } = await withTenant({ clinicId, actor }, async (tx) => {
    const cursor = await lastCursor(tx.db, connectionId, resource);
    const window = windowFor(cursor, now);

    const [row] = await tx.db
      .insert(syncRuns)
      .values({
        clinicId,
        connectionId,
        resource,
        status: "running",
        cursorAt: cursor,
      })
      .returning({ id: syncRuns.id });

    return { runId: row!.id, window };
  });

  const notes = limitationsOf(adapter.capabilities);
  let itemsSeen = 0;
  let itemsWritten = 0;
  let cursorToken: string | undefined;
  let pages = 0;
  let failure: string | undefined;
  let partial = false;

  // ---- 2. Page through. No transaction is open during the fetch. ----------
  while (pages < MAX_PAGES) {
    const permit = await args.throttle.take();
    if (!permit.allowed) {
      // Out of budget is a partial run, not a failed one — what we already
      // wrote is good, and the cursor must NOT advance past what we read.
      partial = true;
      notes.push(permit.reason);
      break;
    }

    const page = await fetchPage(adapter, args.context, resource, window, cursorToken);

    if (!page.ok) {
      if (page.error.code === "unsupported") {
        return finish({
          status: "skipped",
          notes: [...notes, page.error.message],
        });
      }
      // Retryable or not, the run stops here. The difference shows up in
      // whether the caller reschedules — see workers/sync.ts.
      failure = page.error.message;
      break;
    }

    pages += 1;
    itemsSeen += page.value.items.length;
    if (page.value.notes?.length) notes.push(...page.value.notes);

    // ---- 3. Write this page in its own short transaction. -----------------
    if (page.value.items.length > 0) {
      itemsWritten += await withTenant({ clinicId, actor }, async (tx) => {
        const written = await writePage(
          tx.db,
          clinicId,
          provider,
          resource,
          page.value.items,
        );

        // "update", not "create": a sync page is an upsert, and on every run
        // after the first it is overwhelmingly refreshing rows that already
        // exist. Claiming "create" would make the audit trail read as if we
        // manufactured a new patient record every night.
        tx.audit.record({
          action: "update",
          resourceType: AUDIT_RESOURCE[resource],
          resultCount: written,
          metadata: { source: provider, syncRunId: runId, operation: "upsert" },
        });

        return written;
      });
    }

    cursorToken = page.value.cursor;
    if (!cursorToken) break;
  }

  if (pages >= MAX_PAGES && cursorToken) {
    // Say so rather than presenting a truncated sync as complete.
    partial = true;
    notes.push(
      `Stopped after ${MAX_PAGES} pages of ${resource}; the rest will be picked up on the next run.`,
    );
  }

  return finish(
    failure
      ? { status: "failed", notes, error: failure }
      : { status: partial ? "partial" : "ok", notes },
  );

  async function finish(result: {
    status: ResourceOutcome["status"];
    notes: string[];
    error?: string;
  }): Promise<ResourceOutcome> {
    // The cursor only advances on a clean run. A partial run re-reads its own
    // window next time, which the upserts make free — the alternative is a
    // permanent hole in the data that nothing ever goes back for.
    const cursorAt = result.status === "ok" ? advanceTo(window) : undefined;

    await withTenant({ clinicId, actor }, async (tx) => {
      await tx.db
        .update(syncRuns)
        .set({
          status: result.status === "skipped" ? "ok" : result.status,
          itemsSeen,
          itemsWritten,
          notes: dedupe(result.notes),
          error: result.error ?? null,
          pageCursor: cursorToken ?? null,
          finishedAt: new Date(),
          ...(cursorAt ? { cursorAt } : {}),
        })
        .where(and(eq(syncRuns.id, runId), eq(syncRuns.clinicId, clinicId)));

      if (result.error) {
        await tx.db
          .update(providerConnections)
          .set({ lastError: safeLog(result.error), updatedAt: new Date() })
          .where(
            and(
              eq(providerConnections.id, connectionId),
              eq(providerConnections.clinicId, clinicId),
            ),
          );
      }
    });

    return {
      resource,
      status: result.status,
      itemsSeen,
      itemsWritten,
      notes: dedupe(result.notes),
      error: result.error,
    };
  }
}

function fetchPage(
  adapter: ConnectorAdapter,
  context: ConnectorContext,
  resource: SyncResource,
  window: TimeWindow,
  cursor?: string,
): Promise<
  Result<Page<CanonicalContact | CanonicalAppointment | CanonicalSale>>
> {
  switch (resource) {
    case "contacts":
      return adapter.listContacts(context, window, cursor);
    case "appointments":
      return adapter.listAppointments(context, window, cursor);
    case "sales":
      return adapter.listSales(context, window, cursor);
  }
}

function writePage(
  db: Parameters<Parameters<typeof withTenant>[1]>[0]["db"],
  clinicId: string,
  provider: string,
  resource: SyncResource,
  items: (CanonicalContact | CanonicalAppointment | CanonicalSale)[],
): Promise<number> {
  switch (resource) {
    case "contacts":
      return upsertContacts(db, clinicId, provider, items as CanonicalContact[]);
    case "appointments":
      return upsertAppointments(
        db,
        clinicId,
        provider,
        items as CanonicalAppointment[],
      );
    case "sales":
      return upsertSales(db, clinicId, provider, items as CanonicalSale[]);
  }
}

/**
 * Decrypt the credential and build the adapter context.
 *
 * ⚠️ This is the one place the plaintext credential bag leaves the callback
 * store.ts hands it to. That rule exists so decrypts happen in audited places
 * rather than wherever convenient — and it is honoured by there being exactly
 * one exception, named, with the alternative spelled out: keeping the
 * transaction open for the whole run would hold a Postgres snapshot across
 * every HTTP call in a sync, which is a worse problem than this one.
 *
 * The value never leaves the run's closure, is never returned to a caller, and
 * safeLog() redacts token-shaped strings if one ever reaches a log line.
 */
async function openContext(
  clinicId: string,
  connectionId: string,
  actor: ActorContext,
): Promise<{ provider: string; context: ConnectorContext }> {
  return withTenant({ clinicId, actor }, async (tx) => {
    const [connection] = await tx.db
      .select({
        provider: providerConnections.provider,
        status: providerConnections.status,
        metadata: providerConnections.metadata,
      })
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!connection) throw new Error("Connection not found.");
    if (connection.status === "revoked") {
      throw new Error("Connection has been revoked.");
    }

    tx.audit.record({
      action: "decrypt",
      resourceType: "credential",
      resourceId: connectionId,
      metadata: { provider: connection.provider, purpose: "sync" },
    });

    const context = await withCredentials(
      tx.db,
      { clinicId, connectionId },
      async (credentials) => ({
        clinicId,
        connectionId,
        credentials,
        metadata: (connection.metadata ?? undefined) as
          | Record<string, unknown>
          | undefined,
      }),
    );

    return { provider: connection.provider, context };
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

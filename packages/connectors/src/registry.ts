import { fixtureAdapter } from "./fixture/adapter";
import type { ConnectorAdapter } from "./port";

/**
 * Adapter lookup.
 *
 * Only the fixture is registered. The real adapters need vendor accounts that
 * do not exist yet, and registering an unimplemented one would let the sync
 * engine pick it up and fail at runtime rather than at connect time.
 *
 * Adding one is a single line here plus the adapter itself — the engine, the
 * reconciler and the reports need no changes, which is the return on the port
 * being narrow.
 */
const ADAPTERS: Record<string, ConnectorAdapter> = {
  [fixtureAdapter.id]: fixtureAdapter,
};

export function getAdapter(platformId: string): ConnectorAdapter | undefined {
  return ADAPTERS[platformId];
}

export function registeredAdapters(): ConnectorAdapter[] {
  return Object.values(ADAPTERS);
}

/**
 * Platforms a clinic can select but which have no adapter yet.
 *
 * Used by the console to explain why a connected platform isn't syncing, rather
 * than showing an empty report with no reason.
 */
export function isImplemented(platformId: string): boolean {
  return platformId in ADAPTERS;
}

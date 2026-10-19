import type { ServicePriceKind } from "@healdesk/catalog";

import type { AgentService } from "@/db/schema";

/**
 * How a service's price is stated, and keeping it through every writer of
 * agent_configs.services (0056).
 *
 * The wizard and Knowledge store each service's price kind, the unit of a
 * per-unit price and its deposit. The ops console's agent form predates them:
 * it edits a name, two prices and a length, and sends the whole list back.
 * Without the carry below, a greeting edit on the onboarding call erased every
 * kind, unit and deposit, and "$14.50 per pulse" came back as the whole price
 * of the service.
 *
 * Pure: no database, no imports beyond the types, so both writers
 * (lib/setup/knowledge.ts and lib/onboarding/agent-config.ts) can use it
 * without importing each other.
 */

/** What two stored prices say a service's kind is, for a service stored without one. */
export function inferPriceKind(from: number | null, to: number | null): ServicePriceKind | null {
  if (from === null) return null;
  // A start with no top is a "from" price: the console's "from $" field on
  // its own, and how the wizard stores "from" and per-unit prices alike.
  if (to === null) return "from";
  return to === from ? "exact" : "range";
}

/** Whether `kind` describes these prices, as the wizard stores each kind. */
export function priceKindFits(
  kind: ServicePriceKind | null,
  from: number | null,
  to: number | null,
): boolean {
  switch (kind) {
    case null:
      return from === null;
    case "exact":
      return from !== null && to === from;
    case "range":
      return from !== null && to !== null && to > from;
    case "from":
    case "per_unit":
      return from !== null && to === null;
  }
}

/** The service's kind: its own while it still fits its prices, otherwise what the prices say. */
export function priceKindOf(
  service: Pick<AgentService, "priceKind" | "priceFromUsd" | "priceToUsd" | "unit">,
): ServicePriceKind | null {
  const own = service.priceKind;
  if (own !== undefined && priceKindFits(own, service.priceFromUsd, service.priceToUsd)) {
    if (own !== "per_unit" || (service.unit ?? "").trim() !== "") return own;
  }
  return inferPriceKind(service.priceFromUsd, service.priceToUsd);
}

/**
 * A service's listed price as a booking snapshots it (appointments.
 * listed_price_cents and listed_price_kind, drizzle/0081), for booked value
 * (lib/reporting/claims.ts): the low end, in cents, and how the menu states
 * it. An exact price is itself; a "from" price and a range are their start,
 * the least the clinic's own list says the booking is worth; a per-unit
 * price is the price of one unit, which the claims count apart and never
 * multiply into a total, because nobody knows how many units a booking
 * takes. Null for a service with no listed price ("quote on the call is not
 * allowed"), or none at all.
 */
export function listedPrice(
  service: Pick<AgentService, "priceKind" | "priceFromUsd" | "priceToUsd" | "unit"> | null | undefined,
): { cents: number; kind: ServicePriceKind } | null {
  if (!service) return null;
  const kind = priceKindOf(service);
  const from = service.priceFromUsd;
  if (kind === null || from === null || !Number.isFinite(from) || from < 0) return null;
  return { cents: Math.round(from * 100), kind };
}

/** Dollars, to the cent. */
export function toCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The services a writer that does not know the price details is about to
 * store, with those details kept.
 *
 * A key the caller left out (undefined) is taken from the stored service of
 * the same name, matched exactly and then ignoring case and spacing; a key it
 * sent, null included, is its answer. The kind is then checked against the
 * prices the caller sent: a kind they no longer fit (an exact price given a
 * top, a per-unit price given a range, a per-unit price with no unit) gives
 * way to the kind the prices say, so no stored kind can describe a price it
 * is not. A unit stays only with a per-unit price.
 */
export function carryServiceDetails(
  stored: readonly AgentService[],
  incoming: readonly AgentService[],
): AgentService[] {
  const exact = new Map(stored.map((s) => [s.name, s]));
  const loose = new Map(stored.map((s) => [looseName(s.name), s]));
  return incoming.map((row) => {
    const base = exact.get(row.name) ?? loose.get(looseName(row.name));
    const kind = row.priceKind !== undefined ? row.priceKind : base?.priceKind;
    const unit = row.unit !== undefined ? row.unit : base?.unit;
    const deposit = row.depositUsd !== undefined ? row.depositUsd : base?.depositUsd;
    const resolved = priceKindOf({
      priceKind: kind,
      priceFromUsd: row.priceFromUsd,
      priceToUsd: row.priceToUsd,
      unit,
    });
    return {
      name: row.name,
      priceKind: resolved,
      priceFromUsd: row.priceFromUsd,
      priceToUsd: row.priceToUsd,
      unit: resolved === "per_unit" ? (unit ?? null) : null,
      durationMinutes: row.durationMinutes,
      ...(deposit !== undefined && deposit !== null ? { depositUsd: deposit } : {}),
    };
  });
}

function looseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

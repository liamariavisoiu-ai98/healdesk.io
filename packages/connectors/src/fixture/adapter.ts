import type { CapabilitySet } from "../capabilities";
import type { ConnectorAdapter } from "../port";
import { ok, type Result } from "../result";
import type {
  CanonicalAppointment,
  CanonicalContact,
  CanonicalSale,
  ConnectorContext,
  Page,
  TimeWindow,
  VerifiedInfo,
} from "../types";

import { generate } from "./generator";

/**
 * A synthetic clinic that behaves like a real platform.
 *
 * This exists so the sync engine, the reconciler and the monthly report can be
 * built, tested and demoed to prospects before any vendor has granted access —
 * which means business development and engineering run in parallel instead of
 * one waiting on the other.
 *
 * It deliberately declares itself as `partial` on backfill and pages its
 * results, because an adapter that behaves perfectly teaches the engine
 * nothing. If the pipeline only works against a fixture with no cursors, no
 * pagination and complete history, the first real platform breaks it.
 */

const PAGE_SIZE = 25;

const CAPABILITIES: CapabilitySet = {
  listAppointments: { support: "full" },
  readArrival: {
    support: "partial",
    note: "A small share of appointments come back with an unknown arrival state, mimicking platforms that record check-in inconsistently.",
  },
  listSales: { support: "full" },
  backfillSales: {
    support: "partial",
    note: "Synthetic history is generated on demand rather than stored, so it is internally consistent but not a real record.",
  },
  createAppointment: { support: "unsupported", note: "Fixture is read-only." },
  writeBack: { support: "unsupported", note: "Fixture is read-only." },
};

export class FixtureAdapter implements ConnectorAdapter {
  readonly id = "fixture";
  readonly displayName = "Synthetic clinic";
  readonly capabilities = CAPABILITIES;

  async verify(context: ConnectorContext): Promise<Result<VerifiedInfo>> {
    return ok({
      accountLabel: `Synthetic clinic ${context.clinicId.slice(0, 8)}`,
      coverageStartedAt: null,
    });
  }

  async listAppointments(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalAppointment>>> {
    const { appointments } = this.#data(context, window);
    return ok(paginate(appointments, cursor));
  }

  async listSales(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalSale>>> {
    const { sales } = this.#data(context, window);

    // Sales are keyed on when the money moved, which is not the same window as
    // the appointments that produced them — a deposit taken in June belongs to
    // a July visit. Filtering here rather than in the generator keeps that
    // distinction visible.
    const inWindow = sales.filter(
      (sale) =>
        sale.collectedAt >= window.from && sale.collectedAt < window.to,
    );

    return ok(paginate(inWindow, cursor));
  }

  async listContacts(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalContact>>> {
    const { contacts } = this.#data(context, window);
    return ok(paginate(contacts, cursor));
  }

  /**
   * Seeded from the clinic id, so the same clinic always yields the same
   * synthetic history. A demo that changes its numbers on refresh is worse
   * than no demo.
   *
   * The window is widened backwards so sales collected before it — deposits —
   * still exist to be found.
   */
  #data(context: ConnectorContext, window: TimeWindow) {
    const seed = [...context.clinicId].reduce(
      (acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0,
      7,
    );

    return generate({
      seed,
      from: new Date(window.from.getTime() - 30 * 86_400_000),
      to: window.to,
    });
  }
}

function paginate<T>(items: T[], cursor?: string): Page<T> {
  const offset = cursor ? Number(cursor) : 0;
  const slice = items.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;

  return {
    items: slice,
    cursor: next < items.length ? String(next) : undefined,
  };
}

export const fixtureAdapter = new FixtureAdapter();

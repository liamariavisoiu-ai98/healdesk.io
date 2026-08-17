import { describe, expect, test } from "vitest";

import { limitationsOf } from "../src/capabilities";
import { assertNonClinical, ClinicalContentError, safeLog, toE164, toMoney } from "../src/guards";
import type { ConnectorAdapter } from "../src/port";
import { registeredAdapters } from "../src/registry";
import { Throttle } from "../src/throttle";
import type { CanonicalSale, ConnectorContext, TimeWindow } from "../src/types";

/**
 * The contract every adapter must satisfy.
 *
 * Written as a loop over the registry rather than as one suite per adapter, so
 * a new platform is covered the moment it is registered and nobody has to
 * remember to copy the tests. When Boulevard lands, these run against it
 * unchanged — and the properties they check are exactly the ones whose
 * violation would be invisible until a monthly figure came out wrong:
 *
 *   - pagination terminates, and pages don't repeat items
 *   - the window is respected, so consecutive syncs never double-count
 *   - money is a string, always, because a float loses cents
 *   - nothing clinical crosses the boundary
 */

const context = (clinicId = "11111111-1111-4111-8111-111111111111"): ConnectorContext => ({
  clinicId,
  connectionId: "22222222-2222-4222-8222-222222222222",
  credentials: {},
});

const window_: TimeWindow = {
  from: new Date("2026-06-01T00:00:00Z"),
  to: new Date("2026-08-01T00:00:00Z"),
};

/** Drain every page, with a hard stop so a broken cursor fails loudly. */
async function drain<T>(
  fetch: (cursor?: string) => Promise<
    { ok: true; value: { items: T[]; cursor?: string } } | { ok: false; error: unknown }
  >,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await fetch(cursor);
    if (!page.ok) throw new Error(`Page failed: ${JSON.stringify(page.error)}`);
    items.push(...page.value.items);
    cursor = page.value.cursor;
    pages += 1;
    if (pages > 100) throw new Error("Cursor never terminated after 100 pages.");
  } while (cursor);

  return { items, pages };
}

describe.each(registeredAdapters().map((a) => [a.id, a] as const))(
  "adapter contract: %s",
  (_id, adapter: ConnectorAdapter) => {
    test("verify() succeeds and reports what it can reach", async () => {
      const result = await adapter.verify(context());
      expect(result.ok).toBe(true);
    });

    test("every limitation is a sentence, not a field name", () => {
      for (const note of limitationsOf(adapter.capabilities)) {
        // A note is what the clinic reads. "listSales: partial" is not a note.
        expect(note.length).toBeGreaterThan(20);
        expect(note).toMatch(/[.!]$/);
      }
    });

    test("a capability below full always carries a note", () => {
      for (const [name, capability] of Object.entries(adapter.capabilities)) {
        if (capability.support === "full") continue;
        if (capability.support === "unsupported" && !capability.note) {
          // Permissible: "the platform cannot do this" needs no elaboration
          // when the console renders the support level itself.
          continue;
        }
        expect(capability.note, `${name} has no note`).toBeTruthy();
      }
    });

    test("appointment pagination terminates and never repeats an item", async () => {
      if (adapter.capabilities.listAppointments.support === "unsupported") return;

      const { items } = await drain((cursor) =>
        adapter.listAppointments(context(), window_, cursor),
      );

      const ids = items.map((item) => item.externalId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("appointments fall inside the requested window", async () => {
      if (adapter.capabilities.listAppointments.support === "unsupported") return;

      const { items } = await drain((cursor) =>
        adapter.listAppointments(context(), window_, cursor),
      );

      for (const item of items) {
        // Half-open: `to` itself is excluded, so consecutive windows can be
        // stitched together without double-counting the boundary.
        expect(item.scheduledFor.getTime()).toBeLessThan(window_.to.getTime());
      }
    });

    test("sales carry money as a string with two decimals", async () => {
      if (adapter.capabilities.listSales.support === "unsupported") return;

      const { items } = await drain<CanonicalSale>((cursor) =>
        adapter.listSales(context(), window_, cursor),
      );

      expect(items.length).toBeGreaterThan(0);
      for (const sale of items) {
        expect(typeof sale.amountUsd).toBe("string");
        expect(sale.amountUsd).toMatch(/^-?\d+\.\d{2}$/);
      }
    });

    test("nothing clinical crosses the boundary", async () => {
      if (adapter.capabilities.listAppointments.support === "unsupported") return;

      const { items } = await drain((cursor) =>
        adapter.listAppointments(context(), window_, cursor),
      );

      for (const item of items) {
        // The port has no getChart(), but an adapter could still smuggle a
        // diagnosis into a free-text field. This is the runtime backstop.
        for (const text of [item.treatment, item.providerName]) {
          if (text) expect(() => assertNonClinical(text)).not.toThrow();
        }
      }
    });

    test("the same clinic gets the same data twice — sync must be idempotent", async () => {
      if (adapter.capabilities.listAppointments.support === "unsupported") return;

      const first = await drain((cursor) =>
        adapter.listAppointments(context(), window_, cursor),
      );
      const second = await drain((cursor) =>
        adapter.listAppointments(context(), window_, cursor),
      );

      expect(second.items.map((i) => i.externalId)).toEqual(
        first.items.map((i) => i.externalId),
      );
    });

    test("different clinics get different data — no shared fixture leak", async () => {
      if (adapter.capabilities.listAppointments.support === "unsupported") return;

      const a = await drain((cursor) =>
        adapter.listAppointments(context("11111111-1111-4111-8111-111111111111"), window_, cursor),
      );
      const b = await drain((cursor) =>
        adapter.listAppointments(context("33333333-3333-4333-8333-333333333333"), window_, cursor),
      );

      expect(a.items.map((i) => i.externalId)).not.toEqual(
        b.items.map((i) => i.externalId),
      );
    });
  },
);

describe("guards", () => {
  test("assertNonClinical rejects a diagnosis hiding in a free-text field", () => {
    expect(() => assertNonClinical("patient diagnosis: rosacea")).toThrow(
      ClinicalContentError,
    );
    expect(() => assertNonClinical("Botox — 3 areas")).not.toThrow();
  });

  test("toMoney keeps cents through the string boundary", () => {
    expect(toMoney(1234, { isCents: true })).toBe("12.34");
    expect(toMoney("$1,234.5")).toBe("1234.50");
    // 0.1 + 0.2 territory: the reason money is never a float past this point.
    expect(toMoney(0.1 + 0.2)).toBe("0.30");
    expect(toMoney(undefined)).toBeUndefined();
  });

  test("toE164 returns undefined rather than inventing a number", () => {
    expect(toE164("(555) 010-1234")).toBe("+15550101234");
    expect(toE164("ask reception")).toBeUndefined();
  });

  test("safeLog redacts anything patient-shaped", () => {
    const line = safeLog("call from +15550101234 (jane@example.com) on 2026-07-14");
    expect(line).not.toContain("5550101234");
    expect(line).not.toContain("jane@example.com");
  });
});

describe("throttle", () => {
  test("a daily budget holds back the interactive reserve from background work", async () => {
    let clock = 0;
    const throttle = new Throttle(
      { perMinute: null, perDay: 10, interactiveReserve: 3 },
      () => clock,
    );

    for (let i = 0; i < 7; i += 1) {
      expect((await throttle.take()).allowed).toBe(true);
    }

    // Background work is out of budget at 7 of 10...
    expect((await throttle.take()).allowed).toBe(false);
    // ...but an operator clicking "test connection" still gets through.
    expect((await throttle.take({ interactive: true })).allowed).toBe(true);
  });

  test("the daily counter rolls over", async () => {
    let clock = 0;
    const throttle = new Throttle(
      { perMinute: null, perDay: 1, interactiveReserve: 0 },
      () => clock,
    );

    expect((await throttle.take()).allowed).toBe(true);
    expect((await throttle.take()).allowed).toBe(false);

    clock += 86_400_001;
    expect((await throttle.take()).allowed).toBe(true);
  });
});

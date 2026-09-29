import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { canWriteBookings, isUsable, limitationsOf } from "../src/capabilities";
import { fixtureAdapter } from "../src/fixture/adapter";
import { assertNonClinical, ClinicalContentError, safeLog, toE164, toMoney } from "../src/guards";
import type { ConnectorAdapter } from "../src/port";
import { registeredAdapters } from "../src/registry";
import { Throttle } from "../src/throttle";
import type {
  CanonicalSale,
  ConnectorContext,
  CreateAppointmentInput,
  TimeWindow,
} from "../src/types";

import { fakeCalcom } from "./calcom-fake";

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
 *   - an adapter that says it can write can also read slots and read back by
 *     key, because the app's write sequence needs all three
 *
 * Nothing here makes a live call. Every registered adapter needs an offline
 * harness below — a context it accepts and, for a real vendor, a fake standing
 * in for the vendor — and registering one without a harness fails at
 * collection time rather than reaching the vendor with a test key.
 */

const CLINIC_A = "11111111-1111-4111-8111-111111111111";
const CLINIC_B = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "22222222-2222-4222-8222-222222222222";

type Harness = {
  context(clinicId?: string): ConnectorContext;
  install(): void;
  uninstall(): void;
};

function harnessFor(adapter: ConnectorAdapter): Harness {
  switch (adapter.id) {
    case "fixture":
      return {
        context: (clinicId = CLINIC_A) => ({ clinicId, connectionId: CONNECTION, credentials: {} }),
        install() {},
        uninstall() {},
      };
    case "calcom": {
      // The registered instance resolves fetch at call time, so stubbing the
      // global routes it into the fake. Keyed per clinic so two clinics get
      // two Cal.com accounts.
      const fake = fakeCalcom({ seedBookings: 130 });
      return {
        context: (clinicId = CLINIC_A) => ({
          clinicId,
          connectionId: CONNECTION,
          credentials: { apiKey: `cal_${clinicId}` },
          metadata: { eventTypeId: 4242, durationMinutes: 30 },
        }),
        install: () => vi.stubGlobal("fetch", fake.fetch),
        uninstall: () => vi.unstubAllGlobals(),
      };
    }
    default:
      throw new Error(
        `${adapter.id} is registered but has no offline harness in contract.test.ts. ` +
          `Add one: a registered adapter must satisfy the contract without a live call.`,
      );
  }
}

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
    const harness = harnessFor(adapter);
    const context = harness.context;

    beforeAll(() => harness.install());
    afterAll(() => harness.uninstall());

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

    test("declared write support is backed by every method the write path needs", () => {
      const c = adapter.capabilities;
      const methods = {
        listSlots: adapter.listSlots,
        createAppointment: adapter.createAppointment,
        findAppointmentByKey: adapter.findAppointmentByKey,
      };

      for (const [name, capability] of [
        ["listSlots", c.listSlots],
        ["createAppointment", c.createAppointment],
        ["findAppointmentByKey", c.findAppointmentByKey],
      ] as const) {
        if (isUsable(capability)) {
          expect(typeof methods[name], `${name} declared but not implemented`).toBe("function");
        }
      }

      if (isUsable(c.createAppointment)) {
        // Saying "I can book" commits an adapter to the whole sequence: offer
        // real slots, book, and be read back so a retry never books twice.
        expect(typeof adapter.listSlots).toBe("function");
        expect(typeof adapter.findAppointmentByKey).toBe("function");
        expect(canWriteBookings(c)).toBe(true);
      }
    });

    test("the write path books once, reads back by key, and cancels only its own", async () => {
      if (!canWriteBookings(adapter.capabilities)) return;
      const ctx = context();
      const timeZone = "America/New_York";
      const slotWindow = {
        from: new Date("2026-10-05T00:00:00Z"),
        to: new Date("2026-10-10T00:00:00Z"),
      };

      const slots = await adapter.listSlots!(ctx, slotWindow, { timeZone });
      expect(slots.ok).toBe(true);
      if (!slots.ok) return;
      expect(slots.value.length).toBeGreaterThan(0);
      for (const [i, slot] of slots.value.entries()) {
        expect(slot.endsAt.getTime()).toBeGreaterThan(slot.startsAt.getTime());
        expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(slotWindow.from.getTime());
        expect(slot.startsAt.getTime()).toBeLessThan(slotWindow.to.getTime());
        if (i > 0) {
          expect(slot.startsAt.getTime()).toBeGreaterThan(slots.value[i - 1]!.startsAt.getTime());
        }
      }

      const slot = slots.value[0]!;
      const input: CreateAppointmentInput = {
        startsAt: slot.startsAt,
        durationMinutes: 30,
        attendee: { name: "Avery", email: "bookings+contract-1@sink.healdesk.io", timeZone },
        service: null,
        idempotencyKey: "contract-1",
      };

      const created = await adapter.createAppointment!(ctx, input);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.externalId).toBeTruthy();
      expect(created.value.startsAt).toEqual(slot.startsAt);

      const found = await adapter.findAppointmentByKey!(ctx, {
        idempotencyKey: input.idempotencyKey,
        attendeeEmail: input.attendee.email,
        around: slot.startsAt,
      });
      expect(found).toEqual({ ok: true, value: { externalId: created.value.externalId } });

      const missing = await adapter.findAppointmentByKey!(ctx, {
        idempotencyKey: "contract-never",
        attendeeEmail: input.attendee.email,
        around: slot.startsAt,
      });
      expect(missing).toEqual({ ok: true, value: null });

      if (adapter.cancelAppointment) {
        const cancelled = await adapter.cancelAppointment(ctx, created.value.externalId, "contract");
        expect(cancelled.ok).toBe(true);

        const notOurs = await adapter.cancelAppointment(ctx, "not-a-healdesk-booking", "contract");
        expect(notOurs.ok).toBe(false);
        if (!notOurs.ok) expect(notOurs.error.reason).toBe("not_ours");
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
        adapter.listAppointments(context(CLINIC_A), window_, cursor),
      );
      const b = await drain((cursor) =>
        adapter.listAppointments(context(CLINIC_B), window_, cursor),
      );

      expect(a.items.map((i) => i.externalId)).not.toEqual(
        b.items.map((i) => i.externalId),
      );
    });
  },
);

/**
 * The fixture used to declare `createAppointment: unsupported` ("Fixture is
 * read-only"). It is a writer now, because the app's calendar-write tests need
 * an adapter that can be told to refuse, or to time out after booking — the
 * two outcomes a real vendor produces and a read-only fixture could not.
 * Nothing in the repo asserted the old declaration; if something does again,
 * this block is where the reason lives.
 */
describe("fixture write path", () => {
  const context: ConnectorContext = {
    clinicId: CLINIC_A,
    connectionId: CONNECTION,
    credentials: {},
  };
  const input = (over: Partial<CreateAppointmentInput> = {}): CreateAppointmentInput => ({
    startsAt: new Date("2026-10-06T14:00:00Z"),
    durationMinutes: 30,
    attendee: {
      name: "Avery",
      email: "bookings+req-9@sink.healdesk.io",
      timeZone: "America/New_York",
    },
    service: null,
    idempotencyKey: "req-9",
    ...over,
  });

  beforeEach(() => fixtureAdapter.reset());

  test("the fixture satisfies the extended port", () => {
    const writer: Required<
      Pick<ConnectorAdapter, "listSlots" | "createAppointment" | "findAppointmentByKey" | "cancelAppointment">
    > = fixtureAdapter;
    expect(writer).toBe(fixtureAdapter);
    expect(canWriteBookings(fixtureAdapter.capabilities)).toBe(true);
  });

  test("slots are Monday to Friday, 09:00 to 16:00 in the given zone, every half hour", async () => {
    // A Monday-to-Sunday week in October: EDT, so 09:00 New York is 13:00Z.
    const week = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-12T00:00:00Z") };
    const result = await fixtureAdapter.listSlots(context, week, { timeZone: "America/New_York" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(5 * 14);
    expect(result.value[0]?.startsAt.toISOString()).toBe("2026-10-05T13:00:00.000Z");
    expect(result.value[0]?.endsAt.toISOString()).toBe("2026-10-05T13:30:00.000Z");
    expect(result.value.at(-1)?.startsAt.toISOString()).toBe("2026-10-09T19:30:00.000Z");
    expect(result.value.at(-1)?.endsAt.toISOString()).toBe("2026-10-09T20:00:00.000Z");

    const london = await fixtureAdapter.listSlots(context, week, { timeZone: "Europe/London" });
    if (london.ok) expect(london.value[0]?.startsAt.toISOString()).toBe("2026-10-05T08:00:00.000Z");

    const nowhere = await fixtureAdapter.listSlots(context, week, { timeZone: "Mars/Olympus" });
    expect(nowhere.ok).toBe(false);
  });

  test("createAppointment answers fx-<key> and records exactly what it was handed", async () => {
    const given = input();
    const result = await fixtureAdapter.createAppointment(context, given);
    expect(result).toEqual({
      ok: true,
      value: {
        externalId: "fx-req-9",
        startsAt: given.startsAt,
        endsAt: new Date("2026-10-06T14:30:00Z"),
      },
    });
    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect(fixtureAdapter.recordedWrites()[0]?.input).toBe(given);
    expect(fixtureAdapter.recordedWrites()[0]?.timedOut).toBe(false);
  });

  test("failNextWrite: the vendor says no, with a status, and nothing is stored", async () => {
    fixtureAdapter.failNextWrite();
    const result = await fixtureAdapter.createAppointment(context, input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(409);
    expect(result.error.reason).toBe("conflict");
    expect(result.error.retryable).toBe(false);
    expect(fixtureAdapter.recordedWrites()).toHaveLength(0);

    const found = await fixtureAdapter.findAppointmentByKey(context, {
      idempotencyKey: "req-9",
      attendeeEmail: input().attendee.email,
      around: input().startsAt,
    });
    expect(found).toEqual({ ok: true, value: null });

    // The switch is one-shot.
    expect((await fixtureAdapter.createAppointment(context, input())).ok).toBe(true);
  });

  test("timeoutNextWrite: booked but unheard, and the read-back finds it", async () => {
    fixtureAdapter.timeoutNextWrite();
    const result = await fixtureAdapter.createAppointment(context, input());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("timeout");
    expect(result.error.status).toBeUndefined();

    expect(fixtureAdapter.recordedWrites()).toHaveLength(1);
    expect(fixtureAdapter.recordedWrites()[0]?.timedOut).toBe(true);

    const found = await fixtureAdapter.findAppointmentByKey(context, {
      idempotencyKey: "req-9",
      attendeeEmail: input().attendee.email,
      around: input().startsAt,
    });
    expect(found).toEqual({ ok: true, value: { externalId: "fx-req-9" } });
  });

  test("the same key twice is two bookings, as it would be on Cal.com", async () => {
    const first = await fixtureAdapter.createAppointment(context, input());
    const second = await fixtureAdapter.createAppointment(context, input());
    expect(first.ok && first.value.externalId).toBe("fx-req-9");
    expect(second.ok && second.value.externalId).toBe("fx-req-9-2");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(2);

    const found = await fixtureAdapter.findAppointmentByKey(context, {
      idempotencyKey: "req-9",
      attendeeEmail: input().attendee.email,
      around: input().startsAt,
    });
    expect(found).toEqual({ ok: true, value: { externalId: "fx-req-9" } });
  });

  test("read-back needs the same address and a nearby time, like the vendor filter", async () => {
    await fixtureAdapter.createAppointment(context, input());
    const wrongAddress = await fixtureAdapter.findAppointmentByKey(context, {
      idempotencyKey: "req-9",
      attendeeEmail: "someone@example.com",
      around: input().startsAt,
    });
    expect(wrongAddress).toEqual({ ok: true, value: null });

    const farAway = await fixtureAdapter.findAppointmentByKey(context, {
      idempotencyKey: "req-9",
      attendeeEmail: input().attendee.email,
      around: new Date("2026-10-20T14:00:00Z"),
    });
    expect(farAway).toEqual({ ok: true, value: null });
  });

  test("an input that smuggles a phone number past the type is refused at runtime", async () => {
    const smuggled = {
      ...input(),
      attendee: { ...input().attendee, phoneNumber: "+15550101234" },
    } as unknown as CreateAppointmentInput;
    const result = await fixtureAdapter.createAppointment(context, smuggled);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("phone_field_refused");
    expect(fixtureAdapter.recordedWrites()).toHaveLength(0);
  });

  test("cancelAppointment records the reason and refuses an id it did not hand out", async () => {
    await fixtureAdapter.createAppointment(context, input());
    const cancelled = await fixtureAdapter.cancelAppointment(context, "fx-req-9", "desk cancelled");
    expect(cancelled.ok).toBe(true);
    expect(fixtureAdapter.recordedWrites()[0]?.cancelledFor).toBe("desk cancelled");

    const theirs = await fixtureAdapter.cancelAppointment(context, "clinic-made-this", "oops");
    expect(theirs.ok).toBe(false);
    if (!theirs.ok) expect(theirs.error.reason).toBe("not_ours");
  });
});

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

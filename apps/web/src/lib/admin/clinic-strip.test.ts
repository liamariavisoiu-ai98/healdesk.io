import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The strip and inbox readers are lane A2's to add to ops-client; this
 * module asks at run time whether they exist. Absent, each read is null and
 * the probe says so; present, each read is the reader's answer. ops-client
 * is replaced per test, so the module is loaded fresh each time.
 */

// vitest's module mock throws on a key it was not given, where a real module
// namespace answers undefined; the two readers are named as absent here so
// the probe sees what production sees before lane A2 lands.
const BASE = {
  fetchClinics: async () => ({ ok: true, data: { clinics: [], connectionStateLimit: 50 } }),
  fetchClinicCards: async () => ({ ok: true, data: { cards: [], limit: 50 } }),
  fetchClinicHealth: async () => ({ ok: true, data: [] }),
  fetchClinicStrip: undefined,
  fetchOpsInbox: undefined,
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/admin/ops-client");
});

describe("the strip and inbox probes", () => {
  test("without the readers, both reads are null and the probe says the strip is absent", async () => {
    vi.doMock("@/lib/admin/ops-client", () => BASE);
    const strip = await import("./clinic-strip");
    expect(strip.stripReaderPresent()).toBe(false);
    expect(await strip.readClinicStrip()).toBeNull();
    expect(await strip.readOpsInbox()).toBeNull();
    const reads = await strip.loadClinicRows();
    expect(reads.strip).toBeNull();
    expect(reads.rows).toEqual([]);
  });

  test("with the readers, each read is the reader's answer and the probe says so", async () => {
    const stripAnswer = { ok: true, data: [] };
    const inboxAnswer = { ok: true, data: { rows: [], checkedAt: "2026-10-23T09:12:00.000Z", unreadable: [] } };
    vi.doMock("@/lib/admin/ops-client", () => ({ ...BASE, fetchClinicStrip: async () => stripAnswer, fetchOpsInbox: async () => inboxAnswer }));
    const strip = await import("./clinic-strip");
    expect(strip.stripReaderPresent()).toBe(true);
    expect(await strip.readClinicStrip()).toBe(stripAnswer);
    expect(await strip.readOpsInbox()).toBe(inboxAnswer);
    expect((await strip.loadClinicRows()).strip).toBe(stripAnswer);
  });
});

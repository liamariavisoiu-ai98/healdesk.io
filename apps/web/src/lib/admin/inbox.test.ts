import { describe, expect, test, vi } from "vitest";

import type { OpsInbox } from "@/lib/admin/strip-types";

/**
 * What Home reads (E1 step 4): apps/app's inbox when its reader exists and
 * answers; the composed list when it does not, with the missing half named
 * so the list never looks complete; and, when the reader exists but fails,
 * the composed list with that failure named. The clinic rows come from the
 * cached loader, never a second clinic read.
 */

const state = vi.hoisted(() => ({
  upstream: null as null | { ok: true; data: OpsInbox } | { ok: false; code: string; message: string },
  loads: 0,
}));

vi.mock("@/lib/admin/clinic-strip", () => ({
  readOpsInbox: async () => state.upstream,
  loadClinicRows: async () => {
    state.loads += 1;
    return {
      clinics: { ok: true, data: { clinics: [], connectionStateLimit: 50 } },
      cards: { ok: true, data: { cards: [], limit: 50 } },
      health: { ok: false, code: "failed", message: "Could not reach the ops API." },
      strip: null,
      rows: [
        {
          clinicId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          name: "Radiance Med Spa",
          specialty: "med-spa",
          synthetic: false,
          stage: null,
          channels: null,
          availability: null,
          calendar: null,
          voice: null,
          transcripts: null,
          usage: null,
          lastReminder: null,
          blocking: "Covered-entity status not determined.",
          attention: true,
          connection: "unknown",
        },
      ],
    };
  },
}));
vi.mock("@/lib/admin/ops-client", () => ({
  fetchPracticeReviews: async () => ({ ok: true, data: [] }),
  fetchAgreementReviews: async () => ({ ok: true, data: [] }),
  fetchSupportRequests: async () => ({ ok: true, data: { requests: [], unreadClinics: 0 } }),
  fetchRecordingAlerts: async () => ({ ok: true, data: { alerts: [], unreadClinics: 0 } }),
  fetchSiteReadFailures: async () => ({ ok: true, data: { failures: [], limit: 100 } }),
}));
vi.mock("@/lib/sheets/client", () => ({ isMarketingStoreConfigured: () => false }));
vi.mock("@/lib/setup-requests", () => ({ listSetupRequests: async () => [] }));

const { loadOpsInbox, INBOX_MISSING_SOURCE } = await import("./inbox");

const UPSTREAM: OpsInbox = {
  rows: [{ id: "alerts:1", kind: "alert", count: 1, sentence: "x", clinic: null, button: { label: "Open", kind: "link", href: "/admin/clinics" }, tone: "bad", dueAt: null }],
  checkedAt: "2026-10-23T09:12:00.000Z",
  unreadable: [],
};

describe("loadOpsInbox", () => {
  test("apps/app's inbox is the list when its reader exists and answers", async () => {
    state.upstream = { ok: true, data: UPSTREAM };
    state.loads = 0;
    expect(await loadOpsInbox(new Date("2026-10-23T09:12:00.000Z"))).toBe(UPSTREAM);
    expect(state.loads).toBe(0);
  });

  test("without a reader, the composed list names what it cannot show and reuses the cached clinic rows", async () => {
    state.upstream = null;
    state.loads = 0;
    const inbox = await loadOpsInbox(new Date("2026-10-23T09:12:00.000Z"));
    expect(state.loads).toBe(1);
    expect(inbox.unreadable[0]).toEqual({ source: INBOX_MISSING_SOURCE, reason: expect.stringContaining("has not landed") });
    expect(inbox.unreadable.map((u) => u.source)).toContain("the first-weeks list");
    expect(inbox.rows.map((r) => r.kind)).toContain("clinic_blocked");
    expect(inbox.checkedAt).toBe("2026-10-23T09:12:00.000Z");
  });

  test("with a reader that failed, the composed list names that failure first", async () => {
    state.upstream = { ok: false, code: "failed", message: "Could not reach the ops API." };
    const inbox = await loadOpsInbox(new Date("2026-10-23T09:12:00.000Z"));
    expect(inbox.unreadable[0]).toEqual({ source: INBOX_MISSING_SOURCE, reason: "Could not reach the ops API." });
    expect(inbox.rows.length).toBeGreaterThan(0);
  });
});

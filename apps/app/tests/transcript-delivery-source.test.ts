import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Home's transcript row (lib/ops/inbox/transcript-delivery.ts), on the
 * counts listUndeliveredTranscripts returns: a lost copy (deleted unsent
 * after 30 days, or after 72 hours with no answer) is red; a copy waiting or
 * bounced, which may still arrive, is amber; a clinic that could not be read
 * makes the source partial. No database: the read is stubbed.
 */

const stub = vi.hoisted(() => ({
  result: { clinics: [] as unknown[], unreadClinics: 0 },
}));
vi.mock("@/lib/ops/transcript-watch-ops", () => ({
  listUndeliveredTranscripts: async () => stub.result,
}));

import { TRANSCRIPTS_PAGE, transcriptDeliverySource } from "@/lib/ops/inbox/transcript-delivery";

const A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const B = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const clinic = (id: string, counts: Partial<Record<"overdue" | "bounced" | "expired" | "unconfirmed", number>>) => ({
  clinicId: id,
  clinicName: id === A ? "Radiance" : "Glow",
  counts: { overdue: 0, bounced: 0, expired: 0, unconfirmed: 0, ...counts },
  oldestAgeHours: null,
});
const read = () =>
  transcriptDeliverySource.read({
    now: new Date("2026-10-24T10:00:00Z"),
    operator: { email: "ops@healdesk.test", request: {} },
    actor: { type: "service", serviceName: "test" },
    request: {},
    clinicNames: async () => new Map(),
  });

beforeEach(() => {
  stub.result = { clinics: [], unreadClinics: 0 };
});

describe("Home's transcript row", () => {
  test("nothing late: no row", async () => {
    expect(await read()).toEqual({ rows: [], partial: undefined });
  });

  test("waiting or bounced copies, which may still arrive, are amber", async () => {
    stub.result = { clinics: [clinic(A, { overdue: 1, bounced: 2 })], unreadClinics: 0 };
    const { rows } = await read();
    expect(rows).toEqual([
      {
        id: "transcripts:undelivered",
        kind: "queue",
        count: 3,
        sentence: "Transcript copies not delivered: 1 waiting more than 72 hours, 2 bounced.",
        clinic: { id: A, name: "Radiance" },
        button: { label: "Open transcript deliveries", kind: "link", href: TRANSCRIPTS_PAGE },
        tone: "warn",
        dueAt: null,
      },
    ]);
  });

  test("a copy deleted with no answer from the mail service is lost: red, counted", async () => {
    stub.result = { clinics: [clinic(A, { bounced: 1 }), clinic(B, { unconfirmed: 1 })], unreadClinics: 0 };
    const { rows } = await read();
    expect(rows[0]).toMatchObject({
      count: 2,
      clinic: null,
      tone: "bad",
      sentence:
        "Transcript copies not delivered to 2 clinics: 1 bounced, 1 deleted after 72 hours with no answer from the mail service.",
    });
  });

  test("a copy deleted unsent after 30 days is red too", async () => {
    stub.result = { clinics: [clinic(B, { expired: 2 })], unreadClinics: 0 };
    expect((await read()).rows[0]).toMatchObject({
      tone: "bad",
      count: 2,
      sentence: "Transcript copies not delivered: 2 deleted unsent after 30 days.",
    });
  });

  test("a clinic that could not be read makes the source partial, rows or none", async () => {
    stub.result = { clinics: [], unreadClinics: 2 };
    expect(await read()).toEqual({ rows: [], partial: "2 clinic(s) could not be read." });
    stub.result = { clinics: [clinic(A, { overdue: 1 })], unreadClinics: 1 };
    const result = await read();
    expect(result.rows).toHaveLength(1);
    expect(result.partial).toBe("1 clinic(s) could not be read.");
  });
});

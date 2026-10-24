import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The daily setup-replies cron (WP5): CRON_SECRET or nothing; the ids of the
 * requests past their reply day go to apps/app's ops log; and when apps/app
 * does not answer, one email a day to the administrator names them instead.
 * Never a name or an address in either.
 */

const state = vi.hoisted(() => ({
  due: [] as { id: string; email: string; name?: string; clinicName: string; createdAt?: Date }[],
  relay: { ok: true, data: { raised: 0 } } as unknown,
  relayed: [] as string[][],
  requests: [] as unknown[],
  mailed: [] as { to: string; subject: string; text: string; idempotencyKey?: string }[],
}));

vi.mock("@/lib/setup-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/setup-requests")>()),
  setupRequestsPastReply: async () => state.due,
}));
vi.mock("@/lib/admin/ops-client", () => ({
  relaySetupRepliesPastDue: async (ids: string[], requests?: unknown) => {
    state.relayed.push(ids);
    state.requests.push(requests);
    return state.relay;
  },
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendSafely: async (message: {
    to: string;
    subject: string;
    text: string;
    idempotencyKey?: string;
  }) => {
    state.mailed.push(message);
    return { status: "sent", providerId: "re_1" };
  },
}));

const { GET } = await import("./route");

const A = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const B = "6c5b4d3e-2f10-4b0c-9d8e-7f6a5b4c3d2e";

function call(secret: string | null = "cron-secret") {
  return GET(
    new Request("http://web.test/api/cron/setup-replies", {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("HEALDESK_ADMIN_EMAIL", "admin@healdesk.test");
  state.due = [
    { id: A, email: "owner@glowspa.test", clinicName: "Glow Spa" },
    { id: B, email: "other@radiance.test", clinicName: "Radiance" },
  ];
  state.relay = { ok: true, data: { raised: 2 } };
  state.relayed = [];
  state.requests = [];
  state.mailed = [];
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/cron/setup-replies", () => {
  test("refuses without the cron secret, and does nothing", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("wrong-secret")).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call()).status).toBe(503);
    expect(state.relayed).toEqual([]);
  });

  test("hands apps/app the ids, and only the ids", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, due: 2, raised: 2 });
    expect(state.relayed).toEqual([[A, B]]);
    expect(state.mailed).toEqual([]);
  });

  // Lane N1 (owner, 23 October 2026): with each id, the requester's business
  // name when it is safe to print and the day our reply was promised by, so
  // the alert says who is waiting and since when. Never the person's name or
  // email, and never a name that could reach someone.
  test("sends each id's business name and promised day, and nothing about the person", async () => {
    state.due = [
      { id: A, email: "owner@glowspa.test", name: "Dana Ortiz", clinicName: "Glow Spa", createdAt: new Date("2026-10-20T15:00:00Z") },
      { id: B, email: "other@radiance.test", clinicName: "radiance.com 5551234567" },
    ];
    expect((await call()).status).toBe(200);
    expect(state.relayed).toEqual([[A, B]]);
    expect(state.requests).toEqual([[{ id: A, business: "Glow Spa", promisedOn: "2026-10-21" }, { id: B }]]);
    const sent = JSON.stringify(state.requests);
    for (const secret of ["owner@glowspa.test", "Dana Ortiz", "radiance", "5551234567"]) expect(sent).not.toContain(secret);
  });

  test("nothing due asks nobody", async () => {
    state.due = [];
    expect(await (await call()).json()).toEqual({ ok: true, due: 0 });
    expect(state.relayed).toEqual([]);
  });

  test("with apps/app unreachable, the administrator is told from here, by id, once a day", async () => {
    state.relay = { ok: false, code: "unreachable", message: "Could not reach the ops API." };
    const response = await call();
    expect(await response.json()).toEqual({ ok: true, due: 2, alerted: true });
    expect(state.mailed).toHaveLength(1);
    const [mail] = state.mailed;
    expect(mail!.to).toBe("admin@healdesk.test");
    expect(mail!.text).toContain(A);
    expect(mail!.text).toContain(B);
    for (const secret of ["owner@glowspa.test", "Glow Spa", "Radiance"]) {
      expect(`${mail!.subject}\n${mail!.text}`).not.toContain(secret);
    }
    expect(mail!.idempotencyKey).toMatch(/^hd-setup-replies-past-due-\d{4}-\d{2}-\d{2}-1$/);
  });

  test("with nobody to tell, it fails loudly so the cron shows red", async () => {
    state.relay = { ok: false, code: "unconfigured", message: "not configured" };
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
    expect((await call()).status).toBe(500);
  });
});

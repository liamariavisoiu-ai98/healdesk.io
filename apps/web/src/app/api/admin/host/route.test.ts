import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * POST /api/admin/host: the switch that dispatches .github/workflows/host.yml.
 *
 * What must hold: nothing but a signed-in operator on a page of this site
 * reaches GitHub; without the token the answer names the variable to set;
 * standby is refused, before GitHub is asked, whenever apps/app counts
 * anything real on the host; a dispatch sends exactly the workflow, the ref
 * and the inputs host.yml takes, with the token as a bearer; and the token
 * appears in no response, whatever happens.
 */

const mocks = vi.hoisted(() => ({
  operator: "ops@healdesk.test" as string | null,
  check: null as unknown,
}));

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => mocks.operator }));
vi.mock("@/lib/admin/ops-client", () => ({ hostStandbyCheck: async () => mocks.check }));

const { POST } = await import("./route");

const TOKEN = "github_pat_test_token_never_shown";
const SITE = "https://healdesk.io";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let address = 0;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  address += 1;
  return new Request(`${SITE}/api/admin/host`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: SITE,
      host: "healdesk.io",
      "sec-fetch-site": "same-origin",
      // A fresh address per request, so the limiter never decides a test.
      "x-forwarded-for": `203.0.113.${address}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(response: Response): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => {
  calls = [];
  mocks.operator = "ops@healdesk.test";
  mocks.check = { ok: true, data: { ok: true, productionClinics: 0, boundAgreements: 0, openTranscripts: 0 } };
  process.env.HEALDESK_GITHUB_ACTIONS_TOKEN = TOKEN;
  delete process.env.HEALDESK_GITHUB_REPO;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.HEALDESK_GITHUB_ACTIONS_TOKEN;
});

describe("POST /api/admin/host", () => {
  test("no operator session: 401, and GitHub is not asked", async () => {
    mocks.operator = null;
    const { status, text } = await read(await POST(post({ mode: "active" })));
    expect(status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(text).not.toContain(TOKEN);
  });

  test("another site's page: 403, before the session is even read", async () => {
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "same-site", origin: "https://app.healdesk.io" },
    ]) {
      const { status } = await read(await POST(post({ mode: "active" }, headers)));
      expect(status, JSON.stringify(headers)).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test("no Origin and no Sec-Fetch-Site (not a browser page): 403", async () => {
    const request = new Request(`${SITE}/api/admin/host`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "healdesk.io", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({ mode: "active" }),
    });
    expect((await POST(request)).status).toBe(403);
  });

  test("no token: 503, naming the variable to set, and GitHub is not asked", async () => {
    delete process.env.HEALDESK_GITHUB_ACTIONS_TOKEN;
    const { status, body } = await read(await POST(post({ mode: "active" })));
    expect(status).toBe(503);
    expect(body.missing).toBe("HEALDESK_GITHUB_ACTIONS_TOKEN");
    expect(String(body.error)).toContain("HEALDESK_GITHUB_ACTIONS_TOKEN");
    expect(String(body.error)).toMatch(/Actions read and write/);
    expect(calls).toHaveLength(0);
  });

  test("a body that is not a switch: 400", async () => {
    expect((await POST(post({ mode: "off" }))).status).toBe(400);
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ mode: "standby" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("turn on: GitHub gets host.yml on main with mode active, the token as a bearer, and the token never comes back", async () => {
    const response = await read(await POST(post({ mode: "active" })));
    expect(response.status).toBe(202);
    expect(response.body.ok).toBe(true);
    expect(response.text).not.toContain(TOKEN);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.github.com/repos/liamariavisoiu-ai98/healdesk.io/actions/workflows/host.yml/dispatches");
    expect(call!.init.method).toBe("POST");
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(JSON.parse(String(call!.init.body))).toEqual({ ref: "main", inputs: { mode: "active", reason: "from /admin" } });
  });

  test("standby, with nothing real on the host: dispatched with mode standby", async () => {
    const response = await read(await POST(post({ mode: "standby", confirm: "standby" })));
    expect(response.status).toBe(202);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ref: "main", inputs: { mode: "standby", reason: "from /admin" } });
    expect(response.text).not.toContain(TOKEN);
  });

  test("standby while a clinic is in production: 409 with the reason, and GitHub is not asked", async () => {
    mocks.check = { ok: true, data: { ok: false, productionClinics: 1, boundAgreements: 2, openTranscripts: 0 } };
    const { status, body, text } = await read(await POST(post({ mode: "standby", confirm: "standby" })));
    expect(status).toBe(409);
    expect(String(body.error)).toContain("1 clinic is in production");
    expect(String(body.error)).toContain("2 agreements are in effect");
    expect(calls).toHaveLength(0);
    expect(text).not.toContain(TOKEN);
  });

  test("standby when the host cannot be asked: 503, and GitHub is not asked", async () => {
    mocks.check = { ok: false, code: "unreachable", message: "Could not reach the ops API, so nothing below could be read." };
    const { status, body } = await read(await POST(post({ mode: "standby", confirm: "standby" })));
    expect(status).toBe(503);
    expect(String(body.error)).toMatch(/did not answer/);
    expect(calls).toHaveLength(0);
  });

  test("GitHub refusing: 502 with this app's sentence, never GitHub's body or the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }), { status: 401 })),
    );
    const { status, text } = await read(await POST(post({ mode: "active" })));
    expect(status).toBe(502);
    expect(text).toContain("HEALDESK_GITHUB_ACTIONS_TOKEN");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Bad credentials");
  });

  test("a typed reason is cleaned before it reaches the run's name", async () => {
    await POST(post({ mode: "active", reason: "test\nrun ${{ secrets.X }} <b>" }));
    const sent = JSON.parse(String(calls[0]!.init.body)) as { inputs: { reason: string } };
    expect(sent.inputs.reason).toBe("test run secrets.X b");
    expect(sent.inputs.reason).not.toMatch(/[$\n{}<>]/);
  });

  test("one structured log line per dispatch, without the token", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await POST(post({ mode: "active" }));
    const lines = info.mock.calls.map((args) => String(args[0]));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "host_dispatch", by: "admin", mode: "active", result: "dispatched" });
    expect(lines[0]).not.toContain(TOKEN);
  });

  test("a burst is rate limited: 429 after six from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await POST(post({ mode: "active" }, { "x-forwarded-for": "192.0.2.77" }))).status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 202)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});

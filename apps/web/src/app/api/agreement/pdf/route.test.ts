import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The download route's authorisation boundary, as a regression test.
 *
 * `lib/agreement-download.test.ts` proves the token arithmetic: a MAC minted
 * for agreement A does not reproduce for agreement B. That is necessary and it
 * is not sufficient, because the property the design actually depends on lives
 * one layer up, in the route, and until now it was proved only by hand, with
 * curl, against a running pair of dev servers. Two things can break here
 * without a single token test going red:
 *
 *   1. The route could stop passing the *requested* id to `verifyDownloadToken`
 *      verify against a constant, against the id parsed out of the cookie
 *      that deliberately does not carry one, or (the realistic edit) check only
 *      that *some* valid cookie is present. Every token test still passes and
 *      the acceptance uuid is a bearer credential again.
 *
 *   2. The 401 could stop coming FIRST. The route's own header comment makes a
 *      specific promise. That possession of a uuid gets a refusal "without
 *      this route making a single call inward". Move the cookie check below the
 *      upstream fetch, or below the config read, and an unauthenticated
 *      stranger can make apps/app query its acceptance table and can read from
 *      the status code whether the id they guessed exists. Nothing about that
 *      is visible in a unit test of the token.
 *
 * So `fetch` is stubbed with a spy that is asserted NEVER to have been called
 * on every refusal path, and the env is deliberately configured so that a
 * bypass would reach it. A test that only asserted "401" would go green against
 * a route that 401s for the wrong reason; the last case here presents the same
 * cookie against the id it was actually minted for and requires the fetch to
 * happen, so the refusals above are known to be the id binding refusing rather
 * than the whole route being broken.
 */

const AGREEMENT_A = "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f";
const AGREEMENT_B = "0a9c8b7d-6e5f-4321-8abc-9f8e7d6c5b4a";

const SECRET = "wY2kP9sLd4Rn7Vc0Xt6Hb3Mq8Ja1Zg5f";

/**
 * The route reads its cookie through `next/headers`, which needs a request
 * context this test has no way to enter. Mocked to a store the test sets
 * directly, the value under test is what the route DOES with the cookie, not
 * how the framework hands it over.
 */
let cookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "hd_agreement" && cookieValue !== undefined
          ? { name, value: cookieValue }
          : undefined,
    }),
}));

const { DOWNLOAD_TTL_SECONDS, issueDownloadToken } = await import(
  "@/lib/agreement-download"
);
const { GET } = await import("./route");

const env = process.env as Record<string, string | undefined>;
const saved = new Map<string, string | undefined>();
const ENV_KEYS = [
  "HEALDESK_GATE_SECRET",
  "HEALDESK_PROVISION_SECRET",
  "HEALDESK_APP_URL",
] as const;

/** A minimal well-formed PDF response, so the success path can complete. */
function pdfResponse(): Response {
  return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="healdesk-baa-1.0.0.pdf"',
    },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved.clear();
  for (const key of ENV_KEYS) saved.set(key, env[key]);
  env.HEALDESK_GATE_SECRET = SECRET;
  // Set on purpose: a route that skipped the cookie check would get past the
  // config step and reach the spy, which is what makes "never called" mean
  // something.
  env.HEALDESK_PROVISION_SECRET = "provision-secret-for-tests";
  env.HEALDESK_APP_URL = "https://app.example.test";

  cookieValue = undefined;
  fetchSpy = vi.fn(() => Promise.resolve(pdfResponse()));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Each call uses a fresh id where it can, so the per-id limiter never bites. */
function request(id: string): Request {
  return new Request(
    `https://healdesk.io/api/agreement/pdf?id=${encodeURIComponent(id)}`,
  );
}

describe("the uuid alone is not a credential", () => {
  test("no cookie: refused, and nothing is asked of apps/app", async () => {
    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(401);
    // The promise in the route's header comment. If this ever goes green with
    // a call recorded, an unauthenticated stranger is reaching the acceptance
    // table and the status code has become an existence oracle.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a cookie minted for another agreement does not open this one", async () => {
    cookieValue = issueDownloadToken(AGREEMENT_B);

    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("the same cookie DOES open the agreement it was minted for", async () => {
    // The control. Without it the two refusals above are consistent with a
    // route that refuses everything, which would pass while serving nobody.
    cookieValue = issueDownloadToken(AGREEMENT_A);

    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The id travels in the SIGNED body, not only in the path, see the route's
    // header. If it stops doing so, one captured pair of headers is replayable
    // against every other agreement for the whole skew window.
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ agreementId: AGREEMENT_A }));
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(AGREEMENT_A);
  });

  test("an expired cookie is refused even though we signed it", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-03-12T09:00:00.000Z").getTime();
    vi.setSystemTime(start);
    cookieValue = issueDownloadToken(AGREEMENT_A);

    vi.setSystemTime(start + DOWNLOAD_TTL_SECONDS * 1000);
    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a tampered cookie is refused", async () => {
    const token = issueDownloadToken(AGREEMENT_A);
    const last = token.slice(-1);
    cookieValue = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;

    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("no id at all is the same refusal, not a different one", async () => {
    // A missing id reaches verifyDownloadToken as "" and is refused there. It
    // must not acquire a 400 of its own: every unauthenticated shape has to
    // leave with the identical answer or the status code starts describing
    // which ids exist.
    cookieValue = issueDownloadToken(AGREEMENT_A);

    const withoutId = await GET(
      new Request("https://healdesk.io/api/agreement/pdf"),
    );
    const withWrongId = await GET(request(AGREEMENT_B));

    expect(withoutId.status).toBe(401);
    expect(withWrongId.status).toBe(401);
    expect(await withoutId.text()).toBe(await withWrongId.text());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("an unauthenticated caller cannot probe whether we are configured", async () => {
    // The config read sits BELOW the token check. With it above, a stranger
    // learns from a 503 that this deployment is half-wired, and a deployment
    // that is half-wired is one a stranger would like to know about.
    delete env.HEALDESK_PROVISION_SECRET;
    delete env.HEALDESK_APP_URL;

    const response = await GET(request(AGREEMENT_A));

    expect(response.status).toBe(401);
  });
});

import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "@healdesk/catalog";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The inward PDF endpoint is server-to-server, and this is what says so.
 *
 * `tests/agreement-pdf.test.ts` proves the renderer. It cannot prove the thing
 * this endpoint exists to guarantee, which is that knowing an acceptance uuid
 * buys nothing: the acceptance id is deliberately kept out of the emailed copy
 * precisely so that it never becomes a bearer credential for an executed HIPAA
 * agreement naming the practice, the signatory, their IP and their user agent.
 *
 * Until now that guarantee was checked by hand with curl against a running
 * pair of dev servers, which is a check that does not survive the next edit.
 * Four properties can each break silently:
 *
 *   1. The HMAC could stop being required, or stop covering the timestamp, and
 *      the endpoint becomes GET-by-uuid with extra steps.
 *   2. The SIGNED BODY could stop being the authority for which agreement is
 *      served. The path segment is not covered by the signature, so a route
 *      that trusted it would let one captured request be repointed at every
 *      other agreement for the whole 300-second skew window.
 *   3. Work could start happening before authentication. `unsafeDb` is mocked
 *      with a spy asserted never to have been called on every refusal, because
 *      an unauthenticated stranger who can make us query the acceptance table
 *      can read from the answer whether the id they guessed exists.
 *   4. The body cap could stop bounding anything. It is enforced while reading
 *      and not afterwards, and the difference is invisible in a status code:
 *      this route used to answer 413 to a 4 MB chunked body having already
 *      buffered all 4 MB of it.
 *
 * Every refusal here is paired with a control that must succeed, so none of
 * them can pass by way of the route being broken for everyone.
 */

const SECRET = "provision-secret-for-tests";
const A = "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f";
const B = "0a9c8b7d-6e5f-4321-8abc-9f8e7d6c5b4a";

const selectSpy = vi.fn();

vi.mock("@/db", () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve([]),
  };
  return {
    unsafeDb: {
      select: (...args: unknown[]) => {
        selectSpy(...args);
        return chain;
      },
    },
  };
});

vi.mock("@/lib/env", () => ({ env: { provisionSecret: () => SECRET } }));

const { POST } = await import("@/app/api/agreements/[id]/pdf/route");
const { proxy } = await import("@/proxy");

function call(
  pathId: string,
  body: BodyInit,
  headers: Record<string, string>,
): Promise<Response> {
  return POST(
    new Request(`https://app.healdesk.io/api/agreements/${pathId}/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      // Node requires this to send a stream body; harmless for a string one.
      ...({ duplex: "half" } as Record<string, unknown>),
    }),
    { params: Promise.resolve({ id: pathId }) },
  );
}

function signedHeaders(
  body: string,
  atSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(atSeconds);
  return {
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sign(body, timestamp, SECRET),
  };
}

beforeEach(() => {
  selectSpy.mockClear();
});

describe("the uuid is not a credential here either", () => {
  test("no signature: refused, and the acceptance table is never touched", async () => {
    const body = JSON.stringify({ agreementId: A });

    const response = await call(A, body, {});

    expect(response.status).toBe(401);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  test("a signature made with another secret is refused", async () => {
    const body = JSON.stringify({ agreementId: A });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await call(A, body, {
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: sign(body, timestamp, "not-our-secret"),
    });

    expect(response.status).toBe(401);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  test("the timestamp window is closed in both directions", async () => {
    // Date is frozen on a whole second. The test floors the clock to seconds
    // and the route reads it in milliseconds, so on a live clock a second that
    // ticked over in between put "now + 301" 300.x seconds ahead, inside the
    // window, and the route served it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));
    try {
      const body = JSON.stringify({ agreementId: A });
      const now = Math.floor(Date.now() / 1000);

      const stale = await call(A, body, signedHeaders(body, now - 301));
      const ahead = await call(A, body, signedHeaders(body, now + 301));

      expect(stale.status).toBe(401);
      expect(ahead.status).toBe(401);
      expect(selectSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a valid signature repointed at another agreement is refused", async () => {
    // The path is not covered by the signature; the body is. Serving the path's
    // id would make one captured request a key to every other agreement.
    const body = JSON.stringify({ agreementId: A });

    const response = await call(B, body, signedHeaders(body));

    expect(response.status).toBe(400);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  test("editing the body to match the path breaks the signature", async () => {
    const signedForA = JSON.stringify({ agreementId: A });
    const headers = signedHeaders(signedForA);

    const response = await call(B, JSON.stringify({ agreementId: B }), headers);

    expect(response.status).toBe(401);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  test("the control: a correctly signed request DOES reach the table", async () => {
    // Without this, every refusal above is consistent with a route that refuses
    // everything, which would pass while serving nobody.
    const body = JSON.stringify({ agreementId: A });

    const response = await call(A, body, signedHeaders(body));

    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404); // the mocked table holds no rows
  });

  test("an unknown id and a malformed id are byte-identical answers", async () => {
    const known = JSON.stringify({ agreementId: A });
    const junk = JSON.stringify({ agreementId: "not-a-uuid" });

    const unknown = await call(A, known, signedHeaders(known));
    const malformed = await call("not-a-uuid", junk, signedHeaders(junk));

    expect(unknown.status).toBe(malformed.status);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  test("there is no GET handler to reach this by hand", async () => {
    const handlers = await import("@/app/api/agreements/[id]/pdf/route");
    expect("GET" in handlers).toBe(false);
  });
});

describe("the body cap bounds the read, not just the answer", () => {
  /** A chunked body: no Content-Length, and it counts what the route pulls. */
  function countingBody(chunkBytes: number, chunks: number) {
    const counter = { pulled: 0 };
    const chunk = new Uint8Array(chunkBytes).fill(0x61);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        counter.pulled += chunkBytes;
        controller.enqueue(chunk);
      },
    });
    return { stream, counter };
  }

  test("a 4 MB chunked body is refused without being buffered", async () => {
    const { stream, counter } = countingBody(64 * 1024, 64);

    const response = await call(A, stream, {});

    expect(response.status).toBe(413);
    // The assertion that matters. A check on the result of request.text() also
    // produces this 413, having first allocated every one of those 4 MB for an
    // unauthenticated stranger who asked it to.
    expect(counter.pulled).toBeLessThanOrEqual(1024 * 1024);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  test("a declared oversize body is refused before it is read at all", async () => {
    const response = await call(A, "x".repeat(16), {
      "content-length": String(9_000),
    });

    expect(response.status).toBe(413);
  });

  test("a body of ordinary size still gets through", async () => {
    // The cap counts bytes, not characters, and must not have become so eager
    // that the real payload trips it.
    const body = JSON.stringify({ agreementId: A, note: "é".repeat(100) });

    const response = await call(A, body, signedHeaders(body));

    expect(response.status).toBe(404);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the proxy leaves this route to authenticate itself", () => {
  test("/api/agreements/<id>/pdf is not redirected to sign-in", async () => {
    // This used to be a statement about SELF_AUTHENTICATING_PATHS covering the
    // nested path by prefix. The proxy no longer redirects anything at all —
    // the console and its /sign-in were deleted, so the destination is gone —
    // and the property this asserts is the one that mattered either way: a
    // signed server-to-server POST must never come back as a 307 pointing at
    // an HTML page.
    const response = proxy(
      new NextRequest(`https://app.healdesk.io/api/agreements/${A}/pdf`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  /**
   * The control above used to be "a session-less console path still
   * redirects", which proved the assertion was not vacuous. There is no such
   * path left to name: every page behind that redirect was deleted with the
   * console, and a proxy that still redirected would send `/` to a /sign-in
   * that 404s.
   *
   * So the control is inverted. What must not come back is a redirect, for
   * ANY path — including one carrying a session-shaped cookie, which is the
   * shape the old rule keyed on and therefore the one a half-finished revert
   * would resurrect first.
   */
  test("the control: nothing is redirected, cookie or no cookie", () => {
    const bare = proxy(new NextRequest("https://app.healdesk.io/"));
    expect(bare.status).toBe(200);
    expect(bare.headers.get("location")).toBeNull();

    const withCookie = new NextRequest("https://app.healdesk.io/anything");
    withCookie.cookies.set("hd.session_token", "whatever");
    const cookied = proxy(withCookie);
    expect(cookied.status).toBe(200);
    expect(cookied.headers.get("location")).toBeNull();
  });
});

/**
 * What a burst of sign-in attempts is allowed to cost this process.
 *
 * The other tests in this area ask whether a credential is judged correctly.
 * This one asks how much a stranger can make us spend deciding, which is a
 * different question and had a different answer: `HEALDESK_ADMIN_PASSWORD_HASH`
 * is scrypt at N=16384, r=8, so every attempt is ~16 MiB of memory-hard work,
 * and the endpoint that runs it is open to the internet by construction.
 *
 * The route guards that with two window counters, and neither of them bounds
 * concurrency. Both are read before the derivation and written after it, so
 * every request in a simultaneous burst reads the same unspent budget: measured
 * against this route before the fix, two hundred concurrent POSTs each carrying
 * a different `x-forwarded-for` produced two hundred 401s in 4.3 seconds, two
 * hundred derivations, roughly 3 GiB of transient allocation and the whole
 * libuv thread pool, out of a budget written to permit sixty. The counters then
 * correctly refused the two hundred and first, which is the wrong request.
 *
 * The per-address limiter cannot cover this. `clientKey()` reads a header the
 * caller picks, which the route's own comments say plainly, and one request per
 * fabricated address never meets a limit of five.
 *
 * So the property under test is not "the budget is sixty" but "a burst cannot
 * outrun the check": whatever the window counters do, the number of scrypt
 * derivations running at one instant is bounded, and it is bounded by something
 * incremented in the same synchronous turn as the test that reads it.
 *
 * Written against the exported handler rather than over HTTP because the race
 * is between promises inside one process, and a test that went through a server
 * would be measuring the server's own concurrency rather than this file's.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { POST } from "./route";

const EMAIL = "healdesk.io@gmail.com";
const PASSWORD = "correct horse battery staple 9f2a";

/** The real format, at the real work factors: the cost is the thing measured. */
function hashFor(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

beforeAll(() => {
  process.env.HEALDESK_ADMIN_EMAIL = EMAIL;
  process.env.HEALDESK_ADMIN_SECRET = "test-secret-not-a-real-one";
  process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD);
  /**
   * Deliberately unreachable. Nothing below carries a correct password, so
   * nothing reaches the ops API; pointing it at a closed port means a test that
   * ever DID reach it would fail loudly rather than talk to something real.
   */
  process.env.HEALDESK_APP_URL = "http://127.0.0.1:1";
  process.env.HEALDESK_PROVISION_SECRET = "test-provision-secret";
});

/** One attempt, from an address the caller invented. */
function attempt(ip: string, password = "wrong-password"): Request {
  return new Request("http://localhost/api/admin/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

function tally(responses: Response[]): Record<number, number> {
  return responses.reduce<Record<number, number>>((acc, response) => {
    acc[response.status] = (acc[response.status] ?? 0) + 1;
    return acc;
  }, {});
}

describe("a burst of sign-in attempts", () => {
  it("cannot start more derivations at once than the in-flight bound", async () => {
    const BURST = 200;

    const statuses = tally(
      await Promise.all(
        Array.from({ length: BURST }, (_, index) =>
          POST(attempt(`10.0.${index >> 8}.${index & 255}`)),
        ),
      ),
    );

    // A 401 is an attempt that ran scrypt; a 429 is one that was turned away
    // before allocating anything. Every request is one or the other.
    const derived = statuses[401] ?? 0;
    const refused = statuses[429] ?? 0;
    expect(derived + refused).toBe(BURST);

    /**
     * The bound is four. Asserting "well under the burst" rather than exactly
     * four keeps this a test of the property instead of a test of the constant:
     * raising the bound to eight is a judgement about the thread pool, while
     * losing the bound entirely is the regression.
     */
    expect(derived).toBeLessThanOrEqual(16);
    expect(refused).toBeGreaterThan(BURST - 32);
  });

  it("hands the slots back, so the burst is not a lockout", async () => {
    // Straight after the burst above, a single caller is still judged on its
    // merits. If the gate leaked a slot per request this would be a 429, and an
    // attacker would have a permanent denial of service rather than a moment's
    // one.
    const response = await POST(attempt("198.51.100.7"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "That email and password did not match.",
    });
  });

  it("still judges a correct password once the burst has passed", async () => {
    // The gate must not be spent by requests it refused: only the four that
    // actually derived may have charged the guess budget, which leaves the
    // owner far short of the ceiling.
    const response = await POST(attempt("198.51.100.8", PASSWORD));
    // 503, not 200: the password was right and the ops API is unreachable by
    // design here, which is the fail-closed answer. What matters is that it got
    // past the password at all.
    expect(response.status).toBe(503);
  });
});

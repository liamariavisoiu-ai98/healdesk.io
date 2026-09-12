import { randomBytes } from "node:crypto";

import { describe, expect, test } from "vitest";

import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";

/**
 * The ceiling on an anonymous visitor's use of /connect.
 *
 * The limiter this replaced was keyed on the token alone, which is the one key
 * a stranger varies for free: a caller presenting a fresh token every time
 * opened a fresh window every time and was bounded by nothing. It also covered
 * only the submission, leaving the open path — the one that writes an audit row
 * per request, into a table the runtime role cannot DELETE from — unbounded.
 *
 * So these tests are about the two failures that survive a limiter that "works"
 * on a happy-path check:
 *
 *   1. **A key an attacker chooses.** Varying the token must not buy unlimited
 *      attempts, and the address bucket is what has to stop it.
 *   2. **A refusal that costs nothing.** Tripping one bucket must still consume
 *      the other, or the cheap bucket becomes a way to shield the expensive one.
 *
 * No database and no request: the limiter is process state and a pure decision,
 * which is why it can be tested at all. Every case uses freshly generated
 * tokens and its own address, so nothing here depends on the order the cases
 * run in or on a reset hook that production does not have.
 */

/** Shaped like the real thing, though the limiter deliberately does not care. */
function freshToken(): string {
  return randomBytes(32).toString("base64url");
}

describe("connect attempt limit", () => {
  test("an open budget is spent per token, and the next one is refused", () => {
    const token = freshToken();

    // 30 per token per window. A null address so this case cannot reach the
    // address bucket and cannot pollute anyone else's.
    const allowed = Array.from({ length: 30 }, () =>
      withinConnectAttemptLimit("open", token, null),
    );
    expect(allowed.every(Boolean)).toBe(true);

    expect(withinConnectAttemptLimit("open", token, null)).toBe(false);

    // Still refused after the budget is gone, rather than recovering because a
    // counter wrapped or an entry was rewritten.
    expect(withinConnectAttemptLimit("open", token, null)).toBe(false);
  });

  test("a submission budget is five, and it is not the open budget", () => {
    const token = freshToken();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        withinConnectAttemptLimit("submit", token, null),
        `submission ${attempt} was refused inside the allowance`,
      ).toBe(true);
    }
    expect(withinConnectAttemptLimit("submit", token, null)).toBe(false);

    // The kind is part of the key. A person who mistyped their API key five
    // times must still be able to reload the page and read the steps again —
    // and, the other way round, a scanner's prefetches must not spend the
    // credential attempts.
    expect(withinConnectAttemptLimit("open", token, null)).toBe(true);
  });

  test("varying the token does not buy unlimited attempts", () => {
    // The failure the old per-token-only limiter had. Every call here presents
    // a token nobody has ever seen, so the token bucket is fresh every time and
    // permits every one of them; only the address bucket can say no.
    const address = "203.0.113.11";

    const allowed = Array.from({ length: 20 }, () =>
      withinConnectAttemptLimit("submit", freshToken(), address),
    );
    expect(
      allowed.every(Boolean),
      "an honest run of submissions from one address was refused",
    ).toBe(true);

    expect(
      withinConnectAttemptLimit("submit", freshToken(), address),
      "a fresh token bought a 21st submission from the same address",
    ).toBe(false);
  });

  test("a refusal on one key still spends the other", () => {
    // Otherwise the cheap bucket shields the expensive one: burn the token
    // budget deliberately, and the address counter stops moving while the
    // requests keep arriving.
    const address = "203.0.113.12";
    const token = freshToken();

    // Six submissions on one token: five allowed, the sixth refused — and all
    // six must count against the address.
    const onOneToken = Array.from({ length: 6 }, () =>
      withinConnectAttemptLimit("submit", token, address),
    );
    expect(onOneToken).toEqual([true, true, true, true, true, false]);

    // Fourteen more with fresh tokens takes the address to exactly 20.
    for (let i = 0; i < 14; i += 1) {
      expect(
        withinConnectAttemptLimit("submit", freshToken(), address),
        `attempt ${i} from this address was refused inside the allowance`,
      ).toBe(true);
    }

    // The 21st. If the refused sixth had been free, this would still be inside
    // the allowance and would pass.
    expect(
      withinConnectAttemptLimit("submit", freshToken(), address),
      "the refused attempt did not count against the address",
    ).toBe(false);
  });

  test("an unknown address does not put every visitor in one bucket", () => {
    // A deployment whose proxy forwards no client address must not collapse
    // every clinic on earth into a single window and fuse the only page the
    // customer ever sees. Well past the per-address allowance of 120, all with
    // distinct tokens: if null were bucketed rather than skipped, this stops
    // being allowed partway through.
    const allowed = Array.from({ length: 130 }, () =>
      withinConnectAttemptLimit("open", freshToken(), null),
    );
    expect(
      allowed.every(Boolean),
      "visitors with no determinable address shared one window",
    ).toBe(true);
  });

  test("one address's spending does not touch another's", () => {
    const spent = "203.0.113.13";
    for (let i = 0; i < 20; i += 1) {
      withinConnectAttemptLimit("submit", freshToken(), spent);
    }
    expect(withinConnectAttemptLimit("submit", freshToken(), spent)).toBe(
      false,
    );

    // A different clinic, submitting at the same moment, is unaffected.
    expect(
      withinConnectAttemptLimit("submit", freshToken(), "203.0.113.14"),
      "one address's flood refused another address's submission",
    ).toBe(true);
  });
});

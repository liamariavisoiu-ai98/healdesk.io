import { describe, expect, test } from "vitest";

import { auth } from "@/lib/auth";

/**
 * Better Auth's HTTP handler, driven for real (design D5).
 *
 * Until 5 October 2026 the rate limiter was configured with
 * `storage: "database"` against a `rateLimit` model that was never generated
 * or migrated, so every request through /api/auth/* threw inside the limiter
 * before reaching its endpoint. Nothing clinic-facing called those endpoints
 * yet, so nothing noticed. The portal's sign-in and sign-out do, so this
 * drives the handler the way the route does and asserts it answers.
 *
 * No database is needed: an anonymous get-session reads no session row, and
 * the in-memory limiter touches no table.
 */

const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3001";

describe("the Better Auth HTTP handler", () => {
  test("rate limits in memory, not against a table that does not exist", () => {
    expect(auth.options.rateLimit?.storage).toBe("memory");
    expect(auth.options.rateLimit?.enabled).toBe(true);
  });

  test("an anonymous get-session resolves with no session instead of throwing", async () => {
    const response = await auth.handler(new Request(`${base}/api/auth/get-session`));
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  test("repeated requests stay answerable (the limiter counts without a store error)", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await auth.handler(new Request(`${base}/api/auth/get-session`));
      expect(response.status).toBe(200);
    }
  });
});

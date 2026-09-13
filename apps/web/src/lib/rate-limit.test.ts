import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Two suites: the in-memory path that development uses, and the shared
 * Postgres path production uses. The second runs only when
 * TEST_MARKETING_URL points at a scratch database, and skips otherwise —
 * the same convention apps/app's database suites follow.
 */

const key = () => `test:${Math.random()}`;

describe("rateLimit (in-memory path)", () => {
  it("allows up to the limit then refuses", async () => {
    delete process.env.MARKETING_DATABASE_URL;
    const { rateLimit } = await import("./rate-limit");
    const k = key();
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    const third = await rateLimit(k, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it("isOverLimit does not spend from the budget", async () => {
    delete process.env.MARKETING_DATABASE_URL;
    const { isOverLimit, rateLimit } = await import("./rate-limit");
    const k = key();
    for (let i = 0; i < 100; i += 1) expect(await isOverLimit(k, 2)).toBe(false);
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    expect((await rateLimit(k, 2, 60_000)).ok).toBe(true);
    expect(await isOverLimit(k, 2)).toBe(true);
  });

  it("clientKey takes the first x-forwarded-for entry, which is what Vercel sets", async () => {
    const { clientKey } = await import("./rate-limit");
    expect(clientKey(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientKey(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});

const url = process.env.TEST_MARKETING_URL;
const describeDb = url ? describe : describe.skip;

describeDb("rateLimit (shared Postgres path)", () => {
  let pool: Pool;

  beforeAll(async () => {
    process.env.MARKETING_DATABASE_URL = url;
    pool = new Pool({ connectionString: url, max: 8 });
    // Test files run in parallel workers against one scratch database; the
    // lock serialises the migration so two workers cannot both CREATE TABLE.
    const lock = await pool.connect();
    try {
      await lock.query("select pg_advisory_lock(424242)");
      await migrate(drizzle(lock), { migrationsFolder: "./drizzle" });
    } finally {
      await lock.query("select pg_advisory_unlock(424242)");
      lock.release();
    }
    const db = await import("./db");
    db.__setMarketingPoolForTests(pool);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("delete from rate_limits");
  });

  afterAll(async () => {
    const db = await import("./db");
    db.__setMarketingPoolForTests(undefined);
    await pool.end();
  });

  it("refuses the eleventh call in a ten-call window and says when to retry", async () => {
    const { rateLimit } = await import("./rate-limit");
    const k = key();
    for (let i = 0; i < 10; i += 1) {
      const r = await rateLimit(k, 10, 60_000);
      expect(r.ok, `call ${i + 1}`).toBe(true);
      expect(r.remaining).toBe(9 - i);
    }
    const eleventh = await rateLimit(k, 10, 60_000);
    expect(eleventh.ok).toBe(false);
    expect(eleventh.remaining).toBe(0);
    expect(eleventh.retryAfter).toBeGreaterThan(0);
    expect(eleventh.retryAfter).toBeLessThanOrEqual(60);
  });

  it("starts a fresh window once the old one has closed", async () => {
    const { rateLimit } = await import("./rate-limit");
    const k = key();
    // A 1ms window closes before the second call arrives.
    expect((await rateLimit(k, 1, 1)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 15));
    expect((await rateLimit(k, 1, 1)).ok).toBe(true);
  });

  it("lets exactly the limit through when twenty requests race", async () => {
    // This is the property the in-memory limiter could not offer across
    // instances, and the reason the counters moved to one atomic upsert.
    const { rateLimit } = await import("./rate-limit");
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit(k, 10, 60_000)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(10);
  });

  it("isOverLimit peeks without spending", async () => {
    const { isOverLimit, rateLimit } = await import("./rate-limit");
    const k = key();
    expect(await isOverLimit(k, 2)).toBe(false);
    await rateLimit(k, 2, 60_000);
    await rateLimit(k, 2, 60_000);
    expect(await isOverLimit(k, 2)).toBe(true);
    const { rows } = await pool.query("select count from rate_limits where key = $1", [k]);
    expect(rows[0].count).toBe(2);
  });
});

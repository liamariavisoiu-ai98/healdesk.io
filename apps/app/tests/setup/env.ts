/**
 * Test environment defaults.
 *
 * Deliberately does NOT load a .env file: tests must never accidentally point
 * at a real database or a real KMS key. TEST_DATABASE_URL has to be set
 * explicitly by whoever runs the database-backed suites.
 */

// NODE_ENV is typed readonly by @types/node; the assignment is still valid.
(process.env as Record<string, string>).NODE_ENV = "test";

// 32 zero bytes, base64. Fine for tests; getKeyWrapper() refuses this in prod.
process.env.HEALDESK_LOCAL_KEK ??= Buffer.alloc(32).toString("base64");
process.env.HEALDESK_KMS_PROVIDER ??= "local";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-used-outside-tests";
/**
 * Every test session runs in UTC, as CI's Postgres and the dev-db container
 * do. node-postgres falls back to PGOPTIONS for its startup options, so this
 * reaches the harness pools and src/db's pool alike. Without it a local
 * cluster in a daylight-saving zone fails tests on real arithmetic: `now() +
 * make_interval(days => 30)` keeps the wall-clock time across an autumn
 * change, so a 30-day link lives 30 days and an hour, and the connection-link
 * ceiling test fails every October in America/New_York.
 */
process.env.PGOPTIONS ??= "-c TimeZone=UTC";
/**
 * Code under test connects via DATABASE_URL, while the harness is configured
 * with TEST_APP_URL. Point one at the other so a suite can't silently end up
 * talking to a different database than the one it seeded — which surfaces as a
 * confusing ECONNREFUSED or, worse, passing tests against stale data.
 */
process.env.DATABASE_URL ??=
  process.env.TEST_APP_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://localhost:5432/healdesk_test";

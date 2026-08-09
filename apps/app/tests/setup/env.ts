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
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/healdesk_test";

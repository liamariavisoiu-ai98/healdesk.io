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

/**
 * The local wrapper, whatever the shell says, and no way for the AWS SDK to
 * find credentials or a real endpoint.
 *
 * `??=` was enough while @aws-sdk/client-kms was not installed: a shell still
 * holding production settings failed at "SDK not installed". It is installed
 * now, so a shell with HEALDESK_KMS_PROVIDER=aws-kms, the key's ARN and an AWS
 * profile or keys would send every test that seals a synthetic credential to
 * that key, and the tests would pass. So the provider is set rather than
 * defaulted, and everything the SDK reads credentials or an endpoint from is
 * removed: the variables, the task-role and web-identity routes, the instance
 * metadata service, and the shared files, which hold a default profile the SDK
 * reads with no AWS_PROFILE set at all. A test that wants KMS or SES sets its
 * own environment through tests/setup/kms.ts or its own file, pointed at a
 * stand-in served from the test process.
 */
process.env.HEALDESK_KMS_PROVIDER = "local";
for (const name of [
  "HEALDESK_KMS_KEY_ID",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_KMS",
  "AWS_ENDPOINT_URL_SESV2",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
]) {
  delete process.env[name];
}
process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.AWS_SHARED_CREDENTIALS_FILE = "/dev/null";
process.env.AWS_CONFIG_FILE = "/dev/null";

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

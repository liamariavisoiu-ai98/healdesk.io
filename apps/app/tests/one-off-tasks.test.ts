import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * demo-clinic and channels-link as the AWS host runs them (14 October 2026).
 *
 * The host has no shell, so each runs as a one-off ECS task started by
 * infra/aws/scripts/run-task.sh, which passes its options as environment
 * overrides rather than arguments: the demo clinic for the Meta App Review
 * recordings, and the clinic's single-use connect link, printed to the task's
 * CloudWatch log only. These hold both scripts to working from that
 * environment alone, with nothing on the command line.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/cli");
const OPERATOR = "ops-tasks@healdesk.test";

function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [TSX, `scripts/${script}.ts`, ...args], {
    cwd: APP_DIR,
    input: "",
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describe("channels-link with neither arguments nor a clinic in its environment", () => {
  test("prints its usage and exits 2, before touching the database", () => {
    const run = runScript("channels-link", [], { HEALDESK_LINK_CLINIC_ID: "" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/Usage: npm run channels-link/);
  });

  test("refuses a channel it does not know from the environment, as it would on the command line", () => {
    const run = runScript("channels-link", [], {
      HEALDESK_LINK_CLINIC_ID: "0f8e1c2a-1111-4222-8333-444455556666",
      HEALDESK_LINK_ONLY: "sms",
    });
    expect(run.status).toBe(2);
  });
});

describeDb("the one-off tasks run from their environment alone", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("channels-link issues the clinic's Meta link on the public origin, from the environment, with nothing typed", async () => {
    const c = await seedClinic("link-by-env");
    const run = runScript("channels-link", [], {
      HEALDESK_LINK_CLINIC_ID: c.clinicId,
      HEALDESK_LINK_ONLY: "meta",
      HEALDESK_LINK_DAYS: "3",
      BETTER_AUTH_URL: "https://app.healdesk.test",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^meta\s+https:\/\/app\.healdesk\.test\/channels\/meta\/[A-Za-z0-9_-]{43}$/m);
    expect(run.stdout).not.toMatch(/whatsapp/);
    const links = await inTenant(c.clinicId, (client) =>
      client.query(
        `select purpose, expires_at - created_at as lasts from connection_links where clinic_id = $1`,
        [c.clinicId],
      ),
    );
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0].purpose).toBe("meta");
    expect(links.rows[0].lasts.days).toBe(3);
  }, 120_000);

  test("an argument still wins over the environment", async () => {
    const c = await seedClinic("link-argv-wins");
    const run = runScript("channels-link", [c.clinicId, "--only", "whatsapp"], {
      HEALDESK_LINK_CLINIC_ID: "0f8e1c2a-1111-4222-8333-444455556666",
      HEALDESK_LINK_ONLY: "meta",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^whatsapp\s+\S+\/channels\/whatsapp\//m);
  }, 120_000);

  test("demo-clinic makes the one demo clinic from the environment, and refuses a second", async () => {
    const env = {
      HEALDESK_ADMIN_EMAIL: OPERATOR,
      HEALDESK_DEMO_NAME: "Lumen Aesthetics",
      HEALDESK_DEMO_OPERATOR_NAME: "Ops Operator",
      HEALDESK_OPS_OPERATOR: OPERATOR,
    };
    const first = runScript("demo-clinic", [], env);
    expect(first.status, first.stderr).toBe(0);
    const id = first.stdout.match(/clinic id\s+([0-9a-f-]{36})/)?.[1];
    expect(id).toBeTruthy();
    expect(first.stdout).toContain(`run-task.sh channels-link ${id}`);
    const clinic = await getMigratorPool().query(`select name from clinics where id = $1`, [id]);
    expect(clinic.rows[0]?.name).toBe("Lumen Aesthetics");

    const second = runScript("demo-clinic", [], { ...env, HEALDESK_DEMO_NAME: "Another Practice" });
    expect(second.status).toBe(2);
    expect(second.stderr).toMatch(/A demo clinic already exists/);
  }, 180_000);

  test("demo-clinic refuses an address that is not the operator's, from the environment as from the command line", () => {
    const run = runScript("demo-clinic", [], {
      HEALDESK_ADMIN_EMAIL: OPERATOR,
      HEALDESK_DEMO_NAME: "Lumen Aesthetics",
      HEALDESK_DEMO_OPERATOR_NAME: "Ops Operator",
      HEALDESK_OPS_OPERATOR: "frontdesk@some-real-practice.test",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/must be the operator's own address/);
  }, 120_000);
});

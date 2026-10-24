import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { parseEnvelope, runOperation } from "@/lib/ops/api";
import { runOpsSlackSweep } from "@/lib/ops/slack";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";

/**
 * The setup-request alert names who is waiting (lane N1; owner, 23 October
 * 2026): apps/web's cron sends each past-due request's id with the
 * requester's business name and the day our reply was promised by. The name
 * is kept only when printableBusinessName passes it, the alert's identity is
 * the request id as before (so a request raised by an older apps/web is not
 * raised again), and the Slack copy prints the business and the day, with
 * a link to the Queues page that owns it. Ids-only calls still work.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR = { email: "ops@healdesk.test", request: {} };
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/SECRETPART0123456789";

async function op(name: string, args: Record<string, unknown>) {
  const parsed = parseEnvelope(JSON.stringify({ op: name, args }));
  if (!parsed.ok) throw new Error(`${name} is not an operation`);
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

async function alertFor(requestId: string) {
  const { rows } = await getMigratorPool().query<{
    id: string;
    fields: Record<string, unknown>;
    dedupe_key: string;
    repeats: number;
  }>(
    `select id, fields, dedupe_key, repeats from ops_alerts
      where event = 'setup_request_reply_past_due' and fields->>'requestId' = $1`,
    [requestId],
  );
  return rows;
}

describeDb("setupRepliesPastDue with the business name", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(() => {
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await closePools();
  });

  test("keeps a safe business name and the promised day on the alert, with the same identity as before", async () => {
    const id = randomUUID();
    const outcome = await op("setupRepliesPastDue", {
      requestIds: [id],
      requests: [{ id, business: "Glow Med Spa", promisedOn: "2026-10-22" }],
    });
    expect(outcome.body).toEqual({ data: { raised: 1 } });
    const [row] = await alertFor(id);
    expect(row!.fields).toEqual({
      requestId: id,
      source: "setup_request",
      business: "Glow Med Spa",
      promisedOn: "2026-10-22",
    });
    // The key an ids-only call made: the business and the day are not the alert's identity.
    expect(row!.dedupe_key).toBe(`requestId=${id};source=setup_request`);
  });

  test("a request raised by an older apps/web, ids only, is not raised again when the name arrives", async () => {
    const id = randomUUID();
    await op("setupRepliesPastDue", { requestIds: [id] });
    await op("setupRepliesPastDue", { requestIds: [id], requests: [{ id, business: "Radiance" }] });
    const rows = await alertFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toEqual({ requestId: id, source: "setup_request" });
  });

  test("a name that could reach someone, or a day that is not a day, is dropped and the alert still goes", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const outcome = await op("setupRepliesPastDue", {
      requestIds: ids,
      requests: [
        { id: ids[0], business: "owner@glow.test", promisedOn: "tomorrow" },
        { id: ids[1], business: "Call 5551234567" },
        { id: ids[2], business: "https://glow.test" },
      ],
    });
    expect(outcome.body).toEqual({ data: { raised: 3 } });
    for (const id of ids) {
      const [row] = await alertFor(id);
      expect(row!.fields, id).toEqual({ requestId: id, source: "setup_request" });
    }
  });

  test("a malformed `requests` list is refused whole", async () => {
    const id = randomUUID();
    for (const requests of [
      "x",
      [{ id: "not-a-uuid" }],
      [{ business: "Glow" }],
      Array.from({ length: 51 }, () => ({ id: randomUUID() })),
    ]) {
      const outcome = await op("setupRepliesPastDue", { requestIds: [id], requests });
      expect(outcome.status, JSON.stringify(requests).slice(0, 40)).toBe(400);
    }
    expect(await alertFor(id)).toHaveLength(0);
  });

  test("Slack prints the business and the day, every step, and the page that owns it", async () => {
    // Only this alert is owed to Slack: the earlier tests' alerts are in the same log.
    await getMigratorPool().query("delete from ops_alerts");
    const id = randomUUID();
    await op("setupRepliesPastDue", {
      requestIds: [id],
      requests: [{ id, business: "Glow Med Spa", promisedOn: "2026-10-22" }],
    });
    const [row] = await alertFor(id);
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SLACK_WEBHOOK_URL", WEBHOOK);
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.test");
    const result = await runOpsSlackSweep(new Date());
    expect(result.note).toMatch(/1 posted/);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      text: string;
      blocks: { type: string; text: { text: string } }[];
    };
    expect(body.text).toContain("A clinic asked us to set up AYA: Glow Med Spa.");
    expect(body.text).toContain("We promised to reply by 22 Oct, and that day has passed.");
    expect(body.text).toContain("1. Open the Setup requests list on the Queues page");
    expect(body.text).toContain("4. Check the request on the Queues page again.");
    expect(body.text).toContain("<https://healdesk.test/admin/queues#setup-requests|Open in the console>");
    expect(body.text).not.toContain(id);
    expect(body.blocks.map((b) => b.text.text).join("\n")).toBe(body.text);
    expect(row).toBeDefined();
  });
});

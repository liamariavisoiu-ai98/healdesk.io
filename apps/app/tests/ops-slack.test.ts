import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  postToSlack,
  runOpsSlackSweep,
  SLACK_LOOKBACK_MS,
  SLACK_MAX_ATTEMPTS,
  slackFields,
  slackText,
} from "@/lib/ops/slack";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * Ops alerts in Slack (lib/ops/slack.ts; owner decisions D1 and D2, 23
 * October 2026). Slack signs no business associate agreement, so the post is
 * an allow-list: the alert's title, the clinic's name and id, its counts.
 * The sweep posts each alert once, retries on the ladder, gives up after
 * SLACK_MAX_ATTEMPTS, records every outcome on the alert's row, never posts
 * without the key, and never writes the webhook's address anywhere.
 *
 * fetch is stubbed, so the stub IS the wire: what it was handed is what would
 * have reached Slack.
 */

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/SECRETPART0123456789";
const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";

const fetchMock = vi.fn();

function posted(): string[] {
  return fetchMock.mock.calls.map((call) => {
    const body = JSON.parse(String((call[1] as RequestInit).body)) as { text: string };
    return body.text;
  });
}

describe("the Slack allow-list", () => {
  test("keeps the clinic id, the meter and counts, and drops everything else", () => {
    expect(
      slackFields({
        clinicId: CLINIC,
        noticeId: "5f0e4a1b-1111-4222-8333-444455556666",
        conversationId: "c_123",
        kind: "payment_failed",
        status: "late",
        code: "invalid_grant",
        reason: "owner@radiance.test bounced",
        email: "owner@radiance.test",
        meter: "voice_minutes",
        attempts: 3,
        count: 2,
        used: 91,
        included: 100,
        locationCount: -1,
      }),
    ).toEqual({ clinicId: CLINIC, meter: "voice_minutes", attempts: 3, count: 2, used: 91, included: 100 });
  });

  test("refuses a clinic id that is not a uuid, a meter off the list and a count that is not a number", () => {
    expect(slackFields({ clinicId: "Radiance <@here>", meter: "patients", count: "7" })).toEqual({});
  });

  test("the message has the title, the clinic and the counts, and escapes Slack's control characters", () => {
    const text = slackText({
      event: "critical_notice_undelivered",
      fields: { clinicId: CLINIC, noticeId: "n_1", kind: "payment_failed", attempts: 3 },
      clinicName: "Glow & <Co>",
    });
    expect(text).toContain("*A critical email has not gone out*");
    expect(text).toContain(`Glow &amp; &lt;Co&gt;, clinic id \`${CLINIC}\``);
    expect(text).toContain("Attempts: 3");
    expect(text).toContain("_critical_notice_undelivered_");
    expect(text).not.toContain("n_1");
    expect(text).not.toContain("payment_failed");
  });

  test("posts only to a Slack Incoming Webhook", async () => {
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await postToSlack("https://example.com/hook", "hi");
      expect(result).toEqual({ ok: false, error: expect.stringContaining("not a Slack Incoming Webhook") });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      fetchMock.mockReset();
    }
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("the ops-slack sweep", () => {
  let saved: string | undefined;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    saved = process.env.SLACK_OPS_WEBHOOK_URL;
    process.env.SLACK_OPS_WEBHOOK_URL = WEBHOOK;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.SLACK_OPS_WEBHOOK_URL;
    else process.env.SLACK_OPS_WEBHOOK_URL = saved;
  });

  afterAll(async () => {
    await closePools();
  });

  async function raise(fields: Record<string, unknown>, raisedAt: Date, event = "calendar_broken") {
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at)
       values ($1, $2, $3, $4, $4) returning id`,
      [event, JSON.stringify(fields), JSON.stringify(fields), raisedAt],
    );
    return rows[0]!.id;
  }

  async function row(id: string) {
    const { rows } = await getMigratorPool().query<{
      slack_posted_at: Date | null;
      slack_attempts: number;
      slack_error: string | null;
      slack_next_at: Date | null;
    }>(`select slack_posted_at, slack_attempts, slack_error, slack_next_at from ops_alerts where id = $1`, [id]);
    return rows[0]!;
  }

  test("without the key, Slack is off and no row is touched", async () => {
    process.env.SLACK_OPS_WEBHOOK_URL = "__unset__";
    const now = new Date("2026-10-23T10:00:00Z");
    const id = await raise({ clinicId: CLINIC }, now);
    const result = await runOpsSlackSweep(now);
    expect(result.note).toMatch(/Slack is off/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ slack_attempts: 0, slack_posted_at: null });
  });

  test("posts each alert once, with the clinic's name, and records it", async () => {
    const clinic = await seedClinic("slackname");
    const now = new Date("2026-10-23T10:00:00Z");
    const id = await raise({ clinicId: clinic.clinicId, count: 1, code: "invalid_grant" }, now);

    await runOpsSlackSweep(now);
    await runOpsSlackSweep(new Date(now.getTime() + 60_000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(WEBHOOK);
    const [text] = posted();
    expect(text).toContain("slackname Clinic");
    expect(text).toContain(clinic.clinicId);
    expect(text).not.toContain("invalid_grant");
    expect(await row(id)).toMatchObject({ slack_attempts: 1, slack_error: null, slack_next_at: null });
    expect((await row(id)).slack_posted_at).not.toBeNull();
  });

  test("retries at 1, 5 and 30 minutes, then gives up; the address is never recorded", async () => {
    fetchMock.mockResolvedValue(new Response("no_service", { status: 503 }));
    const start = new Date("2026-10-23T10:00:00Z");
    const id = await raise({ clinicId: CLINIC }, start);

    await runOpsSlackSweep(start);
    let state = await row(id);
    expect(state).toMatchObject({ slack_attempts: 1, slack_error: "http 503", slack_posted_at: null });
    expect(state.slack_next_at?.toISOString()).toBe("2026-10-23T10:01:00.000Z");

    // Not before its time.
    await runOpsSlackSweep(new Date("2026-10-23T10:00:30Z"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await runOpsSlackSweep(new Date("2026-10-23T10:01:00Z"));
    expect((await row(id)).slack_next_at?.toISOString()).toBe("2026-10-23T10:06:00.000Z");
    await runOpsSlackSweep(new Date("2026-10-23T10:06:00Z"));
    expect((await row(id)).slack_next_at?.toISOString()).toBe("2026-10-23T10:36:00.000Z");
    await runOpsSlackSweep(new Date("2026-10-23T10:36:00Z"));
    state = await row(id);
    expect(state.slack_attempts).toBe(SLACK_MAX_ATTEMPTS);
    expect(state.slack_next_at).toBeNull();

    // Given up: nothing more, however long the sweep keeps running.
    await runOpsSlackSweep(new Date("2026-10-23T12:00:00Z"));
    expect(fetchMock).toHaveBeenCalledTimes(SLACK_MAX_ATTEMPTS);

    const { rows } = await getMigratorPool().query(`select * from ops_alerts`);
    expect(JSON.stringify(rows)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(rows)).not.toContain("SECRETPART");
  });

  test("a failure that recovers posts on the next try", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    const start = new Date("2026-10-23T10:00:00Z");
    const id = await raise({ clinicId: CLINIC }, start);
    await runOpsSlackSweep(start);
    expect((await row(id)).slack_error).toBe("TimeoutError");
    await runOpsSlackSweep(new Date("2026-10-23T10:01:00Z"));
    expect((await row(id)).slack_posted_at).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("never posts an alert older than the look-back", async () => {
    const now = new Date("2026-10-23T10:00:00Z");
    await raise({ clinicId: CLINIC }, new Date(now.getTime() - SLACK_LOOKBACK_MS - 1000));
    await runOpsSlackSweep(now);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("two sweeps at once post one alert once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await gate;
      return new Response("ok", { status: 200 });
    });
    const now = new Date("2026-10-23T10:00:00Z");
    await raise({ clinicId: CLINIC }, now);
    const first = runOpsSlackSweep(now);
    const second = runOpsSlackSweep(now);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

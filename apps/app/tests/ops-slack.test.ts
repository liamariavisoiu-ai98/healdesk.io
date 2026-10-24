import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  postToSlack,
  runOpsSlackSweep,
  SLACK_LOOKBACK_MS,
  SLACK_MAX_ATTEMPTS,
  SLACK_MAX_RETRY_AFTER_MS,
  slackFields,
  slackText,
} from "@/lib/ops/slack";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
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
  // Since lane N3 a closed word list admits `kind` and `status` when the
  // value is on it (lib/ops/alert-wording/words.ts); a code off the vendor
  // list, ids and free text are still dropped.
  test("keeps the clinic id, the closed words and counts, and drops everything else", () => {
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
    ).toEqual({
      clinicId: CLINIC,
      kind: "payment_failed",
      status: "late",
      meter: "voice_minutes",
      attempts: 3,
      count: 2,
      used: 91,
      included: 100,
    });
  });

  test("refuses a clinic id that is not a uuid, a meter off the list and a count that is not a number", () => {
    expect(slackFields({ clinicId: "Radiance <@here>", meter: "patients", count: "7" })).toEqual({});
  });

  test("the message has the urgency, the headline, the clinic and the counts, and escapes Slack's control characters", () => {
    const text = slackText({
      event: "critical_notice_undelivered",
      fields: { clinicId: CLINIC, noticeId: "n_1", kind: "payment_failed", attempts: 3 },
      clinicName: "Glow & <Co>",
    });
    // Tagged [app]: the #alerts channel is shared with apps/web's [web] posts.
    // Lane N4: the urgency's emoji, then the headline in bold, then step 1.
    expect(text.split("\n")[0]).toBe(
      ":rotating_light: [app] *Glow &amp; &lt;Co&gt; has not received a payment-failed notice: 10 minutes late, still retrying*",
    );
    expect(text.split("\n")[1]).toMatch(/^\*Do this first:\* Open the clinic's \*Deliveries tab\*/);
    expect(text).toContain(`Glow &amp; &lt;Co&gt;, clinic id \`${CLINIC}\``);
    expect(text).toContain("Attempts: 3");
    expect(text).toContain("_critical_notice_undelivered_");
    expect(text).not.toContain("n_1");
    expect(text).not.toContain("payment_failed");
  });

  test("a clinic's name cannot mention the channel or a person", () => {
    for (const name of ["<!channel> Spa", "<!here>", "Glow <@U123|x>", "<https://evil.example|click>"]) {
      const text = slackText({ event: "calendar_broken", fields: { clinicId: CLINIC }, clinicName: name });
      // Every < and > the name brought is escaped: Slack sees text, not a mention or a link.
      // The name's line follows what happened (lane N1), so it is found by its id.
      const nameLine = text.split("\n").find((line) => line.includes("clinic id"))!;
      expect(nameLine, name).not.toMatch(/[<>]/);
      expect(nameLine, name).toContain("&lt;");
    }
  });

  test("posts only to a Slack Incoming Webhook, never a lookalike", async () => {
    vi.stubGlobal("fetch", fetchMock);
    try {
      for (const url of [
        "https://example.com/hook",
        "https://hooks.slack.com@evil.example/services/T000/B000/xyzxyzxyz",
        "https://hooks.slack.com.evil.example/services/T000/B000/xyzxyzxyz",
        "https://user:pw@hooks.slack.com/services/T000/B000/xyzxyzxyz",
        "http://hooks.slack.com/services/T000/B000/xyzxyzxyz",
        "https://hooks.slack.com/api/T000/B000/xyzxyzxyz",
        "https://hooks.slack.com/services/../api/xyzxyzxyz",
        "https://hooks.slack.com/services/T000/B000/xyz?redirect=https://evil.example",
        "https://hooks.slack.com:8443/services/T000/B000/xyzxyzxyz",
      ]) {
        const result = await postToSlack(url, "hi");
        expect(result, url).toMatchObject({ ok: false, error: expect.stringContaining("not a Slack Incoming Webhook") });
      }
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
    saved = process.env.SLACK_WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = WEBHOOK;
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
    if (saved === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = saved;
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
    process.env.SLACK_WEBHOOK_URL = "__unset__";
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
    // The urgency's emoji, then the [app] tag the shared channel needs.
    expect(text!).toMatch(/^:[a-z_]+: \[app\] /);
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

  /**
   * The hourly tick used to hand the sweep the time it started, and reached
   * it minutes later: a lease counted from that stale time was already over
   * when the every-minute sweep, on the real clock, looked, and it claimed
   * and posted the same alert again.
   */
  test("a sweep running on a stale clock still holds its alert against one on the real clock", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await gate;
      return new Response("ok", { status: 200 });
    });
    const real = Date.now();
    await raise({ clinicId: CLINIC }, new Date(real - 30 * 60_000));
    const stale = runOpsSlackSweep(new Date(real - 10 * 60_000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const onTime = await runOpsSlackSweep(new Date());
    release();
    await stale;
    expect(onTime.note).toMatch(/^0 claimed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 429 is not a try: the alert and the rest of its batch wait as long as Slack asked", async () => {
    const now = new Date("2026-10-23T10:00:00Z");
    const ids = [
      await raise({ clinicId: CLINIC, count: 1 }, new Date(now.getTime() - 3000)),
      await raise({ clinicId: CLINIC, count: 2 }, new Date(now.getTime() - 2000)),
      await raise({ clinicId: CLINIC, count: 3 }, new Date(now.getTime() - 1000)),
    ];
    fetchMock.mockResolvedValue(new Response("rate_limited", { status: 429, headers: { "retry-after": "120" } }));

    const result = await runOpsSlackSweep(now);
    // One post, then the batch stops: the other two are not thrown at the same wall.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.note).toMatch(/2 held/);
    for (const id of ids) {
      const state = await row(id);
      expect(state.slack_attempts, id).toBe(0);
      expect(state.slack_next_at?.toISOString(), id).toBe("2026-10-23T10:02:00.000Z");
    }
    expect((await row(ids[0]!)).slack_error).toBe("http 429");

    // However often Slack says 429, no alert spends its four tries on it.
    fetchMock.mockResolvedValue(new Response("rate_limited", { status: 429, headers: { "retry-after": "99999" } }));
    let at = new Date("2026-10-23T10:02:00Z");
    for (let i = 0; i < SLACK_MAX_ATTEMPTS + 2; i += 1) {
      await runOpsSlackSweep(at);
      const next = (await row(ids[0]!)).slack_next_at!;
      // A Retry-After is honoured up to its cap.
      expect(next.getTime() - at.getTime()).toBe(SLACK_MAX_RETRY_AFTER_MS);
      at = next;
    }
    expect((await row(ids[0]!)).slack_attempts).toBe(0);

    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    await runOpsSlackSweep(at);
    for (const id of ids) expect((await row(id)).slack_posted_at, id).not.toBeNull();
  });

  test("a 5xx counts as a try for its alert, and the rest of the batch waits untried", async () => {
    const now = new Date("2026-10-23T10:00:00Z");
    const first = await raise({ clinicId: CLINIC, count: 1 }, new Date(now.getTime() - 2000));
    const second = await raise({ clinicId: CLINIC, count: 2 }, new Date(now.getTime() - 1000));
    fetchMock.mockResolvedValue(new Response("no_service", { status: 503 }));
    await runOpsSlackSweep(now);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await row(first)).toMatchObject({ slack_attempts: 1, slack_error: "http 503" });
    expect(await row(second)).toMatchObject({ slack_attempts: 0 });
    for (const id of [first, second]) {
      expect((await row(id)).slack_next_at?.toISOString(), id).toBe("2026-10-23T10:01:00.000Z");
    }
  });

  /**
   * Two sweeps never both claim a row: one another sweep holds is skipped
   * (SKIP LOCKED), not waited on. Without SKIP LOCKED this sweep would block
   * behind the held lock until the race below gives up, and the test fails.
   */
  test("a sweep skips an alert another sweep holds, rather than waiting for it or claiming it", async () => {
    const now = new Date("2026-10-23T10:00:00Z");
    const id = await raise({ clinicId: CLINIC }, now);
    const holder = await getAppPool().connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from ops_alerts where id = $1 for update`, [id]);
      const outcome = await Promise.race([
        runOpsSlackSweep(now),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(outcome).toMatchObject({ note: expect.stringMatching(/^0 claimed/) });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    expect((await row(id)).slack_attempts).toBe(0);
  });
});

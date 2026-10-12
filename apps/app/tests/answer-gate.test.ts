import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  assistantMayAnswer,
  coverageModeOf,
  decideAnswer,
  voiceAnswerDecision,
  type AnswerFacts,
} from "@/lib/billing/answering";
import { setOverageMode } from "@/lib/billing/entitlements";
import { identifierRef } from "@/lib/identifier-ref";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The answer gate (BD9, BD22, BD23, R1, R18, R20, R21, R25): the pure rules
 * as one table, every reason and the order they are checked in, then the
 * reads behind them against the database, where a location's billing comes
 * from its billing clinic and "no billing row" fails closed outside
 * synthetic data.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "answer-gate-test" } as const;

const NOW = new Date("2026-10-15T15:00:00Z");
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const WINDOW_END = new Date("2026-11-01T00:00:00Z");
const LINE = "+14155550100";

type Billing = NonNullable<AnswerFacts["billing"]>;

function facts(
  overrides: Partial<Omit<AnswerFacts, "billing">> & { billing?: Partial<Billing> | null } = {},
): AnswerFacts {
  const { billing, ...rest } = overrides;
  const base: Billing = {
    status: "active",
    graceEndsAt: null,
    isPlanStarted: true,
    cancelAt: null,
    channelsEnabled: { web: true, meta: true, voice: true },
    overageMode: "allow",
    included: 1_000,
    used: 10,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  };
  return {
    channel: "voice",
    now: NOW,
    isSynthetic: false,
    agreement: "in_effect",
    billing: billing === null ? null : { ...base, ...billing },
    channelRow: { enabled: true, liveAt: new Date("2026-10-02T00:00:00Z") },
    pause: { pausedAt: null, pausedUntil: null },
    directLine: LINE,
    coverageMode: "overflow_after_hours",
    openNow: true,
    closedToday: false,
    startsNew: true,
    ...rest,
  };
}

const before = (ms: number) => new Date(NOW.getTime() - ms);
const after = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60 * 1000;

function reasonOf(f: AnswerFacts): string {
  const decision = decideAnswer(f);
  return decision.decision === "answer" ? "answer" : decision.reason;
}

describe("decideAnswer: every rule (BD22)", () => {
  const table: [string, AnswerFacts, string][] = [
    ["everything in order", facts(), "answer"],
    // 1. Billing (BD9, R8, R21).
    [
      "past due inside grace",
      facts({ billing: { status: "past_due", graceEndsAt: after(HOUR) } }),
      "answer",
    ],
    [
      "past due, grace over",
      facts({ billing: { status: "past_due", graceEndsAt: before(HOUR) } }),
      "unpaid",
    ],
    [
      "past due, grace ends now",
      facts({ billing: { status: "past_due", graceEndsAt: NOW } }),
      "unpaid",
    ],
    ["past due, no grace", facts({ billing: { status: "past_due", graceEndsAt: null } }), "unpaid"],
    ["canceling after the start", facts({ billing: { status: "canceling" } }), "answer"],
    [
      "canceling after the start, inside grace",
      facts({ billing: { status: "canceling", graceEndsAt: after(HOUR) } }),
      "answer",
    ],
    [
      "canceling after the start, grace over (R21)",
      facts({ billing: { status: "canceling", graceEndsAt: before(HOUR) } }),
      "unpaid",
    ],
    [
      "canceling before the start",
      facts({ billing: { status: "canceling", isPlanStarted: false } }),
      "cancel_before_start",
    ],
    [
      "auto-renew off before the start, ahead of the webhook (cancel_at)",
      facts({ billing: { cancelAt: after(HOUR * 24 * 20), isPlanStarted: false } }),
      "cancel_before_start",
    ],
    [
      "cancel_at after the start is the paid period running out",
      facts({ billing: { cancelAt: after(HOUR * 24 * 20) } }),
      "answer",
    ],
    ["provisioning", facts({ billing: { status: "provisioning" } }), "not_active"],
    ["billing paused", facts({ billing: { status: "paused" } }), "not_active"],
    ["suspended", facts({ billing: { status: "suspended" } }), "suspended"],
    ["canceled", facts({ billing: { status: "canceled" } }), "canceled"],
    ["purged", facts({ billing: { status: "purged" } }), "canceled"],
    [
      "demo on synthetic data skips billing",
      facts({ isSynthetic: true, billing: { status: "demo" } }),
      "answer",
    ],
    [
      "demo on a production clinic fails closed",
      facts({ billing: { status: "demo" } }),
      "not_active",
    ],
    [
      "no billing row on synthetic data skips billing (R1)",
      facts({ isSynthetic: true, billing: null }),
      "answer",
    ],
    ["no billing row on a production clinic (R1)", facts({ billing: null }), "not_active"],
    // 2. Bought.
    [
      "the channel was not bought",
      facts({ billing: { channelsEnabled: { web: true, meta: true, voice: false } } }),
      "not_purchased",
    ],
    // 3. The channel row (R1).
    ["no channel row on a production clinic", facts({ channelRow: null }), "channel_not_live"],
    ["no channel row on synthetic data", facts({ isSynthetic: true, channelRow: null }), "answer"],
    [
      "switched off",
      facts({ channelRow: { enabled: false, liveAt: new Date("2026-10-02T00:00:00Z") } }),
      "channel_off",
    ],
    ["not live yet", facts({ channelRow: { enabled: true, liveAt: null } }), "channel_not_live"],
    // 4. The pause (BD26: isPaused).
    [
      "paused until switched back",
      facts({ pause: { pausedAt: before(HOUR), pausedUntil: null } }),
      "ai_paused",
    ],
    [
      "paused for another hour",
      facts({ pause: { pausedAt: before(HOUR), pausedUntil: after(HOUR) } }),
      "ai_paused",
    ],
    [
      "a timed pause that has ended",
      facts({ pause: { pausedAt: before(2 * HOUR), pausedUntil: before(HOUR) } }),
      "answer",
    ],
    // 5. Voice coverage.
    [
      "after hours only, inside opening hours",
      facts({ coverageMode: "after_hours_only", openNow: true }),
      "outside_coverage",
    ],
    [
      "after hours only, outside opening hours",
      facts({ coverageMode: "after_hours_only", openNow: false }),
      "answer",
    ],
    [
      "after hours only, unknown hours or a bad time zone",
      facts({ coverageMode: "after_hours_only", openNow: null }),
      "answer",
    ],
    [
      "after hours only, on a closure day",
      facts({ coverageMode: "after_hours_only", openNow: true, closedToday: true }),
      "answer",
    ],
    [
      "coverage is voice only",
      facts({ channel: "web", coverageMode: "after_hours_only", openNow: true }),
      "answer",
    ],
    ["all calls inside hours", facts({ coverageMode: "all_calls", openNow: true }), "answer"],
    // 6. The allowance cap (R1, R18, R20).
    [
      "Stop and fall back, allowance used, a new call",
      facts({ billing: { overageMode: "hard_cap", used: 1_000 } }),
      "allowance_cap",
    ],
    [
      "Stop and fall back, over the allowance",
      facts({ billing: { overageMode: "hard_cap", used: 1_200 } }),
      "allowance_cap",
    ],
    [
      "Stop and fall back, a conversation already counted",
      facts({ billing: { overageMode: "hard_cap", used: 1_000 }, startsNew: false }),
      "answer",
    ],
    [
      "Stop and fall back, allowance left",
      facts({ billing: { overageMode: "hard_cap", used: 999 } }),
      "answer",
    ],
    [
      "Stop and fall back before the first window (BD6)",
      facts({
        billing: { overageMode: "hard_cap", used: 1_000, windowStart: null, windowEnd: null },
      }),
      "answer",
    ],
    [
      "Stop and fall back on an expired window (R20)",
      facts({ billing: { overageMode: "hard_cap", used: 1_000, windowEnd: before(HOUR) } }),
      "answer",
    ],
    [
      "Keep going, allowance used",
      facts({ billing: { overageMode: "allow", used: 1_500 } }),
      "answer",
    ],
  ];

  test.each(table)("%s", (_name, f, expected) => {
    expect(reasonOf(f)).toBe(expected);
  });
});

describe("decideAnswer: the order, first refusal wins (BD22)", () => {
  test("billing before everything", () => {
    expect(
      reasonOf(
        facts({
          billing: {
            status: "suspended",
            channelsEnabled: { web: false, meta: false, voice: false },
          },
          channelRow: null,
          pause: { pausedAt: before(HOUR), pausedUntil: null },
        }),
      ),
    ).toBe("suspended");
    expect(reasonOf(facts({ billing: null, channelRow: null }))).toBe("not_active");
  });

  test("not bought before the channel row", () => {
    expect(
      reasonOf(
        facts({
          billing: { channelsEnabled: { web: true, meta: true, voice: false } },
          channelRow: { enabled: false, liveAt: null },
        }),
      ),
    ).toBe("not_purchased");
  });

  test("the channel row before the pause", () => {
    expect(
      reasonOf(
        facts({
          channelRow: { enabled: false, liveAt: null },
          pause: { pausedAt: before(HOUR), pausedUntil: null },
        }),
      ),
    ).toBe("channel_off");
  });

  test("the pause before coverage, coverage before the cap", () => {
    expect(
      reasonOf(
        facts({
          pause: { pausedAt: before(HOUR), pausedUntil: null },
          coverageMode: "after_hours_only",
          openNow: true,
        }),
      ),
    ).toBe("ai_paused");
    expect(
      reasonOf(
        facts({
          coverageMode: "after_hours_only",
          openNow: true,
          billing: { overageMode: "hard_cap", used: 1_000 },
        }),
      ),
    ).toBe("outside_coverage");
  });

  test("the cancel_at rule follows the status: an unpaid clinic is unpaid first", () => {
    expect(
      reasonOf(
        facts({
          billing: {
            status: "past_due",
            graceEndsAt: before(HOUR),
            isPlanStarted: false,
            cancelAt: after(HOUR),
          },
        }),
      ),
    ).toBe("unpaid");
  });
});

describe("decideAnswer: where a refusal goes", () => {
  test("voice to the direct line, website chat to the contact form, Meta to no reply", () => {
    const refused = { billing: { status: "suspended" as const } };
    expect(decideAnswer(facts(refused))).toEqual({
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: LINE,
    });
    expect(decideAnswer(facts({ ...refused, channel: "web" }))).toEqual({
      decision: "pass_through",
      reason: "suspended",
      fallback: "contact_form",
      directLine: null,
    });
    expect(decideAnswer(facts({ ...refused, channel: "meta" }))).toEqual({
      decision: "pass_through",
      reason: "suspended",
      fallback: "no_reply",
      directLine: null,
    });
    // No direct line: the runtime still must not leave a dead line.
    expect(decideAnswer(facts({ ...refused, directLine: null }))).toMatchObject({
      fallback: "direct_line",
      directLine: null,
    });
  });
});

describe("coverageModeOf (BD23)", () => {
  test("clinic_settings.coverage_mode is the single source, whatever call_routing says", () => {
    expect(
      coverageModeOf({ callRouting: "conditional" }, { coverageMode: "after_hours_only" }),
    ).toBe("after_hours_only");
    expect(coverageModeOf({ callRouting: "always" }, { coverageMode: "overflow_after_hours" })).toBe(
      "overflow_after_hours",
    );
    expect(coverageModeOf({ callRouting: "conditional" }, { coverageMode: "all_calls" })).toBe(
      "all_calls",
    );
  });

  test("with no settings row, call_routing maps to the coverage modes", () => {
    expect(coverageModeOf({ callRouting: "always" })).toBe("all_calls");
    expect(coverageModeOf({ callRouting: "conditional" }, null)).toBe("overflow_after_hours");
    expect(coverageModeOf({ callRouting: null })).toBe("overflow_after_hours");
  });
});

// -----------------------------------------------------------------------------
// The reads, against the database
// -----------------------------------------------------------------------------

async function makeProduction(clinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`,
    [clinicId],
  );
}

async function makeLocation(locationId: string, billingClinicId: string): Promise<void> {
  await getMigratorPool().query(`update clinics set billing_clinic_id = $2 where id = $1`, [
    locationId,
    billingClinicId,
  ]);
}

async function setDirectLine(clinicId: string, line: string | null): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [clinicId, line],
    ),
  );
}

async function opsAlertsFor(clinicId: string): Promise<{ code: unknown }[]> {
  const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
    `select fields from ops_alerts where event = 'voice_fallback_no_direct_line' and fields->>'clinicId' = $1`,
    [clinicId],
  );
  return rows.map((r) => ({ code: r.fields.code }));
}

async function noticesOf(clinicId: string, kind: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
      `select dedupe_key, payload from billing_notices where kind = $1`,
      [kind],
    );
    return rows;
  });
}

const LIVE = new Date("2026-10-02T00:00:00Z");

describeDb("assistantMayAnswer, reading the facts (R1)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  beforeEach(() => {
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
  });

  afterAll(async () => {
    await closePools();
  });

  test("a synthetic clinic with no rows at all answers", async () => {
    const c = await seedClinic("gate-synthetic");
    for (const channel of ["voice", "web", "meta"] as const) {
      expect(await assistantMayAnswer({ clinicId: c.clinicId, channel, now: NOW, actor })).toEqual({
        decision: "answer",
      });
    }
  });

  test("a production clinic with no billing row refuses with not_active (fail closed)", async () => {
    const c = await seedClinic("gate-production");
    await makeProduction(c.clinicId);
    await seedChannels(c.clinicId, [{ channel: "web", liveAt: LIVE }]);
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "web", now: NOW, actor }),
    ).toEqual({
      decision: "pass_through",
      reason: "not_active",
      fallback: "contact_form",
      directLine: null,
    });
  });

  test("a location whose billing clinic is suspended refuses with suspended", async () => {
    const billing = await seedClinic("gate-billing");
    const location = await seedClinic("gate-location");
    await makeLocation(location.clinicId, billing.clinicId);
    await seedEntitled(billing.clinicId, { planStartedAt: WINDOW_START });
    await seedChannels(location.clinicId, [{ channel: "voice", liveAt: LIVE }]);
    await setDirectLine(location.clinicId, LINE);

    // The location has no entitlements row of its own: its billing clinic's
    // answers for it, and it answers while that clinic is active.
    expect(
      await assistantMayAnswer({ clinicId: location.clinicId, channel: "voice", now: NOW, actor }),
    ).toEqual({ decision: "answer" });

    await withTenant({ clinicId: billing.clinicId, actor }, async (tx) => {
      const { transition } = await import("@/lib/billing/state-machine");
      await transition(tx, "suspended", { actor: "system", reason: "grace_expired" });
    });
    expect(
      await assistantMayAnswer({ clinicId: location.clinicId, channel: "voice", now: NOW, actor }),
    ).toEqual({
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: LINE,
    });
  });

  test("the channel row: missing on a production clinic is not live, off is off, and live answers", async () => {
    const c = await seedClinic("gate-channel");
    await makeProduction(c.clinicId);
    await seedEntitled(c.clinicId, {});
    const ask = (channel: "web" | "meta" | "voice") =>
      assistantMayAnswer({ clinicId: c.clinicId, channel, now: NOW, actor }).then((d) =>
        d.decision === "answer" ? "answer" : d.reason,
      );
    expect(await ask("web")).toBe("channel_not_live");
    await seedChannels(c.clinicId, [
      { channel: "web", liveAt: LIVE },
      { channel: "meta", enabled: false, liveAt: LIVE },
      { channel: "voice", readyAt: LIVE, waitingOn: "forwarding" },
    ]);
    expect(await ask("web")).toBe("answer");
    expect(await ask("meta")).toBe("channel_off");
    expect(await ask("voice")).toBe("channel_not_live");
  });

  test("a synthetic clinic with a billing row but no channel row treats the channel as live (R1)", async () => {
    const c = await seedClinic("gate-synthetic-billed");
    await seedEntitled(c.clinicId, { planId: "chat-web" });
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "web", now: NOW, actor }),
    ).toEqual({
      decision: "answer",
    });
    // ...but billing still applies: Chat Web did not buy voice.
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "voice", now: NOW, actor }),
    ).toMatchObject({
      reason: "not_purchased",
    });
  });

  test("the header's pause holds until its end, through isPaused", async () => {
    const c = await seedClinic("gate-pause");
    await seedEntitled(c.clinicId, {});
    await seedChannels(c.clinicId, [{ channel: "web", liveAt: LIVE }]);
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_by_label, ai_paused_until)
         values ($1, $2, 'owner', $3)`,
        [c.clinicId, before(HOUR), after(HOUR)],
      ),
    );
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "web", now: NOW, actor }),
    ).toMatchObject({
      reason: "ai_paused",
    });
    expect(
      await assistantMayAnswer({
        clinicId: c.clinicId,
        channel: "web",
        now: after(2 * HOUR),
        actor,
      }),
    ).toEqual({ decision: "answer" });
  });

  test("Stop and fall back: a new conversation is refused once the allowance is used, and the clinic is told once", async () => {
    const c = await seedClinic("gate-cap");
    await seedEntitled(c.clinicId, { planId: "chat-web", planStartedAt: WINDOW_START });
    await seedChannels(c.clinicId, [{ channel: "web", liveAt: LIVE }]);
    await withTenant({ clinicId: c.clinicId, actor }, (tx) =>
      setOverageMode(tx.db, c.clinicId, "hard_cap"),
    );
    await inTenant(c.clinicId, (client) =>
      client.query(`update entitlements set used_chat_conversations = 1000 where clinic_id = $1`, [
        c.clinicId,
      ]),
    );
    const counted = identifierRef(
      "chat_conversation",
      c.clinicId,
      "11111111-1111-4111-8111-111111111111",
    );
    const fresh = identifierRef(
      "chat_conversation",
      c.clinicId,
      "22222222-2222-4222-8222-222222222222",
    );
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into usage_events (clinic_id, location_clinic_id, meter, source, source_ref, quantity, occurred_at, window_start, included, used_before)
         values ($1, $1, 'chat_conversations', 'web_chat', $2, 1, $3, $4, 1000, 999)`,
        [c.clinicId, counted, before(HOUR), WINDOW_START],
      ),
    );

    const ask = (sourceRef?: string) =>
      assistantMayAnswer({
        clinicId: c.clinicId,
        channel: "web",
        usage: sourceRef ? { source: "web_chat", sourceRef } : undefined,
        now: NOW,
        actor,
      });

    // A conversation already counted carries on (R18); a new one, or no
    // reference at all, is refused.
    expect(await ask(counted)).toEqual({ decision: "answer" });
    expect(await ask(fresh)).toEqual({
      decision: "pass_through",
      reason: "allowance_cap",
      fallback: "contact_form",
      directLine: null,
    });
    expect(await ask()).toMatchObject({ reason: "allowance_cap" });

    // L19, once per meter per window, whatever the usage-alerts switch says.
    const fallbacks = await noticesOf(c.clinicId, "allowance_fallback");
    expect(fallbacks).toEqual([
      {
        dedupe_key: `chat_conversations:${WINDOW_START.toISOString()}`,
        payload: { meter: "chat_conversations", included: 1000, windowEndsOn: "2026-11-01" },
      },
    ]);

    // An expired window is not the allowance any more (R20).
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "web", now: WINDOW_END, actor }),
    ).toEqual({ decision: "answer" });
  });

  test("a channel bought but not yet billed is measured against the bought allowance, so the cap never refuses its first call (BD5)", async () => {
    const c = await seedClinic("gate-bd5");
    // Bought Web + Voice, billed as Web Chatbot: 0 voice minutes billed.
    await seedEntitled(c.clinicId, {
      planId: "chat-web",
      boughtPlanId: "web-voice",
      planStartedAt: WINDOW_START,
    });
    await seedChannels(c.clinicId, [{ channel: "voice", liveAt: LIVE }]);
    await setDirectLine(c.clinicId, LINE);
    await withTenant({ clinicId: c.clinicId, actor }, (tx) =>
      setOverageMode(tx.db, c.clinicId, "hard_cap"),
    );
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "voice", now: NOW, actor }),
    ).toEqual({
      decision: "answer",
    });
  });

  test("voiceAnswerDecision tells ops when a refused call has no direct line, and never for an unknown clinic (R25)", async () => {
    const withLine = await seedClinic("gate-voice-line");
    await makeProduction(withLine.clinicId);
    await setDirectLine(withLine.clinicId, LINE);
    expect(await voiceAnswerDecision(withLine.clinicId, NOW)).toEqual({
      decision: "pass_through",
      reason: "not_active",
      fallback: "direct_line",
      directLine: LINE,
    });
    expect(await opsAlertsFor(withLine.clinicId)).toEqual([]);

    const noLine = await seedClinic("gate-voice-noline");
    await makeProduction(noLine.clinicId);
    expect(await voiceAnswerDecision(noLine.clinicId, NOW)).toMatchObject({
      decision: "pass_through",
      directLine: null,
    });
    expect(await opsAlertsFor(noLine.clinicId)).toEqual([{ code: "not_active" }]);

    const unknown = "33333333-3333-4333-8333-333333333333";
    expect(await voiceAnswerDecision(unknown, NOW)).toMatchObject({ reason: "not_active" });
    expect(await opsAlertsFor(unknown)).toEqual([]);

    // An answered call raises nothing.
    const fine = await seedClinic("gate-voice-fine");
    expect(await voiceAnswerDecision(fine.clinicId, NOW)).toEqual({ decision: "answer" });
    expect(await opsAlertsFor(fine.clinicId)).toEqual([]);
  });
});

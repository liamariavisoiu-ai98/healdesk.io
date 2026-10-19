import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  assistantFallbackRefused,
  assistantMayAnswer,
  coverageModeOf,
  patientDataRefused,
  decideAnswer,
  servicesEnded,
  voiceAnswerDecision,
  type AnswerFacts,
  type PassThroughReason,
} from "@/lib/billing/answering";
import { unsafeDb } from "@/db";
import { setOverageMode } from "@/lib/billing/entitlements";
import { readPlatformCompliance } from "@/lib/compliance/platform";
import { COVERAGE_VENDORS, NO_LAPSES, vendorLapses } from "@/lib/compliance/vendor-coverage";
import { identifierRef } from "@/lib/identifier-ref";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";
import { attestPlatform, withdrawPlatform } from "./setup/platform";

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
    agreementCovers: true,
    lapsedVendors: NO_LAPSES,
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
    // 0. The agreement (BAA 1.3.0 clause 17: ending it ends the Services).
    ["no agreement on a production clinic", facts({ agreement: "none" }), "no_agreement"],
    [
      "no agreement on synthetic data",
      facts({ agreement: "none", isSynthetic: true, billing: null, channelRow: null }),
      "answer",
    ],
    [
      "a terminated agreement, even on synthetic data",
      facts({ agreement: "ended", isSynthetic: true, billing: null, channelRow: null }),
      "no_agreement",
    ],
    [
      "the agreement before billing",
      facts({ agreement: "ended", billing: { status: "suspended" } }),
      "no_agreement",
    ],
    // ...and its kind still covering the practice (app_agreement_kind_sufficient).
    [
      "an agreement whose kind no longer covers a production clinic (a DPA practice now covered)",
      facts({ agreementCovers: false }),
      "agreement_insufficient",
    ],
    [
      "the kind before billing",
      facts({ agreementCovers: false, billing: { status: "suspended" } }),
      "agreement_insufficient",
    ],
    [
      "the kind does not matter on synthetic data",
      facts({ agreementCovers: false, isSynthetic: true, billing: null, channelRow: null }),
      "answer",
    ],
    [
      "no agreement still says so before the kind",
      facts({ agreement: "none", agreementCovers: false }),
      "no_agreement",
    ],
    // 0b. The vendors' agreements (platform_compliance; the owner, 19 October 2026).
    [
      "the host's agreement not in force (AWS or the database host)",
      facts({ lapsedVendors: { host: ["aws"], assistant: [] } }),
      "host_agreement_lapsed",
    ],
    [
      "the assistant's own vendor's agreement not in force (the model provider; Retell on voice)",
      facts({ lapsedVendors: { host: [], assistant: ["retell"] } }),
      "vendor_agreement_lapsed",
    ],
    [
      "the host before the assistant's vendor",
      facts({ lapsedVendors: { host: ["database_host"], assistant: ["anthropic"] } }),
      "host_agreement_lapsed",
    ],
    [
      "the practice's own agreement before the vendors'",
      facts({ agreementCovers: false, lapsedVendors: { host: ["aws"], assistant: [] } }),
      "agreement_insufficient",
    ],
    [
      "the vendors before billing",
      facts({ lapsedVendors: { host: [], assistant: ["anthropic"] }, billing: { status: "suspended" } }),
      "vendor_agreement_lapsed",
    ],
    [
      "the vendors do not matter on synthetic data",
      facts({
        lapsedVendors: { host: ["aws", "database_host"], assistant: ["anthropic", "retell"] },
        isSynthetic: true,
        billing: null,
        channelRow: null,
      }),
      "answer",
    ],
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

  test("an agreement that no longer covers the practice still goes to its direct line, but never to the assistant", () => {
    // Still a customer who has to sign again: not an ended practice, so a
    // call with a direct line is put through (lib/voice/retell.ts)...
    expect(servicesEnded("agreement_insufficient")).toBe(false);
    expect(decideAnswer(facts({ agreementCovers: false }))).toEqual({
      decision: "pass_through",
      reason: "agreement_insufficient",
      fallback: "direct_line",
      directLine: LINE,
    });
    // ...and with none it is closed, never answered by the safe script, and
    // the website's contact form keeps nothing.
    expect(patientDataRefused("agreement_insufficient")).toBe(true);
    const fallsBack: PassThroughReason[] = [
      "unpaid",
      "not_active",
      "suspended",
      "not_purchased",
      "channel_not_live",
      "channel_off",
      "ai_paused",
      "outside_coverage",
      "allowance_cap",
    ];
    for (const reason of fallsBack) expect(patientDataRefused(reason), reason).toBe(false);
    for (const reason of ["no_agreement", "canceled", "cancel_before_start"] as const) {
      expect(servicesEnded(reason), reason).toBe(true);
      expect(patientDataRefused(reason), reason).toBe(true);
    }
  });

  test("a lapsed vendor's agreement: the host's keeps nothing, the assistant's only stops AYA", () => {
    // The host's: nothing new is kept, so the contact form takes nothing and
    // a call with no direct line is closed and not recorded.
    expect(patientDataRefused("host_agreement_lapsed")).toBe(true);
    expect(assistantFallbackRefused("host_agreement_lapsed")).toBe(true);
    // The model provider's or Retell's: no AYA, not even as the safe script,
    // but the contact form still takes messages, as the host covers them.
    expect(patientDataRefused("vendor_agreement_lapsed")).toBe(false);
    expect(assistantFallbackRefused("vendor_agreement_lapsed")).toBe(true);
    expect(servicesEnded("host_agreement_lapsed")).toBe(false);
    expect(servicesEnded("vendor_agreement_lapsed")).toBe(false);
    // Like every refusal, a call with a direct line goes to it.
    expect(decideAnswer(facts({ lapsedVendors: { host: [], assistant: ["anthropic"] } }))).toEqual({
      decision: "pass_through",
      reason: "vendor_agreement_lapsed",
      fallback: "direct_line",
      directLine: LINE,
    });
    for (const reason of ["unpaid", "suspended", "ai_paused", "allowance_cap"] as const) {
      expect(assistantFallbackRefused(reason), reason).toBe(false);
    }
  });
});

describe("vendorLapses: which vendors a channel's path needs", () => {
  const status = (attested: readonly string[]) =>
    Object.fromEntries(
      ["anthropic", "database_host", "aws", "retell", "launch_promises", "runtime_web", "runtime_meta", "runtime_voice", "voice_pass_through"].map((s) => [
        s,
        { subject: s, attested: attested.includes(s), lapsed: false, latest: null },
      ]),
    ) as unknown as Parameters<typeof vendorLapses>[0];

  test("the host and the model provider on every channel, Retell on phone only, Meta never", () => {
    const none = status([]);
    expect(vendorLapses(none, "voice")).toEqual({ host: ["aws", "database_host"], assistant: ["anthropic", "retell"] });
    expect(vendorLapses(none, "web")).toEqual({ host: ["aws", "database_host"], assistant: ["anthropic"] });
    expect(vendorLapses(none, "meta")).toEqual({ host: ["aws", "database_host"], assistant: ["anthropic"] });
    const all = status(COVERAGE_VENDORS);
    for (const channel of ["voice", "web", "meta"] as const) {
      expect(vendorLapses(all, channel)).toEqual(NO_LAPSES);
    }
    // Retell's lapse is phone's alone; the readiness flags are not vendors.
    const noRetell = status(["anthropic", "aws", "database_host"]);
    expect(vendorLapses(noRetell, "voice").assistant).toEqual(["retell"]);
    expect(vendorLapses(noRetell, "web")).toEqual(NO_LAPSES);
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

/** Live under an agreement in effect, as go-live leaves a clinic. */
async function makeProduction(clinicId: string): Promise<void> {
  await bindAgreementInEffect(clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() where id = $1`,
    [clinicId],
  );
}

/**
 * A location of the billing clinic's practice: in its organisation, pointing
 * at it. The gate follows a pointer only inside the practice.
 */
async function makeLocation(locationId: string, billingClinicId: string): Promise<void> {
  await getMigratorPool().query(
    `update clinics
        set billing_clinic_id = $2,
            organization_id = (select organization_id from clinics where id = $2)
      where id = $1`,
    [locationId, billingClinicId],
  );
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
    // Every vendor's agreement in force, as a launched platform holds them;
    // the vendors' own test withdraws and restores them.
    await attestPlatform(COVERAGE_VENDORS);
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

  test("a production clinic whose DPA no longer covers it refuses with agreement_insufficient, as the database does", async () => {
    const c = await seedClinic("gate-kind");
    await makeProduction(c.clinicId);
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await seedChannels(c.clinicId, [{ channel: "voice", liveAt: LIVE }]);
    await setDirectLine(c.clinicId, LINE);
    // A DPA practice of a regime that is HIPAA once it is a covered entity.
    await getMigratorPool().query(
      `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false
        where id = $1`,
      [c.clinicId],
    );
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "voice", now: NOW, actor }),
    ).toEqual({ decision: "answer" });

    // It tells us it now bills insurance: covered, so the DPA no longer covers it.
    await getMigratorPool().query(`update clinics set is_covered_entity = true where id = $1`, [
      c.clinicId,
    ]);
    const { rows } = await getMigratorPool().query<{ accepts: boolean }>(
      `select app_clinic_accepts_phi($1) as accepts`,
      [c.clinicId],
    );
    expect(rows[0]!.accepts).toBe(false);
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "voice", now: NOW, actor }),
    ).toEqual({
      decision: "pass_through",
      reason: "agreement_insufficient",
      fallback: "direct_line",
      directLine: LINE,
    });
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
    await seedEntitled(c.clinicId, { planId: "webchat-1000" });
    expect(
      await assistantMayAnswer({ clinicId: c.clinicId, channel: "web", now: NOW, actor }),
    ).toEqual({
      decision: "answer",
    });
    // ...but billing still applies: AYA Web Chat did not buy voice.
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
    await seedEntitled(c.clinicId, { planId: "webchat-1000", planStartedAt: WINDOW_START });
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
    // Bought Voice + Web Chat, billed as AYA Web Chat: 0 voice minutes billed.
    await seedEntitled(c.clinicId, {
      planId: "webchat-1000",
      boughtPlanId: "voice-webchat-1000-1000",
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

  test("a vendor's agreement, read from platform_compliance: withdrawn, expired or never recorded stops AYA where it serves, and a renewal resumes", async () => {
    try {
      const c = await seedClinic("gate-vendors");
      await makeProduction(c.clinicId);
      await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
      await seedChannels(c.clinicId, [
        { channel: "voice", liveAt: LIVE },
        { channel: "web", liveAt: LIVE },
      ]);
      await setDirectLine(c.clinicId, LINE);
      const ask = (channel: "voice" | "web") =>
        assistantMayAnswer({ clinicId: c.clinicId, channel, now: NOW, actor });
      const refused = (reason: string, channel: "voice" | "web") => ({
        decision: "pass_through",
        reason,
        fallback: channel === "voice" ? "direct_line" : "contact_form",
        directLine: channel === "voice" ? LINE : null,
      });

      expect(await ask("voice")).toEqual({ decision: "answer" });
      expect(await ask("web")).toEqual({ decision: "answer" });

      // Retell withdrawn: phone stops, website chat answers.
      await withdrawPlatform(["retell"]);
      expect(await ask("voice")).toEqual(refused("vendor_agreement_lapsed", "voice"));
      expect(await ask("web")).toEqual({ decision: "answer" });
      await attestPlatform(["retell"]);
      expect(await ask("voice")).toEqual({ decision: "answer" });

      // The model provider withdrawn: every channel stops.
      await withdrawPlatform(["anthropic"]);
      expect(await ask("voice")).toEqual(refused("vendor_agreement_lapsed", "voice"));
      expect(await ask("web")).toEqual(refused("vendor_agreement_lapsed", "web"));
      await attestPlatform(["anthropic"]);

      // AWS past a recorded expiry, with no renewal: the host, everywhere.
      await attestPlatform(["aws"], { effectiveOn: "2026-09-01", expiresOn: "2026-10-14" });
      expect((await readPlatformCompliance(unsafeDb, NOW)).aws.lapsed).toBe(true);
      expect(await ask("voice")).toEqual(refused("host_agreement_lapsed", "voice"));
      expect(await ask("web")).toEqual(refused("host_agreement_lapsed", "web"));
      // On its last day it still counts.
      await attestPlatform(["aws"], { effectiveOn: "2026-09-01", expiresOn: "2026-10-15" });
      expect(await ask("web")).toEqual({ decision: "answer" });

      // No record at all is no coverage.
      await getMigratorPool().query(`delete from platform_compliance where subject = 'database_host'`);
      expect(await ask("web")).toEqual(refused("host_agreement_lapsed", "web"));

      // Restored, and answering again.
      await attestPlatform(COVERAGE_VENDORS);
      expect(await ask("web")).toEqual({ decision: "answer" });
    } finally {
      // Every vendor in force for whatever runs after, whatever happened above.
      await attestPlatform(COVERAGE_VENDORS);
    }
  });
});

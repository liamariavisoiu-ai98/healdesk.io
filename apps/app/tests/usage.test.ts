import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { setOverageMode } from "@/lib/billing/entitlements";
import {
  overageBlockCentsFor,
  overageChargeCentsFor,
  recordUsage,
  usageSnapshot,
  type RecordUsageInput,
  type RecordUsageResult,
} from "@/lib/billing/usage";
import { touchChatThread } from "@/lib/chat/threads";
import { identifierRef } from "@/lib/identifier-ref";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * Counting usage (BD5, BD6, R18 to R20; maps2/usage-gate.md §10): one ledger
 * row per call or conversation against the BILLING clinic's pooled
 * allowance, the counter beside it moved only by a real insert, under the
 * entitlements row lock; and the chat thread that decides which conversation
 * a message belongs to.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "usage-test" } as const;

const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const WINDOW_END = new Date("2026-11-01T00:00:00Z");
const IN_WINDOW = new Date("2026-10-15T15:00:00Z");

function callRef(clinicId: string, callId = randomUUID()): string {
  return identifierRef("call", clinicId, callId);
}

function voice(
  clinicId: string,
  minutes: number,
  extra: Partial<RecordUsageInput> = {},
): RecordUsageInput {
  return {
    locationClinicId: clinicId,
    meter: "voice_minutes",
    quantity: minutes,
    source: "voice_call",
    sourceRef: callRef(clinicId),
    occurredAt: IN_WINDOW,
    actor,
    ...extra,
  };
}

async function counters(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{ voice: string; chat: number }>(
      `select used_voice_minutes as voice, used_chat_conversations as chat from entitlements where clinic_id = $1`,
      [clinicId],
    );
    return { voice: Number(rows[0]!.voice), chat: rows[0]!.chat };
  });
}

async function ledger(clinicId: string) {
  return inTenant(clinicId, async (c) => {
    const { rows } = await c.query<{
      clinic_id: string;
      location_clinic_id: string;
      meter: string;
      quantity: number;
      window_start: Date | null;
      included: number;
      used_before: number;
      over_allowance: number;
      source_ref: string;
    }>(
      `select clinic_id, location_clinic_id, meter, quantity, window_start, included, used_before, over_allowance, source_ref
         from usage_events order by used_before, created_at`,
    );
    return rows;
  });
}

async function setUsed(clinicId: string, voice: number, chat = 0): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `update entitlements set used_voice_minutes = $2, used_chat_conversations = $3 where clinic_id = $1`,
      [clinicId, voice, chat],
    ),
  );
}

async function hardCap(clinicId: string): Promise<void> {
  await withTenant({ clinicId, actor }, (tx) => setOverageMode(tx.db, clinicId, "hard_cap"));
}

describe("usageSnapshot (pure)", () => {
  const row = {
    usedVoiceMinutes: "1200",
    usedChatConversations: 100,
    includedVoiceMinutes: 1_000,
    includedChatConversations: 0,
    boughtPlanId: "web-voice" as string | null,
    planCode: "voice",
    locations: 1,
    overageMode: "allow" as "allow" | "hard_cap",
    currentPeriodStart: WINDOW_START as Date | null,
    currentPeriodEnd: WINDOW_END as Date | null,
  };

  test("both meters against effectiveIncluded, with the overage at the bought package's rate", () => {
    expect(usageSnapshot(row, IN_WINDOW)).toEqual([
      {
        meter: "voice_minutes",
        used: 1_200,
        included: 1_000,
        remaining: 0,
        overUnits: 200,
        // Two started blocks of 100 at the bought Web + Voice package's $80 a block.
        overageCents: 2 * 8_000,
        percent: 120,
        windowStart: WINDOW_START.toISOString(),
        windowEnd: WINDOW_END.toISOString(),
        isWindowOpen: true,
      },
      {
        // Billed as Voice, bought Web + Voice: chat is measured against the
        // bought package's 1,000 conversations, never against 0 (BD5).
        meter: "chat_conversations",
        used: 100,
        included: 1_000,
        remaining: 900,
        overUnits: 0,
        overageCents: 0,
        percent: 10,
        windowStart: WINDOW_START.toISOString(),
        windowEnd: WINDOW_END.toISOString(),
        isWindowOpen: true,
      },
    ]);
  });

  test("overage in dollars is started blocks of 100 at the block price, never units times the rate", () => {
    const voiceAt = (usedVoiceMinutes: string) =>
      usageSnapshot({ ...row, usedVoiceMinutes }, IN_WINDOW)[0]!;
    expect(voiceAt("1000")).toMatchObject({ overUnits: 0, overageCents: 0 });
    expect(voiceAt("1001")).toMatchObject({ overUnits: 1, overageCents: 8_000 });
    expect(voiceAt("1100")).toMatchObject({ overUnits: 100, overageCents: 8_000 });
    expect(voiceAt("1101")).toMatchObject({ overUnits: 101, overageCents: 16_000 });
    // $240 for 250 minutes, where per minute it would have read $200.
    expect(voiceAt("1250")).toMatchObject({ overUnits: 250, overageCents: 24_000 });

    // Chat on a single-channel chat package is $40 a block of 100 conversations.
    const [, chat] = usageSnapshot(
      {
        ...row,
        boughtPlanId: "chat-web",
        planCode: "chat-web",
        includedVoiceMinutes: 0,
        includedChatConversations: 1_000,
        usedChatConversations: 1_101,
      },
      IN_WINDOW,
    );
    expect(chat).toMatchObject({ overUnits: 101, overageCents: 8_000 });
  });

  test("the block price a meter quotes is the bought package's, and a meter it lacks has none", () => {
    const webVoice = { boughtPlanId: "web-voice" as string | null, planCode: "voice" };
    expect(overageBlockCentsFor(webVoice, "voice_minutes")).toBe(8_000);
    expect(overageBlockCentsFor(webVoice, "chat_conversations")).toBe(3_000);
    const chatWeb = { boughtPlanId: "chat-web" as string | null, planCode: "chat-web" };
    expect(overageBlockCentsFor(chatWeb, "chat_conversations")).toBe(4_000);
    expect(overageBlockCentsFor(chatWeb, "voice_minutes")).toBe(0);
    // A legacy row reads its billed package; a package that left the catalog bills nothing.
    expect(overageBlockCentsFor({ boughtPlanId: null, planCode: "voice" }, "voice_minutes")).toBe(
      8_000,
    );
    const retired = { boughtPlanId: null, planCode: "chat-voice" };
    expect(overageBlockCentsFor(retired, "voice_minutes")).toBe(0);
    expect(overageChargeCentsFor(retired, "voice_minutes", 150)).toBe(0);
    expect(overageChargeCentsFor(chatWeb, "voice_minutes", 0)).toBe(0);
    expect(overageChargeCentsFor(webVoice, "chat_conversations", 250)).toBe(9_000);
  });

  test("no overage in dollars under Stop and fall back, a meter not sold has no allowance, and no window before the start", () => {
    const [capped] = usageSnapshot({ ...row, overageMode: "hard_cap" }, IN_WINDOW);
    expect(capped).toMatchObject({ overUnits: 200, overageCents: 0 });
    const [, chat] = usageSnapshot({ ...row, boughtPlanId: "voice" }, IN_WINDOW);
    expect(chat).toMatchObject({ included: 0, overUnits: 0, overageCents: 0, percent: null });
    const [notStarted] = usageSnapshot(
      { ...row, currentPeriodStart: null, currentPeriodEnd: null },
      IN_WINDOW,
    );
    expect(notStarted).toMatchObject({ windowStart: null, windowEnd: null, isWindowOpen: false });
    expect(usageSnapshot(row, WINDOW_END)[0]!.isWindowOpen).toBe(false);
  });
});

describe("recordUsage refuses what must never reach the ledger", () => {
  const clinicId = "11111111-1111-4111-8111-111111111111";

  test("a vendor id instead of a reference, a meter the source does not count, a fraction", async () => {
    await expect(recordUsage(voice(clinicId, 3, { sourceRef: "call_abc123" }))).rejects.toThrow(
      /identifierRef/,
    );
    await expect(recordUsage(voice(clinicId, 3, { meter: "chat_conversations" }))).rejects.toThrow(
      /voice_minutes/,
    );
    await expect(recordUsage(voice(clinicId, 2.5))).rejects.toThrow(/whole number/);
  });

  test("a call too short to bill records nothing", async () => {
    expect(await recordUsage(voice(clinicId, 0))).toEqual({
      recorded: false,
      reason: "zero_quantity",
    });
  });
});

describeDb("recordUsage against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("counts a call against the open window: used before, the allowance, nothing over", async () => {
    const c = await seedClinic("usage-basic");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    const result = await recordUsage(voice(c.clinicId, 5));
    expect(result).toMatchObject({
      recorded: true,
      billingClinicId: c.clinicId,
      windowStart: WINDOW_START,
      included: 1_000,
      usedBefore: 0,
      usedAfter: 5,
      overAllowance: 0,
      crossed: [],
    });
    expect(await counters(c.clinicId)).toEqual({ voice: 5, chat: 0 });
    const rows = await ledger(c.clinicId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      meter: "voice_minutes",
      quantity: 5,
      included: 1_000,
      used_before: 0,
      over_allowance: 0,
    });
    expect(rows[0]!.source_ref).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("two calls ending together are counted one after the other, exactly", async () => {
    const c = await seedClinic("usage-concurrent");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await setUsed(c.clinicId, 995);
    // Started together, the two recorders do not reliably overlap: the pool
    // can hand the first a warm connection and let it finish before the
    // second has one, and then an unlocked read would pass too. So another
    // transaction holds the row lock until both recorders are queued behind
    // it, one on that transaction and one on the row's tuple lock, and only
    // then lets go: both are inside their transactions at once, and only the
    // row lock decides which reads the other's count.
    const holder = await getMigratorPool().connect();
    let recorders: Promise<RecordUsageResult[]> | null = null;
    try {
      await holder.query("begin");
      await holder.query(`select set_config('app.clinic_id', $1, true)`, [c.clinicId]);
      await holder.query(`select 1 from entitlements where clinic_id = $1 for update`, [
        c.clinicId,
      ]);
      const { rows: held } = await holder.query<{ xid: string }>(
        `select (pg_current_xact_id()::text::bigint & 4294967295)::text as xid`,
      );
      recorders = Promise.all([
        recordUsage(voice(c.clinicId, 3)),
        recordUsage(voice(c.clinicId, 4)),
      ]);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows: waiting } = await getMigratorPool().query<{ n: number }>(
          `select count(*)::int as n from pg_locks
            where not granted
              and ((locktype = 'transactionid' and transactionid::text = $1)
                or (locktype = 'tuple'
                    and database = (select oid from pg_database where datname = current_database())
                    and relation = 'entitlements'::regclass))`,
          [held[0]!.xid],
        );
        if (waiting[0]!.n >= 2) break;
        if (Date.now() > deadline) throw new Error("the recorders never queued on the row lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await holder.query("commit");
    } catch (error) {
      await holder.query("rollback");
      await recorders?.catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    const [a, b] = await recorders;
    expect(a!.recorded && b!.recorded).toBe(true);
    expect(await counters(c.clinicId)).toEqual({ voice: 1_002, chat: 0 });
    // The lock serialised them: the second read the first's increment, so
    // the used_before values have no gap and the overage is counted once.
    const rows = await ledger(c.clinicId);
    expect(rows.map((r) => r.used_before)).toEqual(
      rows[0]!.quantity === 3 ? [995, 998] : [995, 999],
    );
    expect(rows.reduce((sum, r) => sum + r.over_allowance, 0)).toBe(2);
  });

  test("the same call twice, one after the other or at once, is one row and one count", async () => {
    const c = await seedClinic("usage-duplicate");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    const ref = callRef(c.clinicId);
    expect(await recordUsage(voice(c.clinicId, 7, { sourceRef: ref }))).toMatchObject({
      recorded: true,
    });
    expect(await recordUsage(voice(c.clinicId, 7, { sourceRef: ref }))).toEqual({
      recorded: false,
      reason: "duplicate",
    });

    const raced = callRef(c.clinicId);
    const results = await Promise.all([
      recordUsage(voice(c.clinicId, 2, { sourceRef: raced })),
      recordUsage(voice(c.clinicId, 2, { sourceRef: raced })),
    ]);
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect(results.filter((r) => !r.recorded)).toEqual([{ recorded: false, reason: "duplicate" }]);
    expect(await counters(c.clinicId)).toEqual({ voice: 9, chat: 0 });
    expect(await ledger(c.clinicId)).toHaveLength(2);
  });

  test("a clinic with no entitlements row records nothing and does not throw", async () => {
    const c = await seedClinic("usage-none");
    expect(await recordUsage(voice(c.clinicId, 5))).toEqual({
      recorded: false,
      reason: "no_entitlements",
    });
    expect(await ledger(c.clinicId)).toHaveLength(0);
  });

  test("a channel bought but not yet billed counts against the bought allowance, not 0 (BD5)", async () => {
    const c = await seedClinic("usage-bd5");
    // Bought Web + Voice, billed as AYA Web Chat while the phone was set up.
    await seedEntitled(c.clinicId, {
      planId: "chat-web",
      boughtPlanId: "web-voice",
      planStartedAt: WINDOW_START,
    });
    expect(await recordUsage(voice(c.clinicId, 6))).toMatchObject({
      recorded: true,
      included: 1_000,
      overAllowance: 0,
    });
  });

  test("usage before the first window is recorded with no window, never over, and moves no counter (BD6)", async () => {
    const c = await seedClinic("usage-bd6");
    await seedEntitled(c.clinicId, {});
    expect(await recordUsage(voice(c.clinicId, 1_500))).toMatchObject({
      recorded: true,
      windowStart: null,
      overAllowance: 0,
      crossed: [],
    });
    expect(await counters(c.clinicId)).toEqual({ voice: 0, chat: 0 });
    expect((await ledger(c.clinicId))[0]).toMatchObject({ window_start: null, over_allowance: 0 });
  });

  test("an expired monthly window counts nothing against the old allowance (R20)", async () => {
    const c = await seedClinic("usage-r20");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await setUsed(c.clinicId, 1_000);
    // The period ended; the renewal's invoice.paid has not moved the window.
    expect(await recordUsage(voice(c.clinicId, 30, { occurredAt: WINDOW_END }))).toMatchObject({
      recorded: true,
      windowStart: null,
      overAllowance: 0,
    });
    expect(await counters(c.clinicId)).toEqual({ voice: 1_000, chat: 0 });
  });

  test("Keep going bills only the part of a call past the allowance, and reports the crossings", async () => {
    const c = await seedClinic("usage-allow");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await setUsed(c.clinicId, 790);
    expect(await recordUsage(voice(c.clinicId, 20))).toMatchObject({
      overAllowance: 0,
      crossed: [80],
    });
    expect(await recordUsage(voice(c.clinicId, 230))).toMatchObject({
      usedBefore: 810,
      usedAfter: 1_040,
      overAllowance: 40,
      crossed: [100],
    });
    expect(await recordUsage(voice(c.clinicId, 10))).toMatchObject({
      overAllowance: 10,
      crossed: [],
    });
  });

  test("Stop and fall back never bills overage, still counts, and queues the fallback notice once (R19, BD21)", async () => {
    const c = await seedClinic("usage-r19");
    await seedEntitled(c.clinicId, { planStartedAt: WINDOW_START });
    await hardCap(c.clinicId);
    await setUsed(c.clinicId, 990);
    // A call allowed just below the cap runs past it: counted, never billed.
    expect(await recordUsage(voice(c.clinicId, 40))).toMatchObject({
      recorded: true,
      usedAfter: 1_030,
      overAllowance: 0,
      crossed: [100],
    });
    expect(await recordUsage(voice(c.clinicId, 5))).toMatchObject({ overAllowance: 0 });
    expect(await counters(c.clinicId)).toEqual({ voice: 1_035, chat: 0 });
    const notices = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ kind: string; dedupe_key: string; payload: unknown }>(
        `select kind, dedupe_key, payload from billing_notices`,
      );
      return rows;
    });
    expect(notices).toEqual([
      {
        kind: "allowance_fallback",
        dedupe_key: `voice_minutes:${WINDOW_START.toISOString()}`,
        payload: { meter: "voice_minutes", included: 1_000, windowEndsOn: "2026-11-01" },
      },
    ]);
  });

  test("a location's usage is counted on its billing clinic's pooled allowance", async () => {
    const billing = await seedClinic("usage-billing");
    const location = await seedClinic("usage-location");
    await getMigratorPool().query(`update clinics set billing_clinic_id = $2 where id = $1`, [
      location.clinicId,
      billing.clinicId,
    ]);
    await seedEntitled(billing.clinicId, { planStartedAt: WINDOW_START, locations: 2 });
    const result = await recordUsage(voice(location.clinicId, 12));
    expect(result).toMatchObject({
      recorded: true,
      billingClinicId: billing.clinicId,
      included: 2_000,
    });
    expect(await counters(billing.clinicId)).toEqual({ voice: 12, chat: 0 });
    expect(await ledger(billing.clinicId)).toMatchObject([
      { clinic_id: billing.clinicId, location_clinic_id: location.clinicId, quantity: 12 },
    ]);
    // Nothing lands on the location's own tenant.
    expect(await ledger(location.clinicId)).toHaveLength(0);
  });

  test("an annual window that is due rolls before counting, from zero, with the roll in the history", async () => {
    const c = await seedClinic("usage-annual");
    await seedEntitled(c.clinicId, { interval: "year", planStartedAt: WINDOW_START });
    await setUsed(c.clinicId, 400);
    const result = await recordUsage(
      voice(c.clinicId, 9, { occurredAt: new Date("2026-11-03T10:00:00Z") }),
    );
    expect(result).toMatchObject({
      recorded: true,
      windowStart: new Date("2026-11-01T00:00:00Z"),
      usedBefore: 0,
      usedAfter: 9,
    });
    const notes = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{ reason: string }>(
        `select reason from billing_transitions where reason = 'allowance_rolled'`,
      );
      return rows;
    });
    expect(notes).toHaveLength(1);
  });

  test("a chat conversation is counted once however many messages it carries", async () => {
    const c = await seedClinic("usage-chat");
    await seedEntitled(c.clinicId, { planId: "chat-web", planStartedAt: WINDOW_START });
    const ref = identifierRef("chat_conversation", c.clinicId, randomUUID());
    const chat = (occurredAt: Date): RecordUsageInput => ({
      locationClinicId: c.clinicId,
      meter: "chat_conversations",
      quantity: 1,
      source: "web_chat",
      sourceRef: ref,
      occurredAt,
      actor,
    });
    expect(await recordUsage(chat(IN_WINDOW))).toMatchObject({ recorded: true, usedAfter: 1 });
    expect(await recordUsage(chat(new Date(IN_WINDOW.getTime() + 60_000)))).toEqual({
      recorded: false,
      reason: "duplicate",
    });
    expect(await counters(c.clinicId)).toEqual({ voice: 0, chat: 1 });
  });
});

describeDb("touchChatThread", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  const at = (iso: string) => new Date(iso);

  test("a conversation lasts until 24 quiet hours; a late message never starts one or moves the clock back", async () => {
    const c = await seedClinic("threads");
    const touch = (partyId: string, sentAt: Date, channel: "whatsapp" | "messenger" = "whatsapp") =>
      withTenant({ clinicId: c.clinicId, actor }, (tx) =>
        touchChatThread(tx, { channel, partyId, sentAt }),
      );

    const first = await touch("15550100123", at("2026-10-06T09:00:00Z"));
    expect(first.startsNew).toBe(true);
    const same = await touch("15550100123", at("2026-10-07T08:59:00Z"));
    expect(same).toEqual({ conversationId: first.conversationId, startsNew: false });
    // Measured from the newest message, so the conversation runs on.
    const stillSame = await touch("15550100123", at("2026-10-08T08:00:00Z"));
    expect(stillSame).toEqual({ conversationId: first.conversationId, startsNew: false });
    // A redelivery from days ago: same conversation, clock unmoved.
    const late = await touch("15550100123", at("2026-10-05T00:00:00Z"));
    expect(late).toEqual({ conversationId: first.conversationId, startsNew: false });

    const next = await touch("15550100123", at("2026-10-09T08:00:01Z"));
    expect(next.startsNew).toBe(true);
    expect(next.conversationId).not.toBe(first.conversationId);

    // Another person, or the same id on another channel, is another thread.
    expect((await touch("15550100999", at("2026-10-09T09:00:00Z"))).startsNew).toBe(true);
    expect((await touch("15550100123", at("2026-10-09T09:00:00Z"), "messenger")).startsNew).toBe(
      true,
    );

    const rows = await inTenant(c.clinicId, async (client) => {
      const { rows } = await client.query<{
        party_ref: string;
        conversations_count: number;
        last_inbound_at: Date;
      }>(
        `select party_ref, conversations_count, last_inbound_at from chat_threads where channel = 'whatsapp' order by conversations_count desc`,
      );
      return rows;
    });
    expect(rows[0]).toMatchObject({ conversations_count: 2 });
    expect(rows[0]!.last_inbound_at.toISOString()).toBe("2026-10-09T08:00:01.000Z");
    // The sender id, a phone number on WhatsApp, is never stored.
    for (const row of rows) {
      expect(row.party_ref).toMatch(/^v1:[0-9a-f]{64}$/);
      expect(row.party_ref).not.toContain("15550100");
    }
  });

  test("two messages from one person arriving together share one conversation", async () => {
    const c = await seedClinic("threads-race");
    const sentAt = at("2026-10-06T09:00:00Z");
    const [a, b] = await Promise.all(
      [0, 1].map(() =>
        withTenant({ clinicId: c.clinicId, actor }, (tx) =>
          touchChatThread(tx, { channel: "instagram", partyId: "igsid-1", sentAt }),
        ),
      ),
    );
    expect(a!.conversationId).toBe(b!.conversationId);
    expect([a!.startsNew, b!.startsNew].sort()).toEqual([false, true]);
  });
});

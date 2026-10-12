import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { __setMetaRuntimeForTests, POST } from "@/app/api/webhooks/meta/route";
import { setOverageMode } from "@/lib/billing/entitlements";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import type { FrontDoorResponder } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { bindAgreementInEffect, inTenant, seedClinic, seedEntitled } from "./setup/factories";

/**
 * The Meta webhook in front of the answer gate (BD24, R18): a redelivered
 * message is skipped entirely, a refused one is withheld with no model call
 * and no reply, and an allowed conversation is counted once, from the first
 * message the assistant may answer. And the crash: one message's failure is
 * logged with allowlisted keys and the batch carries on.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "test" } as const;
const APP_SECRET = "meta-app-secret-for-gate-tests";
const NOW = new Date("2026-10-15T15:00:00Z");
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const MINUTE = 60_000;

function post(body: unknown): Promise<Response> {
  const raw = JSON.stringify(body);
  return POST(
    new Request("http://app.test/api/webhooks/meta", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signMetaBody(raw, APP_SECRET),
      },
      body: raw,
    }),
  );
}

type Message = { sender: string; text: string; mid?: string; sentAt?: Date };

function batch(pageId: string, messages: Message[]) {
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        messaging: messages.map((m) => ({
          sender: { id: m.sender },
          recipient: { id: pageId },
          timestamp: (m.sentAt ?? new Date(NOW.getTime() - MINUTE)).getTime(),
          message: { mid: m.mid ?? `m-${randomUUID()}`, text: m.text },
        })),
      },
    ],
  };
}

describeDb("the Meta webhook and the answer gate", () => {
  const sent: Parameters<MetaSender>[0][] = [];
  const asked: string[] = [];
  let failSendTo: string | null = null;
  const sender: MetaSender = async (input) => {
    if (input.recipientId === failSendTo) throw new Error("Graph API 400");
    sent.push(input);
  };
  const responder: FrontDoorResponder = async (_system, text) => {
    asked.push(text);
    return "We're open weekdays 9 to 5; call the practice to book.";
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.META_APP_SECRET = APP_SECRET;
  }, 60_000);

  afterEach(() => {
    sent.length = 0;
    asked.length = 0;
    failSendTo = null;
    __setMetaRuntimeForTests(undefined, undefined);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  /** A live production clinic on AYA Meta Chat, its plan started on 1 October, the Meta channel live. */
  async function liveClinic(label: string, pageId: string) {
    const c = await seedClinic(label);
    await bindAgreementInEffect(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [c.clinicId],
    );
    await seedEntitled(c.clinicId, {
      planId: "chat-meta",
      planStartedAt: WINDOW_START,
      channelRows: [{ channel: "meta", liveAt: WINDOW_START }],
    });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 }],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-page-token-0123456789",
      });
      await setMetaFrontDoor(tx, true);
    });
    __setMetaRuntimeForTests(responder, sender, undefined, NOW);
    return c;
  }

  async function stored(clinicId: string) {
    return inTenant(clinicId, async (client) => ({
      usage: (
        await client.query<{ source: string; source_ref: string; quantity: number }>(
          `select source, source_ref, quantity from usage_events order by created_at`,
        )
      ).rows,
      handled: (
        await client.query<{ message_ref: string }>(`select message_ref from meta_inbound_messages`)
      ).rows,
      threads: (
        await client.query<{ party_ref: string; conversations_count: number }>(
          `select party_ref, conversations_count from chat_threads`,
        )
      ).rows,
      audit: (
        await client.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where resource_type = 'meta_front_door_reply' order by occurred_at`,
        )
      ).rows.map((r) => r.metadata),
      fallbacks: (
        await client.query(
          `select dedupe_key from billing_notices where kind = 'allowance_fallback'`,
        )
      ).rows,
    }));
  }

  async function pause(clinicId: string, on: boolean) {
    await inTenant(clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_by_label) values ($1, $2, $3)
         on conflict (clinic_id) do update set ai_paused_at = excluded.ai_paused_at, ai_paused_by_label = excluded.ai_paused_by_label`,
        [clinicId, on ? new Date(NOW.getTime() - 60 * MINUTE) : null, on ? "owner" : null],
      ),
    );
  }

  test("a redelivered batch is skipped entirely: one answer, one count, and only references stored", async () => {
    const c = await liveClinic("gate-redelivery", "310000000000001");
    const body = batch("310000000000001", [
      { sender: "psid-1", text: "what are your hours?", mid: "mid.redelivered" },
    ]);

    expect(await (await post(body)).json()).toEqual({ received: true, answered: 1, skipped: 0 });
    expect(await (await post(body)).json()).toEqual({ received: true, answered: 0, skipped: 1 });
    expect(sent).toHaveLength(1);
    expect(asked).toHaveLength(1);

    const s = await stored(c.clinicId);
    expect(s.usage).toHaveLength(1);
    expect(s.usage[0]).toMatchObject({ source: "meta", quantity: 1 });
    expect(s.audit.map((a) => a.source)).toEqual(["model"]);
    // The message id, the sender id and the conversation are HMAC references.
    expect(s.handled).toHaveLength(1);
    for (const ref of [
      s.handled[0]!.message_ref,
      s.threads[0]!.party_ref,
      s.usage[0]!.source_ref,
    ]) {
      expect(ref).toMatch(/^v1:[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(s)).not.toMatch(/mid\.redelivered|psid-1|hours/);
  });

  test("withheld while paused: no model call, no reply, an audit row with the reason; after the resume the conversation counts once", async () => {
    const c = await liveClinic("gate-withheld", "310000000000002");
    await pause(c.clinicId, true);

    let res = await post(
      batch("310000000000002", [
        { sender: "psid-2", text: "hello?", sentAt: new Date(NOW.getTime() - 10 * MINUTE) },
      ]),
    );
    expect(await res.json()).toEqual({ received: true, answered: 0, skipped: 1 });
    expect(asked).toHaveLength(0);
    expect(sent).toHaveLength(0);
    let s = await stored(c.clinicId);
    expect(s.audit).toEqual([{ platform: "messenger", source: "withheld", reason: "ai_paused" }]);
    expect(s.usage).toHaveLength(0);

    // Resumed: the same conversation's next messages are answered, and the
    // conversation is counted once, from its first allowed message.
    await pause(c.clinicId, false);
    res = await post(
      batch("310000000000002", [
        { sender: "psid-2", text: "are you there?", sentAt: new Date(NOW.getTime() - 5 * MINUTE) },
      ]),
    );
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 0 });
    await post(
      batch("310000000000002", [
        { sender: "psid-2", text: "thanks", sentAt: new Date(NOW.getTime() - 2 * MINUTE) },
      ]),
    );
    expect(sent).toHaveLength(2);
    s = await stored(c.clinicId);
    expect(s.usage).toHaveLength(1);
    expect(s.threads).toEqual([expect.objectContaining({ conversations_count: 1 })]);
  });

  test("Stop and fall back: a capped conversation stays refused, an allowed one is never cut off, and the clinic is told once", async () => {
    const c = await liveClinic("gate-capped", "310000000000003");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      setOverageMode(tx.db, c.clinicId, "hard_cap"),
    );
    await inTenant(c.clinicId, (client) =>
      client.query(`update entitlements set used_chat_conversations = 999 where clinic_id = $1`, [
        c.clinicId,
      ]),
    );

    // The last conversation of the allowance is allowed and counted, which
    // reaches 100%: "Stop and fall back" engages.
    expect(
      await (await post(batch("310000000000003", [{ sender: "psid-allowed", text: "hi" }]))).json(),
    ).toMatchObject({ answered: 1 });
    let s = await stored(c.clinicId);
    expect(s.usage).toHaveLength(1);
    expect(s.fallbacks).toEqual([
      { dedupe_key: `chat_conversations:${WINDOW_START.toISOString()}` },
    ]);

    // A new conversation is refused, and so is its second message: it was
    // never counted, so the cap still applies to it.
    for (const text of ["hello", "hello again"]) {
      expect(
        await (await post(batch("310000000000003", [{ sender: "psid-capped", text }]))).json(),
      ).toEqual({
        received: true,
        answered: 0,
        skipped: 1,
      });
    }
    // The allowed conversation carries on past the cap.
    expect(
      await (
        await post(batch("310000000000003", [{ sender: "psid-allowed", text: "one more thing" }]))
      ).json(),
    ).toMatchObject({ answered: 1 });

    s = await stored(c.clinicId);
    expect(s.usage).toHaveLength(1);
    expect(s.audit.filter((a) => a.source === "withheld")).toEqual([
      { platform: "messenger", source: "withheld", reason: "allowance_cap" },
      { platform: "messenger", source: "withheld", reason: "allowance_cap" },
    ]);
    expect(s.fallbacks).toHaveLength(1);
    expect(sent.map((m) => m.recipientId)).toEqual(["psid-allowed", "psid-allowed"]);
  });

  test("a failing send is logged with allowlisted keys and the batch carries on with a 200 (the crash)", async () => {
    const c = await liveClinic("gate-crash", "310000000000004");
    failSendTo = "psid-broken";
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const res = await post(
      batch("310000000000004", [
        { sender: "psid-broken", text: "first" },
        { sender: "psid-fine", text: "second" },
      ]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, answered: 1, skipped: 1 });
    expect(sent.map((m) => m.recipientId)).toEqual(["psid-fine"]);
    const failure = lines.find((l) => l.includes("meta message not answered"));
    expect(failure).toBeDefined();
    expect(failure).toContain('"channel":"messenger"');
    expect(failure).toContain(c.clinicId);
    expect(failure).not.toContain("platform");
  });
});

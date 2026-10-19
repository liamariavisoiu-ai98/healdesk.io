import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/ops/notify", () => ({ notifyOps: async () => {}, notifyOpsOnce: async () => {} }));

import { forgetDirectLines, rememberedDirectLine } from "@/lib/voice/fallback-line";
import { RetellCallSession, TROUBLE_TRANSFER_LINE, type RetellOutbound } from "@/lib/voice/retell";
import { syncRetellFallbacks } from "@/lib/voice/retell-fallback-sync";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The voice fall-through against a real database (the rest is in
 * voice-fall-through.test.ts, without one): a call that starts normally
 * remembers its clinic's direct line, so the next call that cannot read the
 * database still reaches it; and the hourly sync reads the AYA number and
 * the direct line through its own queries. Retell is a fake fetch.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const AYA = "+15125550142";
const PUBLISHED = "+15125550100";
const DIRECT = "+15125550199";

async function withNumbers(label: string): Promise<string> {
  const { clinicId } = await seedClinic(label);
  const pool = getMigratorPool();
  await pool.query(`update clinics set assistant_number_e164 = $2, published_phone_e164 = $3 where id = $1`, [clinicId, AYA, PUBLISHED]);
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [clinicId, DIRECT],
    ),
  );
  return clinicId;
}

describeDb("the voice fall-through, with the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    forgetDirectLines();
  }, 180_000);
  afterAll(async () => {
    await closePools();
  });

  test("a call that starts normally remembers the line a later call without the database uses", async () => {
    const clinicId = await withNumbers("fall-memory");
    const first = new RetellCallSession(clinicId, "call_first", () => {}, { responder: null, ingest: async () => ({}) as never });
    await first.open();
    expect(rememberedDirectLine(clinicId)).toBe(DIRECT);

    const sent: RetellOutbound[] = [];
    const second = new RetellCallSession(clinicId, "call_second", (m) => sent.push(m), {
      responder: null,
      gate: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      callDetailsWaitMs: 20,
      ingest: async () => ({}) as never,
    });
    await second.open();
    // finish() is the hang-up: let the fall-through speak first.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await second.finish();
    expect(sent.filter((m) => m.response_type === "response")).toEqual([
      expect.objectContaining({ content: TROUBLE_TRANSFER_LINE, transfer_number: DIRECT }),
    ]);
  });

  test("a caller who spoke before the opening line went out hears the AI line first", async () => {
    const clinicId = await withNumbers("fall-opening");
    const sent: RetellOutbound[] = [];
    const session = new RetellCallSession(clinicId, "call_opening", (m) => sent.push(m), {
      responder: async () => JSON.stringify({ reply: "Happy to help." }),
      ingest: async () => ({}) as never,
    });
    await session.open();
    // Retell's transcript holds no word of the agent's: the opening was dropped.
    await session.handle(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "When are you open?" }] }));
    const said = sent.filter((m): m is Extract<RetellOutbound, { response_type: "response" }> => m.response_type === "response");
    const last = said[said.length - 1]!;
    expect(last.response_id).toBe(1);
    expect(last.content).toMatch(/^Hi, I'm an AI assistant/);
    await session.handle(
      JSON.stringify({ interaction_type: "response_required", response_id: 2, transcript: [{ role: "agent", content: last.content }, { role: "user", content: "Thanks" }] }),
    );
    const next = sent.filter((m) => m.response_type === "response").pop() as { content: string };
    expect(next.content).not.toMatch(/AI assistant/);
  });

  test("the hourly sync reads the AYA number and the direct line through its own queries", async () => {
    await truncateAll();
    await withNumbers("fall-sync");
    const patched: unknown[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patched.push(JSON.parse(String(init.body)));
        return Response.json({ phone_number: AYA, fallback_number: DIRECT });
      }
      expect(String(input)).toBe("https://api.retellai.com/get-phone-number/%2B15125550142");
      return Response.json({ phone_number: AYA, fallback_number: null });
    }) as typeof fetch;
    const result = await syncRetellFallbacks({ key: "key_test", fetch: fetcher });
    expect(result).toMatchObject({ status: "ok", clinics: 1, set: 1 });
    expect(patched).toEqual([{ fallback_number: DIRECT }]);
  });
});

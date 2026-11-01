import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";

import type { AssistantFacts } from "@/lib/assistant/facts";
import { buildAssistantPrompt, LIVE_TRANSFER } from "@/lib/assistant/prompt";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import type { DeliveryResult, DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { TRANSFER_LINE } from "@/lib/voice/retell";
import { createVoiceServer } from "@/voice/server";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, queuedNotices, seedClinic } from "./setup/factories";
import { attestPlatform } from "./setup/platform";

/**
 * Transfer live calls (the spec's "On lets the voice agent transfer a caller
 * to a real number during opening hours"; Settings › Alerts). With the switch
 * on and the practice open, a caller who asks for a person is put through to
 * the transfer number, or the direct line when it is empty, with the fixed
 * transfer line and no call-back alert. Closed, or with the switch off, she
 * takes their details for a call back as before. A transfer number that loops
 * back to us is never used. Synthetic clinics, a fake model, over a real
 * WebSocket on a local port; nothing reaches Retell or Anthropic.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SECRET = "test-retell-llm-secret-live-transfer-01";

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  async send(_target: DeliveryTarget, _message: OutgoingEmail): Promise<DeliveryResult> {
    return { status: "sent", messageId: `ses-${crypto.randomUUID()}` };
  }
}

/** Open every minute of every day: two ranges, so no minute of the clock is left out whenever the suite runs. */
const ALWAYS_OPEN = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } as Record<string, string[][]>;
for (const day of Object.keys(ALWAYS_OPEN)) ALWAYS_OPEN[day] = [["00:00", "12:00"], ["12:00", "00:00"]];
/** Shut every day of the week. */
const NEVER_OPEN = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };

describe("the prompt's transfer line", () => {
  const facts = (transferLine: string | null): AssistantFacts => ({
    clinicId: "c0ffee00-0000-4000-8000-000000000003",
    clinicName: "Glow Clinic",
    specialty: "med-spa",
    timeZone: "America/New_York",
    phone: "+14155550100",
    urgentPhone: null,
    vetReferralPhone: null,
    directLine: "+14155550101",
    transferLine,
    address: null,
    hours: [],
    openingHours: null,
    services: [],
    policies: [],
    quickAnswers: [],
    promotions: null,
    notes: null,
    escalationHours: null,
    neverSay: [],
    requirements: [],
    greeting: { phone: "Thanks for calling.", chat: "How can I help?" },
    tone: "warm",
    languages: ["en"],
    suggestAddOns: false,
    providerNames: [],
  });

  test("said on a call only while a transfer line is given, never in website chat", () => {
    expect(buildAssistantPrompt(facts("+14155550102"), "voice")).toContain(LIVE_TRANSFER);
    expect(buildAssistantPrompt(facts(null), "voice")).not.toContain(LIVE_TRANSFER);
    expect(buildAssistantPrompt(facts("+14155550102"), "web_chat")).not.toContain(LIVE_TRANSFER);
  });
});

describeDb("Transfer live calls on a call", () => {
  let port = 0;
  let server: ReturnType<typeof createVoiceServer>;
  const responder: AssistantResponder = async ({ messages }) => {
    const last = messages[messages.length - 1]!.content;
    return JSON.stringify(
      last.includes("person") ? { reply: "Of course. What's your first name and a good number?", handoff: true } : { reply: "We're open weekdays." },
    );
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    await attestPlatform(COVERAGE_VENDORS);
    server = createVoiceServer({ secret: SECRET, responder, transport: new FakeTransport(), realCalls: true });
    await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.server.address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await server.drain();
    await closePools();
  });

  async function clinicWith(slug: string, opts: { on: boolean; transfer: string | null; hours: object }): Promise<string> {
    const clinic = await seedClinic(slug);
    await getMigratorPool().query(`update clinics set opening_hours = $2::jsonb, timezone = 'America/New_York' where id = $1`, [
      clinic.clinicId,
      JSON.stringify(opts.hours),
    ]);
    await inTenant(clinic.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, direct_line_e164, transfer_live_calls, transfer_e164) values ($1, '+14155550161', $2, $3)
         on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164,
           transfer_live_calls = excluded.transfer_live_calls, transfer_e164 = excluded.transfer_e164`,
        [clinic.clinicId, opts.on, opts.transfer],
      ),
    );
    return clinic.clinicId;
  }

  /** One call: the opening line, then "Can I talk to a person?"; what the endpoint said back to it. */
  async function askForPerson(clinicId: string, callId: string): Promise<Record<string, unknown>[]> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/llm-websocket/${SECRET}/${clinicId}/${callId}`);
    const received: Record<string, unknown>[] = [];
    ws.on("message", (data) => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const finals = () => received.filter((m) => m.response_type === "response" && m.content_complete === true);
    const until = async (n: number) => {
      for (let i = 0; i < 200 && finals().length < n; i += 1) await new Promise((r) => setTimeout(r, 25));
    };
    await until(1);
    ws.send(JSON.stringify({ interaction_type: "call_details", call: { call_id: callId, from_number: "+14155550188", direction: "inbound" } }));
    ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "Can I talk to a person?" }] }));
    await until(2);
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await Promise.all([...server.sessions].map((s) => s.finish()));
    return received.filter((m) => m.response_type === "response" && m.response_id === 1);
  }

  test("on and open: put through to the transfer number with the fixed line, and no call-back alert", async () => {
    const clinicId = await clinicWith("live-transfer-open", { on: true, transfer: "+14155550162", hours: ALWAYS_OPEN });
    const said = await askForPerson(clinicId, "call_live_transfer_open");
    const last = said[said.length - 1]!;
    expect(last).toMatchObject({ transfer_number: "+14155550162", content_complete: true });
    expect(said.map((m) => m.content).join(" ")).toContain(TRANSFER_LINE);
    expect(said.map((m) => m.content).join(" ")).not.toContain("good number");
    expect(await queuedNotices(clinicId, ["handover"])).toEqual([]);
  }, 60_000);

  test("on and open with no transfer number: put through to the direct line", async () => {
    const clinicId = await clinicWith("live-transfer-direct", { on: true, transfer: null, hours: ALWAYS_OPEN });
    const said = await askForPerson(clinicId, "call_live_transfer_direct");
    expect(said[said.length - 1]).toMatchObject({ transfer_number: "+14155550161" });
  }, 60_000);

  test("on but closed: no transfer; she takes their details and the call-back alert is raised", async () => {
    const clinicId = await clinicWith("live-transfer-closed", { on: true, transfer: "+14155550163", hours: NEVER_OPEN });
    const said = await askForPerson(clinicId, "call_live_transfer_closed");
    expect(said.some((m) => "transfer_number" in m)).toBe(false);
    expect(said.map((m) => m.content).join(" ")).toContain("good number");
    expect(await queuedNotices(clinicId, ["handover"])).toHaveLength(1);
  }, 60_000);

  test("off: no transfer, whatever number is saved", async () => {
    const clinicId = await clinicWith("live-transfer-off", { on: false, transfer: "+14155550164", hours: ALWAYS_OPEN });
    const said = await askForPerson(clinicId, "call_live_transfer_off");
    expect(said.some((m) => "transfer_number" in m)).toBe(false);
  }, 60_000);

  test("a transfer number that is the clinic's own published number is never dialled", async () => {
    const clinicId = await clinicWith("live-transfer-loop", { on: true, transfer: "+14155550165", hours: ALWAYS_OPEN });
    await getMigratorPool().query(`update clinics set published_phone_e164 = '+14155550165' where id = $1`, [clinicId]);
    const said = await askForPerson(clinicId, "call_live_transfer_loop");
    expect(said.some((m) => m.transfer_number === "+14155550165")).toBe(false);
  }, 60_000);
});

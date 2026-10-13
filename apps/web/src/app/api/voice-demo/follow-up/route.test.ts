import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { verifyRetellSignature } from "@/lib/retell-signature";

import { POST } from "./route";

/**
 * The demo call's follow-up tool mails a stranger's words to our inbox, so it
 * must refuse anything Retell did not sign, and it must tell the agent the
 * truth about whether the team will be in touch: the prompt only lets AYA
 * promise a follow-up when this route says ok.
 */

const KEY = "key_test_webhook";
let call = 0;

function sign(body: string, at = Date.now()): string {
  const digest = createHmac("sha256", KEY).update(body + String(at)).digest("hex");
  return `v=${at},d=${digest}`;
}

function post(args: Record<string, unknown>, options: { signature?: string; toNumber?: string } = {}) {
  call += 1;
  const body = JSON.stringify({
    name: "request_follow_up",
    args,
    call: {
      call_id: `call_${call}`,
      call_type: options.toNumber ? "phone_call" : "web_call",
      to_number: options.toNumber,
      retell_llm_dynamic_variables: { practice_type: "Med Spas" },
    },
  });
  return POST(
    new Request("http://localhost/api/voice-demo/follow-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-retell-signature": options.signature ?? sign(body) },
      body,
    }),
  );
}

const sent: { body: Record<string, unknown> }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv("RETELL_WEBHOOK_KEY", KEY);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the signature", () => {
  test("accepts Retell's scheme and refuses a tampered body, a stale stamp and junk", () => {
    const body = '{"a":1}';
    expect(verifyRetellSignature(body, sign(body), KEY)).toBe(true);
    expect(verifyRetellSignature('{"a":2}', sign(body), KEY)).toBe(false);
    expect(verifyRetellSignature(body, sign(body, Date.now() - 6 * 60_000), KEY)).toBe(false);
    expect(verifyRetellSignature(body, "nonsense", KEY)).toBe(false);
    expect(verifyRetellSignature(body, null, KEY)).toBe(false);
  });

  test("an unsigned request is refused and nothing is mailed", async () => {
    const response = await post({ email: "sam@clinic.com", topic: "pricing" }, { signature: "v=1,d=00" });
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe("what the agent is told", () => {
  test("a valid request is mailed to the team, replying to the prospect", async () => {
    const response = await post({
      name: "Sam Rivera",
      clinic: "Radiance",
      email: "Sam@Clinic.com",
      topic: "sales_session",
      preferred_time: "Thursday morning",
      recommended_package: "AYA Voice + Web Chat",
      summary: "Two-chair med spa, Saturdays go to voicemail.",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ to: ["hello@healdesk.io"], reply_to: "sam@clinic.com" });
    expect(String(sent[0]!.body.subject)).toContain("session with the team");
    expect(String(sent[0]!.body.text)).toContain("Thursday morning");
    expect(String(sent[0]!.body.text)).toContain("AYA Voice + Web Chat");
    expect(String(sent[0]!.body.text)).toContain("Saturdays go to voicemail");
  });

  test("email only: the number the demo called is never passed on", async () => {
    // It was given "for the demo call only" (lib/consent.ts).
    const response = await post({ topic: "pricing", contact_by_phone: true }, { toNumber: "+15125550142" });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/no email/);
    expect(sent).toHaveLength(0);

    await post({ topic: "pricing", email: "sam@clinic.com" }, { toNumber: "+15125550142" });
    expect(String(sent[0]!.body.text)).not.toContain("5125550142");
  });

  test("a half-heard email is sent back to be spelled again, not mailed", async () => {
    const response = await post({ email: "sam at clinic", topic: "pricing" });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/spell it again/);
    expect(sent).toHaveLength(0);
  });

  test("start: the owner gets the setup link for the package she named, then the team gets the summary", async () => {
    const response = await post({
      topic: "start",
      name: "Sam Rivera",
      clinic: "Radiance",
      email: "sam@radiance.com",
      recommended_package: "AYA Voice + Web Chat",
      summary: "After six the phone rings out.",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toContain("AYA Voice + Web Chat is in their inbox");
    expect(sent).toHaveLength(2);
    // Theirs first: it is the promise AYA makes.
    expect(sent[0]!.body).toMatchObject({ to: ["sam@radiance.com"], reply_to: "hello@healdesk.io" });
    expect(String(sent[0]!.body.text)).toContain("/get-started?plan=voice-webchat");
    expect(String(sent[0]!.body.text)).toMatch(/^Hi Sam,/);
    expect(sent[1]!.body).toMatchObject({ to: ["hello@healdesk.io"], reply_to: "sam@radiance.com" });
    expect(String(sent[1]!.body.text)).toContain("/get-started?plan=voice-webchat");
  });

  test("start: a plan named in full, with its step, links to that plan", async () => {
    // The price list names packages, and checkout opens a package at the
    // default steps; a plan named in full carries its own step.
    const response = await post({ topic: "start", email: "sam@radiance.com", recommended_package: "AYA Voice, 300 minutes" });
    expect((await response.json()).message).toContain("AYA Voice, 300 minutes is in their inbox");
    expect(String(sent[0]!.body.text)).toContain("/get-started?plan=voice-300\n");
  });

  test("start: a package of 5 October links to the buy flow with none chosen", async () => {
    await post({ topic: "start", email: "sam@radiance.com", recommended_package: "AYA Complete Frontdesk" });
    expect(String(sent[0]!.body.text)).not.toContain("get-started?plan=");
  });

  test("start: a package she did not name exactly links to the buy flow with none chosen, never to a guess", async () => {
    await post({ topic: "start", email: "sam@radiance.com", recommended_package: "the big one" });
    expect(String(sent[0]!.body.text)).toMatch(/\/get-started\n/);
    expect(String(sent[0]!.body.text)).not.toContain("get-started?plan=");
    expect(String(sent[0]!.body.text)).not.toContain("/pricing");
  });

  test("start: if their email fails, AYA is told so and the team is not told otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 500 })),
    );
    const response = await post({ topic: "start", email: "sam@radiance.com", recommended_package: "AYA Voice + Web Chat" });
    expect(response.status).toBe(502);
    expect((await response.json()).message).toContain("hello@healdesk.io");
  });

  test("with no transport the agent is told to give the address instead", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const response = await post({ email: "sam@clinic.com", topic: "discount" });
    expect(response.status).toBe(503);
    expect((await response.json()).message).toContain("hello@healdesk.io");
  });
});

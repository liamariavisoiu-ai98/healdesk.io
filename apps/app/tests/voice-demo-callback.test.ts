import { verify, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@healdesk/catalog";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CALLBACK_FAILED_LINE,
  callbackFrom,
  callbackNote,
  callbackOrigin,
  callbackPhone,
  callbackSentLine,
  sendDemoCallback,
  type DemoCallbackRequest,
} from "@/lib/voice/demo-callback";

/**
 * A call back asked for on a demo call (demo-callback.ts): the number is
 * checked before it leaves the call, the request to apps/web is signed and
 * carries only what the design lets cross, and anything but a 2xx is a
 * failure the caller hears as hello@.
 */

const SECRET = "test-provision-secret-0123456789abcdef";

function request(overrides: Partial<DemoCallbackRequest> = {}): DemoCallbackRequest {
  return {
    phoneE164: "+15125550147",
    note: "Pricing for two locations",
    context: {
      slug: "lumen-aesthetics-austin",
      firstName: "Josh",
      test: false,
      offer: { percentOfSetupFee: 50, endsAt: Date.UTC(2026, 9, 27, 12) },
      clinic: { clinicName: "Lumen Aesthetics" } as DemoCallbackRequest["context"]["clinic"],
    },
    at: new Date(Date.UTC(2026, 9, 26, 9)),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the number Aya heard", () => {
  test("a US or Canadian number in any spoken shape becomes E.164", () => {
    for (const heard of ["512 555 0147", "(512) 555-0147", "512.555.0147", "5125550147", "1 512 555 0147", "+1 512 555 0147"]) {
      expect(callbackPhone(heard), heard).toBe("+15125550147");
    }
  });

  test("an international number needs its own plus", () => {
    expect(callbackPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(callbackPhone("44 20 7946 0958")).toBeNull();
  });

  test("anything that cannot be called is refused, so nothing is sent and nothing promised", () => {
    for (const heard of ["", "555 0147", "012 555 0147", "512 155 0147", "+1 512 555 014", "call me tomorrow", "512-555-0147 ext 4", "+0 123 456 789", 5125550147, null]) {
      expect(callbackPhone(heard), String(heard)).toBeNull();
    }
  });

  test("the one line is one plain line, cut short", () => {
    expect(callbackNote("Pricing\nfor   two\tlocations ")).toBe("Pricing for two locations");
    expect(callbackNote("x".repeat(400))).toHaveLength(160);
    expect(callbackNote(42)).toBe("");
  });

  test("a state's callback is taken only with a number that can be called", () => {
    expect(callbackFrom({ phone: "512 555 0147", note: "Pricing" })).toEqual({ phoneE164: "+15125550147", note: "Pricing" });
    expect(callbackFrom({ phone: "512 555 0147" })).toEqual({ phoneE164: "+15125550147", note: "" });
    expect(callbackFrom({ phone: "soon", note: "Pricing" })).toBeNull();
    expect(callbackFrom("512 555 0147")).toBeNull();
    expect(callbackFrom(null)).toBeNull();
  });
});

describe("what the caller hears", () => {
  test("the number read back as a voice reads one; hello@ when it did not get through, never a promise", () => {
    expect(callbackSentLine("+15125550147")).toBe(
      "Perfect, I've passed that to the team, and someone will call you on five one two — five five five — oh one four seven. Is there anything else I can help with?",
    );
    expect(CALLBACK_FAILED_LINE).toContain("hello at healdesk dot io");
    expect(CALLBACK_FAILED_LINE).not.toMatch(/will call|passed that/);
  });
});

describe("the request to apps/web", () => {
  test("signed with the provision secret, to the callback route, carrying only what may cross", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const ok = await sendDemoCallback(request(), { fetch: fetcher as typeof fetch, origin: "https://healdesk.io", secret: SECRET });
    expect(ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://healdesk.io/api/voice-demo/callback-request");
    const headers = seen[0]!.init.headers as Record<string, string>;
    const body = String(seen[0]!.init.body);
    expect(verify(body, headers[TIMESTAMP_HEADER]!, headers[SIGNATURE_HEADER]!, SECRET)).toEqual({ ok: true });
    expect(JSON.parse(body)).toEqual({
      slug: "lumen-aesthetics-austin",
      clinicName: "Lumen Aesthetics",
      firstName: "Josh",
      phoneE164: "+15125550147",
      note: "Pricing for two locations",
      test: false,
      offerEndsAt: Date.UTC(2026, 9, 27, 12),
      at: "2026-10-26T09:00:00.000Z",
    });
    expect(seen[0]!.init.redirect).toBe("error");
  });

  test("anything but a 2xx, a network failure or a missing origin or secret is a failure, and never throws", async () => {
    const answer = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
    for (const status of [400, 401, 404, 429, 500, 503]) {
      expect(await sendDemoCallback(request(), { fetch: answer(status), origin: "https://healdesk.io", secret: SECRET }), String(status)).toBe(false);
    }
    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await sendDemoCallback(request(), { fetch: broken, origin: "https://healdesk.io", secret: SECRET })).toBe(false);
    const never = vi.fn() as unknown as typeof fetch;
    expect(await sendDemoCallback(request(), { fetch: never, origin: null, secret: SECRET })).toBe(false);
    expect(await sendDemoCallback(request(), { fetch: never, origin: "https://healdesk.io", secret: null })).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  test("a slow apps/web is given up on, and heard as a failure", async () => {
    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")))),
    ) as unknown as typeof fetch;
    expect(await sendDemoCallback(request(), { fetch: slow, origin: "https://healdesk.io", secret: SECRET, timeoutMs: 20 })).toBe(false);
  });

  test("apps/web's origin: HEALDESK_WEB_URL, else the console's origin Terraform already sets on the voice task", () => {
    vi.stubEnv("HEALDESK_WEB_URL", "");
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.io");
    expect(callbackOrigin()).toBe("https://healdesk.io");
    vi.stubEnv("HEALDESK_WEB_URL", "https://web.example.test");
    expect(callbackOrigin()).toBe("https://web.example.test");
    vi.stubEnv("HEALDESK_WEB_URL", "");
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "");
    expect(callbackOrigin()).toBeNull();
    vi.stubEnv("HEALDESK_CONSOLE_ORIGIN", "https://healdesk.io/admin");
    expect(callbackOrigin()).toBeNull();
  });
});

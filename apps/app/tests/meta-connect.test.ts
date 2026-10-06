import { afterEach, describe, expect, test, vi } from "vitest";

import { graphSend } from "@/lib/meta/channels";
import { generateRegistrationPin, prepareMetaLogin, prepareWhatsApp } from "@/lib/meta/connect";
import { GRAPH_VERSION, loginDialogUrl, type FetchLike } from "@/lib/meta/graph";
import {
  decodeLoginCookie,
  encodeLoginCookie,
  LOGIN_COOKIE,
  loginCookieHeader,
  newNonce,
  readCookie,
  stateMatches,
} from "@/lib/meta/login-state";

/**
 * The Meta connect flows without Meta (launch plan 1.6 and 2.5).
 *
 * The routes are thin: they resolve the link, call `prepareMetaLogin` /
 * `prepareWhatsApp`, and store what comes back while burning the link
 * (tests/meta-channel-links.test.ts covers that half against the database).
 * Everything that decides WHAT is stored is here, driven by a fake Graph that
 * records every call, so the tests can say not only what came back but which
 * calls were never made — the subscription that must not happen for a login
 * that chose two Pages, the fetch that must not happen for a malformed id.
 */

const APP = { appId: "1234567890", appSecret: "app-secret-not-real" };
const REDIRECT = "https://app.healdesk.io/api/meta/callback";

type Call = { method: string; url: string; auth: string | null; body: string | null };

/** A fake Graph: routes by path suffix, records every call. */
function fakeGraph(routes: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      method: init.method ?? "GET",
      url: input,
      auth: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : null,
    };
    calls.push(call);
    const path = new URL(input).pathname.replace(`/${GRAPH_VERSION}`, "");
    const key = `${call.method} ${path}`;
    const handler = routes[key];
    if (!handler) return Response.json({ error: { message: `unexpected ${key}` } }, { status: 500 });
    const { status = 200, body } = handler(call);
    return Response.json(body, { status });
  };
  return { fetchImpl, calls };
}

const PAGE = {
  id: "111222333",
  name: "Glow Aesthetics",
  access_token: "page-token-not-real",
  instagram_business_account: { id: "17841400000001", username: "glowaesthetics" },
};

function loginRoutes(pages: unknown[], subscribe: { status?: number; body: unknown } = { body: { success: true } }) {
  return {
    "GET /oauth/access_token": () => ({ body: { access_token: "business-token-not-real" } }),
    "GET /me/accounts": () => ({ body: { data: pages } }),
    [`POST /${PAGE.id}/subscribed_apps`]: () => subscribe,
  };
}

describe("the Facebook Login for Business dialog", () => {
  test("asks for a code on the configuration, on the pinned version, and carries only the nonce", () => {
    const url = new URL(loginDialogUrl({ appId: APP.appId, configId: "9988776655", redirectUri: REDIRECT, state: "nonce-123" }));
    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: APP.appId,
      redirect_uri: REDIRECT,
      config_id: "9988776655",
      response_type: "code",
      override_default_response_type: "true",
      state: "nonce-123",
    });
    // The configuration carries the permissions. A `scope` here would be ignored at best.
    expect(url.searchParams.has("scope")).toBe(false);
  });

  test("the pinned version is v25.0, which Meta runs until 29 July 2028", () => {
    expect(GRAPH_VERSION).toBe("v25.0");
  });
});

describe("prepareMetaLogin", () => {
  test("one Page with Instagram: subscribes the Page, then returns Messenger and Instagram", async () => {
    const { fetchImpl, calls } = fakeGraph(loginRoutes([PAGE]));
    const outcome = await prepareMetaLogin(fetchImpl, APP, { code: "the-code", redirectUri: REDIRECT });

    expect(outcome).toEqual({
      ok: true,
      page: { id: PAGE.id, name: PAGE.name },
      instagram: { id: "17841400000001", username: "glowaesthetics" },
      channels: [
        { platform: "messenger", externalId: PAGE.id, accessToken: PAGE.access_token, label: PAGE.name },
        {
          platform: "instagram",
          externalId: "17841400000001",
          accessToken: PAGE.access_token,
          label: "@glowaesthetics",
          details: { pageId: PAGE.id },
        },
      ],
    });

    const exchange = new URL(calls[0]!.url);
    expect(exchange.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(exchange.searchParams.get("code")).toBe("the-code");

    const subscribe = calls.find((c) => c.method === "POST")!;
    expect(subscribe.auth).toBe(`Bearer ${PAGE.access_token}`);
    expect(subscribe.body).toBe("subscribed_fields=messages");
  });

  test("no token ever appears in a URL except the code exchange Meta defines that way", async () => {
    const { fetchImpl, calls } = fakeGraph(loginRoutes([PAGE]));
    await prepareMetaLogin(fetchImpl, APP, { code: "the-code", redirectUri: REDIRECT });
    for (const call of calls.slice(1)) {
      expect(call.url).not.toContain("business-token-not-real");
      expect(call.url).not.toContain(PAGE.access_token);
      expect(call.url).not.toContain(APP.appSecret);
    }
  });

  test("a Page with no Instagram account connects Messenger alone", async () => {
    const { fetchImpl } = fakeGraph(loginRoutes([{ ...PAGE, instagram_business_account: undefined }]));
    const outcome = await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT });
    expect(outcome.ok && outcome.channels.map((c) => c.platform)).toEqual(["messenger"]);
    expect(outcome.ok && outcome.instagram).toBeNull();
  });

  test("two Pages: refuses, and subscribes neither", async () => {
    const { fetchImpl, calls } = fakeGraph(loginRoutes([PAGE, { ...PAGE, id: "444555666" }]));
    expect(await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT })).toEqual({ ok: false, problem: "several_pages" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("no Page: refuses", async () => {
    const { fetchImpl } = fakeGraph(loginRoutes([]));
    expect(await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT })).toEqual({ ok: false, problem: "no_page" });
  });

  test("a Page whose subscription Meta refuses is not returned, so it is never shown as connected", async () => {
    const { fetchImpl } = fakeGraph(loginRoutes([PAGE], { status: 403, body: { error: { message: "Insufficient permission", code: 200 } } }));
    expect(await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT })).toEqual({
      ok: false,
      problem: "meta_error",
      detail: "Insufficient permission",
    });
  });

  test("a subscription Meta does not confirm counts as refused", async () => {
    const { fetchImpl } = fakeGraph(loginRoutes([PAGE], { body: { success: false } }));
    const outcome = await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT });
    expect(outcome.ok).toBe(false);
  });

  test("a Page row with a malformed id or no token is dropped, never put in a path", async () => {
    const { fetchImpl, calls } = fakeGraph(loginRoutes([{ ...PAGE, id: "../../me" }, { ...PAGE, access_token: "" }]));
    expect(await prepareMetaLogin(fetchImpl, APP, { code: "c", redirectUri: REDIRECT })).toEqual({ ok: false, problem: "no_page" });
    expect(calls.some((c) => c.url.includes(".."))).toBe(false);
  });
});

describe("prepareWhatsApp", () => {
  const WABA = "102030405060708";
  const PHONE = "109876543210987";

  function whatsappRoutes(register: { status?: number; body: unknown } = { body: { success: true } }) {
    return {
      "GET /oauth/access_token": () => ({ body: { access_token: "wa-business-token" } }),
      [`POST /${WABA}/subscribed_apps`]: () => ({ body: { success: true } }),
      [`POST /${PHONE}/register`]: () => register,
      [`GET /${PHONE}`]: () => ({ body: { display_phone_number: "+1 555 010 0199", id: PHONE } }),
    };
  }

  test("exchanges with no redirect, subscribes the account, registers the number with the PIN, and seals the PIN", async () => {
    const { fetchImpl, calls } = fakeGraph(whatsappRoutes());
    const outcome = await prepareWhatsApp(fetchImpl, APP, { code: "wa-code", wabaId: WABA, phoneNumberId: PHONE }, "246810");

    expect(outcome).toEqual({
      ok: true,
      displayNumber: "+1 555 010 0199",
      channel: {
        platform: "whatsapp",
        externalId: PHONE,
        accessToken: "wa-business-token",
        label: "+1 555 010 0199",
        secrets: { registrationPin: "246810" },
        details: { wabaId: WABA },
      },
    });
    expect(new URL(calls[0]!.url).searchParams.has("redirect_uri")).toBe(false);
    const register = calls.find((c) => c.url.endsWith("/register"))!;
    expect(JSON.parse(register.body!)).toEqual({ messaging_product: "whatsapp", pin: "246810" });
    expect(register.auth).toBe("Bearer wa-business-token");
  });

  test.each([
    ["a malformed account id", { code: "c", wabaId: "1; drop", phoneNumberId: PHONE }],
    ["a malformed number id", { code: "c", wabaId: WABA, phoneNumberId: "../register" }],
    ["no code", { code: "", wabaId: WABA, phoneNumberId: PHONE }],
  ])("%s is refused before Meta is called at all", async (_label, input) => {
    const { fetchImpl, calls } = fakeGraph(whatsappRoutes());
    expect(await prepareWhatsApp(fetchImpl, APP, input)).toEqual({ ok: false, problem: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  test("a registration Meta refuses stores nothing", async () => {
    const { fetchImpl } = fakeGraph(whatsappRoutes({ status: 400, body: { error: { message: "Invalid PIN", code: 133005 } } }));
    expect(await prepareWhatsApp(fetchImpl, APP, { code: "c", wabaId: WABA, phoneNumberId: PHONE })).toEqual({
      ok: false,
      problem: "meta_error",
      detail: "Invalid PIN",
    });
  });

  test("the PIN is six digits, and varies", () => {
    const pins = new Set(Array.from({ length: 50 }, () => generateRegistrationPin()));
    for (const pin of pins) expect(pin).toMatch(/^\d{6}$/);
    expect(pins.size).toBeGreaterThan(40);
  });
});

describe("the login cookie and state", () => {
  test("round-trips the token and nonce", () => {
    const nonce = newNonce();
    expect(decodeLoginCookie(encodeLoginCookie({ token: "link-token", nonce }))).toEqual({ token: "link-token", nonce });
  });

  test.each([[null], [""], ["not base64 json"], [Buffer.from('{"t":"x"}').toString("base64url")]])(
    "a missing or malformed cookie decodes to nothing (%s)",
    (raw) => {
      expect(decodeLoginCookie(raw)).toBeNull();
    },
  );

  test("state must equal the nonce exactly", () => {
    const nonce = newNonce();
    expect(stateMatches(nonce, nonce)).toBe(true);
    expect(stateMatches(`${nonce}x`, nonce)).toBe(false);
    expect(stateMatches(nonce.slice(1), nonce)).toBe(false);
    expect(stateMatches(null, nonce)).toBe(false);
  });

  test("the cookie is HttpOnly, Secure, Lax and scoped to /api/meta, and clearing uses the same scope", () => {
    const set = loginCookieHeader("value");
    const clear = loginCookieHeader(null);
    for (const header of [set, clear]) {
      expect(header).toContain("Path=/api/meta");
      expect(header).toContain("HttpOnly");
      expect(header).toContain("Secure");
      expect(header).toContain("SameSite=Lax");
    }
    expect(set).toContain("Max-Age=900");
    expect(clear).toContain("Max-Age=0");
  });

  test("reads one cookie out of a header", () => {
    expect(readCookie(`a=1; ${LOGIN_COOKIE}=abc.def; b=2`, LOGIN_COOKIE)).toBe("abc.def");
    expect(readCookie("a=1", LOGIN_COOKIE)).toBeNull();
    expect(readCookie(null, LOGIN_COOKIE)).toBeNull();
  });
});

describe("the send path", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("speaks the same pinned version as the connect flows", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response("{}", { status: 200 });
    });
    await graphSend({ platform: "messenger", externalId: PAGE.id, accessToken: "t", recipientId: "r", text: "hi" });
    await graphSend({ platform: "whatsapp", externalId: "109876543210987", accessToken: "t", recipientId: "r", text: "hi" });
    expect(urls).toEqual([
      `https://graph.facebook.com/${GRAPH_VERSION}/me/messages`,
      `https://graph.facebook.com/${GRAPH_VERSION}/109876543210987/messages`,
    ]);
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GET, HEAD } from "@/app/widget/v1.js/route";
import { WIDGET_SCRIPT_PATH, widgetSnippet } from "@/lib/setup/snippet";

/**
 * The website chat bubble (src/widget/v1.js), the script the line a clinic
 * pastes loads, and the route that serves it (app/widget/v1.js/route.ts).
 * The script runs here against a fake engine that answers the way
 * app/api/widget/v1/[slug]/* does; the routes' own behaviour is
 * web-chat.test.ts's and website-message tests'.
 */

const SOURCE = readFileSync(join(process.cwd(), "src/widget/v1.js"), "utf8");
/** The source without its comments, which describe what the code must not do. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ORIGIN = "https://app.healdesk.test";
const API = `${ORIGIN}/api/widget/v1/radiance/`;
const OPENING = "You're chatting with an AI assistant for Radiance Clinic. How can I help you today?";
const TIMES = [
  { id: "any_time", label: "Any time" },
  { id: "mornings", label: "Mornings" },
];

type Answer = { status: number; body?: unknown } | "network";
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

let calls: Call[];
let answers: Record<string, Answer[]>;
let beacons: { url: string; body: string }[];
let roots: ShadowRoot[];
const realAttach = Element.prototype.attachShadow;

function answer(path: string, ...list: Answer[]) {
  answers[path] = [...(answers[path] ?? []), ...list];
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Run the script as a page that pasted the line would, and hand back its closed shadow root. */
async function load(attrs: Record<string, string> = { "data-clinic": "radiance" }): Promise<ShadowRoot> {
  const script = document.createElement("script");
  script.setAttribute("type", "text/plain"); // never fetched or run by the DOM itself
  script.setAttribute("src", `${ORIGIN}${WIDGET_SCRIPT_PATH}`);
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  new Function(SOURCE)();
  await settle();
  return roots[roots.length - 1]!;
}

function q<T extends Element = HTMLElement>(root: ShadowRoot, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

async function open(root: ShadowRoot) {
  q<HTMLButtonElement>(root, ".launcher").click();
  await settle();
}

async function type(root: ShadowRoot, text: string) {
  q<HTMLTextAreaElement>(root, "textarea").value = text;
  q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
}

function messages(root: ShadowRoot): string[] {
  return [...root.querySelectorAll(".msg")].map((m) => m.textContent ?? "");
}

beforeEach(async () => {
  // A bubble from an earlier test still listens on this window: let it end
  // its chat now, so it sends nothing during this one.
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  calls = [];
  answers = {};
  beacons = [];
  roots = [];
  document.body.replaceChildren();
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = realAttach.call(this, init);
    roots.push(root);
    return root;
  };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const path = url.replace(API, "");
    const next = answers[path]?.shift() ?? { status: 500, body: {} };
    if (next === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json" } });
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, blob: Blob) => {
      void blob.text().then((body) => beacons.push({ url, body }));
      return true;
    },
  });
});

afterEach(() => {
  Element.prototype.attachShadow = realAttach;
  vi.unstubAllGlobals();
});

describe("the bubble on a clinic's page", () => {
  test("draws a closed launcher in a closed shadow root and calls nothing until opened", async () => {
    const root = await load();
    const host = document.querySelector("healdesk-chat")!;
    expect(host.shadowRoot).toBeNull();
    const launcher = q(root, ".launcher");
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(launcher.getAttribute("aria-controls")).toBe("panel");
    expect(q(root, ".panel").hidden).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("draws nothing for a line without a clinic's name, and once for a line pasted twice", async () => {
    await load({ "data-clinic": "Bad Name<script>" });
    expect(document.querySelector("healdesk-chat")).toBeNull();
    await load();
    await load();
    expect(document.querySelectorAll("healdesk-chat")).toHaveLength(1);
  });

  test("opens with the locked AI line first, asking the engine the script came from with no credential", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}start`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("omit");
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`]);
    expect(q(root, ".msg").classList.contains("opening")).toBe(true);
    expect(q(root, ".compose").hidden).toBe(false);
    expect(q(root, ".panel").getAttribute("role")).toBe("dialog");
    expect(q(root, ".log").getAttribute("role")).toBe("log");
    expect(root.activeElement).toBe(q(root, "textarea"));
  });

  test("opens no chat without an opening line to show", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: "  ", token: "t0" } });
    const root = await load();
    await open(root);
    expect(q(root, ".compose").hidden).toBe(true);
    expect(q(root, ".call").textContent).toContain("Please call the practice");
  });

  test("sends the token and the words, shows the reply as text, and carries the new token", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer(
      "message",
      { status: 200, body: { mode: "chat", reply: "A consultation is $150.", token: "t1", ended: false } },
      { status: 200, body: { mode: "chat", reply: "<img src=x onerror=alert(1)>", token: "t2", ended: false } },
    );
    const root = await load();
    await open(root);
    await type(root, "How much is a consultation?");
    expect(calls[1]!.body).toEqual({ token: "t0", text: "How much is a consultation?" });
    await type(root, "<b>hi</b>");
    expect(calls[2]!.body).toEqual({ token: "t1", text: "<b>hi</b>" });
    expect(messages(root)).toEqual([
      `Assistant: ${OPENING}`,
      "You: How much is a consultation?",
      "Assistant: A consultation is $150.",
      "You: <b>hi</b>",
      "Assistant: <img src=x onerror=alert(1)>",
    ]);
    expect(root.querySelector("img, b")).toBeNull();
    expect(q(root, ".text-button").hidden).toBe(false);
  });

  test("ends the chat with the end route, and by beacon when the page goes", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Again.", token: "t2", ended: false } });
    answer("end", { status: 200, body: { ended: true } });
    const root = await load();
    await open(root);
    // Nothing said yet: nothing to end.
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(beacons).toHaveLength(0);

    await type(root, "Hello");
    q<HTMLButtonElement>(root, ".text-button").click();
    await settle();
    expect(calls.at(-1)!.url).toBe(`${API}end`);
    expect(calls.at(-1)!.body).toEqual({ token: "t1" });
    expect(root.querySelector(".note")?.textContent).toMatch(/Chat ended/);

    await type(root, "One more");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(beacons).toEqual([{ url: `${API}end`, body: JSON.stringify({ token: "t2" }) }]);
  });

  test("an ended chat says so, and the next message starts a new one", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Goodbye.", token: "fresh", ended: true } });
    const root = await load();
    await open(root);
    await type(root, "bye");
    expect(root.querySelector(".note")?.textContent).toMatch(/This chat has ended/);
    expect(q(root, ".text-button").hidden).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(beacons).toHaveLength(0);
  });

  test("a token that ran out opens a new chat, with its own opening line, and sends the message again", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "old" } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "new" } });
    answer("message", { status: 400, body: { error: "token" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Hi again.", token: "new1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Still there?");
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["start", "message", "start", "message"]);
    expect(calls[3]!.body).toEqual({ token: "new", text: "Still there?" });
    expect(messages(root).filter((m) => m === `Assistant: ${OPENING}`)).toHaveLength(2);
    expect(messages(root).at(-1)).toBe("Assistant: Hi again.");
  });

  test("a rate limit keeps the words in the box to send again", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 429, body: { error: "rate_limited" } });
    const root = await load();
    await open(root);
    await type(root, "Hello?");
    expect(q<HTMLTextAreaElement>(root, "textarea").value).toBe("Hello?");
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`]);
    expect(q(root, ".status").textContent).toMatch(/wait a minute/);
    expect(q<HTMLButtonElement>(root, ".send").disabled).toBe(false);
  });

  test("Escape closes the panel and gives focus back to the launcher", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    q(root, ".panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(q(root, ".panel").hidden).toBe(true);
    expect(q(root, ".launcher").getAttribute("aria-expanded")).toBe("false");
    expect(root.activeElement).toBe(q(root, ".launcher"));
  });
});

describe("when the chat is not answering", () => {
  test("becomes the engine's contact form, sends exactly its three fields, and shows the fixed reply", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    answer("contact", { status: 400, body: { error: "invalid", fields: ["phone"] } });
    answer("contact", { status: 200, body: { mode: "received", reply: "Thanks. Your message is with Radiance Clinic." } });
    const root = await load();
    await open(root);
    expect(q(root, ".compose").hidden).toBe(true);
    const labels = [...root.querySelectorAll(".option label")].map((l) => l.textContent);
    expect(labels).toEqual(["Any time", "Mornings"]);
    expect(q(root, ".form").querySelector("textarea")).toBeNull();

    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "555";
    q<HTMLInputElement>(root, "#time-1").checked = true;
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(calls.at(-1)!.url).toBe(`${API}contact`);
    expect(calls.at(-1)!.body).toEqual({ firstName: "Jamie", phone: "555", preferredTime: "mornings" });
    expect(q(root, "#phone").getAttribute("aria-invalid")).toBe("true");
    expect(q(root, "#first").getAttribute("aria-invalid")).toBe("false");
    expect(q(root, "#phone-error").textContent).toMatch(/phone number/);

    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q(root, ".received").textContent).toBe("Thanks. Your message is with Radiance Clinic.");
    expect(root.querySelector(".form")).toBeNull();
  });

  test("checks the fields in the page before sending anything", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    const root = await load();
    await open(root);
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(calls).toHaveLength(1);
    expect(q(root, "#first").getAttribute("aria-invalid")).toBe("true");
    expect(root.activeElement).toBe(q(root, "#first"));
  });

  test("a form that takes nothing says to call the practice, with the number the line names", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "cancelled", form: { takesMessages: false, times: TIMES } } });
    const root = await load({ "data-clinic": "radiance", "data-phone": "+1 (415) 555-0199" });
    await open(root);
    expect(root.querySelector(".form")).toBeNull();
    const link = q<HTMLAnchorElement>(root, ".call a");
    expect(link.getAttribute("href")).toBe("tel:+14155550199");
    expect(link.textContent).toBe("(415) 555-0199");
  });

  test("without a number on the line it points to the clinic's own website", async () => {
    answer("start", { status: 503, body: { mode: "contact_form", reason: "unavailable" } });
    const root = await load({ "data-clinic": "radiance", "data-phone": "javascript:alert(1)" });
    await open(root);
    expect(root.querySelector(".call a")).toBeNull();
    expect(q(root, ".call").textContent).toContain("Its phone number is on this website.");
  });

  test("an engine that cannot be reached, mid-chat, turns the chat into the way to call", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", "network");
    const root = await load();
    await open(root);
    await type(root, "Hello");
    expect(q(root, ".compose").hidden).toBe(true);
    expect(q(root, ".call").textContent).toContain("Please call the practice");
    // What was said stays on screen, the opening line first.
    expect(messages(root)[0]).toBe(`Assistant: ${OPENING}`);
  });

  test("a message the engine answers with the contact form switches to it", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "contact_form", reason: "unavailable", form: { takesMessages: true, times: TIMES } } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    expect(q(root, ".form")).toBeTruthy();
  });

});

describe("the script's source", () => {
  test("builds the DOM without markup parsing, eval or the page's storage", () => {
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "document.cookie", "setAttribute(\"style\""]) {
      expect(CODE, banned).not.toContain(banned);
    }
  });

  test("animates only for visitors who have not asked for reduced motion", () => {
    const css = SOURCE.slice(SOURCE.indexOf("function css("));
    const motion = css.indexOf("prefers-reduced-motion:no-preference");
    expect(motion).toBeGreaterThan(0);
    const before = css.slice(0, motion);
    expect(before).not.toMatch(/animation|transition/);
  });

  test("is small and depends on nothing", () => {
    expect(Buffer.byteLength(SOURCE)).toBeLessThan(32_000);
    expect(CODE).not.toMatch(/\bimport\b|\brequire\(/);
  });

  test("promises no booking it cannot make", () => {
    expect(CODE).not.toMatch(/\bbook/i);
  });
});

describe("GET /widget/v1.js", () => {
  test("serves the script as written, cacheable and loadable from any site", async () => {
    const response = GET(new Request(`${ORIGIN}/widget/v1.js`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SOURCE);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=86400");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toMatch(/^"[\w-]{27}"$/);
  });

  test("answers 304 to a browser that already holds it", async () => {
    const etag = GET(new Request(`${ORIGIN}/widget/v1.js`)).headers.get("etag")!;
    const again = GET(new Request(`${ORIGIN}/widget/v1.js`, { headers: { "if-none-match": `W/${etag}` } }));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    const head = HEAD(new Request(`${ORIGIN}/widget/v1.js`));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("is the address the pasted line loads", () => {
    expect(widgetSnippet("radiance")).toContain(`${WIDGET_SCRIPT_PATH}" data-clinic="radiance"`);
  });
});

describe("next.config.ts", () => {
  test("lets the bubble be cached, overriding the no-store every other response carries", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.headers!();
    const cache = rules
      .filter((rule) => rule.source === "/:path*" || rule.source === WIDGET_SCRIPT_PATH)
      .flatMap((rule) => rule.headers.filter((h) => h.key === "Cache-Control").map((h) => ({ source: rule.source, value: h.value })));
    // The later rule wins in Next, so the bubble's must come last.
    expect(cache.at(-1)).toEqual({ source: WIDGET_SCRIPT_PATH, value: GET(new Request(`${ORIGIN}/widget/v1.js`)).headers.get("cache-control") });
    expect(cache[0]).toEqual({ source: "/:path*", value: "no-store, max-age=0" });
  });
});

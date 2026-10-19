// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

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

type Answer = { status: number; body?: unknown } | "network" | "hang";
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
  delete (window as unknown as { __healdeskChat?: boolean }).__healdeskChat;
  Object.defineProperty(Request.prototype, "keepalive", { configurable: true, get: () => false });
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
    if (next === "hang") {
      return new Promise<Response>((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }
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
  delete (Request.prototype as unknown as { keepalive?: boolean }).keepalive;
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

  test("a line in <head> waits for the body, and two copies there still draw one bubble", async () => {
    Object.defineProperty(document, "body", { configurable: true, get: () => null });
    await load();
    await load();
    expect(roots).toHaveLength(1);
    expect(document.querySelector("healdesk-chat")).toBeNull();
    delete (document as unknown as { body?: unknown }).body;
    document.dispatchEvent(new Event("DOMContentLoaded"));
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

  test("ends the chat with the end route, and as the page goes, and opens the next chat with its own opening line", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    answer("end", { status: 200, body: { ended: true }, }, { status: 200, body: { ended: true } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "n0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Again.", token: "n1", ended: false } });
    const root = await load();
    await open(root);
    // Nothing said yet: nothing to end.
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["start"]);

    await type(root, "Hello");
    q<HTMLButtonElement>(root, ".text-button").click();
    await settle();
    expect(calls.at(-1)!.url).toBe(`${API}end`);
    expect(calls.at(-1)!.body).toEqual({ token: "t1" });
    expect(calls.at(-1)!.init.keepalive).toBe(true);
    expect(root.querySelector(".note")?.textContent).toMatch(/Chat ended/);
    expect(q(root, ".text-button").hidden).toBe(true);
    expect(root.activeElement).toBe(q(root, "textarea"));

    // The next message opens a new chat first, and its AI line is on screen above the message.
    await type(root, "One more");
    expect(calls.slice(-2).map((c) => c.url.replace(API, ""))).toEqual(["start", "message"]);
    expect(calls.at(-1)!.body).toEqual({ token: "n0", text: "One more" });
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`, "You: Hello", "Assistant: Sure.", `Assistant: ${OPENING}`, "You: One more", "Assistant: Again."]);
    expect(messages(root).filter((m) => m === `Assistant: ${OPENING}`)).toHaveLength(2);

    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(calls.at(-1)!.url).toBe(`${API}end`);
    expect(calls.at(-1)!.body).toEqual({ token: "n1" });
    expect(calls.at(-1)!.init.keepalive).toBe(true);
    expect(calls.at(-1)!.init.referrerPolicy).toBe("no-referrer");
  });

  test("falls back to a beacon where fetch cannot outlive the page", async () => {
    delete (Request.prototype as unknown as { keepalive?: boolean }).keepalive;
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(beacons).toEqual([{ url: `${API}end`, body: JSON.stringify({ token: "t1" }) }]);
  });

  test("a page kept for Back does not end its chat", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    const kept = new Event("pagehide") as Event & { persisted: boolean };
    Object.defineProperty(kept, "persisted", { value: true });
    window.dispatchEvent(kept);
    await settle();
    expect(calls.some((c) => c.url.endsWith("/end"))).toBe(false);
    expect(beacons).toHaveLength(0);
  });

  test("End chat is out of reach while a reply is on its way", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "First.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    expect(q(root, ".text-button").hidden).toBe(false);
    q<HTMLTextAreaElement>(root, "textarea").value = "Second";
    q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
    // Synchronously, before the reply: End is hidden, and a page going now sends no end.
    expect(q(root, ".text-button").hidden).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(calls.some((c) => c.url.endsWith("/end"))).toBe(false);
  });

  test("an ended chat says so, and the next message opens a new one with its own opening line", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Goodbye.", token: "fresh", ended: true } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "n0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Hello again.", token: "n1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "bye");
    expect(root.querySelector(".note")?.textContent).toMatch(/This chat has ended/);
    expect(q(root, ".text-button").hidden).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(calls.some((c) => c.url.endsWith("/end"))).toBe(false);
    await type(root, "wait");
    expect(calls.slice(-2).map((c) => c.url.replace(API, ""))).toEqual(["start", "message"]);
    expect(calls.at(-1)!.body).toEqual({ token: "n0", text: "wait" });
    expect(messages(root).slice(-3)).toEqual([`Assistant: ${OPENING}`, "You: wait", "Assistant: Hello again."]);
  });

  test("a token that ran out opens a new chat, with its own opening line above the message, and sends it again", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "old" } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "new" } });
    answer("message", { status: 400, body: { error: "token" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Hi again.", token: "new1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Still there?");
    expect(calls.map((c) => c.url.replace(API, ""))).toEqual(["start", "message", "start", "message"]);
    expect(calls[3]!.body).toEqual({ token: "new", text: "Still there?" });
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`, `Assistant: ${OPENING}`, "You: Still there?", "Assistant: Hi again."]);
  });

  test("Enter confirming an IME conversion does not send", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    const box = q<HTMLTextAreaElement>(root, "textarea");
    box.value = "こんにちは";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    await settle();
    expect(calls).toHaveLength(1);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(calls.at(-1)!.url).toBe(`${API}message`);
  });

  test("a request that never answers is given up on after ninety seconds, and the words kept", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    answer("message", "hang");
    vi.useFakeTimers();
    try {
      q<HTMLTextAreaElement>(root, "textarea").value = "Hello?";
      q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(89_000);
      expect(q<HTMLButtonElement>(root, ".send").disabled).toBe(true);
      expect(q(root, ".status").textContent).toBe("Replying");
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(q<HTMLButtonElement>(root, ".send").disabled).toBe(false);
    expect(q<HTMLTextAreaElement>(root, "textarea").value).toBe("Hello?");
    expect(q(root, ".status").textContent).toMatch(/couldn't reach the chat/);
  });

  test("after thirty quiet minutes the next message opens a new chat, with its opening line on screen", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "n0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Welcome back.", token: "n1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 29 * 60 * 1000 + 1000);
    try {
      await type(root, "Back again");
    } finally {
      clock.mockRestore();
    }
    expect(calls.slice(-2).map((c) => c.url.replace(API, ""))).toEqual(["start", "message"]);
    expect(calls.at(-1)!.body).toEqual({ token: "n0", text: "Back again" });
    expect(messages(root).slice(-3)).toEqual([`Assistant: ${OPENING}`, "You: Back again", "Assistant: Welcome back."]);
  });

  test("after 59 answers the next message opens a new chat, before the engine's turn limit would", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    for (let i = 0; i < 59; i++) answer("message", { status: 200, body: { mode: "chat", reply: `Reply ${i}`, token: `t${i + 1}`, ended: false } });
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "n0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Fresh.", token: "n1", ended: false } });
    const root = await load();
    await open(root);
    for (let i = 0; i < 59; i++) await type(root, `Message ${i}`);
    expect(calls.filter((c) => c.url.endsWith("/start"))).toHaveLength(1);
    await type(root, "Number sixty");
    expect(calls.slice(-2).map((c) => c.url.replace(API, ""))).toEqual(["start", "message"]);
    expect(messages(root).slice(-3)).toEqual([`Assistant: ${OPENING}`, "You: Number sixty", "Assistant: Fresh."]);
  });

  test("a reply that lands while the visitor is on the clinic's page leaves focus there", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    const search = document.createElement("input");
    document.body.appendChild(search);
    q<HTMLTextAreaElement>(root, "textarea").value = "Hello";
    q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
    search.focus();
    await settle();
    expect(messages(root).at(-1)).toBe("Assistant: Sure.");
    expect(document.activeElement).toBe(search);
  });

  test("a new chat that cannot be opened keeps the words, and asks again next time", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Bye.", token: "t1", ended: true } });
    answer("start", { status: 429, body: { error: "rate_limited" } });
    const root = await load();
    await open(root);
    await type(root, "bye");
    await type(root, "wait");
    expect(q<HTMLTextAreaElement>(root, "textarea").value).toBe("wait");
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "n0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Yes?", token: "n1", ended: false } });
    await type(root, "wait");
    expect(calls.slice(-2).map((c) => c.url.replace(API, ""))).toEqual(["start", "message"]);
  });

  test("on a phone the panel is modal and Tab stays inside it", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    const panel = q(root, ".panel");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const close = q<HTMLButtonElement>(root, ".icon-button");
    const send = q<HTMLButtonElement>(root, ".send");
    send.focus();
    // Rendering is not laid out here: every control counts as visible.
    for (const node of panel.querySelectorAll("button, textarea, input, a")) {
      (node as HTMLElement).getClientRects = () => ({ length: (node as HTMLElement).closest("[hidden]") ? 0 : 1 }) as unknown as DOMRectList;
    }
    send.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(close);
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(root.activeElement).toBe(send);
  });

  test("every request is plain text with no credential", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    answer("end", { status: 200, body: { ended: true } });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    q<HTMLButtonElement>(root, ".text-button").click();
    await settle();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.init.credentials).toBe("omit");
      expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe("text/plain;charset=UTF-8");
    }
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

  test("a form that takes nothing says to call the practice, at the number on its own website", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "cancelled", form: { takesMessages: false, times: TIMES } } });
    const root = await load();
    await open(root);
    expect(root.querySelector(".form")).toBeNull();
    expect(q(root, ".call").textContent).toContain("Its phone number is on this website.");
    expect(q(root, ".call").textContent).toContain("If it's an emergency, call 911.");
    expect(root.querySelector(".call a")).toBeNull();
  });

  test("a start that could not reach the engine is asked again when the bubble is reopened", async () => {
    answer("start", "network");
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    expect(q(root, ".call")).toBeTruthy();
    q<HTMLButtonElement>(root, ".icon-button").click();
    await open(root);
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`]);
    expect(q(root, ".compose").hidden).toBe(false);
    expect(q(root, ".contact").hidden).toBe(true);
  });

  test("a rate-limited start says to try again in a minute, or call", async () => {
    answer("start", { status: 429, body: { error: "rate_limited" } });
    const root = await load();
    await open(root);
    expect(q(root, ".call").textContent).toContain("Please try again in a minute, or call.");
  });

  test("one failure to reach the engine mid-chat keeps the words to send again; a second shows the way to call", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", "network", { status: 502, body: "<html>bad gateway</html>" });
    const root = await load();
    await open(root);
    await type(root, "Hello");
    expect(q(root, ".compose").hidden).toBe(false);
    expect(q<HTMLTextAreaElement>(root, "textarea").value).toBe("Hello");
    expect(q(root, ".status").textContent).toMatch(/couldn't reach the chat/);

    await type(root, "Hello");
    expect(q(root, ".compose").hidden).toBe(true);
    expect(q(root, ".call").textContent).toContain("Please call the practice");
    // The message that never arrived says so, and focus is on the way to call.
    expect(root.querySelectorAll(".msg.unsent")).toHaveLength(1);
    expect(messages(root).at(-1)).toBe("You: Hello (not sent)");
    expect(root.activeElement).toBe(q(root, ".call"));

    // Reopening asks for a chat again.
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t9" } });
    q<HTMLButtonElement>(root, ".icon-button").click();
    await open(root);
    expect(q(root, ".compose").hidden).toBe(false);
    expect(messages(root).at(-1)).toBe(`Assistant: ${OPENING}`);
    // What was said stays on screen, the opening line first.
    expect(messages(root)[0]).toBe(`Assistant: ${OPENING}`);
  });

  test("a dropped connection keeps what was typed in the form; a second shows the way to call", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    answer("contact", "network", { status: 503, body: { error: "unavailable" } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q<HTMLInputElement>(root, "#first").value).toBe("Jamie");
    expect(q(root, ".status").textContent).toMatch(/didn't send/);
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(root.querySelector(".form")).toBeNull();
    expect(q(root, ".call").textContent).toContain("Please call the practice");
  });

  test("a reply after the visitor clicked the page's own text leaves keys to the page", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    q<HTMLTextAreaElement>(root, "textarea").value = "Hello";
    q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
    // A click on plain text: focus goes to the body, not to a control.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (root.activeElement as HTMLElement | null)?.blur();
    await settle();
    expect(messages(root).at(-1)).toBe("Assistant: Sure.");
    expect(root.activeElement).toBeNull();
  });

  test("a click inside the bubble while a reply is on its way is not a visit to the page", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "Sure.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    q<HTMLTextAreaElement>(root, "textarea").value = "Hello";
    q<HTMLFormElement>(root, ".compose").dispatchEvent(new Event("submit", { cancelable: true }));
    q(root, ".log").dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    (root.activeElement as HTMLElement | null)?.blur();
    await settle();
    expect(root.activeElement).toBe(q(root, "textarea"));
  });

  test("the contact form's answer leaves focus on the clinic's page if the visitor went there", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    answer("contact", { status: 200, body: { mode: "received", reply: "Thanks." } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    const search = document.createElement("input");
    document.body.appendChild(search);
    search.focus();
    await settle();
    expect(q(root, ".received").textContent).toBe("Thanks.");
    expect(document.activeElement).toBe(search);
  });

  test("a slow first open leaves focus on the clinic's page if the visitor went back there", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    const search = document.createElement("input");
    document.body.appendChild(search);
    q<HTMLButtonElement>(root, ".launcher").click();
    search.focus();
    await settle();
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`]);
    expect(document.activeElement).toBe(search);
  });

  test("a message the form can no longer take says to call the practice", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    answer("contact", { status: 409, body: { mode: "closed" } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q(root, ".call").textContent).toContain("Please call the practice");
    expect(root.querySelector(".form")).toBeNull();
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
    // Served as written, comments and all: what crosses the wire is gzipped.
    expect(gzipSync(SOURCE).byteLength).toBeLessThan(12_000);
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

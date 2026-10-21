// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GET, HEAD } from "@/app/widget/v1.js/route";
import { WIDGET_SCRIPT_PATH, widgetSnippet } from "@/lib/setup/snippet";

import { axeViolations } from "./setup/axe";

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
const CALL_LINE = "To reach Radiance Clinic, please call the practice on (555) 123-4567.";

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

  test("a form that takes nothing shows the practice's number the engine sends, as text", async () => {
    // What contactFormOffer sends for a clinic that cancelled: the fixed line
    // with its published number (lib/chat/contact-form.ts, callPracticeLine).
    answer("start", { status: 200, body: { mode: "contact_form", reason: "cancelled", form: { takesMessages: false, times: TIMES, callLine: CALL_LINE } } });
    const root = await load();
    await open(root);
    expect(root.querySelector(".form")).toBeNull();
    expect(q(root, ".call").textContent).toContain(CALL_LINE);
    expect(q(root, ".call").textContent).not.toContain("on this website");
    expect(q(root, ".call").textContent).toContain("If it's an emergency, call 911.");
    expect(root.querySelector(".call a")).toBeNull();
  });

  test("the engine's line is shown as text, never parsed as markup", async () => {
    const line = 'To reach <b id="x">Radiance</b>, please call the practice on (555) 123-4567.';
    answer("start", { status: 200, body: { mode: "contact_form", reason: "cancelled", form: { takesMessages: false, times: TIMES, callLine: line } } });
    const root = await load();
    await open(root);
    expect(q(root, ".call .line").textContent).toBe(line);
    expect(root.querySelector(".call b")).toBeNull();
  });

  test("with no line from the engine, or one naming no number, it points to the number on its own website", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "unavailable", form: { takesMessages: false, times: TIMES } } });
    const root = await load();
    await open(root);
    expect(q(root, ".call").textContent).toContain("Its phone number is on this website.");
    expect(root.querySelector(".call .line")).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    await settle();
    document.body.replaceChildren();
    delete (window as unknown as { __healdeskChat?: boolean }).__healdeskChat;
    const directly = "To reach Radiance Clinic, please call the practice directly.";
    answer("start", { status: 200, body: { mode: "contact_form", reason: "cancelled", form: { takesMessages: false, times: TIMES, callLine: directly } } });
    const second = await load();
    await open(second);
    expect(q(second, ".call").textContent).toContain(directly);
    expect(q(second, ".call").textContent).toContain("Its phone number is on this website.");
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

  test("a message the form can no longer take says to call the practice, on the number the engine's refusal carries", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    // The contact route's 409: leaveWebsiteMessage's closed reply, the same fixed line.
    answer("contact", { status: 409, body: { mode: "closed", reply: CALL_LINE } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q(root, ".call").textContent).toContain("Please call the practice");
    expect(q(root, ".call").textContent).toContain(CALL_LINE);
    expect(q(root, ".call").textContent).not.toContain("on this website");
    expect(root.querySelector(".form")).toBeNull();
  });

  test("a refusal with no line says to call the practice at the number on its own website", async () => {
    answer("start", { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } });
    answer("contact", { status: 409, body: { mode: "closed" } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(q(root, ".call").textContent).toContain("Its phone number is on this website.");
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

/** The stylesheet's text, as the source writes it: one rule per string. */
const STYLESHEET = SOURCE.slice(SOURCE.indexOf("function css("));

/** The declarations of the rule whose selector is written exactly so, or fail. */
function rule(selector: string): string {
  const at = STYLESHEET.indexOf(`"${selector}{`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const from = at + selector.length + 2;
  return STYLESHEET.slice(from, STYLESHEET.indexOf("}", from));
}

function px(declarations: string, property: string): number | null {
  const m = new RegExp(`(?:^|;)${property}:(\\d+(?:\\.\\d+)?)px`).exec(declarations);
  return m ? Number(m[1]) : null;
}

/** The name a screen reader gives a control: aria-label, aria-labelledby, its label, or its own text. */
function accessibleName(root: ShadowRoot, node: Element): string {
  const label = node.getAttribute("aria-label");
  if (label) return label;
  const by = node.getAttribute("aria-labelledby");
  if (by) return by.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? "").join(" ").trim();
  const own = node.id ? root.querySelector(`label[for="${node.id}"]`) : null;
  if (own) return own.textContent!.trim();
  return (node.textContent ?? "").trim();
}

const CONTACT = { status: 200, body: { mode: "contact_form", reason: "paused", form: { takesMessages: true, times: TIMES } } };

/** The page the bubble is on, taken down so a second one may be drawn in the same test. */
async function newPage() {
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  delete (window as unknown as { __healdeskChat?: boolean }).__healdeskChat;
  document.body.replaceChildren();
}

describe("the bubble for people who use a keyboard or a screen reader", () => {
  test("the chat passes axe (WCAG 2.2 A and AA, as far as a render without CSS can decide)", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "We open at nine.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "When do you open?");
    expect(await axeViolations(root.innerHTML)).toEqual([]);
    // The check is not vacuous: a button with no name is found by the same run.
    expect(await axeViolations("<button></button>")).not.toEqual([]);
  });

  test("the contact form passes axe, and so does the page that thanks the visitor", async () => {
    answer("start", CONTACT);
    answer("contact", { status: 200, body: { mode: "received", reply: "Thanks. Your message is with Radiance Clinic." } });
    const root = await load();
    await open(root);
    expect(await axeViolations(root.innerHTML)).toEqual([]);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(await axeViolations(root.innerHTML)).toEqual([]);
  });

  test("every control, in the chat and in the form, has a name a screen reader can say", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const chat = await load();
    await open(chat);
    for (const node of chat.querySelectorAll("button, textarea, input")) {
      expect(accessibleName(chat, node), node.outerHTML).not.toBe("");
    }
    expect(accessibleName(chat, q(chat, ".send"))).toBe("Send message");
    expect(accessibleName(chat, q(chat, ".icon-button"))).toBe("Close chat");
    expect(accessibleName(chat, q(chat, "textarea"))).toBe("Your message");

    await newPage();
    answer("start", CONTACT);
    const form = await load();
    await open(form);
    for (const node of form.querySelectorAll("button, textarea, input")) {
      expect(accessibleName(form, node), node.outerHTML).not.toBe("");
    }
    expect([...form.querySelectorAll("input[type=radio]")].map((r) => accessibleName(form, r))).toEqual(["Any time", "Mornings"]);
  });

  test("the dialog is named by its heading, the launcher says what it will do, and the icons are hidden from readers", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    const panel = q(root, ".panel");
    expect(accessibleName(root, panel)).toBe("Chat with us");
    expect(q(root, ".launcher").hasAttribute("aria-label")).toBe(false);
    await open(root);
    expect(q(root, ".launcher").getAttribute("aria-label")).toBe("Close chat");
    for (const svg of root.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden"), "an icon with no name").toBe("true");
    q<HTMLButtonElement>(root, ".icon-button").click();
    expect(q(root, ".launcher").getAttribute("aria-label")).toBe("Chat with us");
  });

  test("the conversation and its status are live regions that speak politely, never interrupt", async () => {
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const root = await load();
    await open(root);
    const log = q(root, ".log");
    expect([log.getAttribute("role"), log.getAttribute("aria-live"), log.getAttribute("aria-label")]).toEqual(["log", "polite", "Conversation"]);
    const status = q(root, ".status");
    expect([status.getAttribute("role"), status.getAttribute("aria-live")]).toEqual(["status", "polite"]);
    expect(root.querySelector("[aria-live=assertive], [role=alert]")).toBeNull();
    // Each message says who spoke, to a reader only.
    expect(q(root, ".msg .sr").textContent).toBe("Assistant: ");
  });

  test("each form field is labelled, required, and tied to the error that will name its fault", async () => {
    answer("start", CONTACT);
    const root = await load();
    await open(root);
    for (const id of ["first", "phone"]) {
      const input = q<HTMLInputElement>(root, `#${id}`);
      expect(root.querySelector(`label[for="${id}"]`), id).not.toBeNull();
      expect(input.hasAttribute("required"), id).toBe(true);
      const error = root.getElementById(input.getAttribute("aria-describedby")!);
      expect(error?.id, id).toBe(`${id}-error`);
    }
    // The radios sit in a named group, and the group points at its own error line.
    const group = q(root, "fieldset");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(q(root, "legend").textContent).toBe("Best time to call");
    expect(root.getElementById(group.getAttribute("aria-describedby")!)).not.toBeNull();
    expect(q(root, ".form").getAttribute("aria-labelledby")).toBe("form-title");
    expect(q(root, "#phone").getAttribute("type")).toBe("tel");
    expect(q(root, "#first").getAttribute("autocomplete")).toBe("given-name");
  });

  test("tab order is the page's own: nothing takes a positive tabindex, and only words to be read are focused by script", async () => {
    answer("start", CONTACT);
    answer("contact", { status: 200, body: { mode: "received", reply: "Thanks." } });
    const root = await load();
    await open(root);
    q<HTMLInputElement>(root, "#first").value = "Jamie";
    q<HTMLInputElement>(root, "#phone").value = "415 555 0199";
    q<HTMLFormElement>(root, ".form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    const indexes = [...root.querySelectorAll("[tabindex]")].map((n) => n.getAttribute("tabindex"));
    expect(indexes.length).toBeGreaterThan(0);
    expect(indexes.every((t) => t === "-1")).toBe(true);
    expect(root.activeElement?.textContent).toMatch(/^Thanks/);
  });

  test("a keyboard user sees where focus is, in the stylesheet and on a forced-colours display", () => {
    expect(rule(":focus-visible")).toMatch(/outline:3px solid/);
    // The one outline taken away belongs to a line of words focused by script (tabindex -1), never to a control.
    expect([...STYLESHEET.matchAll(/"([^"]*)\{[^}]*outline:none/g)].map((m) => m[1])).toEqual([".call:focus"]);
    expect(STYLESHEET).toContain("@media (forced-colors:active)");
  });

  test("no text is set smaller than 13px, and the page's own font settings cannot reach in", () => {
    const sizes = [...STYLESHEET.matchAll(/font-size:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(5);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
    expect(STYLESHEET).toContain(":host{all:initial}");
  });
});

describe("the bubble on a phone", () => {
  /** A phone-sized screen: the query the script asks about, answered yes or no. */
  function screen(matches: boolean) {
    const asked: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      asked.push(query);
      return { matches };
    });
    return asked;
  }

  test("the script asks about the same small screen the stylesheet is written for", async () => {
    const asked = screen(true);
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    await load();
    expect(asked).toEqual(["(max-width: 480px), (max-height: 500px)"]);
    // The stylesheet's media query is the same one, so the panel fills the screen exactly where the dialog turns modal.
    expect(STYLESHEET).toContain("@media (max-width:480px),(max-height:500px){");
  });

  test("on a phone the panel fills the screen, clears the home indicator, and the launcher gives way to it", () => {
    const small = STYLESHEET.slice(STYLESHEET.indexOf("@media (max-width:480px)"));
    const panel = small.slice(0, small.indexOf("}") + 1);
    for (const needed of ["inset:0", "width:100%", "max-width:none", "height:100vh;height:100dvh", "border-radius:0", "padding-bottom:env(safe-area-inset-bottom)"]) {
      expect(panel, needed).toContain(needed);
    }
    expect(small.slice(0, small.indexOf("@media (prefers-reduced-motion")), "the launcher while the panel is open").toContain(":host([data-open=true]) .launcher{display:none}");
  });

  test("on a larger screen the panel never outgrows a narrow window, and the launcher keeps off the screen's corners", () => {
    const desktop = rule(".panel");
    expect(desktop).toContain("width:380px");
    expect(desktop).toContain("max-width:calc(100vw - 32px)");
    expect(desktop).toContain("height:min(600px,calc(100dvh - 120px))");
    const launcher = rule(".launcher");
    expect(launcher).toContain("right:max(16px,env(safe-area-inset-right))");
    expect(launcher).toContain("bottom:max(16px,env(safe-area-inset-bottom))");
  });

  test("every control is at least 44px to touch, and a radio row at least 24px (WCAG 2.5.8)", () => {
    for (const selector of [".icon-button,.text-button", "textarea", "input[type=text],input[type=tel]", ".primary"]) {
      expect(px(rule(selector), "min-height"), selector).toBeGreaterThanOrEqual(44);
    }
    expect(px(rule(".icon-button,.text-button"), "min-width")).toBeGreaterThanOrEqual(44);
    const send = rule(".send");
    expect([px(send, "width"), px(send, "height")]).toEqual([44, 44]);
    expect(px(rule(".launcher"), "min-height")).toBeGreaterThanOrEqual(56);
    expect(px(rule(".option"), "min-height")).toBeGreaterThanOrEqual(24);
    expect(px(rule("input[type=radio]"), "width")).toBeGreaterThanOrEqual(20);
  });

  test("fields are 16px or larger, so a phone's browser does not zoom the page when one is focused", () => {
    expect(px(rule(".launcher,.panel"), "font-size")).toBe(16);
    // The fields take the panel's size by inheriting it, and none sets its own below 16.
    for (const selector of ["textarea", "input[type=text],input[type=tel]"]) expect(rule(selector), selector).toContain("font:inherit");
  });

  test("long words and addresses wrap inside the message rather than push the panel sideways", () => {
    const msg = rule(".msg");
    expect(msg).toContain("overflow-wrap:anywhere");
    expect(msg).toContain("max-width:85%");
    expect(rule(".body")).toContain("overflow-y:auto");
    expect(rule("*,*::before,*::after")).toContain("box-sizing:border-box");
  });

  test("on a phone the dialog is modal while it is open and not after, and a larger screen is never trapped", async () => {
    screen(true);
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    const phone = await load();
    expect(q(phone, ".panel").hasAttribute("aria-modal")).toBe(false);
    await open(phone);
    expect(q(phone, ".panel").getAttribute("aria-modal")).toBe("true");
    q(phone, ".panel").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(q(phone, ".panel").hasAttribute("aria-modal")).toBe(false);
    expect(phone.activeElement).toBe(q(phone, ".launcher"));

    await newPage();
    screen(false);
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t1" } });
    const desktop = await load();
    await open(desktop);
    expect(q(desktop, ".panel").hasAttribute("aria-modal")).toBe(false);
    // Tab off the last control is the page's to take: the script does not stop it.
    const send = q<HTMLButtonElement>(desktop, ".send");
    send.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    send.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  test("a whole conversation works on a phone: open, send, read the reply, close", async () => {
    screen(true);
    answer("start", { status: 200, body: { mode: "chat", opening: OPENING, token: "t0" } });
    answer("message", { status: 200, body: { mode: "chat", reply: "We open at nine.", token: "t1", ended: false } });
    const root = await load();
    await open(root);
    await type(root, "When do you open?");
    expect(messages(root)).toEqual([`Assistant: ${OPENING}`, "You: When do you open?", "Assistant: We open at nine."]);
    expect(root.activeElement).toBe(q(root, "textarea"));
    q<HTMLButtonElement>(root, ".icon-button").click();
    expect(q(root, ".panel").hidden).toBe(true);
    expect(root.activeElement).toBe(q(root, ".launcher"));
  });

  test("the contact form is usable on a phone: the number field raises the phone keypad and the first name offers autofill", async () => {
    screen(true);
    answer("start", CONTACT);
    const root = await load();
    await open(root);
    expect(q(root, "#phone").getAttribute("inputmode")).toBe("tel");
    expect(q(root, "#phone").getAttribute("autocomplete")).toBe("tel");
    expect(q(root, "#first").getAttribute("autocomplete")).toBe("given-name");
    expect(q(root, ".fine").textContent).toBe("If it's an emergency, call 911.");
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

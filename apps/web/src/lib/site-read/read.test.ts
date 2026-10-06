import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ExtractionClient } from "./extract";
import type { Resolver, Transport, TransportResult } from "./fetch";
import { readClinicSite } from "./read";

/**
 * The read end to end, with DNS, HTTP and the model stubbed: the guard's
 * failures pass through as reasons, thin pages never reach the model, and a
 * good site comes back as a screened profile.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

const resolve: Resolver = async (hostname) => {
  if (hostname === "glowmedspa.com") return [{ address: "93.184.216.34" }];
  if (hostname === "intranet.glowmedspa.com") return [{ address: "10.1.2.3" }];
  throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
};

function transport(pages: Record<string, TransportResult>): Transport {
  return async ({ url, accept }) =>
    pages[url.href] ??
    (accept === "robots"
      ? { kind: "response", status: 404, body: "" }
      : { kind: "response", status: 404, body: "" });
}

const HOME = `<h1>Glow Med Spa</h1><p>12 Main St, Austin, TX 78701. Call (512) 555-0100.</p>
  <p>Open Monday to Friday, 9am to 5pm. Our nurses offer injectables, facials and laser treatments.</p>
  <a href="/services">Services</a>`;
const SERVICES =
  "<h1>Services</h1><p>Hydrafacial $199</p><p>Botox $14 per unit</p><p>Lip filler from $650</p>";

function model(json: unknown) {
  const create = vi.fn(
    async () =>
      ({
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify(json), citations: null }],
        stop_reason: "end_turn",
        stop_details: null,
      }) as unknown as BetaMessage,
  );
  return { create, client: { beta: { messages: { create } } } satisfies ExtractionClient };
}

const EXTRACTED = {
  practiceKind: "med-spa",
  acceptsInsurance: "no",
  locations: [
    { label: "Glow Med Spa", address: "12 Main St, Austin, TX 78701", phone: "(512) 555-0100" },
  ],
  services: [
    { name: "Hydrafacial", priceKind: "exact", priceUsd: 199 },
    { name: "Botox", priceKind: "per_unit", priceUsd: 14, unit: "unit" },
  ],
  providers: [],
  policies: [],
  faqs: [],
};

describe("readClinicSite", () => {
  test("reads the home page and its services page, and returns the screened profile", async () => {
    const { client, create } = model(EXTRACTED);
    const read = await readClinicSite("glowmedspa.com", {
      deadline: Date.now() + 50_000,
      client,
      fetch: {
        resolve,
        transport: transport({
          "https://glowmedspa.com/": { kind: "response", status: 200, body: HOME },
          "https://glowmedspa.com/services": { kind: "response", status: 200, body: SERVICES },
        }),
      },
    });
    expect(read).toMatchObject({ status: "read", model: "claude-opus-5-5" });
    if (read.status !== "read") return;
    expect(read.profile.pages).toBe(2);
    expect(read.profile.services.map((s) => s.name)).toEqual(["Hydrafacial", "Botox"]);
    const input = (create.mock.calls[0] as unknown[])[0] as { messages: { content: string }[] };
    expect(input.messages[0]!.content).toContain("Lip filler from $650");
  });

  test("a refused site is a failure with the guard's reason, and the model is never asked", async () => {
    const { client, create } = model(EXTRACTED);
    const read = await readClinicSite("intranet.glowmedspa.com", {
      deadline: Date.now() + 50_000,
      client,
      fetch: { resolve, transport: transport({}) },
    });
    expect(read).toMatchObject({ status: "failed", reason: "refused" });
    expect(create).not.toHaveBeenCalled();
  });

  test("a page with almost no text is not worth a model call", async () => {
    const { client, create } = model(EXTRACTED);
    const read = await readClinicSite("glowmedspa.com", {
      deadline: Date.now() + 50_000,
      client,
      fetch: {
        resolve,
        transport: transport({
          "https://glowmedspa.com/": {
            kind: "response",
            status: 200,
            body: '<div id="root"></div><script src="/app.js"></script>',
          },
        }),
      },
    });
    expect(read).toEqual({ status: "failed", reason: "no-text" });
    expect(create).not.toHaveBeenCalled();
  });

  test("without an Anthropic key there is no read", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await readClinicSite("glowmedspa.com", { deadline: Date.now() + 50_000 })).toEqual({
      status: "failed",
      reason: "unconfigured",
    });
  });

  test("no model call is started without time left to finish it", async () => {
    const { client, create } = model(EXTRACTED);
    const read = await readClinicSite("glowmedspa.com", {
      deadline: Date.now() + 5_000,
      client,
      fetch: {
        resolve,
        transport: transport({
          "https://glowmedspa.com/": { kind: "response", status: 200, body: HOME.repeat(3) },
        }),
      },
    });
    expect(read).toMatchObject({ status: "failed", reason: "timeout" });
    expect(create).not.toHaveBeenCalled();
  });
});

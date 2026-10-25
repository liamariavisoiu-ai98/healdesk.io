import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Readying the model for a call's next turn (owner, 25 October 2026: "still
 * way too slow to answer"): a `max_tokens: 0` request that writes the prompt
 * cache and keeps the connection open, built exactly as a real turn's
 * request is, or the cache it writes is one the turns never read.
 */

const created = vi.hoisted(() => ({ requests: [] as Record<string, unknown>[] }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (request: Record<string, unknown>) => {
        created.requests.push(request);
        return { content: [], stop_reason: "max_tokens", usage: {} };
      },
    };
  },
}));

import { anthropicAssistantResponder, modelRequest, prewarmModel } from "@/lib/assistant/responder";

afterEach(() => {
  created.requests = [];
  vi.unstubAllEnvs();
});

describe("readying the model for a call's next turn", () => {
  test("is a max_tokens 0 request on the turn's own model, thinking and effort, caching the stable prompt alone", async () => {
    const system = { stable: "The rules and the clinic's facts.", turn: "Now it is Saturday." };
    await prewarmModel({ apiKey: "test-key", channel: "voice", system });
    expect(created.requests).toHaveLength(1);
    const warm = created.requests[0]!;
    const turn = modelRequest({ channel: "voice", system, messages: [{ role: "user", content: "hi" }] });
    expect(warm.max_tokens).toBe(0);
    expect(warm).not.toHaveProperty("stream");
    expect(warm.model).toBe(turn.model);
    expect(warm.thinking).toEqual(turn.thinking);
    expect(warm.output_config).toEqual(turn.output_config);
    // The turn's first block, byte for byte, with its breakpoint; the turn's own context is not part of it.
    expect(warm.system).toEqual([turn.system![0]]);
    expect(warm.messages).toEqual([{ role: "user", content: "warmup" }]);
  });

  test("comes with the responder when the key is set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const responder = anthropicAssistantResponder();
    expect(responder?.prewarm).toBeTypeOf("function");
    await responder!.prewarm!({ stable: "x", turn: "" }, "voice");
    expect(created.requests[0]).toMatchObject({ max_tokens: 0 });
  });
});

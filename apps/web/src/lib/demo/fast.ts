import Anthropic from "@anthropic-ai/sdk";

/**
 * A model call that must finish by a deadline: the demo build's extraction
 * and grade (lib/demo/budget.ts, one minute for the whole build).
 *
 * It asks for fast mode first: the same Opus 5.5 at up to two and a half
 * times the output speed, at twice the price per token, which is what fits a
 * structured profile and a graded read inside the minute. Fast mode has its
 * own rate limit and is a research preview, so a refused or rate-limited fast
 * call is asked again once at standard speed, if the deadline leaves room.
 * The deadline is one abort signal over every attempt: a call still running
 * when it passes is cut off, and the caller decides what that means.
 *
 * Streams, so a long `max_tokens` never trips the SDK's non-streaming guard.
 */

type Client = Pick<Anthropic, "beta">;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export const FAST_MODE_BETA = "fast-mode-2026-02-01";

/** Below this much time left, a standard-speed second attempt is not worth starting. */
const RETRY_FLOOR_MS = 4_000;

function isAbort(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

export async function createBy(client: Client, params: Params, deadline: number): Promise<Anthropic.Beta.Messages.BetaMessage> {
  const left = () => Math.max(0, deadline - Date.now());
  const signal = AbortSignal.timeout(Math.max(1, left()));
  const { stream: _stream, ...base } = params as Params & { stream?: unknown };
  try {
    return await client.beta.messages
      .stream({ ...base, speed: "fast", betas: [...(base.betas ?? []), FAST_MODE_BETA] }, { maxRetries: 0, signal })
      .finalMessage();
  } catch (error) {
    if (isAbort(error) || signal.aborted || left() < RETRY_FLOOR_MS) throw error;
    console.warn("[healdesk] fast mode call failed; asking again at standard speed", {
      error: error instanceof Anthropic.APIError ? `${error.status ?? ""} ${error.name}` : error instanceof Error ? error.message : String(error),
    });
    return client.beta.messages.stream(base, { maxRetries: 1, signal }).finalMessage();
  }
}

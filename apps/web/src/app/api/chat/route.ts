import Anthropic from "@anthropic-ai/sdk";

import { GATE_COOKIE, verifyGateToken } from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { composeKnowledge, isNiche, isPractice } from "@/lib/knowledge";
import { buildSystemPrompt } from "@/lib/demo-prompt";
import { getSpecialty } from "@/lib/specialties";

/**
 * POST /api/chat, the live demo's model call.
 *
 * This route exists because the prototype called api.anthropic.com directly
 * from browser JavaScript. A key shipped that way is public the moment the page
 * deploys. ANTHROPIC_API_KEY is read here and only here; it has no
 * NEXT_PUBLIC_ prefix, so Next will never inline it into a client bundle.
 *
 * Three things bound the cost: the email gate, a per-IP rate limit, and hard
 * caps on both conversation length and max_tokens.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Conversation turns accepted from the client (the model sees at most this many). */
const MAX_TURNS = 12;
/** Characters per message. Long enough for a real question, short enough to bound cost. */
const MAX_CHARS = 1_000;
/** Requests per IP per window. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Caps thinking + visible text together. Adaptive thinking at low effort fits comfortably. */
const MAX_TOKENS = 2_000;
/**
 * The spend ceiling, site-wide, per UTC day. The per-IP limit above bounds one
 * visitor; this bounds the bill when a thousand of them (or one with a proxy
 * pool) arrive at once. It counts turns, not dollars: the default of 2,000
 * turns at up to MAX_TOKENS each admits about four million output tokens a
 * day, plus the input of every turn (the composed system prompt rides on all
 * of them). That is well past "a few dollars", which this comment used to
 * say; price it against the model's current rates before relying on it, and
 * lower DEMO_DAILY_CHAT_CAP if it is more than the demo is worth. Override
 * with DEMO_DAILY_CHAT_CAP; 0 disables the demo.
 */
const DAILY_CAP = Number(process.env.DEMO_DAILY_CHAT_CAP ?? 2_000);
const DAY_MS = 24 * 60 * 60 * 1000;

type ClientMessage = { role: "user" | "assistant"; content: string };

function badRequest(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[healdesk] ANTHROPIC_API_KEY is not set");
    return badRequest("The demo is temporarily unavailable.", 503);
  }

  // 1. Gate, every chat session is tied to a captured email.
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GATE_COOKIE}=`))
    ?.slice(GATE_COOKIE.length + 1);

  if (!verifyGateToken(cookie)) {
    return badRequest("Enter your email to start the demo.", 401);
  }

  // 2. Rate limit.
  const limit = await rateLimit(
    `chat:${clientKey(request.headers)}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return Response.json(
      { error: "You've hit the demo limit. Book a call and we'll show you the rest." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }
  // Site-wide daily ceiling, checked after the per-IP limit so a single
  // abusive address is turned away by its own budget rather than by
  // everyone's. When it trips, the demo says so honestly instead of hanging.
  const daily = await rateLimit("chat:global:day", DAILY_CAP, DAY_MS);
  if (!daily.ok) {
    return Response.json(
      { error: "The demo has hit its daily limit. It resets at midnight UTC — or book a live walkthrough from the contact page." },
      { status: 429, headers: { "Retry-After": String(daily.retryAfter) } },
    );
  }


  // 3. Validate input.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body.");
  }

  const { specialtyId, practice, niche, messages } = (body ?? {}) as {
    specialtyId?: unknown;
    practice?: unknown;
    niche?: unknown;
    messages?: unknown;
  };

  // Optional. The homepage demo sends none, one agent, all specialties, but
  // a caller that names one still gets the deeper branch.
  if (specialtyId !== undefined && typeof specialtyId !== "string") {
    return badRequest("Invalid specialty.");
  }

  const specialty =
    typeof specialtyId === "string" ? getSpecialty(specialtyId) : undefined;
  if (typeof specialtyId === "string" && !specialty) {
    return badRequest("Unknown specialty.");
  }

  // Optional, and validated against the enum rather than passed through. An
  // unrecognised value falls back to the specialty layer instead of erroring:
  // the visitor's conversation is worth more than strictness about a hint, and
  // a generalist answer is always safe where a wrong-niche answer is not.
  const branch = isNiche(niche) ? niche : undefined;
  const practiceType = isPractice(practice) ? practice : undefined;

  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest("Missing messages.");
  }

  const clean: ClientMessage[] = [];
  for (const raw of messages.slice(-MAX_TURNS)) {
    const role = (raw as ClientMessage | null)?.role;
    const content = (raw as ClientMessage | null)?.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    const trimmed = content.trim();
    if (!trimmed) continue;
    clean.push({ role, content: trimmed.slice(0, MAX_CHARS) });
  }

  // The Messages API requires the conversation to start with a user turn.
  while (clean.length > 0 && clean[0]!.role !== "user") clean.shift();
  if (clean.length === 0) return badRequest("Missing messages.");

  // 4. Stream from the model.
  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>): void => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      try {
        const modelStream = client.messages.stream({
          model: "claude-opus-5",
          max_tokens: MAX_TOKENS,
          // Adaptive thinking at low effort: fast and cheap, which is right for
          // short pricing Q&A. Raise to "medium" if answers start reading thin.
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          system: [
            {
              type: "text",
              text: buildSystemPrompt(
                specialty?.name ?? null,
                composeKnowledge({
                  specialtyContext: specialty?.context,
                  practice: practiceType ?? specialty?.id,
                  niche: branch,
                }),
              ),
              // Stable per (specialty, niche) pair, and the homepage demo now
              // sends neither, so every visitor there shares ONE prompt and the
              // cache hits far more often than it did behind the picker.
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: clean,
        });

        for await (const event of modelStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send({ type: "text", text: event.delta.text });
          }
        }

        const final = await modelStream.finalMessage();

        // Safety classifiers can decline with HTTP 200 and an empty content
        // array, check stop_reason before assuming there was an answer.
        if (final.stop_reason === "refusal") {
          send({
            type: "error",
            error:
              "I can't help with that one. Ask me about treatments, pricing, or how healdesk works.",
          });
        }

        send({ type: "done" });
      } catch (error) {
        console.error("[healdesk] chat stream failed", error);
        send({
          type: "error",
          error: "Something went wrong reaching the assistant. Try again.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

import Anthropic from "@anthropic-ai/sdk";

import { GATE_COOKIE, verifyGateToken } from "@/lib/gate";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { getSpecialty } from "@/lib/specialties";

/**
 * POST /api/chat — the live demo's model call.
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

type ClientMessage = { role: "user" | "assistant"; content: string };

function buildSystemPrompt(specialtyName: string, context: string): string {
  return [
    `You are the front-desk assistant for healdesk (healdesk.io), embedded live on healdesk's marketing website as an interactive demo. You are configured for a ${specialtyName} clinic.`,
    "",
    "You have two jobs at once:",
    `1) Demonstrate how well healdesk handles real ${specialtyName} patient questions — pricing, what treatments involve, scheduling, preparation, basic post-care, and insurance where relevant. Answer like a warm, sharp front desk.`,
    '2) You are also speaking with a clinic owner or operator evaluating healdesk. When they ask about the product, answer clearly and win them over, then point them to the "Make It Yours" button to get their own.',
    "",
    "About healdesk, for product questions:",
    "- It answers calls, SMS, web chat, Instagram DM, and WhatsApp 24/7, qualifies the caller, books directly into the clinic's calendar or EMR, takes deposits, runs intake and consent, and follows up on no-shows and lapsed patients.",
    "- It calls back missed numbers automatically, so an unanswered phone stops being a lost patient.",
    "- What actually sets it apart: closed-loop revenue attribution. Other AI receptionists write a booking into the calendar and stop there. healdesk also reads the money event back out of the point-of-sale, so a clinic can see which specific recovered call became booked, showed up, and collected revenue — and feed that back to their ad platforms.",
    "- HIPAA is handled with a BAA, encrypted storage, and audit-ready intake and consent records.",
    "",
    "Clinical boundaries — these are absolute:",
    "- Never diagnose, prescribe, or set a treatment plan. You are a front desk, not a clinician.",
    "- Route anything about complications, adverse reactions, or urgent symptoms to a human provider immediately.",
    "- Quote pricing as an approximate range and note the clinic confirms exact pricing at consult.",
    "",
    `Domain context for this ${specialtyName} clinic:`,
    context,
    "",
    "Style: two to four sentences, warm and direct, no bullet lists, no emoji, no markdown headers. Sound like a great receptionist, not a chatbot. Move toward a booked appointment when you're talking to a patient, and toward a demo when you're talking to an operator.",
  ].join("\n");
}

function badRequest(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[healdesk] ANTHROPIC_API_KEY is not set");
    return badRequest("The demo is temporarily unavailable.", 503);
  }

  // 1. Gate — every chat session is tied to a captured email.
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
  const limit = rateLimit(
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

  // 3. Validate input.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Invalid request body.");
  }

  const { specialtyId, messages } = (body ?? {}) as {
    specialtyId?: unknown;
    messages?: unknown;
  };

  if (typeof specialtyId !== "string") {
    return badRequest("Missing specialty.");
  }

  const specialty = getSpecialty(specialtyId);
  if (!specialty) {
    return badRequest("Unknown specialty.");
  }

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
              text: buildSystemPrompt(specialty.name, specialty.context),
              // The prompt is stable per specialty, so it caches across visitors.
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
        // array — check stop_reason before assuming there was an answer.
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

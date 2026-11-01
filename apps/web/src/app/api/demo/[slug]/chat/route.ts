import Anthropic from "@anthropic-ai/sdk";

import { demoChatParams, demoUrgentReply } from "@/lib/demo/chat-model";
import { liveDemo } from "@/lib/demo/samples";
import { getDemoSession, isDemoActive, isDemoSlug, profileOf } from "@/lib/demo/sessions";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/demo/[slug]/chat, the personalised demo's website assistant.
 *
 * The same shape as /api/chat (NDJSON stream of `text`, `error`, `done`),
 * with three differences:
 *
 *   - No email gate. The unguessable slug is the gate: the demo was built
 *     for one prospect who asked for it, and they already have the link.
 *   - The system prompt is the clinic's own (lib/demo/clinic-prompts.ts),
 *     built from the stored profile, never from anything the browser sends.
 *   - It stops answering when the demo expires (410), which is the page's
 *     "Instance Archived" banner made true on the server.
 *
 * Nothing typed here is stored. The conversation lives in the browser and in
 * the model call, which is what the spec asks of a demo sandbox: no
 * transcript to purge because none was kept.
 *
 * Cost is bounded the way /api/chat bounds it: per-IP and per-demo limits,
 * the shared site-wide daily turn cap, and hard caps on history and output.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 16;
const MAX_CHARS = 1_000;
const IP_LIMIT = 40;
const IP_WINDOW_MS = 60 * 60 * 1000;
/** One prospect and their team, playing with it for a week. */
const DEMO_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_CAP = Number(process.env.DEMO_DAILY_CHAT_CAP ?? 2_000);

type ClientMessage = { role: "user" | "assistant"; content: string };

function fail(error: string, status: number, headers?: Record<string, string>): Response {
  return Response.json({ error }, { status, headers });
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isDemoSlug(slug)) return fail("Demo not found.", 404);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[healdesk] ANTHROPIC_API_KEY is not set");
    return fail("The assistant is temporarily unavailable.", 503);
  }

  const ip = clientKey(request.headers);
  const perIp = await rateLimit(`demo-chat:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!perIp.ok) {
    return fail("You've sent a lot of messages. Give it a few minutes.", 429, { "Retry-After": String(perIp.retryAfter) });
  }

  const session = await getDemoSession(slug);
  if (!session) return fail("Demo not found.", 404);
  if (!isDemoActive(session)) {
    return fail(session.status === "ready" ? "This demo has expired." : "This demo isn't ready yet.", 410);
  }
  const stored = profileOf(session);
  if (!stored) return fail("This demo isn't ready yet.", 410);
  // What the website did not show is made up for the live demo, as the page
  // says: the values the build stored (lib/demo/samples.ts).
  const profile = liveDemo(stored, session.demoFill).profile;

  const perDemo = await rateLimit(`demo-chat:slug:${slug}`, DEMO_LIMIT, DAY_MS);
  if (!perDemo.ok) {
    return fail("This demo has had a busy day. It resets tomorrow.", 429, { "Retry-After": String(perDemo.retryAfter) });
  }
  const daily = await rateLimit("chat:global:day", DAILY_CAP, DAY_MS);
  if (!daily.ok) {
    return fail("The assistant has hit its daily limit. It resets at midnight UTC.", 429, { "Retry-After": String(daily.retryAfter) });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body.", 400);
  }
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return fail("Missing messages.", 400);

  const clean: ClientMessage[] = [];
  for (const raw of messages.slice(-MAX_TURNS)) {
    const role = (raw as ClientMessage | null)?.role;
    const content = (raw as ClientMessage | null)?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const trimmed = content.trim();
    if (trimmed) clean.push({ role, content: trimmed.slice(0, MAX_CHARS) });
  }
  while (clean.length > 0 && clean[0]!.role !== "user") clean.shift();
  if (clean.length === 0) return fail("Missing messages.", 400);

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      try {
        // An urgent message never reaches the model (lib/demo/chat-model.ts).
        const urgent = demoUrgentReply(profile, clean[clean.length - 1]!.role === "user" ? clean[clean.length - 1]!.content : "");
        if (urgent) {
          send({ type: "text", text: urgent });
          send({ type: "done" });
          return;
        }
        // The same request the handoff audit tested (lib/demo/chat-model.ts).
        const modelStream = client.beta.messages.stream(demoChatParams(profile, clean));

        for await (const event of modelStream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", text: event.delta.text });
          }
        }
        const final = await modelStream.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ type: "error", error: "I can't help with that one. Ask me about our treatments, prices or hours." });
        }
        send({ type: "done" });
      } catch (error) {
        console.error("[healdesk] demo chat stream failed", { slug, error: error instanceof Error ? error.message : String(error) });
        send({ type: "error", error: "Something went wrong reaching the assistant. Try again." });
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

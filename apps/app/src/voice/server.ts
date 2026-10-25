import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { DEMO_CALL_PATH, findUrgentContent } from "@healdesk/catalog";
import { WebSocketServer, type WebSocket } from "ws";

import { guardAssistantReply } from "@/lib/assistant/guard";
import { buildAssistantPrompt } from "@/lib/assistant/prompt";
import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { demoAssistantFacts } from "@/lib/voice/demo-facts";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";
import { voiceRealCallsAllowed } from "@/lib/voice/test-calls";

/**
 * The voice endpoint: Retell's custom-LLM WebSocket, one socket per call, held
 * open for the whole call. Its own long-lived Node process from the same
 * image as the web tier and the worker (CLAUDE.md, "Deployment"): a Next route
 * handler cannot accept the upgrade, and a serverless function cannot hold it.
 *
 *   node --import tsx src/voice/server.ts      (in /repo/apps/app, as ECS runs it)
 *   npm run voice -w @healdesk/app             (locally)
 *
 * It listens on PORT (3001, like the web tier, so the same tls-proxy sidecar
 * fronts it in its own task) and answers:
 *
 *   GET /health                               200, for the load balancer
 *   GET /llm-websocket/<secret>/<clinic>/<call>
 *                                             the WebSocket. Each clinic's
 *                                             Retell agent is configured with
 *                                             wss://app.healdesk.io/llm-websocket/<secret>/<clinic id>,
 *                                             and Retell appends the call id.
 *   GET /llm-websocket/<secret>/demo/<call>   a personalised demo call, from the
 *                                             demo engine agent apps/web starts
 *                                             (@healdesk/catalog demo-call.ts):
 *                                             the same session in demo mode,
 *                                             which reads the clinic from the
 *                                             call's sealed dynamic variable,
 *                                             opened with
 *                                             HEALDESK_PROVISION_SECRET, and
 *                                             reads or writes nothing else
 *                                             (lib/voice/retell.ts).
 *
 * The secret (HEALDESK_RETELL_LLM_SECRET) is compared in constant time before
 * the upgrade; unset, every upgrade is refused. It is in the URL because
 * Retell's WebSocket request carries no signature of its own: the load
 * balancer and the sidecar keep no access log, and neither does this process.
 *
 * Until HEALDESK_VOICE_REAL_CALLS=1 (Terraform's voice_real_calls, once
 * every agreement is signed) it is in test mode: a call for any clinic but a
 * made-up one is passed to that clinic's line or refused, unanswered and
 * unrecorded (lib/voice/test-calls.ts). A demo call is no clinic's call and
 * keeps nothing, so test mode does not apply to it.
 *
 * On SIGTERM it stops taking calls and records every call still open (the
 * load balancer has already drained it for up to an hour by then, ecs.tf).
 */

const PATH = new RegExp(
  String.raw`^\/llm-websocket\/([^/]{16,200})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|${DEMO_CALL_PATH})\/([A-Za-z0-9_-]{1,128})$`,
);
const MAX_MESSAGE_BYTES = 256 * 1024;
const HEALTH_PATHS = new Set(["/health", "/health?probe=liveness", "/api/health?probe=liveness"]);
/**
 * Longer than the load balancer's 120-second idle timeout, as for the web
 * tier (KEEP_ALIVE_TIMEOUT, ecs.tf), so the balancer never sends a health
 * check on a connection Node has just closed. A WebSocket is not bound by it.
 */
const KEEP_ALIVE_MS = Number(process.env.KEEP_ALIVE_TIMEOUT) > 0 ? Number(process.env.KEEP_ALIVE_TIMEOUT) : 125_000;

export type VoiceServerOptions = {
  secret?: string | null;
  responder?: AssistantResponder | null;
  transport?: EmailTransport;
  /** Real patients' calls allowed; unset reads HEALDESK_VOICE_REAL_CALLS. */
  realCalls?: boolean;
  /** Opens a demo call's sealed context; unset reads HEALDESK_PROVISION_SECRET. */
  demoSecret?: string | null;
  /** For tests: the session's dependencies beyond the model. */
  sessionDeps?: Partial<ConstructorParameters<typeof RetellCallSession>[3]>;
};

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createVoiceServer(options: VoiceServerOptions = {}): { server: Server; sessions: Set<RetellCallSession>; drain: () => Promise<void> } {
  const secret = options.secret === undefined ? (process.env.HEALDESK_RETELL_LLM_SECRET?.trim() || null) : options.secret;
  const responder = options.responder === undefined ? anthropicAssistantResponder() : options.responder;
  const demoSecret = options.demoSecret === undefined ? (process.env.HEALDESK_PROVISION_SECRET?.trim() || null) : options.demoSecret;
  const sessions = new Set<RetellCallSession>();
  let draining = false;

  const server = createServer((request, response) => {
    // /health for the target group; the tls-proxy sidecar's own check asks
    // the web tier's liveness path, so it is answered here too.
    if (request.method === "GET" && HEALTH_PATHS.has(request.url ?? "")) {
      response.writeHead(draining ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: !draining, calls: sessions.size }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });

  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const match = PATH.exec((request.url ?? "").split("?")[0]!);
    const refuse = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : "Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (draining || !secret) return refuse(503);
    if (!match || !secretMatches(match[1]!, secret)) return refuse(404);
    const clinicId = match[2]!;
    const callId = match[3]!;
    wss.handleUpgrade(request, socket, head, (ws) => attach(ws, clinicId, callId));
  });

  function attach(ws: WebSocket, clinicId: string, callId: string): void {
    const send = (message: RetellOutbound) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    // A demo call gets the model and its secret, and nothing that reaches the database or the mail.
    const session =
      clinicId === DEMO_CALL_PATH
        ? new RetellCallSession(clinicId, callId, send, {
            responder,
            ...options.sessionDeps,
            demo: { secret: demoSecret, ...options.sessionDeps?.demo },
          })
        : new RetellCallSession(clinicId, callId, send, { responder, transport: options.transport, realCalls: options.realCalls, ...options.sessionDeps });
    sessions.add(session);
    // Messages are handled one at a time, in order; a newer response request
    // supersedes an older one inside the session.
    let chain = session.open();
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      chain = chain.then(() => session.handle(raw)).catch((error) => log.error("retell message failed", { clinicId, error: describeError(error) }));
    });
    const finish = () => {
      // Told at once, not in turn: a start still being read behind the
      // chain must not say its line, or record it as heard, on a call that
      // has already ended.
      session.socketClosed();
      void chain.finally(() => session.finish().finally(() => sessions.delete(session)));
    };
    ws.on("close", finish);
    ws.on("error", (error) => {
      log.warn("retell socket error", { clinicId, error: describeError(error) });
      finish();
    });
  }

  async function drain(): Promise<void> {
    draining = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const client of wss.clients) client.close(1001, "server shutting down");
    await Promise.all([...sessions].map((s) => s.finish()));
  }

  return { server, sessions, drain };
}

/**
 * Runs once at boot what every call's first turn would otherwise run cold
 * (owner, 25 October 2026: "still way too slow to answer"): the model SDK's
 * import, the prompt, the urgent screen and the guard, whose patterns
 * compile on first use. Measured on a full core: the guard's first run 80 ms
 * against 3 warm, the SDK's import 148 ms, each several times that on the
 * voice task's quarter vCPU, and all of it heard by the first caller after
 * a deploy. Made-up business data only; never throws.
 */
export async function warmProcess(): Promise<number> {
  const started = Date.now();
  try {
    await import("@anthropic-ai/sdk");
    const facts = demoAssistantFacts({
      slug: "warm-up",
      clinic: {
        clinicName: "Warm-up Clinic",
        summary: null,
        specialty: "med-spa",
        phone: null,
        address: null,
        hours: [{ days: "Mon-Fri", hours: "9am-5pm" }],
        services: [{ name: "Botox", description: null, price: "$12/unit", duration: "30 min" }],
        providers: [],
        faqs: [],
        policies: [],
        booking: null,
        highlights: [],
      },
    });
    buildAssistantPrompt(facts, "voice");
    findUrgentContent("hi, how much is botox and can I book friday", facts.specialty, { clinicName: facts.clinicName });
    guardAssistantReply("Yep, we do! Botox is $12 per unit, about thirty minutes. Want me to note a time?", facts);
  } catch (error) {
    log.warn("voice endpoint warm-up failed", { error: describeError(error) });
  }
  return Date.now() - started;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOSTNAME ?? "0.0.0.0";
  // The clinic's facts kept for a couple of minutes between calls, so the
  // opening line waits only for the answer gate (lib/voice/retell.ts,
  // cacheFacts). Only here, in the running process: tests build their own.
  const { server, drain } = createVoiceServer({ sessionDeps: { cacheFacts: true } });
  if (!process.env.HEALDESK_RETELL_LLM_SECRET?.trim()) {
    log.warn("voice endpoint has no HEALDESK_RETELL_LLM_SECRET: every call is refused", { status: "refusing" });
  }
  if (!voiceRealCallsAllowed()) {
    log.info("voice endpoint in test mode: only a made-up clinic's calls are answered", { status: "test-calls" });
  }
  server.listen(port, host, () => log.info("voice endpoint ready", { status: "listening" }));
  void warmProcess().then((ms) => log.info("voice endpoint warmed", { ms }));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log.info("voice endpoint draining on signal", { signal });
      void drain().then(() => process.exit(0));
    });
  }
}

// Run only as the entry point, never when a test imports the module.
if (process.argv[1] && /src[\\/]voice[\\/]server\.ts$/.test(process.argv[1])) {
  void main();
}

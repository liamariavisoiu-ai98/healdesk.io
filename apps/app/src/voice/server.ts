import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocketServer, type WebSocket } from "ws";

import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";

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
 *
 * The secret (HEALDESK_RETELL_LLM_SECRET) is compared in constant time before
 * the upgrade; unset, every upgrade is refused. It is in the URL because
 * Retell's WebSocket request carries no signature of its own: the load
 * balancer and the sidecar keep no access log, and neither does this process.
 *
 * On SIGTERM it stops taking calls and records every call still open (the
 * load balancer has already drained it for up to an hour by then, ecs.tf).
 */

const PATH = /^\/llm-websocket\/([^/]{16,200})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9_-]{1,128})$/;
const MAX_MESSAGE_BYTES = 256 * 1024;

export type VoiceServerOptions = {
  secret?: string | null;
  responder?: AssistantResponder | null;
  transport?: EmailTransport;
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
  const sessions = new Set<RetellCallSession>();
  let draining = false;

  const server = createServer((request, response) => {
    if (request.method === "GET" && (request.url === "/health" || request.url === "/health?probe=liveness")) {
      response.writeHead(draining ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: !draining, calls: sessions.size }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });

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
    const session = new RetellCallSession(clinicId, callId, send, { responder, transport: options.transport, ...options.sessionDeps });
    sessions.add(session);
    // Messages are handled one at a time, in order; a newer response request
    // supersedes an older one inside the session.
    let chain = session.open();
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      chain = chain.then(() => session.handle(raw)).catch((error) => log.error("retell message failed", { clinicId, error: describeError(error) }));
    });
    const finish = () => {
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

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOSTNAME ?? "0.0.0.0";
  const { server, drain } = createVoiceServer();
  if (!process.env.HEALDESK_RETELL_LLM_SECRET?.trim()) {
    log.warn("voice endpoint has no HEALDESK_RETELL_LLM_SECRET: every call is refused", { status: "refusing" });
  }
  server.listen(port, host, () => log.info("voice endpoint ready", { status: "listening" }));
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

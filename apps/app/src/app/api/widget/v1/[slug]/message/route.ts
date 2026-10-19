import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { json, preflight, widgetRequest } from "@/lib/chat/widget-http";
import { sendWebChatMessage } from "@/lib/chat/web-chat";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let depsForTests: { responder?: AssistantResponder | null; transport?: EmailTransport; now?: Date } | undefined;
/** Test seam: the model, the desk's mail and the clock. Undefined restores the real ones. */
export function __setWebChatDepsForTests(deps: typeof depsForTests): void {
  depsForTests = deps;
}

/**
 * POST /api/widget/v1/<slug>/message {token, text}: one visitor message,
 * answered (lib/chat/web-chat.ts). The reply carries a new token; the old
 * one still names the same conversation until it ends.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const req = await widgetRequest(request, slug);
  if (req instanceof Response) return req;
  try {
    const responder = depsForTests && "responder" in depsForTests ? (depsForTests.responder ?? null) : anthropicAssistantResponder();
    const answer = await sendWebChatMessage(req.clinic, req.body.token, req.body.text, {
      responder,
      transport: depsForTests?.transport,
      now: depsForTests?.now,
      origin: req.origin,
    });
    if (answer.mode === "invalid") return json({ error: answer.reason }, 400, req.origin);
    return json(answer, 200, req.origin);
  } catch (error) {
    log.error("web chat message failed", { clinicId: req.clinic.clinicId, error: describeError(error) });
    return json({ mode: "contact_form", reason: "unavailable" }, 200, req.origin);
  }
}

export async function OPTIONS(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  return preflight(request, (await params).slug);
}

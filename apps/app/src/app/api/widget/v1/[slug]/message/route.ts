import { after } from "next/server";

import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { contactFormOfferSafely } from "@/lib/chat/contact-form";
import { json, preflight, widgetRequest } from "@/lib/chat/widget-http";
import { sendWebChatMessage } from "@/lib/chat/web-chat";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let depsForTests: { responder?: AssistantResponder | null; transport?: EmailTransport; now?: Date } | undefined;
/** Test seam: the model, the clinic's mail and the clock. Undefined restores the real ones. */
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
      // The urgent alert (L12) goes once the reply has been sent.
      after,
      origin: req.origin,
    });
    if (answer.mode === "invalid") return json({ error: answer.reason }, 400, req.origin);
    return json(answer, 200, req.origin);
  } catch (error) {
    log.error("web chat message failed", { clinicId: req.clinic.clinicId, error: describeError(error) });
    // Our endpoint failed: the widget shows the contact form, which still
    // takes a message while the agreement covers the clinic.
    return json({ mode: "contact_form", reason: "unavailable", form: await contactFormOfferSafely(req.clinic) }, 200, req.origin);
  }
}

export async function OPTIONS(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  return preflight(request, (await params).slug);
}

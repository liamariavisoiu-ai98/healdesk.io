import { json, preflight, widgetRequest } from "@/lib/chat/widget-http";
import { endWebChat } from "@/lib/chat/web-chat";
import { describeError, log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/widget/v1/<slug>/end {token}: the visitor closed the chat, so its
 * transcript goes to the clinic now rather than after thirty quiet minutes.
 * The widget may send it with navigator.sendBeacon as the page goes away;
 * if it never arrives, the quiet time sends the transcript anyway.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const req = await widgetRequest(request, slug);
  if (req instanceof Response) return req;
  try {
    return json({ ended: await endWebChat(req.clinic, req.body.token) }, 200, req.origin);
  } catch (error) {
    log.error("web chat end failed", { clinicId: req.clinic.clinicId, error: describeError(error) });
    return json({ ended: false }, 200, req.origin);
  }
}

export async function OPTIONS(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  return preflight(request, (await params).slug);
}

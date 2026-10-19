import { contactFormOfferSafely } from "@/lib/chat/contact-form";
import { json, preflight, widgetRequest } from "@/lib/chat/widget-http";
import { startWebChat } from "@/lib/chat/web-chat";
import { describeError, log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/widget/v1/<slug>/start: the widget opening. Answers the opening
 * line and a token, or `contact_form` when the assistant may not answer
 * (lib/chat/web-chat.ts). Nothing is stored until the first message.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const req = await widgetRequest(request, slug);
  if (req instanceof Response) return req;
  try {
    return json(await startWebChat(req.clinic, new Date(), req.origin), 200, req.origin);
  } catch (error) {
    log.error("web chat start failed", { clinicId: req.clinic.clinicId, error: describeError(error) });
    // Our endpoint failed: the widget shows the contact form, which still
    // takes a message while the agreement covers the clinic.
    return json({ mode: "contact_form", reason: "unavailable", form: await contactFormOfferSafely(req.clinic) }, 200, req.origin);
  }
}

export async function OPTIONS(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  return preflight(request, (await params).slug);
}

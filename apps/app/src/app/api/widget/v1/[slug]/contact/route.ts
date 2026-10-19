import { addressLimited, leaveWebsiteMessage, logMessageFailure } from "@/lib/chat/contact-form";
import { json, preflight, widgetRequest } from "@/lib/chat/widget-http";
import { clientIp } from "@/lib/client-ip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/widget/v1/<slug>/contact {firstName, phone, preferredTime}: a
 * message left on the website's contact form while website chat is not
 * answering (lib/chat/contact-form.ts). Three fields and nothing else; the
 * time is one of the form's fixed choices.
 *
 *   200 {mode: "received", reply}   kept as a booking request; the clinic is
 *                                   alerted (L20); the reply is fixed text
 *   400 {error: "invalid", fields}  which fields to fix, never their values
 *   409 {mode: "closed", reply}     nothing may be kept for this clinic now
 *                                   (it has left, its website chat was never
 *                                   live, or the PHI gate is closed): reply is
 *                                   the fixed "please call the practice on
 *                                   {number}" line, and nothing was written
 *   429 {error: "rate_limited"}     per address and clinic, or per clinic
 *
 * The widget's CORS, body limit and per-minute limit are widgetRequest's.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const req = await widgetRequest(request, slug);
  if (req instanceof Response) return req;
  if (addressLimited(`${clientIp(request.headers) ?? "unknown"}:${req.clinic.clinicId}`)) {
    return json({ error: "rate_limited" }, 429, req.origin);
  }
  try {
    const result = await leaveWebsiteMessage(req.clinic, req.body);
    switch (result.status) {
      case "received":
        return json({ mode: "received", reply: result.reply }, 200, req.origin);
      case "invalid":
        return json({ error: "invalid", fields: result.problems }, 400, req.origin);
      case "closed":
        return json(
          { mode: "closed", ...(result.reply ? { reply: result.reply } : {}) },
          409,
          req.origin,
        );
      case "rate_limited":
        return json({ error: "rate_limited" }, 429, req.origin);
    }
  } catch (error) {
    logMessageFailure(req.clinic.clinicId, error);
    return json({ error: "unavailable" }, 503, req.origin);
  }
}

export async function OPTIONS(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return preflight(request, (await params).slug);
}
